// Public surface of the trips module for other modules (tracking, alerts, notifications, reports, parent).
//   gpsDistance / registerGpsDistanceProvider  GPS distance of a trip (tracking may register its own)
//   gpsMismatchAlert                           odometer ↔ GPS comparison; the trip-finalizer re-runs it
//                                              once late points arrived (same dedupe key)
//   acceptsLatePoints / LATE_POINTS_WINDOW_HOURS  ingestion window after a trip ended (BP §10.3 rule 6)
//   generateTripsForDate                       scheduled trips of a school-local date (current school tx)
//   restoreScheduleTrips                       after a schedule create/re-activation/edit: revive the trips
//                                              its earlier state cancelled, create today's missing run
//   TRIP_FINALIZER_JOB                         job name the tracking module defines ('trip-finalizer')
// Events (after commit, see ./events.ts): 'trip.status_changed', 'trip.not_started', 'trip.interrupted',
// 'trip.reassigned'; socket SOCKET_EVENTS.TRIP_STATUS on school:{id}:fleet and trip:{tripId}.
import { LATE_POINTS_WINDOW_HOURS } from '@wimb/shared';
import './events.js';

export { gpsDistance, registerGpsDistanceProvider, sqlGpsDistance, MIN_GPS_POINTS, type GpsDistance, type GpsDistanceProvider, type GpsTripRef } from './gps.js';
export { gpsMismatch, gpsMismatchAlert, gapVerdict, tripConfigOf } from './odometer.js';
export { generateTripsForDate, restoreScheduleTrips, TRIP_JOB_DEFINITIONS } from './jobs.js';
export { TRIP_FINALIZER_JOB, publishTripStatus, statusPayload, type TripStatusPayload, type TripNotStartedPayload } from './events.js';
export { LATE_POINTS_WINDOW_HOURS };

/**
 * True while a trip accepts location points: in progress, or closed less than
 * LATE_POINTS_WINDOW_HOURS ago — completed, auto-closed, or cancelled WHILE RUNNING (a breakdown,
 * BP §10.4: the driver's queued fixes, including where the bus broke down, are kept for the record;
 * a scheduled trip cancelled before its start never ran and takes nothing). The window is measured
 * from closed_at (the close instant; an auto-closed trip's ended_at is its last fix), falling back to
 * ended_at for rows closed before migration 500. Points of a closed trip are backfill only (no live
 * analytics); ingestion also bounds them by the close instant.
 */
export function acceptsLatePoints(t: { status: string; ended_at: string | null; closed_at?: string | null; started_at?: string | null }, now = Date.now()): boolean {
  if (t.status === 'in_progress') return true;
  const closed = t.closed_at ?? t.ended_at;
  if (!closed) return false;
  const ran = t.status === 'completed' || t.status === 'auto_closed' || (t.status === 'cancelled' && Boolean(t.started_at));
  return ran && now - Date.parse(closed) <= LATE_POINTS_WINDOW_HOURS * 3600_000;
}
