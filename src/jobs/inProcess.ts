// In-process job backend (no Redis: local dev, tests, single-instance deployments).
// - cron / school-cron dispatcher: croner timers (protect: no overlapping runs of one job)
// - queue jobs: per-job async queue with concurrency, retries with exponential backoff and jobId
//   deduplication (an id is ignored while a job with that id is queued, running or finished
//   within DEDUPE_TTL_MS — mirroring BullMQ's custom job ids)
// Enqueued jobs always run in this process, even when schedules are not started.
import crypto from 'node:crypto';
import { Cron } from 'croner';
import { logger as rootLogger, type Logger } from '../shared/logger.js';
import { createSchoolCronDispatcher, type SchoolTimezoneLoader } from './schoolCron.js';
import type { EnqueueOptions, JobContext, JobDef, JobRunner, QueueJobDef, SchoolCronJobDef } from './types.js';

const DEDUPE_TTL_MS = 24 * 3600 * 1000;

interface QueuedItem {
  id: string;
  payload: unknown;
  attempt: number;
  /** Cron items: when the schedule fired (ISO). */
  scheduledAt?: string;
}

interface JobState {
  def: JobDef;
  queue: QueuedItem[];
  running: number;
  runs: number;
  failures: number;
}

export function createInProcessRunner(
  defs: readonly JobDef[],
  { logger = rootLogger.child({ module: 'jobs' }), loadSchools }: { logger?: Logger; loadSchools?: SchoolTimezoneLoader } = {},
): JobRunner {
  const states = new Map<string, JobState>();
  const schoolDefs = defs.filter((d): d is SchoolCronJobDef => d.kind === 'school-cron');
  const allDefs: JobDef[] = [...defs];
  let started = false;
  let stopping = false;
  let controller = new AbortController();
  const crons: Cron[] = [];
  const timers = new Set<NodeJS.Timeout>();
  const seenIds = new Map<string, number>();
  const idle = new Set<() => void>();

  const runner: JobRunner = {
    backend: 'in-process',
    enqueue,
    start,
    stop,
    drain,
    stats: () => ({
      backend: 'in-process',
      started,
      jobs: [...states.values()].map((s) => ({ name: s.def.name, kind: s.def.kind, runs: s.runs, failures: s.failures, running: s.running, queued: s.queue.length })),
    }),
  };

  if (schoolDefs.length) allDefs.push(createSchoolCronDispatcher({ defs: schoolDefs, loadSchools, enqueue }));
  for (const def of allDefs) states.set(def.name, { def, queue: [], running: 0, runs: 0, failures: 0 });

  function isIdle(): boolean {
    for (const s of states.values()) if (s.running > 0 || s.queue.length > 0) return false;
    return timers.size === 0;
  }
  function notifyIdle(): void {
    if (!isIdle()) return;
    for (const fn of [...idle]) fn();
    idle.clear();
  }

  function concurrencyOf(def: JobDef): number {
    return def.kind === 'queue' ? Math.max(1, def.concurrency ?? 1) : 1;
  }
  function attemptsOf(def: JobDef): number {
    if (def.kind === 'queue') return Math.max(1, def.attempts ?? 3);
    if (def.kind === 'school-cron') return Math.max(1, def.attempts ?? 2);
    return 1;
  }

  async function execute(state: JobState, item: QueuedItem): Promise<void> {
    const def = state.def;
    const ctx: JobContext = { name: def.name, jobId: item.id, attempt: item.attempt, logger: logger.child({ job: def.name, jobId: item.id }), signal: controller.signal, scheduledAt: item.scheduledAt };
    if (def.kind === 'cron') await def.handler(ctx);
    else if (def.kind === 'school-cron') await def.handler(item.payload as Parameters<SchoolCronJobDef['handler']>[0], ctx);
    else await (def as QueueJobDef<unknown>).handler(item.payload, ctx);
  }

  function pump(state: JobState): void {
    while (!stopping && state.running < concurrencyOf(state.def) && state.queue.length) {
      const item = state.queue.shift()!;
      state.running += 1;
      void (async () => {
        try {
          await execute(state, item);
          state.runs += 1;
        } catch (err) {
          state.failures += 1;
          const max = attemptsOf(state.def);
          if (item.attempt < max && !stopping) {
            const base = state.def.kind === 'queue' ? (state.def.backoffMs ?? 2000) : 2000;
            const delay = base * 2 ** (item.attempt - 1);
            logger.warn({ job: state.def.name, jobId: item.id, attempt: item.attempt, err }, `Job failed; retrying in ${delay} ms`);
            schedule(() => {
              state.queue.push({ ...item, attempt: item.attempt + 1 });
              pump(state);
            }, delay);
          } else {
            logger.error({ job: state.def.name, jobId: item.id, attempt: item.attempt, err }, 'Job failed');
          }
        } finally {
          state.running -= 1;
          pump(state);
          notifyIdle();
        }
      })();
    }
  }

  function schedule(fn: () => void, delayMs: number): void {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
      notifyIdle();
    }, delayMs);
    t.unref();
    timers.add(t);
  }

  async function enqueue(name: string, payload: unknown, opts: EnqueueOptions = {}): Promise<void> {
    const state = states.get(name);
    if (!state || state.def.kind === 'cron') throw new TypeError(`Unknown queue job: ${name}`);
    if (stopping) throw new Error('Job runner is stopping');
    const now = Date.now();
    for (const [id, at] of seenIds) if (now - at > DEDUPE_TTL_MS) seenIds.delete(id);
    if (opts.jobId) {
      if (seenIds.has(`${name}|${opts.jobId}`)) return;
      seenIds.set(`${name}|${opts.jobId}`, now);
    }
    const item: QueuedItem = { id: opts.jobId ?? crypto.randomUUID(), payload: JSON.parse(JSON.stringify(payload ?? null)) as unknown, attempt: 1 };
    const push = () => {
      state.queue.push(item);
      pump(state);
    };
    if (opts.delayMs && opts.delayMs > 0) schedule(push, opts.delayMs);
    else push();
  }

  async function start({ schedule: withSchedules = true } = {}): Promise<void> {
    if (started) return;
    started = true;
    stopping = false;
    controller = new AbortController();
    if (!withSchedules) return;
    for (const state of states.values()) {
      const def = state.def;
      if (def.kind !== 'cron') continue;
      const cron = new Cron((def).cron, { timezone: (def).timezone ?? 'UTC', protect: true }, async () => {
        if (stopping) return;
        const firedAt = new Date().toISOString();
        state.queue.push({ id: `${def.name}@${firedAt}`, payload: null, attempt: 1, scheduledAt: firedAt });
        pump(state);
      });
      crons.push(cron);
    }
    logger.info({ jobs: [...states.keys()] }, 'In-process job schedules started');
  }

  async function stop({ timeoutMs = 10000 } = {}): Promise<void> {
    stopping = true;
    for (const c of crons.splice(0)) c.stop();
    for (const t of timers) clearTimeout(t);
    timers.clear();
    for (const s of states.values()) s.queue.length = 0;
    controller.abort();
    await Promise.race([drain(), new Promise<void>((r) => setTimeout(r, timeoutMs).unref())]);
    started = false;
  }

  function drain(): Promise<void> {
    if (isIdle()) return Promise.resolve();
    return new Promise((resolve) => idle.add(resolve));
  }

  return runner;
}
