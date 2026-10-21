// Public surface of the tracking module for other modules (trips, parent, notifications, reports):
//   gpsDistanceKm(tx, tripId)        GPS km of a trip (outlier-filtered); also registered as the trips
//                                    module's GPS distance provider (registerGpsDistanceProvider)
//   parentStatus(trip, live, stop, o) parent-facing status of BP §9.4 (+ quality-gated ETA)
//   getLiveState(tx|schoolId, tripId) public live state of a running trip (kv), or null
//   loadGeometry(tx, tripId)          planned geometry (polyline, stops with progress/timetable)
//   finalizeTrip / runTripFinalizer   post-trip analytics (the 'trip-finalizer' job)
// Events (after commit, see ./events.ts): tracking.stop_arrived, tracking.stop_departed,
// tracking.left_school, tracking.eta_updated, tracking.location_unavailable, tracking.location_restored.
import type { TripLiveState } from '@wimb/shared';
import type { Tx } from '../../db/tenant.js';
import { trackingConfig } from './config.js';
import { liveStore, toPublicLive } from './liveState.js';
import './events.js';

export { gpsDistanceKm, finalizeTrip, trackingGpsDistance, type FinalizeResult } from './finalizer.js';
export { runTripFinalizer, TRACKING_JOB_DEFINITIONS } from './jobs.js';
export { NO_TRIP_PHASE, parentStatus, tripPhase, type ParentStatusOptions, type ParentStatusStop, type ParentStatusTrip } from './status.js';
export { loadGeometry, type GeoStop, type TripGeometry } from './geometry.js';
export { trackingConfig, staleAfterS, expectedIntervalS, type TrackingConfig } from './config.js';
export { POINTS_PERSIST_JOB, TRIP_FINALIZER_JOB, LOCATION_GAP_JOB } from './constants.js';
export { PARENT_EMIT_MIN_MS } from './publish.js';
export type { TrackingStopEvent } from './events.js';

/** Public live state of a trip of the transaction's school (null when none is stored). */
export async function getLiveState(tx: Tx, tripId: string): Promise<TripLiveState | null> {
  const schoolId = tx.ctx.schoolId;
  if (!schoolId) throw new TypeError('getLiveState requires a school context');
  const stored = await liveStore.get(schoolId, tripId);
  return stored ? toPublicLive(stored, await trackingConfig(tx)) : null;
}
