// Prometheus metrics (BP §16 Monitoring, §17 Observability). A small dependency-free registry
// (counters, gauges, histograms with labels) rendered in the Prometheus text exposition format 0.0.4
// by GET /metrics (shared/httpMetrics.ts, bearer METRICS_TOKEN). Every sample carries the label
// process="api" | "worker".
//
// The application metrics (`appMetrics`):
//   wimb_http_requests_total{method,route,status}        HTTP requests (route = the Express pattern)
//   wimb_http_request_duration_seconds{method,route}     HTTP latency histogram
//   wimb_socket_connections                              open Socket.IO connections (/rt)
//   wimb_socket_connections_total                        Socket.IO connections accepted
//   wimb_job_runs_total{job,outcome}                     job executions (success | failure, per attempt)
//   wimb_job_duration_seconds{job}                       job duration histogram
//   wimb_ingest_points_total                             location points accepted by the ingest API
//   wimb_sms_sends_total{kind,outcome}                   SMS: sent | simulated | failed (otp | text)
//   process_* / nodejs_*                                 uptime, memory, event-loop lag of the process
//
// The worker process has no HTTP server: it publishes a snapshot of its registry to the KV store
// (Redis in production) every WORKER_SNAPSHOT_INTERVAL_MS; the API merges a fresh snapshot into its
// own /metrics output (samples labelled process="worker"). Label values are bounded by design
// (route patterns, job names, fixed outcome sets) — never ids, phone numbers or school names.
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { JobContext, JobDef, SchoolCronPayload } from '../jobs/types.js';
import type { KvStore } from './kv.js';
import type { SmsChannel, SmsResult } from './notifications/sms.js';

export type Labels = Readonly<Record<string, string>>;
type MetricType = 'counter' | 'gauge' | 'histogram';

export interface MetricSample {
  /** Full sample name (histograms: _bucket / _sum / _count). */
  name: string;
  labels: Labels;
  value: number;
}

export interface MetricFamilySnapshot {
  name: string;
  help: string;
  type: MetricType;
  samples: MetricSample[];
}

const NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
export const DEFAULT_LATENCY_BUCKETS = Object.freeze([0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]);
export const JOB_DURATION_BUCKETS = Object.freeze([0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 300]);

function labelKey(names: readonly string[], labels: Labels): string {
  return names.map((n) => labels[n] ?? '').join('\u0000');
}

function checkLabels(metric: string, names: readonly string[], labels: Labels): void {
  for (const k of Object.keys(labels)) if (!names.includes(k)) throw new TypeError(`Metric ${metric}: unknown label "${k}"`);
}

/** Escapes a label value for the text format (backslash, double quote, newline). */
export function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function formatValue(v: number): string {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Infinity) return '+Inf';
  if (v === -Infinity) return '-Inf';
  return String(v);
}

function formatLabels(labels: Labels): string {
  const entries = Object.entries(labels);
  if (!entries.length) return '';
  return `{${entries.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(',')}}`;
}

interface Metric {
  readonly name: string;
  readonly help: string;
  readonly type: MetricType;
  collect(): MetricSample[];
  reset(): void;
}

export class Counter implements Metric {
  readonly type = 'counter' as const;
  private readonly values = new Map<string, { labels: Labels; value: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[] = [],
  ) {}
  inc(labels: Labels = {}, by = 1): void {
    if (!(by >= 0) || !Number.isFinite(by)) throw new RangeError(`Counter ${this.name}: increment must be a finite number >= 0`);
    checkLabels(this.name, this.labelNames, labels);
    const k = labelKey(this.labelNames, labels);
    const cur = this.values.get(k);
    if (cur) cur.value += by;
    else this.values.set(k, { labels: { ...labels }, value: by });
  }
  get(labels: Labels = {}): number {
    return this.values.get(labelKey(this.labelNames, labels))?.value ?? 0;
  }
  collect(): MetricSample[] {
    return [...this.values.values()].map((v) => ({ name: this.name, labels: v.labels, value: v.value }));
  }
  reset(): void {
    this.values.clear();
  }
}

export class Gauge implements Metric {
  readonly type = 'gauge' as const;
  private readonly values = new Map<string, { labels: Labels; value: number }>();
  private collector: (() => number | Array<{ labels: Labels; value: number }>) | null = null;
  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[] = [],
  ) {}
  set(labels: Labels, value: number): void {
    checkLabels(this.name, this.labelNames, labels);
    this.values.set(labelKey(this.labelNames, labels), { labels: { ...labels }, value });
  }
  /** Value computed at scrape time (replaces set() values). */
  collectWith(fn: (() => number | Array<{ labels: Labels; value: number }>) | null): void {
    this.collector = fn;
  }
  collect(): MetricSample[] {
    if (this.collector) {
      let v: number | Array<{ labels: Labels; value: number }>;
      try {
        v = this.collector();
      } catch {
        return [];
      }
      return typeof v === 'number' ? [{ name: this.name, labels: {}, value: v }] : v.map((s) => ({ name: this.name, labels: s.labels, value: s.value }));
    }
    return [...this.values.values()].map((v) => ({ name: this.name, labels: v.labels, value: v.value }));
  }
  reset(): void {
    this.values.clear();
  }
}

export class Histogram implements Metric {
  readonly type = 'histogram' as const;
  private readonly series = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>();
  readonly buckets: readonly number[];
  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[] = [],
    buckets: readonly number[] = DEFAULT_LATENCY_BUCKETS,
  ) {
    this.buckets = [...buckets].sort((a, b) => a - b);
    if (labelNames.includes('le')) throw new TypeError(`Histogram ${name}: "le" is a reserved label`);
  }
  observe(labels: Labels, value: number): void {
    if (!Number.isFinite(value)) return;
    checkLabels(this.name, this.labelNames, labels);
    const k = labelKey(this.labelNames, labels);
    let s = this.series.get(k);
    if (!s) {
      s = { labels: { ...labels }, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(k, s);
    }
    for (let i = 0; i < this.buckets.length; i += 1) if (value <= this.buckets[i]!) s.counts[i]! += 1;
    s.sum += value;
    s.count += 1;
  }
  /** Starts a timer; the returned function observes the elapsed seconds. */
  startTimer(labels: Labels = {}): (extra?: Labels) => number {
    const start = process.hrtime.bigint();
    return (extra = {}) => {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      this.observe({ ...labels, ...extra }, seconds);
      return seconds;
    };
  }
  count(labels: Labels = {}): number {
    return this.series.get(labelKey(this.labelNames, labels))?.count ?? 0;
  }
  collect(): MetricSample[] {
    const out: MetricSample[] = [];
    for (const s of this.series.values()) {
      this.buckets.forEach((b, i) => out.push({ name: `${this.name}_bucket`, labels: { ...s.labels, le: formatValue(b) }, value: s.counts[i]! }));
      out.push({ name: `${this.name}_bucket`, labels: { ...s.labels, le: '+Inf' }, value: s.count });
      out.push({ name: `${this.name}_sum`, labels: s.labels, value: s.sum });
      out.push({ name: `${this.name}_count`, labels: s.labels, value: s.count });
    }
    return out;
  }
  reset(): void {
    this.series.clear();
  }
}

export class MetricsRegistry {
  private readonly metrics = new Map<string, Metric>();
  constructor(readonly defaultLabels: Labels = {}) {
    for (const k of Object.keys(defaultLabels)) if (!LABEL_RE.test(k)) throw new TypeError(`Invalid label name ${k}`);
  }
  private add<M extends Metric>(m: M): M {
    if (!NAME_RE.test(m.name)) throw new TypeError(`Invalid metric name ${m.name}`);
    if (this.metrics.has(m.name)) throw new TypeError(`Duplicate metric ${m.name}`);
    this.metrics.set(m.name, m);
    return m;
  }
  counter(name: string, help: string, labelNames: readonly string[] = []): Counter {
    return this.add(new Counter(name, help, labelNames));
  }
  gauge(name: string, help: string, labelNames: readonly string[] = []): Gauge {
    return this.add(new Gauge(name, help, labelNames));
  }
  histogram(name: string, help: string, labelNames: readonly string[] = [], buckets?: readonly number[]): Histogram {
    return this.add(new Histogram(name, help, labelNames, buckets));
  }
  /** Every family with its current samples (default labels applied). */
  snapshot(): MetricFamilySnapshot[] {
    return [...this.metrics.values()].map((m) => ({
      name: m.name,
      help: m.help,
      type: m.type,
      samples: m.collect().map((s) => ({ ...s, labels: { ...this.defaultLabels, ...s.labels } })),
    }));
  }
  /** Text exposition of this registry plus `extra` snapshots (e.g. the worker's), merged per family. */
  render(extra: readonly MetricFamilySnapshot[] = []): string {
    return renderFamilies(mergeFamilies([this.snapshot(), extra]));
  }
  resetAll(): void {
    for (const m of this.metrics.values()) m.reset();
  }
}

/** Merges family lists by name (the first definition's help/type wins; a type clash drops the later family). */
export function mergeFamilies(lists: readonly (readonly MetricFamilySnapshot[])[]): MetricFamilySnapshot[] {
  const byName = new Map<string, MetricFamilySnapshot>();
  for (const list of lists) {
    for (const f of list) {
      const cur = byName.get(f.name);
      if (!cur) byName.set(f.name, { ...f, samples: [...f.samples] });
      else if (cur.type === f.type) cur.samples.push(...f.samples);
    }
  }
  return [...byName.values()];
}

export function renderFamilies(families: readonly MetricFamilySnapshot[]): string {
  const lines: string[] = [];
  for (const f of families) {
    lines.push(`# HELP ${f.name} ${f.help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}`);
    lines.push(`# TYPE ${f.name} ${f.type}`);
    for (const s of f.samples) lines.push(`${s.name}${formatLabels(s.labels)} ${formatValue(s.value)}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Validates a snapshot read back from the KV store (untrusted shape) → families or []. */
export function parseSnapshot(raw: string | null): { at: number; families: MetricFamilySnapshot[] } | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { at?: unknown; families?: unknown };
    if (typeof v.at !== 'number' || !Array.isArray(v.families)) return null;
    const families: MetricFamilySnapshot[] = [];
    for (const f of v.families as Record<string, unknown>[]) {
      if (typeof f?.name !== 'string' || !NAME_RE.test(f.name) || typeof f.help !== 'string' || !['counter', 'gauge', 'histogram'].includes(String(f.type)) || !Array.isArray(f.samples)) continue;
      const samples: MetricSample[] = [];
      for (const s of f.samples as Record<string, unknown>[]) {
        if (typeof s?.name !== 'string' || !NAME_RE.test(s.name) || typeof s.value !== 'number' || typeof s.labels !== 'object' || s.labels === null) continue;
        const labels = Object.fromEntries(Object.entries(s.labels as Record<string, unknown>).filter(([k, lv]) => LABEL_RE.test(k) && typeof lv === 'string')) as Labels;
        samples.push({ name: s.name, labels, value: s.value });
      }
      families.push({ name: f.name, help: f.help, type: f.type as MetricType, samples });
    }
    return { at: v.at, families };
  } catch {
    return null;
  }
}

// ── application metrics ───────────────────────────────────────────────────────
export function createAppMetrics(process_: 'api' | 'worker' = 'api') {
  const registry = new MetricsRegistry({ process: process_ });
  const m = {
    registry,
    httpRequests: registry.counter('wimb_http_requests_total', 'HTTP requests by method, route pattern and status code', ['method', 'route', 'status']),
    httpDuration: registry.histogram('wimb_http_request_duration_seconds', 'HTTP request latency in seconds by method and route pattern', ['method', 'route']),
    socketConnections: registry.gauge('wimb_socket_connections', 'Open Socket.IO connections (/rt namespace)'),
    socketConnectionsTotal: registry.counter('wimb_socket_connections_total', 'Socket.IO connections accepted (/rt namespace)'),
    jobRuns: registry.counter('wimb_job_runs_total', 'Job executions by job and outcome (success | failure; one per attempt)', ['job', 'outcome']),
    jobDuration: registry.histogram('wimb_job_duration_seconds', 'Job execution time in seconds', ['job'], JOB_DURATION_BUCKETS),
    ingestPoints: registry.counter('wimb_ingest_points_total', 'Location points accepted by the driver ingest API'),
    smsSends: registry.counter('wimb_sms_sends_total', 'SMS by kind (otp | text) and outcome (sent | simulated | failed)', ['kind', 'outcome']),
    uptime: registry.gauge('process_uptime_seconds', 'Seconds since the process started'),
    residentMemory: registry.gauge('process_resident_memory_bytes', 'Resident memory size in bytes'),
    heapUsed: registry.gauge('nodejs_heap_used_bytes', 'V8 heap used in bytes'),
    eventLoopLag: registry.gauge('nodejs_eventloop_lag_p99_seconds', 'Event-loop delay (99th percentile since the last scrape) in seconds'),
  };
  m.uptime.collectWith(() => Math.round(process.uptime()));
  m.residentMemory.collectWith(() => process.memoryUsage.rss());
  m.heapUsed.collectWith(() => process.memoryUsage().heapUsed);
  let loop: ReturnType<typeof monitorEventLoopDelay> | null = null;
  m.eventLoopLag.collectWith(() => {
    if (!loop) {
      loop = monitorEventLoopDelay({ resolution: 20 });
      loop.enable();
      return 0;
    }
    const v = loop.percentile(99) / 1e9;
    loop.reset();
    return Number.isFinite(v) ? v : 0;
  });
  return m;
}

export type AppMetrics = ReturnType<typeof createAppMetrics>;

/** Process-wide metrics (process="api" unless setMetricsProcess('worker') runs first — src/worker.ts). */
let current: AppMetrics = createAppMetrics('api');
export function appMetrics(): AppMetrics {
  return current;
}
/** Marks this process as the worker (call once at startup, before any job runs). */
export function setMetricsProcess(p: 'api' | 'worker'): AppMetrics {
  if (current.registry.defaultLabels.process !== p) current = createAppMetrics(p);
  return current;
}

// ── instrumentation helpers ───────────────────────────────────────────────────
export type JobFailureReporter = (err: unknown, ctx: JobContext) => void;

/**
 * Wraps a job definition: counts runs/failures and observes the duration; a failure is also handed to
 * `onFailure` (Sentry) and rethrown unchanged, so the runner's retry/backoff logic is not affected.
 */
export function instrumentJob<D extends JobDef>(def: D, { metrics = appMetrics, onFailure }: { metrics?: () => AppMetrics; onFailure?: JobFailureReporter } = {}): D {
  const run = async <T>(ctx: JobContext, fn: () => Promise<T>): Promise<T> => {
    const m = metrics();
    const stop = m.jobDuration.startTimer({ job: def.name });
    try {
      const r = await fn();
      m.jobRuns.inc({ job: def.name, outcome: 'success' });
      return r;
    } catch (err) {
      m.jobRuns.inc({ job: def.name, outcome: 'failure' });
      try {
        onFailure?.(err, ctx);
      } catch {
        // reporting never changes the job outcome
      }
      throw err;
    } finally {
      stop();
    }
  };
  const d: JobDef = def;
  let wrapped: JobDef;
  if (d.kind === 'cron') wrapped = { ...d, handler: (ctx: JobContext) => run(ctx, () => d.handler(ctx)) };
  else if (d.kind === 'school-cron') wrapped = { ...d, handler: (p: SchoolCronPayload, ctx: JobContext) => run(ctx, () => d.handler(p, ctx)) };
  else wrapped = { ...d, handler: (p: never, ctx: JobContext) => run(ctx, () => d.handler(p, ctx)) };
  return wrapped as D;
}

function smsOutcome(r: SmsResult): 'sent' | 'simulated' | 'failed' {
  if (!r.delivered) return 'failed';
  return r.simulated ? 'simulated' : 'sent';
}

/** Wraps an SMS channel so every send is counted (outcome only — never the number or the text). */
export function instrumentSms(channel: SmsChannel, metrics: () => AppMetrics = appMetrics): SmsChannel {
  const count = async (kind: 'otp' | 'text', fn: () => Promise<SmsResult>): Promise<SmsResult> => {
    try {
      const r = await fn();
      metrics().smsSends.inc({ kind, outcome: smsOutcome(r) });
      return r;
    } catch (err) {
      metrics().smsSends.inc({ kind, outcome: 'failed' });
      throw err;
    }
  };
  return {
    ...channel,
    sendOtp: (to, otp) => count('otp', () => channel.sendOtp(to, otp)),
    sendText: (to, text, opts) => count('text', () => channel.sendText(to, text, opts)),
  };
}

/** Minimal shape of a Socket.IO namespace (so tests can pass a stub). */
export interface NamespaceLike {
  sockets: { size: number };
  on(event: 'connection', fn: (socket: unknown) => void): unknown;
}

/** Socket metrics for a namespace: connections accepted + open connections at scrape time. */
export function instrumentSocketNamespace(nsp: NamespaceLike, metrics: () => AppMetrics = appMetrics): void {
  nsp.on('connection', () => metrics().socketConnectionsTotal.inc());
  metrics().socketConnections.collectWith(() => nsp.sockets.size);
}

// ── worker snapshot (cross-process) ───────────────────────────────────────────
export const WORKER_SNAPSHOT_KEY = 'metrics:worker';
export const WORKER_SNAPSHOT_INTERVAL_MS = 15_000;
/** A snapshot older than this is ignored by the API (worker stopped or unreachable). */
export const WORKER_SNAPSHOT_MAX_AGE_MS = 90_000;

/** Publishes the worker registry to the KV store now and every intervalMs → stop function. */
export function startSnapshotPublisher(kv: KvStore, { metrics = appMetrics, intervalMs = WORKER_SNAPSHOT_INTERVAL_MS, onError }: { metrics?: () => AppMetrics; intervalMs?: number; onError?: (err: unknown) => void } = {}): () => Promise<void> {
  const publish = async () => {
    try {
      await kv.set(WORKER_SNAPSHOT_KEY, JSON.stringify({ at: Date.now(), families: metrics().registry.snapshot() }), Math.ceil(WORKER_SNAPSHOT_MAX_AGE_MS / 1000));
    } catch (err) {
      onError?.(err);
    }
  };
  void publish();
  const timer = setInterval(() => void publish(), intervalMs);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await kv.del(WORKER_SNAPSHOT_KEY).catch(() => undefined);
  };
}

/** The worker's last snapshot when it is fresh (else []); never throws. */
export async function readWorkerSnapshot(kv: KvStore, now = Date.now()): Promise<MetricFamilySnapshot[]> {
  try {
    const snap = parseSnapshot(await kv.get(WORKER_SNAPSHOT_KEY));
    if (!snap || now - snap.at > WORKER_SNAPSHOT_MAX_AGE_MS) return [];
    // Only worker-labelled samples are merged (an API snapshot written there by mistake is ignored).
    return snap.families.map((f) => ({ ...f, samples: f.samples.filter((s) => s.labels.process === 'worker') }));
  } catch {
    return [];
  }
}
