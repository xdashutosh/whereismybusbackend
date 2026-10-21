// Optional error reporting to Sentry (BP §16 Monitoring) for the API and the worker. Disabled unless
// SENTRY_DSN is set (and always in tests): every function below is then a no-op, so nothing is sent
// anywhere and a missing DSN can never crash the process.
//
// Built on @sentry/core's ServerRuntimeClient with a fetch transport (no OpenTelemetry auto-
// instrumentation, no performance tracing). What is reported: unexpected 5xx errors (errorHandler),
// job failures (jobs/index.ts via instrumentJob), unhandled rejections and uncaught exceptions
// (lifecycle.ts). What is never reported (scrubEvent, beforeSend + beforeBreadcrumb):
//   * request bodies, cookies, query strings and every header outside a short allow-list
//     (Authorization, Cookie, X-Device-Id, X-School-Id … are dropped);
//   * values under secret-looking keys (password, token, otp, pin, secret, apiKey … — shared/audit.ts
//     isSecretKey) and under personal-data keys (phone, email, name, address, ip …);
//   * secrets and personal data inside strings (error messages, PG details): JWTs, bearer tokens,
//     long opaque tokens, phone numbers, e-mail addresses, IP addresses;
//   * the user's IP address (sendDefaultPii: false; event.user keeps only the actor id and role).
import {
  ServerRuntimeClient,
  captureException,
  createStackParser,
  createTransport,
  dedupeIntegration,
  functionToStringIntegration,
  getClient,
  getGlobalScope,
  inboundFiltersIntegration,
  linkedErrorsIntegration,
  nodeStackLineParser,
  setCurrentClient,
  withScope,
  type BaseTransportOptions,
  type Breadcrumb,
  type ErrorEvent,
  type Event,
  type Transport,
} from '@sentry/core';
import config, { type Config } from '../config/index.js';
import { isSecretKey, REDACTED } from './audit.js';

export const SENTRY_FLUSH_TIMEOUT_MS = 2000;
const SEND_TIMEOUT_MS = 5000;

/** Request headers that may be reported (everything else is dropped). */
const SAFE_HEADERS: ReadonlySet<string> = new Set(['user-agent', 'content-type', 'content-length', 'accept', 'x-request-id', 'x-app-name', 'x-app-version', 'x-wimb-client']);

/** Words of keys whose values are personal data (camelCase / snake_case split like isSecretKey). */
const PII_WORDS = new Set(['phone', 'phones', 'mobile', 'msisdn', 'email', 'emails', 'mail', 'name', 'names', 'address', 'addresses', 'ip', 'ips', 'aadhaar', 'pan', 'dob', 'birth', 'latitude', 'longitude', 'lat', 'lng', 'location']);
/** Keys allowed although they contain a PII word (identifiers of code, not people). */
const SAFE_KEYS = new Set(['name', 'filename', 'function', 'module', 'type', 'job', 'jobname', 'route', 'action', 'code', 'hostname', 'servername', 'pathname', 'constraint', 'table', 'column']);

function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
}

/** True when a key names personal data (phone, email, fullName, address, ip …). */
export function isPiiKey(key: string): boolean {
  if (SAFE_KEYS.has(key.toLowerCase())) return false;
  return keyWords(key).some((w) => PII_WORDS.has(w));
}

const STRING_RULES: readonly [RegExp, string][] = [
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, '[JWT]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]'],
  [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, '[EMAIL]'],
  [/(?:\+|\b00)[1-9]\d{6,14}\b/g, '[PHONE]'],
  [/(?<![\w.-])\d{10,15}(?![\w.-])/g, '[NUMBER]'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[IP]'],
  [/\b[A-Za-z0-9_-]{40,}\b/g, '[TOKEN]'],
];

/** Removes secrets and personal data from free text (messages, PG error details). */
export function scrubString(s: string): string {
  let out = s;
  for (const [re, repl] of STRING_RULES) out = out.replace(re, repl);
  return out.length > 4000 ? `${out.slice(0, 4000)}…` : out;
}

/** Deep copy with secret/PII keys redacted and every string scrubbed. */
export function scrubValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (depth > 8) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => scrubValue(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = isSecretKey(k) || isPiiKey(k) ? REDACTED : scrubValue(v, depth + 1);
  return out;
}

function stripQuery(url: string): string {
  const i = url.search(/[?#]/);
  return i < 0 ? url : url.slice(0, i);
}

/** beforeSend: the event as it may leave the process (see header). Exported for tests. */
export function scrubEvent<E extends Event>(event: E): E {
  const e: E = { ...event };
  if (e.request) {
    const headers = Object.fromEntries(Object.entries(e.request.headers ?? {}).filter(([k]) => SAFE_HEADERS.has(k.toLowerCase())).map(([k, v]) => [k, scrubString(String(v))]));
    e.request = { method: e.request.method, url: e.request.url ? scrubString(stripQuery(e.request.url)) : undefined, headers };
  }
  if (e.user) e.user = { ...(e.user.id !== undefined ? { id: e.user.id } : {}), ...(typeof e.user.role === 'string' ? { role: e.user.role } : {}) };
  if (e.message) e.message = scrubString(e.message);
  if (e.logentry) e.logentry = { ...e.logentry, ...(e.logentry.message ? { message: scrubString(e.logentry.message) } : {}), params: undefined };
  if (e.exception?.values) {
    e.exception = {
      ...e.exception,
      values: e.exception.values.map((x) => ({
        ...x,
        ...(x.value ? { value: scrubString(x.value) } : {}),
        ...(x.stacktrace?.frames ? { stacktrace: { ...x.stacktrace, frames: x.stacktrace.frames.map(({ vars: _vars, ...f }) => f) } } : {}),
      })),
    };
  }
  if (e.extra) e.extra = scrubValue(e.extra) as E['extra'];
  if (e.contexts) e.contexts = scrubValue(e.contexts) as E['contexts'];
  if (e.tags) e.tags = scrubValue(e.tags) as E['tags'];
  if (e.breadcrumbs) e.breadcrumbs = e.breadcrumbs.map((b) => scrubBreadcrumb(b)).filter((b): b is Breadcrumb => b !== null);
  return e;
}

function scrubBreadcrumb(b: Breadcrumb): Breadcrumb | null {
  return { ...b, ...(b.message ? { message: scrubString(b.message) } : {}), ...(b.data ? { data: scrubValue(b.data) as Breadcrumb['data'] } : {}) };
}

/** Transport over global fetch (Node ≥ 20), bounded by a timeout. */
export function makeFetchTransport(options: BaseTransportOptions): Transport {
  return createTransport(options, async (request) => {
    const res = await fetch(options.url, {
      method: 'POST',
      body: request.body,
      headers: options.headers ?? {},
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    return { statusCode: res.status, headers: { 'x-sentry-rate-limits': res.headers.get('x-sentry-rate-limits'), 'retry-after': res.headers.get('retry-after') } };
  });
}

export interface InitSentryOptions {
  role: 'api' | 'worker';
  sentry?: Config['observability']['sentry'];
  /** Transport factory (tests capture envelopes instead of sending them). */
  transport?: (options: BaseTransportOptions) => Transport;
}

let enabled = false;

/** Starts Sentry when configured → whether it is enabled. Safe to call more than once. */
export function initSentry({ role, sentry = config.observability.sentry, transport = makeFetchTransport }: InitSentryOptions): boolean {
  if (!sentry) {
    enabled = false;
    return false;
  }
  const client = new ServerRuntimeClient({
    dsn: sentry.dsn,
    environment: sentry.environment,
    ...(sentry.release ? { release: sentry.release } : {}),
    sendDefaultPii: false,
    maxBreadcrumbs: 20,
    integrations: [dedupeIntegration(), inboundFiltersIntegration(), functionToStringIntegration(), linkedErrorsIntegration()],
    stackParser: createStackParser(nodeStackLineParser()),
    transport,
    platform: 'node',
    runtime: { name: 'node', version: process.version },
    serverName: `whereismybus-${role}`,
    beforeSend: (event: ErrorEvent) => scrubEvent(event),
    beforeBreadcrumb: (b: Breadcrumb) => scrubBreadcrumb(b),
  });
  setCurrentClient(client);
  client.init();
  getGlobalScope().setTag('role', role);
  enabled = true;
  return true;
}

export function sentryEnabled(): boolean {
  return enabled && getClient() !== undefined;
}

/** Context attached to a report (tags are searchable in Sentry; no personal data). */
export interface ErrorContext {
  requestId?: string;
  method?: string;
  route?: string;
  status?: number;
  code?: string;
  schoolId?: string | null;
  actorId?: string | null;
  actorRole?: string | null;
  job?: string;
  jobId?: string;
  attempt?: number;
  source?: 'http' | 'job' | 'process' | 'socket';
}

/** Reports an error (no-op when Sentry is disabled) → the event id or null. Never throws. */
export function captureError(err: unknown, ctx: ErrorContext = {}): string | null {
  if (!sentryEnabled()) return null;
  try {
    let id: string | null = null;
    withScope((scope) => {
      const tags: Record<string, string> = {};
      for (const k of ['source', 'method', 'route', 'code', 'job', 'actorRole'] as const) if (ctx[k]) tags[k] = String(ctx[k]);
      if (ctx.status !== undefined) tags.status = String(ctx.status);
      if (ctx.schoolId) tags.schoolId = ctx.schoolId;
      scope.setTags(tags);
      if (ctx.actorId) scope.setUser({ id: ctx.actorId, ...(ctx.actorRole ? { role: ctx.actorRole } : {}) });
      scope.setContext('wimb', { requestId: ctx.requestId ?? null, jobId: ctx.jobId ?? null, attempt: ctx.attempt ?? null });
      id = captureException(err);
    });
    return id;
  } catch {
    return null;
  }
}

/** Waits (bounded) until queued events are sent; true when the queue drained. Never throws. */
export async function flushSentry(timeoutMs = SENTRY_FLUSH_TIMEOUT_MS): Promise<boolean> {
  const client = getClient();
  if (!enabled || !client) return true;
  try {
    return await client.flush(timeoutMs);
  } catch {
    return false;
  }
}

/** Flushes and disables the client (shutdown, tests). */
export async function closeSentry(timeoutMs = SENTRY_FLUSH_TIMEOUT_MS): Promise<void> {
  const client = getClient();
  enabled = false;
  if (!client) return;
  try {
    await client.close(timeoutMs);
  } catch {
    // shutting down anyway
  }
}

/** Job failure reporter for instrumentJob (jobs/index.ts): job name, id and attempt as context. */
export function reportJobFailure(err: unknown, ctx: { name: string; jobId: string; attempt: number }): void {
  captureError(err, { source: 'job', job: ctx.name, jobId: ctx.jobId, attempt: ctx.attempt });
}
