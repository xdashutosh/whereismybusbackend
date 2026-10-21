// Core (platform-wide) jobs that belong to no BP module (contract §3, §8).
//
// partition-maintenance — location_points is range-partitioned by UTC month (BP §6.3). Daily at
// 02:15 UTC, and once whenever a process starts its schedules (worker, or the API with
// JOBS_IN_PROCESS=true), it calls location_partition_maintenance() (migration 014) under the system
// context in ONE statement: creates the current month and PARTITION_MONTHS_AHEAD − 1 following ones,
// drops months older than platform setting location.retention_months, purges expired rows of the
// DEFAULT partition, deletes the points of schools with a shorter location_retention_months
// override (school settings, migration 800), clears the coordinates of device events older than each
// school's cutoff (migration 926) and reports how many rows sit in the DEFAULT partition. Before that,
// the tracking module stores the simplified path of every trip about to lose its raw points that has
// none yet (tracking/retention.ts: BP §9.6 "afterwards downsample to a simplified polyline"), with the
// same per-school cutoffs (location_retention_cutoffs(): the platform value is the maximum, a shorter
// school override wins). Rows in the DEFAULT partition mean points
// arrived outside the pre-created window (clock skew, a long job outage); they stay queryable and
// are moved into their month automatically when it is created, but the job logs an error so
// operations can look at it. Idempotent (an advisory lock serialises concurrent runs).
//
// session-cleanup (contract §8) — daily 03:30 UTC: session_cleanup() (migration 013, system context,
// one statement) deletes sessions expired or revoked more than SESSION_RETENTION ago, OTP codes
// expired for more than a day and expired idempotency records. Super Admin TOTP enrolment
// challenges live in the KV store with a TTL (10 min), so they expire on their own (Redis TTL /
// bounded in-memory LRU) and need no sweep.
//
// files-staging-cleanup — hourly at :40 UTC: presigned mobile uploads go to '<key>.part' staging
// objects (BP §12); POST /files/:id/complete replaces them with the validated object. Staging
// objects older than 24 h belong to uploads that were never completed and are deleted (listing
// under <S3_KEY_PREFIX>schools/, at most STAGING_DELETE_LIMIT per run). Alternative on the bucket
// side: an S3 lifecycle rule that expires objects with the suffix '.part' after 1 day (Linode
// Object Storage supports lifecycle policies; note that S3 lifecycle filters match prefixes, not
// suffixes, so this job remains the portable implementation — see docs/api/files.md).
import { isPgError, PG_ERROR } from '../db/pool.js';
import { withSystem } from '../db/tenant.js';
import { logger as rootLogger, type Logger } from '../shared/logger.js';
import { storage as defaultStorage, type Storage } from '../shared/storage.js';
import { defineCronJob } from './registry.js';
import type { JobDef } from './types.js';

/** Months of partitions that exist at any time, counting the current one. */
export const PARTITION_MONTHS_AHEAD = 3;
export const PARTITION_MAINTENANCE_JOB = 'partition-maintenance';

export interface PartitionMaintenanceResult {
  created: string[];
  dropped: string[];
  defaultRows: number;
  retentionMonths: number;
  /** Points deleted for schools whose retention override is shorter than the platform's. */
  schoolRowsPurged: number;
  /** Simplified paths stored (trips.summary.path) for trips about to lose their raw points. */
  pathsRetained: number;
  /** Device events whose coordinates were cleared at their school's cutoff. */
  deviceEventCoordsPurged: number;
}

/** One maintenance pass (exported for tests and the boot run). */
export async function partitionMaintenance({ logger = rootLogger.child({ job: PARTITION_MAINTENANCE_JOB }), monthsAhead = PARTITION_MONTHS_AHEAD }: { logger?: Logger; monthsAhead?: number } = {}): Promise<PartitionMaintenanceResult> {
  // Lazy: the tracking module imports jobs/index (enqueue), which imports this file.
  const { retainExpiringPaths } = await import('../modules/tracking/retention.js');
  const retained = await retainExpiringPaths({ logger });
  const row = await withSystem((tx) =>
    tx.one<{ created: string[]; dropped: string[]; default_rows: number; retention_months: number; school_rows_purged: string; device_event_coords_purged: string }>(
      'select created, dropped, default_rows, retention_months, school_rows_purged, device_event_coords_purged from location_partition_maintenance($1)',
      [monthsAhead],
    ),
  );
  const result: PartitionMaintenanceResult = {
    created: row.created,
    dropped: row.dropped,
    defaultRows: Number(row.default_rows),
    retentionMonths: row.retention_months,
    schoolRowsPurged: Number(row.school_rows_purged),
    pathsRetained: retained.pathsStored,
    deviceEventCoordsPurged: Number(row.device_event_coords_purged),
  };
  if (result.created.length || result.dropped.length || result.schoolRowsPurged || result.deviceEventCoordsPurged) {
    logger.info(
      { created: result.created, dropped: result.dropped, retentionMonths: result.retentionMonths, schoolRowsPurged: result.schoolRowsPurged, pathsRetained: result.pathsRetained, deviceEventCoordsPurged: result.deviceEventCoordsPurged },
      'location_points partitions maintained',
    );
  }
  if (result.defaultRows > 0) {
    logger.error({ defaultRows: result.defaultRows, alert: 'location_points_default_partition' }, 'location_points rows landed in the DEFAULT partition (outside the pre-created months)');
  }
  return result;
}

export const partitionMaintenanceJob = defineCronJob({
  name: PARTITION_MAINTENANCE_JOB,
  cron: '15 2 * * *',
  timezone: 'UTC',
  handler: async (ctx) => {
    await partitionMaintenance({ logger: ctx.logger });
  },
});

// ── session-cleanup ──────────────────────────────────────────────────────────
export const SESSION_CLEANUP_JOB = 'session-cleanup';
/** Expired/revoked sessions are kept this long (audit of recent sign-ins, refresh reuse detection). */
export const SESSION_RETENTION = '30 days';

export interface SessionCleanupResult {
  sessionsDeleted: number;
  otpsDeleted: number;
  idempotencyDeleted: number;
}

export async function sessionCleanup({ logger = rootLogger.child({ job: SESSION_CLEANUP_JOB }), retention = SESSION_RETENTION }: { logger?: Logger; retention?: string } = {}): Promise<SessionCleanupResult> {
  const row = await withSystem((tx) =>
    tx.one<{ sessions_deleted: number; otps_deleted: number; idempotency_deleted: number }>(
      'select sessions_deleted, otps_deleted, idempotency_deleted from session_cleanup($1::interval)',
      [retention],
    ),
  );
  const result = { sessionsDeleted: row.sessions_deleted, otpsDeleted: row.otps_deleted, idempotencyDeleted: row.idempotency_deleted };
  if (result.sessionsDeleted || result.otpsDeleted || result.idempotencyDeleted) logger.info(result, 'Expired sessions, OTP codes and idempotency records removed');
  return result;
}

export const sessionCleanupJob = defineCronJob({
  name: SESSION_CLEANUP_JOB,
  cron: '30 3 * * *',
  timezone: 'UTC',
  handler: async (ctx) => {
    await sessionCleanup({ logger: ctx.logger });
  },
});

// ── files-staging-cleanup ────────────────────────────────────────────────────
export const FILES_STAGING_CLEANUP_JOB = 'files-staging-cleanup';
export const STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const STAGING_DELETE_LIMIT = 5000;

export async function filesStagingCleanup({
  logger = rootLogger.child({ job: FILES_STAGING_CLEANUP_JOB }),
  store = defaultStorage,
  now = Date.now(),
}: { logger?: Logger; store?: Storage; now?: number } = {}): Promise<{ scanned: number; deleted: number; truncated: boolean }> {
  const result = await store.deleteStaleStagingObjects({ olderThanMs: STAGING_MAX_AGE_MS, now, limit: STAGING_DELETE_LIMIT });
  if (result.deleted) logger.info(result, 'Stale upload staging objects deleted');
  if (result.truncated) logger.warn(result, 'More stale staging objects remain; the next run continues');
  return result;
}

export const filesStagingCleanupJob = defineCronJob({
  name: FILES_STAGING_CLEANUP_JOB,
  cron: '40 * * * *',
  timezone: 'UTC',
  handler: async (ctx) => {
    await filesStagingCleanup({ logger: ctx.logger });
  },
});

/** Core job definitions (listed first in JOB_DEFINITIONS). */
export const CORE_JOB_DEFINITIONS: readonly JobDef[] = [partitionMaintenanceJob, sessionCleanupJob, filesStagingCleanupJob];

/**
 * Work every process that runs schedules does once at start (worker; API with JOBS_IN_PROCESS).
 * Never throws: a failure is logged and the daily schedule retries.
 */
export async function runBootMaintenance(logger: Logger = rootLogger): Promise<void> {
  try {
    await partitionMaintenance({ logger: logger.child({ job: PARTITION_MAINTENANCE_JOB, boot: true }) });
  } catch (err) {
    if (isPgError(err, PG_ERROR.UNDEFINED_FUNCTION)) {
      logger.error('location_partition_maintenance() is not defined: apply the migrations (npm run migrate)');
      return;
    }
    logger.error({ err }, 'Boot partition maintenance failed; the daily partition-maintenance job will retry');
  }
}
