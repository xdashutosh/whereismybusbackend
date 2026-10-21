// Location retention, tracking side (BP §6.3 / §9.6: "keep raw points for N months … afterwards
// downsample to a simplified polyline stored in trips.summary and drop old partitions"; §12 privacy).
// Called by the partition-maintenance job (src/jobs/core.ts) BEFORE location_partition_maintenance()
// drops / deletes points: every trip that still has raw points older than its school's cutoff
// (location_retention_cutoffs(): least(platform maximum, school override), migration 926) and no stored
// path yet — a cancelled-while-running trip, or one the finalizer never processed — gets its simplified
// path stored in trips.summary.path (retainedAt set), so the trip page keeps the driven path after the
// purge. Analytics and alerts are not recomputed (the finalizer owns them). At most `limitPerSchool`
// trips per school per run (the rest follow on the next daily run, before their points can go: the
// cutoff moves by whole months, the job runs daily).
import { withSchoolSystem, withSystem } from '../../db/tenant.js';
import { logger as rootLogger, type Logger } from '../../shared/logger.js';
import { loadTrack, SIMPLIFY_TOLERANCE_DEG, simplifiedPath } from './finalizer.js';

export const RETAIN_PATHS_PER_SCHOOL = 500;

export interface RetentionCutoff {
  schoolId: string;
  retentionMonths: number;
  cutoff: string;
}

export interface RetainPathsResult {
  schools: number;
  pathsStored: number;
}

/** Effective retention and cutoff of every school (platform maximum, shorter school overrides). */
export async function retentionCutoffs(): Promise<RetentionCutoff[]> {
  const rows = await withSystem(
    (tx) => tx.many<{ school_id: string; retention_months: number; cutoff: string }>('select school_id, retention_months, cutoff from location_retention_cutoffs()'),
    { readOnly: true },
  );
  return rows.map((r) => ({ schoolId: r.school_id, retentionMonths: Number(r.retention_months), cutoff: new Date(r.cutoff).toISOString() }));
}

/** Stores the simplified path of the trips about to lose their raw points (see the header). */
export async function retainExpiringPaths({
  logger = rootLogger.child({ module: 'tracking.retention' }),
  limitPerSchool = RETAIN_PATHS_PER_SCHOOL,
  cutoffs,
}: { logger?: Logger; limitPerSchool?: number; cutoffs?: RetentionCutoff[] } = {}): Promise<RetainPathsResult> {
  const list = cutoffs ?? (await retentionCutoffs());
  let pathsStored = 0;
  for (const c of list) {
    try {
      pathsStored += await withSchoolSystem(c.schoolId, async (tx) => {
        const trips = await tx.many<{ id: string; started_at: string | null; ended_at: string | null; closed_at: string | null }>(
          `select t.id, t.started_at, t.ended_at, t.closed_at from trips t
            where t.trip_date <= ($1::timestamptz at time zone 'UTC')::date + 1
              and t.status <> 'in_progress' and t.points_count > 0
              and (t.summary is null or t.summary -> 'path' is null)
              and exists (select 1 from location_points lp where lp.trip_id = t.id and lp.recorded_at < $1::timestamptz)
            order by t.trip_date, t.id
            limit $2`,
          [c.cutoff, limitPerSchool],
        );
        for (const t of trips) {
          const { all, kept } = await loadTrack(tx, t.id, { from: null, to: null });
          const path = await simplifiedPath(tx, kept);
          await tx.query(
            `update trips set summary = coalesce(summary, '{}'::jsonb) || jsonb_build_object('path', $2::jsonb, 'points', coalesce(summary -> 'points', $3::jsonb)),
                    updated_at = now()
              where id = $1`,
            [
              t.id,
              JSON.stringify({ encoded: path.encoded, pointCount: path.pointCount, toleranceDeg: SIMPLIFY_TOLERANCE_DEG, retainedAt: new Date().toISOString() }),
              JSON.stringify({ total: all.length, kept: kept.length, outliers: all.length - kept.length }),
            ],
          );
        }
        return trips.length;
      });
    } catch (err) {
      // One school's failure must not block the others (the purge runs right after): log it loudly.
      logger.error({ err, schoolId: c.schoolId }, 'Could not store the simplified paths before the location purge');
    }
  }
  if (pathsStored) logger.info({ pathsStored }, 'Simplified paths stored before the location purge');
  return { schools: list.length, pathsStored };
}
