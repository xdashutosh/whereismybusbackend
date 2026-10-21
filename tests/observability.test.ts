// Observability (BP §16 Monitoring, §17): GET /metrics (Prometheus text format, bearer METRICS_TOKEN,
// HTTP / socket / job / ingest / SMS metrics, the worker's snapshot merged in) and optional Sentry
// reporting (disabled without SENTRY_DSN, secrets and personal data scrubbed, never crashes).
import { EventEmitter } from 'node:events';
import type { Envelope, Event, Transport } from '@sentry/core';
import { Router } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { buildConfig, redactedSummary, type ConfigError } from '../src/config/index.js';
import type { CronJobDef, JobContext, QueueJobDef, SchoolCronJobDef } from '../src/jobs/types.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { createRateLimits } from '../src/middleware/rateLimits.js';
import { modules as defaultModules } from '../src/modules/index.js';
import { AppError } from '../src/shared/errors.js';
import { routeLabel } from '../src/shared/httpMetrics.js';
import { createMemoryKv } from '../src/shared/kv.js';
import {
  appMetrics,
  createAppMetrics,
  instrumentJob,
  instrumentSms,
  instrumentSocketNamespace,
  MetricsRegistry,
  parseSnapshot,
  readWorkerSnapshot,
  startSnapshotPublisher,
  WORKER_SNAPSHOT_KEY,
  WORKER_SNAPSHOT_MAX_AGE_MS,
  type AppMetrics,
} from '../src/shared/metrics.js';
import type { SmsChannel } from '../src/shared/notifications/sms.js';
import { captureError, closeSentry, initSentry, isPiiKey, reportJobFailure, scrubEvent, scrubString, sentryEnabled } from '../src/shared/sentry.js';
import { closeDb, truncateAll } from './helpers/db.js';
import { buildApp, type TestApp } from './helpers/authApp.js';
import { drainJobs, northbound, postPoints, trackingWorld } from './helpers/trackingWorld.js';

const TOKEN = 'metrics-token-0123456789abcdef-xyz';

function probeApp(metrics: AppMetrics, { token = TOKEN, kv = createMemoryKv() }: { token?: string | null; kv?: ReturnType<typeof createMemoryKv> } = {}) {
  const r = Router();
  r.get('/probe/items/:id', (_req, res) => {
    res.json({ ok: true });
  });
  r.get('/probe/boom', () => {
    throw new Error('boom for +919845012345 with token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcdefghijk');
  });
  r.get('/probe/rejected', () => {
    throw new AppError('CONFLICT', 'Expected conflict');
  });
  const app = createApp({ modules: [{ name: 'probe', router: r }], rateLimits: createRateLimits({ enabled: false }), loadMinVersions: async () => ({}), metricsToken: token, metrics: () => metrics, metricsKv: kv });
  return { app, kv };
}

const scrape = (app: Parameters<typeof request>[0], token = TOKEN) => request(app).get('/metrics').set('Authorization', `Bearer ${token}`);

describe('metrics registry', () => {
  it('renders counters, gauges and cumulative histograms in the text format with escaped labels', () => {
    const reg = new MetricsRegistry({ process: 'api' });
    const c = reg.counter('demo_total', 'Demo counter', ['kind']);
    const g = reg.gauge('demo_gauge', 'Demo gauge');
    const h = reg.histogram('demo_seconds', 'Demo histogram', ['op'], [0.1, 1]);
    c.inc({ kind: 'a"b\\c\nd' });
    c.inc({ kind: 'x' }, 2);
    g.set({}, 7);
    h.observe({ op: 'read' }, 0.05);
    h.observe({ op: 'read' }, 0.5);
    h.observe({ op: 'read' }, 5);
    const text = reg.render();
    expect(text).toContain('# HELP demo_total Demo counter\n# TYPE demo_total counter\n');
    expect(text).toContain('demo_total{process="api",kind="a\\"b\\\\c\\nd"} 1');
    expect(text).toContain('demo_total{process="api",kind="x"} 2');
    expect(text).toContain('demo_gauge{process="api"} 7');
    expect(text).toContain('demo_seconds_bucket{process="api",op="read",le="0.1"} 1');
    expect(text).toContain('demo_seconds_bucket{process="api",op="read",le="1"} 2');
    expect(text).toContain('demo_seconds_bucket{process="api",op="read",le="+Inf"} 3');
    expect(text).toContain('demo_seconds_count{process="api",op="read"} 3');
    expect(text).toContain('demo_seconds_sum{process="api",op="read"} 5.55');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('refuses duplicate metrics, unknown labels, negative increments and invalid names', () => {
    const reg = new MetricsRegistry();
    const c = reg.counter('x_total', 'x', ['a']);
    expect(() => reg.counter('x_total', 'again')).toThrow(/Duplicate/);
    expect(() => c.inc({ b: '1' })).toThrow(/unknown label/);
    expect(() => c.inc({}, -1)).toThrow(RangeError);
    expect(() => reg.gauge('bad-name', 'x')).toThrow(/Invalid metric name/);
    expect(() => reg.histogram('h', 'x', ['le'])).toThrow(/reserved/);
  });

  it('parses only well-formed snapshots', () => {
    expect(parseSnapshot(null)).toBeNull();
    expect(parseSnapshot('not json')).toBeNull();
    expect(parseSnapshot(JSON.stringify({ families: [] }))).toBeNull();
    const parsed = parseSnapshot(
      JSON.stringify({
        at: 1,
        families: [
          { name: 'ok_total', help: 'h', type: 'counter', samples: [{ name: 'ok_total', labels: { process: 'worker', 'bad-label': 'x', n: 5 }, value: 3 }, { name: 'bad name', labels: {}, value: 1 }] },
          { name: 'bad name', help: 'h', type: 'counter', samples: [] },
          { name: 'weird', help: 'h', type: 'summary', samples: [] },
        ],
      }),
    );
    expect(parsed).toEqual({ at: 1, families: [{ name: 'ok_total', help: 'h', type: 'counter', samples: [{ name: 'ok_total', labels: { process: 'worker' }, value: 3 }] }] });
  });
});

describe('GET /metrics', () => {
  it('does not exist without METRICS_TOKEN (404) and requires the bearer token (401)', async () => {
    const off = probeApp(createAppMetrics(), { token: null }).app;
    expect((await request(off).get('/metrics')).status).toBe(404);
    const { app } = probeApp(createAppMetrics());
    const none = await request(app).get('/metrics');
    expect(none.status).toBe(401);
    expect(none.headers['www-authenticate']).toMatch(/^Bearer/);
    expect((await scrape(app, `${TOKEN}x`)).status).toBe(401);
    expect((await request(app).get('/metrics').set('Authorization', `Basic ${Buffer.from(`u:${TOKEN}`).toString('base64')}`)).status).toBe(401);
  });

  it('serves the Prometheus text format with HTTP counters by route pattern and latency histograms', async () => {
    const m = createAppMetrics();
    const { app } = probeApp(m);
    await request(app).get('/api/v1/probe/items/0f3c1b2a-1111-4222-8333-444455556666');
    await request(app).get('/api/v1/probe/items/another-id');
    await request(app).get('/api/v1/nothing/here');
    const res = await scrape(app);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toContain('wimb_http_requests_total{process="api",method="GET",route="/api/v1/probe/items/:id",status="200"} 2');
    expect(res.text).toContain('wimb_http_requests_total{process="api",method="GET",route="unmatched",status="404"} 1');
    expect(res.text).toContain('wimb_http_request_duration_seconds_count{process="api",method="GET",route="/api/v1/probe/items/:id"} 2');
    expect(res.text).not.toContain('0f3c1b2a-1111');
    for (const family of ['wimb_socket_connections', 'wimb_job_runs_total', 'wimb_ingest_points_total', 'wimb_sms_sends_total', 'process_resident_memory_bytes', 'nodejs_heap_used_bytes', 'process_uptime_seconds', 'nodejs_eventloop_lag_p99_seconds']) {
      expect(res.text).toContain(`# TYPE ${family} `);
    }
  });

  it('merges a fresh worker snapshot (process="worker") and ignores stale ones', async () => {
    const api = createAppMetrics('api');
    const worker = createAppMetrics('worker');
    worker.jobRuns.inc({ job: 'document-expiry-scan', outcome: 'success' }, 4);
    worker.jobRuns.inc({ job: 'document-expiry-scan', outcome: 'failure' });
    const { app, kv } = probeApp(api);
    const stop = startSnapshotPublisher(kv, { metrics: () => worker, intervalMs: 60_000 });
    await new Promise((r) => setTimeout(r, 5));
    const res = await scrape(app);
    expect(res.text).toContain('wimb_job_runs_total{process="worker",job="document-expiry-scan",outcome="success"} 4');
    expect(res.text).toContain('wimb_job_runs_total{process="worker",job="document-expiry-scan",outcome="failure"} 1');
    expect(res.text.match(/# TYPE wimb_job_runs_total counter/g)).toHaveLength(1);
    // Stale snapshot → ignored; an API-labelled snapshot is never merged.
    await kv.set(WORKER_SNAPSHOT_KEY, JSON.stringify({ at: Date.now() - WORKER_SNAPSHOT_MAX_AGE_MS - 1000, families: worker.registry.snapshot() }));
    expect(await readWorkerSnapshot(kv)).toEqual([]);
    await kv.set(WORKER_SNAPSHOT_KEY, JSON.stringify({ at: Date.now(), families: api.registry.snapshot() }));
    expect((await readWorkerSnapshot(kv)).every((f) => f.samples.length === 0)).toBe(true);
    await stop();
    expect(await kv.get(WORKER_SNAPSHOT_KEY)).toBeNull();
  });

  it('routeLabel never uses the raw URL', () => {
    expect(routeLabel({ originalUrl: '/api/v1/x/123', route: { path: '/x/:id' } } as never)).toBe('/api/v1/x/:id');
    expect(routeLabel({ originalUrl: '/healthz', route: { path: '/healthz' } } as never)).toBe('/healthz');
    expect(routeLabel({ originalUrl: '/api/v1/x/123' } as never)).toBe('unmatched');
  });
});

describe('instrumentation helpers', () => {
  it('instrumentJob counts successes and failures, observes durations and rethrows unchanged', async () => {
    const m = createAppMetrics('worker');
    const onFailure = vi.fn();
    const failure = new Error('job broke');
    const okDef: CronJobDef = { kind: 'cron', name: 'ok-job', cron: '* * * * *', handler: async () => undefined };
    const badDef: QueueJobDef<{ any: number }> = { kind: 'queue', name: 'bad-job', handler: async () => Promise.reject(failure) };
    const seen: unknown[] = [];
    const schoolDef: SchoolCronJobDef = { kind: 'school-cron', name: 'school-job', cron: '5 0 * * *', handler: async (p) => void seen.push(p) };
    const ok = instrumentJob(okDef, { metrics: () => m, onFailure });
    const bad = instrumentJob(badDef, { metrics: () => m, onFailure });
    const school = instrumentJob(schoolDef, { metrics: () => m });
    const ctx: JobContext = { name: 'x', jobId: 'j1', attempt: 2, logger: console as never, signal: new AbortController().signal };
    await ok.handler(ctx);
    await expect(bad.handler({ any: 1 }, ctx)).rejects.toBe(failure);
    await school.handler({ schoolId: 's', timezone: 'Asia/Kolkata', scheduledFor: 'now', localDate: '2026-10-19' }, ctx);
    expect(seen).toHaveLength(1);
    expect(m.jobRuns.get({ job: 'ok-job', outcome: 'success' })).toBe(1);
    expect(m.jobRuns.get({ job: 'bad-job', outcome: 'failure' })).toBe(1);
    expect(m.jobRuns.get({ job: 'school-job', outcome: 'success' })).toBe(1);
    expect(m.jobDuration.count({ job: 'bad-job' })).toBe(1);
    expect(onFailure).toHaveBeenCalledWith(failure, ctx);
    // A throwing reporter never changes the job outcome.
    const loudDef: CronJobDef = { kind: 'cron', name: 'loud', cron: '* * * * *', handler: async () => Promise.reject(failure) };
    const loud = instrumentJob(loudDef, { metrics: () => m, onFailure: () => { throw new Error('reporter down'); } });
    await expect(loud.handler(ctx)).rejects.toBe(failure);
  });

  it('instrumentSms counts sent / simulated / failed per kind, never the number or text', async () => {
    const m = createAppMetrics();
    const base: SmsChannel = {
      provider: 'console',
      sendsRealSms: () => false,
      sendOtp: vi.fn().mockResolvedValueOnce({ delivered: true, provider: 'webpayservices' }).mockResolvedValueOnce({ delivered: true, provider: 'console', simulated: true }).mockRejectedValueOnce(new Error('net')),
      sendText: vi.fn().mockResolvedValue({ delivered: false, provider: 'webpayservices', error: 'HTTP_ERROR' }),
      checkBalance: vi.fn(),
    } as unknown as SmsChannel;
    const sms = instrumentSms(base, () => m);
    await sms.sendOtp('+919845012345', '123456');
    await sms.sendOtp('+919845012345', '123456');
    await expect(sms.sendOtp('+919845012345', '123456')).rejects.toThrow('net');
    await sms.sendText('+919845012345', 'hello', { templateId: '1' });
    expect(m.smsSends.get({ kind: 'otp', outcome: 'sent' })).toBe(1);
    expect(m.smsSends.get({ kind: 'otp', outcome: 'simulated' })).toBe(1);
    expect(m.smsSends.get({ kind: 'otp', outcome: 'failed' })).toBe(1);
    expect(m.smsSends.get({ kind: 'text', outcome: 'failed' })).toBe(1);
    expect(m.registry.render()).not.toContain('9845012345');
    expect(sms.provider).toBe('console');
  });

  it('instrumentSocketNamespace counts connections and reports open sockets at scrape time', () => {
    const m = createAppMetrics();
    const nsp = Object.assign(new EventEmitter(), { sockets: new Map<string, unknown>() });
    instrumentSocketNamespace(nsp, () => m);
    nsp.sockets.set('a', {});
    nsp.emit('connection', {});
    nsp.sockets.set('b', {});
    nsp.emit('connection', {});
    nsp.sockets.delete('a');
    expect(m.socketConnectionsTotal.get()).toBe(2);
    expect(m.registry.render()).toContain('wimb_socket_connections{process="api"} 1');
  });
});

describe('ingest points metric (driver location API)', () => {
  let t: TestApp;
  beforeAll(async () => {
    await truncateAll({ keep: ['platform_settings'] });
    t = buildApp();
  });
  afterAll(closeDb);

  it('counts accepted location points and labels the ingest route by its pattern', async () => {
    const w = await trackingWorld(t.app);
    const before = appMetrics().ingestPoints.get();
    const res = await postPoints(t.app, w, northbound({ baseMs: Date.now() - 60_000, count: 3 }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await drainJobs();
    expect(appMetrics().ingestPoints.get() - before).toBe(res.body.data.accepted);
    expect(res.body.data.accepted).toBeGreaterThan(0);
    const scraped = await request(createApp({ modules: defaultModules, metricsToken: TOKEN, rateLimits: createRateLimits({ enabled: false }) })).get('/metrics').set('Authorization', `Bearer ${TOKEN}`);
    expect(scraped.text).toMatch(/wimb_http_requests_total\{process="api",method="POST",route="\/api\/v1\/driver\/trips\/:\w+\/locations",status="200"\} \d+/);
    expect(scraped.text).toMatch(/wimb_ingest_points_total\{process="api"\} \d+/);
  });
});

describe('observability configuration', () => {
  const base = { NODE_ENV: 'development', DATABASE_URL: 'postgresql://owner:pw@localhost:5432/wimb', STORAGE_DRIVER: 'local' };
  const issuesOf = (env: Record<string, string>) => {
    try {
      buildConfig(env);
      return [];
    } catch (err) {
      return (err as ConfigError).issues;
    }
  };

  it('validates METRICS_TOKEN and the Sentry keys without echoing them', () => {
    expect(issuesOf({ ...base, METRICS_TOKEN: 'short' }).join()).toMatch(/METRICS_TOKEN must be at least 24/);
    expect(issuesOf({ ...base, METRICS_TOKEN: 'has spaces in it but is long enough' }).join()).toMatch(/METRICS_TOKEN/);
    const bad = issuesOf({ ...base, SENTRY_DSN: 'https://sentry.example.com/no-key' });
    expect(bad.join()).toMatch(/SENTRY_DSN must be a Sentry DSN/);
    expect(bad.join()).not.toContain('sentry.example.com/no-key');
    expect(issuesOf({ ...base, SENTRY_DSN: 'not a url' }).join()).toMatch(/SENTRY_DSN/);
    expect(issuesOf({ ...base, SENTRY_ENVIRONMENT: 'bad env!' }).join()).toMatch(/SENTRY_ENVIRONMENT/);
    expect(issuesOf({ ...base, SENTRY_RELEASE: 'a/b' }).join()).toMatch(/SENTRY_RELEASE/);
  });

  it('enables Sentry only with a DSN (never under NODE_ENV=test) and redacts token and DSN', () => {
    const off = buildConfig(base);
    expect(off.observability).toEqual({ metricsToken: null, sentry: null });
    const dsn = 'https://abc123def456@o4500000.ingest.sentry.io/4500001';
    const on = buildConfig({ ...base, SENTRY_DSN: dsn, SENTRY_RELEASE: 'api@2.0.0', METRICS_TOKEN: TOKEN });
    expect(on.observability).toEqual({ metricsToken: TOKEN, sentry: { dsn, environment: 'development', release: 'api@2.0.0' } });
    const summary = JSON.stringify(redactedSummary(on));
    expect(summary).not.toContain(TOKEN);
    expect(summary).not.toContain('abc123def456');
    expect(redactedSummary(on)).toMatchObject({ metricsEnabled: true, sentry: { enabled: true, environment: 'development', release: 'api@2.0.0' } });
    expect(buildConfig({ ...base, NODE_ENV: 'test', TEST_DATABASE_URL: 'postgresql://o@localhost/wimb_test', SENTRY_DSN: dsn }).observability.sentry).toBeNull();
    expect(buildConfig({ ...base, SENTRY_DSN: dsn, SENTRY_ENVIRONMENT: 'staging' }).observability.sentry?.environment).toBe('staging');
  });
});

describe('Sentry scrubbing', () => {
  it('scrubs secrets and personal data from strings', () => {
    const s = scrubString('user +919845012345 / 9845012345 mail a.b@example.com ip 203.0.113.9 Bearer abcdefgh12345678 jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcdefghijk tok ' + 'x'.repeat(48));
    expect(s).not.toMatch(/9845012345|a\.b@example\.com|203\.0\.113\.9|abcdefgh12345678|eyJhbGci|xxxxxxxx/);
    expect(s).toContain('[PHONE]');
    expect(s).toContain('[EMAIL]');
    expect(s).toContain('[IP]');
    expect(s).toContain('Bearer [REDACTED]');
    expect(s).toContain('[JWT]');
    // UUIDs (request/entity ids) stay readable.
    expect(scrubString('trip 0f3c1b2a-1111-4222-8333-444455556666')).toContain('0f3c1b2a-1111-4222-8333-444455556666');
  });

  it('classifies personal-data keys', () => {
    for (const k of ['phone', 'alternatePhone', 'email', 'fullName', 'display_name', 'address', 'ip_address', 'lat', 'location']) expect(isPiiKey(k), k).toBe(true);
    for (const k of ['name', 'route', 'job', 'code', 'tripId', 'status']) expect(isPiiKey(k), k).toBe(false);
  });

  it('drops bodies, cookies, query strings, unsafe headers and the user IP from events', () => {
    const event: Event = {
      message: 'failed for a.b@example.com',
      request: { method: 'POST', url: 'https://api.example.com/api/v1/auth/refresh?refreshToken=abc', data: { password: 'x' }, cookies: { wimb_rt: 'secret' }, query_string: 'refreshToken=abc', headers: { Authorization: 'Bearer abc', Cookie: 'wimb_rt=s', 'X-Device-Id': 'dev-1', 'User-Agent': 'ParentApp/1.0', 'X-Request-Id': 'req-1' } },
      user: { id: 'u1', ip_address: '203.0.113.9', email: 'a@b.c', role: 'parent' },
      extra: { body: { phone: '+919845012345', otp: '123456', note: 'call 9845012345', nested: { refreshToken: 'abc' } } },
      breadcrumbs: [{ message: 'otp sent to +919845012345', data: { email: 'x@y.z' } }],
      exception: { values: [{ type: 'Error', value: 'duplicate key (phone)=(+919845012345)', stacktrace: { frames: [{ filename: 'a.js', vars: { password: 'p' } }] } }] },
    };
    const out = scrubEvent(event);
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/9845012345|a\.b@example\.com|secret|Bearer abc|wimb_rt|refreshToken=abc|123456|dev-1|203\.0\.113\.9|"vars"/);
    expect(out.request).toEqual({ method: 'POST', url: 'https://api.example.com/api/v1/auth/refresh', headers: { 'User-Agent': 'ParentApp/1.0', 'X-Request-Id': 'req-1' } });
    expect(out.user).toEqual({ id: 'u1', role: 'parent' });
    expect((out.extra as { body: Record<string, unknown> }).body).toMatchObject({ phone: '[REDACTED]', otp: '[REDACTED]', nested: { refreshToken: '[REDACTED]' } });
  });
});

describe('Sentry reporting', () => {
  const captured: Event[] = [];
  const transport = (): Transport => ({
    send(envelope: Envelope) {
      for (const [header, payload] of envelope[1] as unknown as [{ type: string }, Event][]) if (header.type === 'event') captured.push(payload);
      return Promise.resolve({ statusCode: 200 });
    },
    flush: () => Promise.resolve(true),
  });
  const sentry = { dsn: 'https://publickey@o1.ingest.sentry.io/1', environment: 'test', release: 'wimb@test' };

  afterEach(async () => {
    await closeSentry();
    captured.length = 0;
  });

  it('is a no-op without a DSN', async () => {
    expect(initSentry({ role: 'api', sentry: null, transport })).toBe(false);
    expect(sentryEnabled()).toBe(false);
    expect(captureError(new Error('nothing'))).toBeNull();
    reportJobFailure(new Error('x'), { name: 'job', jobId: '1', attempt: 1 });
    expect(captured).toHaveLength(0);
  });

  it('reports unexpected 5xx errors of the API scrubbed, with route and request context — never 4xx', async () => {
    expect(initSentry({ role: 'api', sentry, transport })).toBe(true);
    const { app } = probeApp(createAppMetrics());
    const boom = await request(app).get('/api/v1/probe/boom').set('Authorization', 'Bearer secret-token-123456').set('X-Request-Id', 'req-boom-1');
    expect(boom.status).toBe(500);
    expect((await request(app).get('/api/v1/probe/rejected')).status).toBe(409);
    await new Promise((r) => setTimeout(r, 20));
    expect(captured).toHaveLength(1);
    const ev = captured[0]!;
    expect(ev.tags).toMatchObject({ source: 'http', method: 'GET', route: '/api/v1/probe/boom', status: '500', code: 'INTERNAL_ERROR', role: 'api' });
    expect(ev.contexts?.wimb).toMatchObject({ requestId: 'req-boom-1' });
    expect(ev.environment).toBe('test');
    expect(ev.release).toBe('wimb@test');
    const text = JSON.stringify(ev);
    expect(text).not.toMatch(/9845012345|eyJhbGci|secret-token-123456/);
    expect(ev.exception?.values?.[0]?.value).toContain('[PHONE]');
  });

  it('reports job failures with the job name and attempt', async () => {
    initSentry({ role: 'worker', sentry, transport });
    reportJobFailure(new Error('scan failed'), { name: 'document-expiry-scan', jobId: 'j-7', attempt: 3 });
    await new Promise((r) => setTimeout(r, 20));
    expect(captured).toHaveLength(1);
    expect(captured[0]!.tags).toMatchObject({ source: 'job', job: 'document-expiry-scan', role: 'worker' });
    expect(captured[0]!.contexts?.wimb).toMatchObject({ jobId: 'j-7', attempt: 3 });
  });

  it('errorHandler reports only unexpected failures (injectable reporter)', () => {
    const report = vi.fn();
    const handler = errorHandler({ report });
    const res = () => {
      const r = { headersSent: false, statusCode: 200, set: vi.fn(), status(code: number) { r.statusCode = code; return r; }, json: vi.fn(), setHeader: vi.fn() };
      return r as never;
    };
    const req = { id: 'r1', method: 'GET', originalUrl: '/api/v1/x', log: undefined } as never;
    handler(new Error('db exploded'), req, res(), () => undefined);
    handler(new AppError('NOT_FOUND'), req, res(), () => undefined);
    handler(new AppError('SERVICE_UNAVAILABLE', 'planned'), req, res(), () => undefined);
    handler(Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' }), req, res(), () => undefined);
    expect(report).toHaveBeenCalledTimes(2);
    expect(report.mock.calls[0]![1]).toMatchObject({ source: 'http', requestId: 'r1', status: 500, code: 'INTERNAL_ERROR' });
  });
});
