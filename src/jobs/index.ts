// Jobs entry point (contract §8). Modules export their definitions (defineCronJob /
// defineSchoolCronJob / defineQueueJob, see registry.ts) from src/modules/<m>/jobs.ts and add them
// to JOB_DEFINITIONS below. The process-wide runner is BullMQ when REDIS_URL is set, otherwise the
// in-process backend. Producers call `jobs.enqueue(name, payload, { jobId })` from any process;
// consumers/schedules start in src/worker.ts, or in src/server.ts when JOBS_IN_PROCESS=true.
import config from '../config/index.js';
import { createBullmqRunner } from './bullmq.js';
import { CORE_JOB_DEFINITIONS } from './core.js';
import { createInProcessRunner } from './inProcess.js';
import { buildRegistry } from './registry.js';
import type { JobDef, JobRunner } from './types.js';
import { instrumentJob } from '../shared/metrics.js';
import { reportJobFailure } from '../shared/sentry.js';
import { PLATFORM_JOB_DEFINITIONS } from '../modules/platform/jobs.js';
import { TRIP_JOB_DEFINITIONS } from '../modules/trips/jobs.js';
import { TRACKING_JOB_DEFINITIONS } from '../modules/tracking/jobs.js';
import { ALERT_JOB_DEFINITIONS } from '../modules/alerts/jobs.js';
import { NOTIFICATION_JOB_DEFINITIONS } from '../modules/notifications/jobs.js';
import { MAINTENANCE_JOB_DEFINITIONS } from '../modules/maintenance/jobs.js';

export * from './types.js';
export { defineCronJob, defineQueueJob, defineSchoolCronJob, buildRegistry } from './registry.js';
export { createInProcessRunner } from './inProcess.js';
export { createBullmqRunner } from './bullmq.js';
export {
  CORE_JOB_DEFINITIONS,
  FILES_STAGING_CLEANUP_JOB,
  filesStagingCleanup,
  PARTITION_MAINTENANCE_JOB,
  PARTITION_MONTHS_AHEAD,
  partitionMaintenance,
  partitionMaintenanceJob,
  runBootMaintenance,
  SESSION_CLEANUP_JOB,
  sessionCleanup,
  STAGING_MAX_AGE_MS,
  type PartitionMaintenanceResult,
  type SessionCleanupResult,
} from './core.js';
export { cronMatchesMinute, dueSchoolRuns, loadSchoolTimezones, minuteStart, SCHOOL_CRON_DISPATCHER, type SchoolTimezone, type SchoolTimezoneLoader } from './schoolCron.js';

/** Every job of the application: core jobs (core.ts) first, module definitions appended here. */
export const JOB_DEFINITIONS: readonly JobDef[] = [...CORE_JOB_DEFINITIONS, ...PLATFORM_JOB_DEFINITIONS, ...TRIP_JOB_DEFINITIONS, ...TRACKING_JOB_DEFINITIONS, ...ALERT_JOB_DEFINITIONS, ...NOTIFICATION_JOB_DEFINITIONS, ...MAINTENANCE_JOB_DEFINITIONS];

/**
 * Builds a runner for a set of definitions (BullMQ when Redis is configured). Every handler is
 * instrumented (shared/metrics.ts: run/failure counters + duration; failures reported to Sentry).
 */
export function createJobRunner(defs: readonly JobDef[] = JOB_DEFINITIONS, { redisUrl = config.redisUrl } = {}): JobRunner {
  const registry = buildRegistry(defs.map((d) => instrumentJob(d, { onFailure: reportJobFailure })));
  return redisUrl ? createBullmqRunner([...registry.values()], { redisUrl }) : createInProcessRunner([...registry.values()]);
}

let runner: JobRunner | null = null;

/** Process-wide runner (created on first use). */
export function getJobs(): JobRunner {
  return (runner ??= createJobRunner());
}

/** Producer facade: jobs.enqueue('trip-finalizer', { schoolId, tripId }, { jobId: tripId }). */
export const jobs = {
  enqueue: (name: string, payload: unknown, opts?: { jobId?: string; delayMs?: number }) => getJobs().enqueue(name, payload, opts),
};
