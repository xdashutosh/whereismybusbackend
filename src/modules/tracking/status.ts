// Parent-facing status derivation (BP §9.4) — pure, exported for the parent module:
//   parentStatus(trip, liveState, studentStop, options) → ParentTripStatus
// Rules, in precedence order:
//   Completed            trip completed / auto_closed
//   Bus Stopped          in_progress but marked interrupted by the driver (breakdown, BP §10.4):
//                        reason TRIP_INTERRUPTED, interrupted: true, no ETA
//   Not Started          trip scheduled and planned start + grace not passed (cancelled: reason TRIP_CANCELLED)
//   Delayed              trip not started past grace (scheduled or missed)
//   Location Unavailable in_progress but no fresh point (older than 3× the expected interval), or the app
//                        reported the location permission as denied (reason LOCATION_PERMISSION_DENIED)
//   Arrived at Stop      the bus is inside the child's stop geofence
//   Delayed              ETA to the child's stop later than its timetable time + delay threshold
//   Bus Stopped          in_progress, STOPPED, fresh point
//   On Route             in_progress, moving, fresh point
// The ETA is returned only when the live ETA quality allows it (BP §9.5 quality gating).
// Every status also carries the trip PHASE (tripPhase): scheduled, running, interrupted (with the
// driver's reason), completed, cancelled (with the school's reason) or missed.
import type { ParentTripPhase, ParentTripStatus, TripLiveState, TripStatus } from '@wimb/shared';

export interface ParentStatusTrip {
  status: TripStatus;
  /** Planned start instant (ISO) — trips.planned_start_at. */
  plannedStartAt: string | null;
  /** trips.interrupted_at — the driver marked the running trip interrupted. */
  interruptedAt?: string | null;
  /** The driver's breakdown reason (trips.close_reason of an interrupted trip). */
  interruptionReason?: string | null;
  /** trips.cancel_reason of a cancelled trip. */
  cancelReason?: string | null;
}

/** Longest reason shown to parents. */
export const PHASE_REASON_MAX = 200;

const shortReason = (r: string | null | undefined): string | null => {
  const t = r?.trim();
  if (!t) return null;
  return t.length > PHASE_REASON_MAX ? `${t.slice(0, PHASE_REASON_MAX - 1).trimEnd()}…` : t;
};

/** Phase of a trip for the parent app, with the interruption / cancellation reason. */
export function tripPhase(trip: ParentStatusTrip): { phase: ParentTripPhase; phaseReason: string | null; interruptedAt: string | null } {
  switch (trip.status) {
    case 'completed':
    case 'auto_closed':
      return { phase: 'completed', phaseReason: null, interruptedAt: null };
    case 'cancelled':
      return { phase: 'cancelled', phaseReason: shortReason(trip.cancelReason), interruptedAt: trip.interruptedAt ?? null };
    case 'missed':
      return { phase: 'missed', phaseReason: null, interruptedAt: null };
    case 'scheduled':
      return { phase: 'scheduled', phaseReason: null, interruptedAt: null };
    case 'in_progress':
      return trip.interruptedAt
        ? { phase: 'interrupted', phaseReason: shortReason(trip.interruptionReason), interruptedAt: trip.interruptedAt }
        : { phase: 'running', phaseReason: null, interruptedAt: null };
  }
}

/** Phase fields of a child with no trip today. */
export const NO_TRIP_PHASE = Object.freeze({ phase: 'no_trip' as const, phaseReason: null, interruptedAt: null });

export interface ParentStatusStop {
  stopId: string;
  /** Timetable instant of the child's stop on the trip date (ISO), when known. */
  plannedAt?: string | null;
}

export interface ParentStatusOptions {
  nowMs?: number;
  /** school_settings.trip_delay_threshold_min */
  delayThresholdMin: number;
  /** school_settings.trip_not_started_grace_min */
  notStartedGraceMin: number;
}

const minutesUntil = (iso: string, nowMs: number) => Math.max(0, Math.ceil((Date.parse(iso) - nowMs) / 60_000));

export function parentStatus(trip: ParentStatusTrip, live: TripLiveState | null, studentStop: ParentStatusStop | null, opts: ParentStatusOptions): ParentTripStatus {
  const nowMs = opts.nowMs ?? Date.now();
  const stopEta = studentStop && live?.eta && live.eta.quality !== 'unavailable' ? (live.eta.stops.find((s) => s.stopId === studentStop.stopId) ?? null) : null;
  const plannedAt = stopEta?.plannedAt ?? studentStop?.plannedAt ?? null;
  const stopPassed = Boolean(studentStop && live && live.visitedStopIds.includes(studentStop.stopId) && live.currentStop?.stopId !== studentStop.stopId);
  const base: ParentTripStatus = {
    status: 'not_started',
    reason: null,
    etaAt: null,
    etaMinutes: null,
    plannedAt,
    delayMin: null,
    lastUpdatedAt: live?.point?.t ?? null,
    stopPassed,
    ...tripPhase(trip),
  };

  switch (trip.status) {
    case 'completed':
    case 'auto_closed':
      return { ...base, status: 'completed', reason: trip.status === 'auto_closed' ? 'AUTO_CLOSED' : null };
    case 'cancelled':
      return { ...base, status: 'not_started', reason: 'TRIP_CANCELLED' };
    case 'missed':
      return { ...base, status: 'delayed', reason: 'NOT_STARTED_PAST_GRACE' };
    case 'scheduled': {
      const planned = trip.plannedStartAt ? Date.parse(trip.plannedStartAt) : NaN;
      if (Number.isFinite(planned) && nowMs > planned + opts.notStartedGraceMin * 60_000) {
        return { ...base, status: 'delayed', reason: 'NOT_STARTED_PAST_GRACE', delayMin: Math.round((nowMs - planned) / 60_000) };
      }
      return base;
    }
    case 'in_progress':
      if (trip.interruptedAt) return { ...base, status: 'bus_stopped', reason: 'TRIP_INTERRUPTED', interrupted: true };
      break;
  }

  if (live?.locationPermissionDenied) return { ...base, status: 'location_unavailable', reason: 'LOCATION_PERMISSION_DENIED' };
  if (!live || !live.point) return { ...base, status: 'location_unavailable', reason: 'NO_POSITION_YET' };
  if (live.freshness !== 'live' || live.locationUnavailable) return { ...base, status: 'location_unavailable', reason: 'STALE_POSITION' };

  const withEta: ParentTripStatus = stopEta
    ? { ...base, etaAt: stopEta.etaAt, etaMinutes: minutesUntil(stopEta.etaAt, nowMs), delayMin: stopEta.delayMin }
    : base;
  if (studentStop && live.currentStop?.stopId === studentStop.stopId) return { ...withEta, status: 'arrived_at_stop', etaAt: null, etaMinutes: 0 };
  if (!stopPassed && stopEta && stopEta.delayMin !== null && stopEta.delayMin > opts.delayThresholdMin) {
    return { ...withEta, status: 'delayed', reason: 'ETA_LATE' };
  }
  return { ...withEta, status: live.motion === 'stopped' ? 'bus_stopped' : 'on_route' };
}
