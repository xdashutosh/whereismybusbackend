// BullMQ job backend (REDIS_URL set; required in production). One queue per job name under the
// 'wimb' prefix; repeatable schedules via job schedulers (upsert on start, stale ones removed);
// consumers (Workers) only in processes that call start() — the worker process, or the API when
// JOBS_IN_PROCESS=true. enqueue() works from any process (API → worker hand-off).
import { Queue, Worker, type Job } from 'bullmq';
import { logger as rootLogger, type Logger } from '../shared/logger.js';
import { createRedis, type Redis } from '../shared/redis.js';
import { createSchoolCronDispatcher, type SchoolTimezoneLoader } from './schoolCron.js';
import { sanitizeJobId, type EnqueueOptions, type JobContext, type JobDef, type JobRunner, type QueueJobDef, type SchoolCronJobDef } from './types.js';

export const QUEUE_PREFIX = 'wimb';

export function createBullmqRunner(
  defs: readonly JobDef[],
  { logger = rootLogger.child({ module: 'jobs' }), loadSchools, redisUrl }: { logger?: Logger; loadSchools?: SchoolTimezoneLoader; redisUrl?: string | null } = {},
): JobRunner {
  const schoolDefs = defs.filter((d): d is SchoolCronJobDef => d.kind === 'school-cron');
  const all = new Map<string, JobDef>(defs.map((d) => [d.name, d]));
  const counters = new Map<string, { runs: number; failures: number; running: number }>();
  let connection: Redis | null = null;
  const queues = new Map<string, Queue>();
  const workers: Worker[] = [];
  let started = false;
  let controller = new AbortController();

  const conn = () => (connection ??= createRedis('bullmq', redisUrl));
  const queueFor = (name: string): Queue => {
    let q = queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: conn(), prefix: QUEUE_PREFIX });
      queues.set(name, q);
    }
    return q;
  };
  const counter = (name: string) => {
    let c = counters.get(name);
    if (!c) {
      c = { runs: 0, failures: 0, running: 0 };
      counters.set(name, c);
    }
    return c;
  };

  const attemptsOf = (def: JobDef) => (def.kind === 'queue' ? Math.max(1, def.attempts ?? 3) : def.kind === 'school-cron' ? Math.max(1, def.attempts ?? 2) : 1);
  const backoffOf = (def: JobDef) => (def.kind === 'queue' ? (def.backoffMs ?? 2000) : 2000);

  async function enqueue(name: string, payload: unknown, opts: EnqueueOptions = {}): Promise<void> {
    const def = all.get(name);
    if (!def || def.kind === 'cron') throw new TypeError(`Unknown queue job: ${name}`);
    await queueFor(name).add(name, payload ?? null, {
      jobId: opts.jobId ? sanitizeJobId(opts.jobId) : undefined,
      delay: opts.delayMs && opts.delayMs > 0 ? opts.delayMs : undefined,
      attempts: attemptsOf(def),
      backoff: { type: 'exponential', delay: backoffOf(def) },
      removeOnComplete: { age: 24 * 3600, count: 5000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    });
  }

  if (schoolDefs.length) {
    const dispatcher = createSchoolCronDispatcher({ defs: schoolDefs, loadSchools, enqueue });
    all.set(dispatcher.name, dispatcher);
  }

  async function processJob(def: JobDef, job: Job): Promise<void> {
    const c = counter(def.name);
    c.running += 1;
    const ctx: JobContext = { name: def.name, jobId: String(job.id), attempt: job.attemptsMade + 1, logger: logger.child({ job: def.name, jobId: job.id }), signal: controller.signal };
    if (def.kind === 'cron') {
      // Scheduler jobs carry their fire time (prevMillis); a backlog must not shift it to "now".
      const fired = job.opts.prevMillis ?? job.timestamp + (job.delay || 0);
      if (Number.isFinite(fired) && fired > 0) ctx.scheduledAt = new Date(fired).toISOString();
    }
    try {
      if (def.kind === 'cron') await def.handler(ctx);
      else if (def.kind === 'school-cron') await def.handler(job.data as Parameters<SchoolCronJobDef['handler']>[0], ctx);
      else await (def as QueueJobDef<unknown>).handler(job.data, ctx);
      c.runs += 1;
    } catch (err) {
      c.failures += 1;
      ctx.logger.error({ err, attempt: ctx.attempt }, 'Job failed');
      throw err;
    } finally {
      c.running -= 1;
    }
  }

  async function start({ schedule = true } = {}): Promise<void> {
    if (started) return;
    started = true;
    controller = new AbortController();
    for (const def of all.values()) {
      const concurrency = def.kind === 'queue' ? Math.max(1, def.concurrency ?? 1) : 1;
      const worker = new Worker(def.name, (job) => processJob(def, job), { connection: conn(), prefix: QUEUE_PREFIX, concurrency, autorun: true });
      worker.on('error', (err) => logger.error({ err, job: def.name }, 'BullMQ worker error'));
      workers.push(worker);
      if (!schedule) continue;
      const q = queueFor(def.name);
      if (def.kind === 'cron') {
        await q.upsertJobScheduler(def.name, { pattern: def.cron, tz: def.timezone ?? 'UTC' }, { name: def.name, data: null, opts: { removeOnComplete: { age: 3600, count: 100 }, removeOnFail: { age: 7 * 24 * 3600 } } });
      }
      // Remove schedulers that no longer match a cron definition of this queue.
      for (const s of await q.getJobSchedulers()) {
        if (def.kind !== 'cron' || s.key !== def.name) await q.removeJobScheduler(s.key);
      }
    }
    logger.info({ jobs: [...all.keys()], schedules: schedule }, 'BullMQ job workers started');
  }

  async function stop({ timeoutMs = 10000 } = {}): Promise<void> {
    controller.abort();
    const closing = Promise.allSettled([...workers.splice(0).map((w) => w.close()), ...[...queues.values()].map((q) => q.close())]);
    await Promise.race([closing, new Promise<void>((r) => setTimeout(r, timeoutMs).unref())]);
    queues.clear();
    if (connection) {
      try {
        await connection.quit();
      } catch {
        connection.disconnect();
      }
      connection = null;
    }
    started = false;
  }

  return {
    backend: 'bullmq',
    enqueue,
    start,
    stop,
    drain: async () => undefined,
    stats: () => ({
      backend: 'bullmq',
      started,
      jobs: [...all.values()].map((d) => ({ name: d.name, kind: d.kind, ...counter(d.name), queued: 0 })),
    }),
  };
}
