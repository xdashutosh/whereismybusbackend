// Pure mappers of the parent module (BP §7.2: responses never carry raw rows). Live data is reduced
// to what a parent may see: the newest received fix (no battery/network, never interpolated), the
// motion/freshness, the BP §9.4 status for THIS child's stop and the quality-gated ETA to the
// child's stop and the next stop (BP §9.5).
import type {
  Direction,
  ParentChildDirection,
  ParentStopRef,
  ParentTrackingPosition,
  ParentTrackingSnapshot,
  ParentTripStatus,
  TripLiveState,
  TripStatus,
} from '@wimb/shared';
import { NO_TRIP_PHASE, parentStatus, tripPhase, type ParentStatusTrip, type TrackingConfig } from '../tracking/index.js';
import type { ChildRow } from './repository.js';

/** A row that carries a current assignment (direction columns set). */
export type AssignedRow = ChildRow & {
  direction: Direction;
  bus_id: string;
  bus_code: string;
  route_id: string;
  route_code: string;
  stop_id: string;
  stop_name: string;
  stop_sequence: number;
  stop_lat: number;
  stop_lng: number;
  stop_radius_m: number;
};

export function isAssigned(r: ChildRow): r is AssignedRow {
  return r.direction !== null && r.bus_id !== null && r.bus_code !== null && r.route_id !== null && r.stop_id !== null && r.stop_lat !== null;
}

export const firstName = (fullName: string): string => fullName.trim().split(/\s+/)[0] ?? fullName;

export function stopRef(r: AssignedRow): ParentStopRef {
  return { id: r.stop_id, name: r.stop_name, sequence: r.stop_sequence, lat: r.stop_lat, lng: r.stop_lng, expectedTime: r.stop_expected_time };
}

export function positionOf(live: TripLiveState | null): ParentTrackingPosition | null {
  const p = live?.point;
  return p ? { lat: p.lat, lng: p.lng, hdg: p.hdg, spd: p.spd, t: p.t } : null;
}

/** Live state only counts while it belongs to the trip and the trip is running. */
export function liveFor(tripStatus: TripStatus | null, live: TripLiveState | null): TripLiveState | null {
  return tripStatus === 'in_progress' ? live : null;
}

/** BP §9.4 status of a trip for one child's stop (tracking.parentStatus with the school thresholds). */
export function childStatus(
  trip: ParentStatusTrip,
  live: TripLiveState | null,
  stop: { stopId: string; plannedAt: string | null },
  cfg: Pick<TrackingConfig, 'tripDelayThresholdMin' | 'tripNotStartedGraceMin'>,
  nowMs = Date.now(),
): ParentTripStatus {
  return parentStatus(trip, liveFor(trip.status, live), stop, {
    nowMs,
    delayThresholdMin: cfg.tripDelayThresholdMin,
    notStartedGraceMin: cfg.tripNotStartedGraceMin,
  });
}

/** ETA block of a snapshot / child event (null without a usable ETA object). */
export function etaFor(live: TripLiveState | null, stopId: string): ParentTrackingSnapshot['eta'] {
  const eta = live?.eta;
  if (!eta) return null;
  if (eta.quality === 'unavailable') return { quality: 'unavailable', childStop: null, nextStop: null, destinationEtaAt: null };
  const passed = live.visitedStopIds.includes(stopId) && live.currentStop?.stopId !== stopId;
  return {
    quality: eta.quality,
    childStop: passed ? null : (eta.stops.find((s) => s.stopId === stopId) ?? null),
    nextStop: eta.stops[0] ?? null,
    destinationEtaAt: eta.destinationEtaAt,
  };
}

/** Polling fallback (BP §9.3): every 10 s while moving, 60 s otherwise. */
export function pollAfterS(tripStatus: TripStatus | null, live: TripLiveState | null): number {
  return tripStatus === 'in_progress' && live?.motion !== 'stopped' ? 10 : 60;
}

/** Trip of a child row as the status derivation needs it (status, planned start, interruption, cancellation). */
export function statusTrip(r: { trip_status: TripStatus; planned_start_at: string | null; interrupted_at: string | null; interruption_reason: string | null; cancel_reason: string | null }): ParentStatusTrip {
  return { status: r.trip_status, plannedStartAt: r.planned_start_at, interruptedAt: r.interrupted_at, interruptionReason: r.interruption_reason, cancelReason: r.cancel_reason };
}

/** The /parent/children direction entry of an assigned row. */
export function directionCard(r: AssignedRow, live: TripLiveState | null, cfg: Pick<TrackingConfig, 'tripDelayThresholdMin' | 'tripNotStartedGraceMin'>, nowMs = Date.now()): ParentChildDirection {
  const open = r.trip_status === 'scheduled' || r.trip_status === 'in_progress';
  const trip = r.trip_id && r.trip_status ? statusTrip({ ...r, trip_status: r.trip_status }) : null;
  const status = trip ? childStatus(trip, live, { stopId: r.stop_id, plannedAt: r.stop_planned_at }, cfg, nowMs).status : null;
  const { phase, phaseReason } = trip ? tripPhase(trip) : NO_TRIP_PHASE;
  return {
    direction: r.direction,
    busId: r.bus_id,
    busCode: r.bus_code,
    routeId: r.route_id,
    routeCode: r.route_code,
    routeName: r.route_name,
    stop: stopRef(r),
    // Best known time: the stop's timetable instant, else the trip's planned start.
    nextAt: open ? (r.stop_planned_at ?? r.planned_start_at) : r.next_at,
    nextDate: open ? r.trip_date : r.next_day,
    trip: r.trip_id && r.trip_status ? { id: r.trip_id, status: r.trip_status, plannedStartAt: r.planned_start_at, startedAt: r.started_at, endedAt: r.ended_at } : null,
    status,
    phase,
    phaseReason,
  };
}

const ORDER: Record<string, number> = { in_progress: 0, scheduled: 1 };

/**
 * The direction that matters now when the app does not ask for one: the running trip, else the next
 * open trip today, else the earliest upcoming pickup/drop, else morning.
 */
export function pickDirection(rows: AssignedRow[]): AssignedRow | null {
  if (!rows.length) return null;
  const open = rows
    .filter((r) => r.trip_status && r.trip_status in ORDER)
    .sort((a, b) => ORDER[a.trip_status!]! - ORDER[b.trip_status!]! || String(a.planned_start_at ?? '').localeCompare(String(b.planned_start_at ?? '')));
  if (open[0]) return open[0];
  const upcoming = rows.filter((r) => r.next_at).sort((a, b) => String(a.next_at).localeCompare(String(b.next_at)));
  return upcoming[0] ?? rows.find((r) => r.direction === 'morning') ?? rows[0]!;
}
