// Job definitions (contract §8, BP §7.3). Three kinds behind one interface:
//   cron         repeatable, one global schedule (UTC unless `timezone`), e.g. partition-maintenance
//   school-cron  repeatable in EACH school's own IANA timezone, e.g. generate-daily-trips at 00:05
//                local time; payload { schoolId, timezone, scheduledFor, localDate }
//   queue        on demand, e.g. trip-finalizer, points-persist
// Handlers are plain exported functions (tests call them directly) and must be idempotent; work on
// tenant data inside withSchoolSystem(schoolId, tx => …).
import type { Logger } from '../shared/logger.js';

export interface JobContext {
  name: string;
  jobId: string;
  /** 1-based attempt number. */
  attempt: number;
  logger: Logger;
  signal: AbortSignal;
  /** Cron jobs: the time the schedule fired (ISO), which may be earlier than when the job runs. */
  scheduledAt?: string;
}

export interface CronJobDef {
  kind: 'cron';
  name: string;
  /** 5-field cron pattern (minute precision). */
  cron: string;
  /** IANA timezone of the pattern (default UTC). */
  timezone?: string;
  handler(ctx: JobContext): Promise<void>;
}

export interface SchoolCronPayload {
  schoolId: string;
  timezone: string;
  /** Minute that triggered the run (ISO, UTC). */
  scheduledFor: string;
  /** School-local calendar date of that minute ('YYYY-MM-DD'). */
  localDate: string;
}

export interface SchoolCronJobDef {
  kind: 'school-cron';
  name: string;
  /** 5-field cron pattern evaluated in each school's timezone. */
  cron: string;
  handler(payload: SchoolCronPayload, ctx: JobContext): Promise<void>;
  attempts?: number;
}

export interface QueueJobDef<P = unknown> {
  kind: 'queue';
  name: string;
  handler(payload: P, ctx: JobContext): Promise<void>;
  /** Parallel executions per process (default 1). */
  concurrency?: number;
  /** Total attempts including the first (default 3). */
  attempts?: number;
  /** Base delay of the exponential backoff in ms (default 2000). */
  backoffMs?: number;
}

export type JobDef = CronJobDef | SchoolCronJobDef | QueueJobDef<never>;

export interface EnqueueOptions {
  /** Deduplication id: a job with the same id is not added again while it exists. */
  jobId?: string;
  delayMs?: number;
}

export interface JobRunner {
  readonly backend: 'bullmq' | 'in-process';
  /** Adds an on-demand job (queue or school-cron definitions). */
  enqueue(name: string, payload: unknown, opts?: EnqueueOptions): Promise<void>;
  /** Starts consumers and (when `schedule`) repeatable schedules. */
  start(opts?: { schedule?: boolean }): Promise<void>;
  /** Stops schedules and consumers, waiting (bounded) for in-flight jobs. */
  stop(opts?: { timeoutMs?: number }): Promise<void>;
  /** Waits until no job is queued or running (in-process backend; tests). */
  drain(): Promise<void>;
  stats(): { backend: string; started: boolean; jobs: { name: string; kind: JobDef['kind']; runs: number; failures: number; running: number; queued: number }[] };
}

/** Job names: lower-case kebab (BullMQ queue names; no ':'). */
export const JOB_NAME_RE = /^[a-z][a-z0-9-]{1,62}$/;

/** BullMQ-safe job id (no ':'; not an integer). */
export function sanitizeJobId(id: string): string {
  const s = id.replace(/:/g, '_');
  return /^\d+$/.test(s) ? `j${s}` : s;
}
