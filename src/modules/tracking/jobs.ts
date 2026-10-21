// Job definitions of the tracking module (BP §7.3, contract §8), listed in src/jobs/index.ts:
//   points-persist          queue  batched location inserts + per-point analytics (ingest enqueues)
//   trip-finalizer          queue  post-trip analytics; the trips module enqueues it after trip end:
//                                  jobs.enqueue('trip-finalizer', { schoolId, tripId }, { jobId: tripId })
//   location-gap-detector   cron   every minute, every active school
// partition-maintenance is a core job (src/jobs/core.ts) shared with the platform.
import { withSchoolSystem } from '../../db/tenant.js';
import { defineCronJob, defineQueueJob } from '../../jobs/registry.js';
import type { JobDef } from '../../jobs/types.js';
import { audit } from '../../shared/audit.js';
import { announceAlerts } from '../alerts/service.js';
import { logger as rootLogger, type Logger } from '../../shared/logger.js';
import { LOCATION_GAP_JOB, POINTS_PERSIST_JOB, TRIP_FINALIZER_JOB, type PersistPayload, type TripFinalizerPayload } from './constants.js';
import { finalizeTrip, type FinalizeResult } from './finalizer.js';
import { detectLocationGapsAllSchools } from './gap.js';
import { liveStore } from './liveState.js';
import { persistPoints } from './persist.js';

/** Runs the finalizer for one trip in its school (exported for tests and manual re-runs). */
export async function runTripFinalizer({ schoolId, tripId }: TripFinalizerPayload, logger: Logger = rootLogger.child({ job: TRIP_FINALIZER_JOB })): Promise<FinalizeResult> {
  const result = await withSchoolSystem(schoolId, async (tx) => {
    const r = await finalizeTrip(tx, tripId);
    if (r.finalized) {
      await audit.log(tx, {
        action: 'trip.finalize',
        entityType: 'trip',
        entityId: tripId,
        new: { distanceGpsKm: r.distanceGpsKm, flags: (r.summary as { flags?: string[] } | undefined)?.flags ?? [] },
      });
    }
    return r;
  });
  if (result.finalized) {
    await announceAlerts(result.alerts ?? []);
    await liveStore.del(schoolId, tripId);
    logger.info({ schoolId, tripId, distanceGpsKm: result.distanceGpsKm }, 'Trip finalized');
  } else {
    logger.info({ schoolId, tripId, reason: result.reason }, 'Trip finalizer skipped');
  }
  return result;
}

export const pointsPersistJob = defineQueueJob<PersistPayload>({
  name: POINTS_PERSIST_JOB,
  concurrency: 4,
  attempts: 5,
  backoffMs: 1000,
  handler: async (payload, ctx) => {
    await persistPoints(payload, ctx.logger);
  },
});

export const tripFinalizerJob = defineQueueJob<TripFinalizerPayload>({
  name: TRIP_FINALIZER_JOB,
  concurrency: 2,
  attempts: 5,
  backoffMs: 5000,
  handler: async (payload, ctx) => {
    await runTripFinalizer(payload, ctx.logger);
  },
});

export const locationGapDetectorJob = defineCronJob({
  name: LOCATION_GAP_JOB,
  cron: '* * * * *',
  timezone: 'UTC',
  handler: async (ctx) => {
    const r = await detectLocationGapsAllSchools({ logger: ctx.logger });
    if (r.flagged || r.alerts) ctx.logger.info(r, 'Location gaps detected');
  },
});

export const TRACKING_JOB_DEFINITIONS: readonly JobDef[] = [pointsPersistJob, tripFinalizerJob, locationGapDetectorJob];
