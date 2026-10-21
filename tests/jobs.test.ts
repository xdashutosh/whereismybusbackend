// Jobs: definitions/registry validation, the in-process backend (queue, dedupe, retries,
// concurrency, cron, stop) and per-school-timezone scheduling.
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildRegistry,
  createInProcessRunner,
  cronMatchesMinute,
  defineCronJob,
  defineQueueJob,
  defineSchoolCronJob,
  dueSchoolRuns,
  minuteStart,
  sanitizeJobId,
  SCHOOL_CRON_DISPATCHER,
  type JobRunner,
  type SchoolCronPayload,
} from '../src/jobs/index.js';
import { createSchoolCronDispatcher } from '../src/jobs/schoolCron.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let runner: JobRunner | null = null;
afterEach(async () => {
  await runner?.stop({ timeoutMs: 2000 });
  runner = null;
});

describe('definitions', () => {
  it('validates names and cron patterns', () => {
    expect(() => defineQueueJob({ name: 'Bad_Name', handler: async () => undefined })).toThrow(/Invalid job name/);
    expect(() => defineCronJob({ name: 'x-job', cron: '* * * *', handler: async () => undefined })).toThrow(/5 fields/);
    expect(() => defineCronJob({ name: 'x-job', cron: '61 * * * *', handler: async () => undefined })).toThrow(/invalid cron/);
    expect(() => defineSchoolCronJob({ name: 'daily', cron: '5 0 * * *', handler: async () => undefined })).not.toThrow();
  });

  it('rejects duplicate names', () => {
    const a = defineQueueJob({ name: 'dup-job', handler: async () => undefined });
    expect(() => buildRegistry([a, a])).toThrow(/Duplicate job name/);
  });

  it('makes job ids BullMQ-safe', () => {
    expect(sanitizeJobId('trip-finalizer:abc')).toBe('trip-finalizer_abc');
    expect(sanitizeJobId('12345')).toBe('j12345');
  });
});

describe('in-process runner', () => {
  it('runs queue jobs with a JSON copy of the payload, without start()', async () => {
    const seen: unknown[] = [];
    const def = defineQueueJob<{ tripId: string }>({ name: 'trip-finalizer', handler: async (p, ctx) => void seen.push({ p, attempt: ctx.attempt, name: ctx.name }) });
    runner = createInProcessRunner([def]);
    const payload = { tripId: 't1' };
    await runner.enqueue('trip-finalizer', payload);
    payload.tripId = 'mutated';
    await runner.drain();
    expect(seen).toEqual([{ p: { tripId: 't1' }, attempt: 1, name: 'trip-finalizer' }]);
    await expect(runner.enqueue('nope', {})).rejects.toThrow(/Unknown queue job/);
  });

  it('deduplicates by jobId', async () => {
    let runs = 0;
    runner = createInProcessRunner([defineQueueJob({ name: 'once-job', handler: async () => void (runs += 1) })]);
    await Promise.all([runner.enqueue('once-job', {}, { jobId: 'k1' }), runner.enqueue('once-job', {}, { jobId: 'k1' }), runner.enqueue('once-job', {}, { jobId: 'k2' })]);
    await runner.drain();
    expect(runs).toBe(2);
  });

  it('retries with backoff until the attempts are exhausted', async () => {
    const attempts: number[] = [];
    runner = createInProcessRunner([
      defineQueueJob({
        name: 'flaky-job',
        attempts: 3,
        backoffMs: 10,
        handler: async (_p, ctx) => {
          attempts.push(ctx.attempt);
          if (ctx.attempt < 3) throw new Error('transient');
        },
      }),
      defineQueueJob({ name: 'broken-job', attempts: 2, backoffMs: 5, handler: async () => Promise.reject(new Error('always')) }),
    ]);
    await runner.enqueue('flaky-job', {});
    await runner.enqueue('broken-job', {});
    await runner.drain();
    expect(attempts).toEqual([1, 2, 3]);
    const stats = runner.stats().jobs.find((j) => j.name === 'broken-job');
    expect(stats).toMatchObject({ failures: 2, runs: 0 });
  });

  it('honours concurrency and delayed jobs', async () => {
    let active = 0;
    let peak = 0;
    runner = createInProcessRunner([
      defineQueueJob({
        name: 'parallel-job',
        concurrency: 2,
        handler: async () => {
          active += 1;
          peak = Math.max(peak, active);
          await sleep(20);
          active -= 1;
        },
      }),
    ]);
    const started = Date.now();
    await runner.enqueue('parallel-job', {}, { delayMs: 30 });
    for (let i = 0; i < 4; i += 1) await runner.enqueue('parallel-job', {});
    await runner.drain();
    expect(peak).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
  });

  it('starts cron schedules and stops cleanly', async () => {
    let ticks = 0;
    runner = createInProcessRunner([defineCronJob({ name: 'every-minute', cron: '* * * * *', handler: async () => void (ticks += 1) })]);
    await runner.start({ schedule: true });
    expect(runner.stats()).toMatchObject({ backend: 'in-process', started: true });
    await runner.stop();
    expect(runner.stats().started).toBe(false);
    expect(ticks).toBe(0);
  });
});

describe('school-local scheduling', () => {
  const daily = defineSchoolCronJob({ name: 'generate-daily-trips', cron: '5 0 * * *', handler: async () => undefined });
  const schools = [
    { schoolId: '11111111-1111-4111-8111-111111111111', timezone: 'Asia/Kolkata' },
    { schoolId: '22222222-2222-4222-8222-222222222222', timezone: 'Europe/London' },
    { schoolId: '33333333-3333-4333-8333-333333333333', timezone: 'Not/AZone' },
  ];

  it('matches a pattern in each school timezone', () => {
    // 00:05 IST = 18:35 UTC the previous day.
    expect(cronMatchesMinute('5 0 * * *', 'Asia/Kolkata', new Date('2026-10-17T18:35:00Z'))).toBe(true);
    expect(cronMatchesMinute('5 0 * * *', 'Asia/Kolkata', new Date('2026-10-17T18:36:00Z'))).toBe(false);
    expect(minuteStart(new Date('2026-10-17T18:35:42.123Z')).toISOString()).toBe('2026-10-17T18:35:00.000Z');
  });

  it('computes due runs with local dates and deterministic job ids; skips invalid zones', () => {
    const runs = dueSchoolRuns([daily], schools, new Date('2026-10-17T18:35:20Z'));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.payload).toEqual<SchoolCronPayload>({ schoolId: schools[0]!.schoolId, timezone: 'Asia/Kolkata', scheduledFor: '2026-10-17T18:35:00.000Z', localDate: '2026-10-18' });
    expect(runs[0]!.jobId).not.toContain(':');
    // 00:05 in London (BST, UTC+1) on 18 Oct = 23:05 UTC on 17 Oct.
    expect(dueSchoolRuns([daily], schools, new Date('2026-10-17T23:05:00Z')).map((r) => r.payload.schoolId)).toEqual([schools[1]!.schoolId]);
  });

  it('dispatches through the runner: the dispatcher enqueues and the school job runs once per school-minute', async () => {
    const received: SchoolCronPayload[] = [];
    const job = defineSchoolCronJob({ name: 'generate-daily-trips', cron: '5 0 * * *', handler: async (p) => void received.push(p) });
    runner = createInProcessRunner([job], { loadSchools: async () => schools });
    expect(runner.stats().jobs.map((j) => j.name)).toContain(SCHOOL_CRON_DISPATCHER);
    const r = runner;
    const dispatcher = createSchoolCronDispatcher({ defs: [job], loadSchools: async () => schools, enqueue: (n, p, o) => r.enqueue(n, p, o), now: () => new Date('2026-10-17T18:35:05Z') });
    const ctx = { name: dispatcher.name, jobId: 'x', attempt: 1, logger: (await import('../src/shared/logger.js')).logger, signal: new AbortController().signal };
    await dispatcher.handler(ctx);
    await dispatcher.handler(ctx); // duplicate dispatch of the same minute
    await runner.drain();
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ schoolId: schools[0]!.schoolId, localDate: '2026-10-18' });
  });
});
