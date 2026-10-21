// Live tracking (BP §9, §8.3 live fleet, §8.6 sockets): ingestion request/response, live state
// shapes broadcast over Socket.IO, the live-fleet list and the trip path view. The compact point
// keys of BP §9.1 stay on the wire (contract §5); everything else is camelCase.
import { z } from 'zod';
import type { Direction, LiveStatus, ParentTripPhase, TripStatus, TripType } from '../enums.js';
import { isoDateTime } from './common.js';
import { locationPoint, MAX_POINTS_PER_BATCH } from './location.js';

/**
 * POST /driver/trips/:id/locations body. BP §9.1 sends `device_id`; the camelCase `deviceId` of
 * the shared locationBatch is accepted too (both must name the device the session is bound to).
 * `sentAt` (or `sent_at`): when the batch was sent, on the SAME clock as the points' `t`, stamped
 * right before each attempt — the server measures the device clock offset from it (BP §14.3).
 */
export const locationIngestBody = z.preprocess(
  (raw) => {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      let o = raw as Record<string, unknown>;
      if (o.deviceId === undefined && o.device_id !== undefined) o = { ...o, deviceId: o.device_id };
      if (o.sentAt === undefined && o.sent_at !== undefined) o = { ...o, sentAt: o.sent_at };
      return o;
    }
    return raw;
  },
  z.object({
    deviceId: z.string().trim().min(1).max(200).optional(),
    sentAt: isoDateTime().optional(),
    points: z.array(locationPoint).min(1).max(MAX_POINTS_PER_BATCH),
  }),
);
export type LocationIngestBody = z.infer<typeof locationIngestBody>;

/** Ingestion answer: the app retunes its interval and stops tracking when the trip is over. */
export interface LocationIngestResult {
  serverTime: string;
  /** Interval the app should use next (moving vs stopped, school/platform configuration). */
  nextIntervalS: number;
  tripStatus: TripStatus;
  /** Points stored (live + backfill). */
  accepted: number;
  /** Points ignored: closer than the 10-s floor, duplicates, outside the trip window or in the future. */
  dropped: number;
  /** Accepted points older than the newest live point (offline backfill). */
  backfilled: number;
  /**
   * Device clock handling of this batch (BP §14.3): `none` = timestamps used as sent (offset within
   * CLOCK_DRIFT_TOLERANCE_MS or unknown); `corrected` = every timestamp was shifted by clockOffsetMs;
   * `rejected` = the offset exceeded CLOCK_DRIFT_MAX_CORRECTION_MS and the points were dropped.
   */
  clockDrift: ClockDriftAction;
  /** server − device clock offset (ms) applied (corrected) or refused (rejected); null when none. */
  clockOffsetMs: number | null;
}

export type ClockDriftAction = 'none' | 'corrected' | 'rejected';

export type MotionState = 'moving' | 'stopped';
/** Freshness of a live position: live ≤ 3× expected interval < stale; none = never received. */
export type Freshness = 'live' | 'stale' | 'none';
export type EtaQuality = 'good' | 'degraded' | 'unavailable';

/** One received fix (compact keys as sent by the driver app). */
export interface LivePoint {
  t: string;
  lat: number;
  lng: number;
  spd: number | null;
  hdg: number | null;
  acc: number | null;
  bat: number | null;
  net: string | null;
  mv: boolean | null;
}

export interface StopEta {
  stopId: string;
  sequence: number;
  name: string;
  /** Remaining distance along the planned route (m). */
  remainingM: number;
  /** Predicted arrival (ISO). */
  etaAt: string;
  /** Timetable arrival on the trip date (ISO) when the stop has an expected time. */
  plannedAt: string | null;
  /** etaAt − plannedAt in minutes (positive = late). */
  delayMin: number | null;
}

export interface TripEta {
  computedAt: string;
  quality: EtaQuality;
  /** Why the ETA is degraded/unavailable (STALE_POSITION, LOW_ACCURACY, OFF_ROUTE, NO_ROUTE, NO_SPEED_HISTORY). */
  reason: string | null;
  /** Smoothed speed used (km/h, after the floor). */
  speedKmh: number;
  /** Upcoming stops in route order (empty when quality is unavailable). */
  stops: StopEta[];
  /** Arrival at the end of the route (school for morning trips). */
  destinationEtaAt: string | null;
  /** 'v2' when the Google traffic-aware estimate (ETA v2, school feature etaV2) set the stop times; absent for ETA v1. */
  source?: 'v2';
}

export interface CurrentStop {
  stopId: string;
  name: string;
  sequence: number;
  arrivedAt: string;
}

/** Live state of a running trip (payload of live:position / live:status, fleet and path views). */
export interface TripLiveState {
  tripId: string;
  busId: string;
  routeId: string | null;
  direction: Direction | null;
  tripStatus: TripStatus;
  point: LivePoint | null;
  /** Server time of the newest accepted live point. */
  receivedAt: string | null;
  motion: MotionState;
  stoppedSince: string | null;
  freshness: Freshness;
  /**
   * Seconds since the newest point ARRIVED (receivedAt; the point time when unknown) — freshness is
   * judged on the server clock, so a phone whose clock is wrong is not shown as stale (BP §14.3).
   */
  ageS: number | null;
  locationUnavailable: boolean;
  /** The driver app reported that it lost the location permission (location_permission_denied) and has not reported it back. */
  locationPermissionDenied?: boolean;
  /** server − device clock offset (ms) applied to this trip's timestamps; null/absent when the clock is right (school views only). */
  clockOffsetMs?: number | null;
  /** Progress along the planned route (m) and distance from it (m). */
  progressM: number | null;
  distanceFromRouteM: number | null;
  currentStop: CurrentStop | null;
  /** Ids of stops already reached, in visiting order. */
  visitedStopIds: string[];
  eta: TripEta | null;
}

/** Socket event payloads (contract §7). */
export interface LivePositionEvent {
  schoolId: string;
  tripId: string;
  busId: string;
  live: TripLiveState;
}
export interface LiveStatusEvent {
  schoolId: string;
  tripId: string;
  busId: string;
  /** What changed: arrived/departed a stop, location unavailable/restored, ETA refresh. */
  change: 'stop_arrived' | 'stop_departed' | 'location_unavailable' | 'location_restored' | 'eta' | 'motion';
  stopId?: string;
  live: TripLiveState;
}

export interface FleetStaffRef {
  staffId: string;
  name: string;
}

export interface FleetTripRef {
  id: string;
  tripType: TripType;
  direction: Direction | null;
  status: TripStatus;
  routeId: string | null;
  routeCode: string | null;
  routeName: string | null;
  startedAt: string | null;
  plannedStartAt: string | null;
  pointsCount: number;
}

/** Status of a bus on the live fleet map (BP §8.3, §13.3). */
export type FleetBusStatus = 'moving' | 'stopped' | 'location_unavailable' | 'awaiting_location' | 'idle' | 'maintenance' | 'inactive';

/** GET /school/fleet/live item. */
export interface FleetLiveItem {
  busId: string;
  busCode: string;
  displayName: string | null;
  registrationNo: string;
  busStatus: string;
  status: FleetBusStatus;
  driver: FleetStaffRef | null;
  conductor: FleetStaffRef | null;
  activeTrip: FleetTripRef | null;
  live: TripLiveState | null;
  /** Today's next scheduled trip (school-local date) when no trip is running. */
  nextTrip: { id: string; direction: Direction | null; plannedStartAt: string | null; routeCode: string | null } | null;
  /** Last known position from the latest closed trip (idle buses). */
  lastKnown: { lat: number; lng: number; at: string; tripId: string } | null;
}

export interface FleetLiveSummary {
  total: number;
  onTrip: number;
  moving: number;
  stopped: number;
  locationUnavailable: number;
  idle: number;
}

export interface FleetLiveResponse {
  generatedAt: string;
  summary: FleetLiveSummary;
  buses: FleetLiveItem[];
}

export interface PathStop {
  id: string;
  sequence: number;
  name: string;
  lat: number;
  lng: number;
  expectedTime: string | null;
  arrivalRadiusM: number;
}

export interface TripStopEventDto {
  stopId: string;
  stopName: string | null;
  sequence: number | null;
  arrivedAt: string | null;
  departedAt: string | null;
  dwellS: number | null;
  distanceM: number | null;
  source: 'live' | 'finalizer' | 'manual';
}

/** GET /school/trips/:id/path */
export interface TripPathResponse {
  trip: {
    id: string;
    status: TripStatus;
    tripType: TripType;
    direction: Direction | null;
    tripDate: string;
    busId: string;
    busCode: string | null;
    routeId: string | null;
    routeCode: string | null;
    routeName: string | null;
    startedAt: string | null;
    endedAt: string | null;
    distanceGpsKm: number | null;
    distanceOdometerKm: number | null;
    finalizedAt: string | null;
  };
  planned: {
    polyline: string | null;
    polylineSource: 'google' | 'straight' | null;
    stops: PathStop[];
    school: { lat: number; lng: number } | null;
  };
  actual: {
    /** Google-encoded simplified path (ST_SimplifyPreserveTopology). */
    polyline: string | null;
    pointCount: number;
    simplifiedPointCount: number;
    start: { lat: number; lng: number; at: string } | null;
    end: { lat: number; lng: number; at: string } | null;
    /** finalizer = stored by trip-finalizer; computed = built from the stored points now. */
    source: 'finalizer' | 'computed' | 'none';
  };
  stopEvents: TripStopEventDto[];
  summary: Record<string, unknown> | null;
  live: TripLiveState | null;
  /** Raw points when ?includePoints=true (capped). */
  points?: LivePoint[];
}

/** GET /driver/trips/:id/route — planned geometry for the driver's active trip screen. */
export interface DriverTripRouteResponse {
  tripId: string;
  routeId: string | null;
  polyline: string | null;
  polylineSource: 'google' | 'straight' | null;
  stops: PathStop[];
  school: { lat: number; lng: number } | null;
  live: TripLiveState | null;
}

/** Parent-facing status of a child's trip (BP §9.4), computed by the tracking module's parentStatus(). */
export interface ParentTripStatus {
  status: LiveStatus;
  /** Reason code for the status (e.g. NOT_STARTED_PAST_GRACE, ETA_LATE, STALE_POSITION). */
  reason: string | null;
  /** ETA to the child's stop (ISO) when the data quality allows one. */
  etaAt: string | null;
  etaMinutes: number | null;
  /** Timetable time at the child's stop (ISO) when known. */
  plannedAt: string | null;
  delayMin: number | null;
  /** Last update time shown as "Last updated hh:mm:ss" (ISO). */
  lastUpdatedAt: string | null;
  /** The bus has passed the child's stop (afternoon drop done / morning pickup done). */
  stopPassed: boolean;
  /** The running trip was marked interrupted by the driver (breakdown, BP §10.4; reason TRIP_INTERRUPTED). */
  interrupted?: boolean;
  /** Trip phase (no_trip, scheduled, running, interrupted, completed, cancelled, missed). */
  phase: ParentTripPhase;
  /**
   * Why the trip is interrupted (the driver's breakdown reason) or cancelled (the school's reason), as
   * entered (max 200 characters); null otherwise.
   */
  phaseReason: string | null;
  /** When the running trip was marked interrupted (ISO), else null. */
  interruptedAt: string | null;
}
