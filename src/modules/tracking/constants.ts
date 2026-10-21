// Job names and payloads of the tracking module (no imports of the job runner here, so the job
// definitions and the producers can share them without an import cycle).
import type { ParsedPoint } from './motion.js';

export const POINTS_PERSIST_JOB = 'points-persist';
export const TRIP_FINALIZER_JOB = 'trip-finalizer';
export const LOCATION_GAP_JOB = 'location-gap-detector';

export interface PersistPayload {
  schoolId: string;
  tripId: string;
  /** Every accepted point (live + backfill), ascending. */
  points: ParsedPoint[];
  /** The accepted live points (ascending) — analysed after the insert. */
  live: ParsedPoint[];
  /** Points that arrived after the trip ended: re-run the finalizer afterwards. */
  lateBackfill: boolean;
}

export interface TripFinalizerPayload {
  schoolId: string;
  tripId: string;
}
