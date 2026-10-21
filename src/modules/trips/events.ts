// Trip events (emitted AFTER commit). Every payload carries school_id (BP §16).
//   in-process (shared/events)  'trip.status_changed' (started, completed, cancelled, missed, auto_closed),
//                               'trip.not_started' (parent "trip not started" notifications, when the
//                               school enabled notify_trip_not_started), 'trip.interrupted' (breakdown),
//                               'trip.reassigned', 'trip.location_permission' (denied / restored)
//   realtime (Socket.IO)        SOCKET_EVENTS.TRIP_STATUS to school:{id}:fleet and trip:{tripId}
//   jobs                        'trip-finalizer' { schoolId, tripId } when a trip closes and the
//                               definition is registered (tracking module, BP §9.6)
import { SOCKET_EVENTS, type Direction, type TripStatus, type TripType } from '@wimb/shared';
import { events } from '../../shared/events.js';
import { logger as rootLogger } from '../../shared/logger.js';
import { realtime, rooms } from '../../shared/realtime.js';

const log = rootLogger.child({ module: 'trips.events' });

export const TRIP_FINALIZER_JOB = 'trip-finalizer';

export interface TripStatusPayload {
  schoolId: string;
  tripId: string;
  busId: string;
  routeId: string | null;
  tripType: TripType;
  direction: Direction | null;
  tripDate: string;
  status: TripStatus;
  previousStatus: TripStatus | null;
  /** Interrupted by the driver (breakdown) while still in progress. */
  interrupted: boolean;
  at: string;
  reason?: string | null;
}

export interface TripNotStartedPayload {
  schoolId: string;
  tripId: string;
  busId: string;
  routeId: string | null;
  direction: Direction | null;
  tripDate: string;
  plannedStartAt: string;
  busCode: string | null;
}

declare module '../../shared/events.js' {
  interface AppEvents {
    'trip.status_changed': TripStatusPayload;
    'trip.not_started': TripNotStartedPayload;
    'trip.interrupted': TripStatusPayload & { reason: string };
    'trip.reassigned': { schoolId: string; tripId: string; driverStaffId: string | null; conductorStaffId: string | null };
    /** The driver app lost / got back the location permission during a running trip (device events, server-clock time). */
    'trip.location_permission': {
      schoolId: string;
      tripId: string;
      state: 'denied' | 'restored';
      at: string;
      /** The trip, so the tracking module can start a live state for a trip without fixes yet. */
      busId?: string;
      routeId?: string | null;
      direction?: Direction | null;
      lastPointAt?: string | null;
    };
  }
}

export interface StatusSource {
  id: string;
  school_id: string;
  bus_id: string;
  route_id: string | null;
  trip_type: TripType;
  direction: Direction | null;
  trip_date: string;
  status: TripStatus;
  interrupted_at: string | null;
}

export function statusPayload(t: StatusSource, previousStatus: TripStatus | null, reason: string | null = null): TripStatusPayload {
  return {
    schoolId: t.school_id,
    tripId: t.id,
    busId: t.bus_id,
    routeId: t.route_id,
    tripType: t.trip_type,
    direction: t.direction,
    tripDate: t.trip_date,
    status: t.status,
    previousStatus,
    interrupted: t.interrupted_at !== null,
    at: new Date().toISOString(),
    reason,
  };
}

/** After commit: in-process event + socket broadcast of a trip status. Never throws. */
export async function publishTripStatus(p: TripStatusPayload, { event = true }: { event?: boolean } = {}): Promise<void> {
  if (event) events.emit('trip.status_changed', p);
  const payload = { tripId: p.tripId, busId: p.busId, status: p.status, previousStatus: p.previousStatus, interrupted: p.interrupted, at: p.at, reason: p.reason ?? null };
  try {
    await Promise.all([
      realtime.emit(rooms.schoolFleet(p.schoolId), SOCKET_EVENTS.TRIP_STATUS, payload),
      realtime.emit(rooms.trip(p.tripId), SOCKET_EVENTS.TRIP_STATUS, payload),
    ]);
  } catch (err) {
    log.warn({ err, schoolId: p.schoolId, tripId: p.tripId }, 'Could not publish the trip status');
  }
}

/**
 * After commit: queues the post-trip analytics (deduplicated per trip). Never throws. jobs/index is
 * loaded lazily: it imports this module's job definitions, so a static import would be a cycle.
 */
export async function enqueueFinalizer(schoolId: string, tripId: string): Promise<boolean> {
  const { JOB_DEFINITIONS, jobs } = await import('../../jobs/index.js');
  if (!JOB_DEFINITIONS.some((d) => d.name === TRIP_FINALIZER_JOB && d.kind === 'queue')) {
    log.debug({ schoolId, tripId }, 'trip-finalizer is not registered; skipping');
    return false;
  }
  try {
    await jobs.enqueue(TRIP_FINALIZER_JOB, { schoolId, tripId }, { jobId: `trip-finalizer-${tripId}` });
    return true;
  } catch (err) {
    log.error({ err, schoolId, tripId }, 'Could not queue the trip finalizer');
    return false;
  }
}
