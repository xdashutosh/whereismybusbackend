// ETA v1 (BP §9.5) — no paid API call per update. Pure functions:
//   1. project the fix onto the planned polyline (progress along the route, distance from it);
//   2. remaining distance along the polyline to every upcoming stop;
//   3. divide by an exponentially weighted recent speed (≈ 3-min window) with a floor, so a red
//      light never gives an infinite ETA, and a ceiling against GPS spikes;
//   4. add a typical dwell per intermediate stop;
//   5. beyond the next stop, blend with the planned timetable's segment durations for stability
//      (the farther the stop, the more weight the timetable gets);
//   6. quality gating: stale, inaccurate or off-route fixes and missing routes give no ETA.
import type { EtaQuality, StopEta, TripEta } from '@wimb/shared';
import { projectOnPolyline, type Projection } from '../../shared/geo.js';
import type { TripGeometry } from './geometry.js';

export const ETA_SPEED_FLOOR_KMH = 10;
export const ETA_SPEED_CEILING_KMH = 70;
/** Used when there is no speed history yet (first points of a trip). */
export const ETA_DEFAULT_SPEED_KMH = 20;
export const ETA_DWELL_S = 30;
/** Fixes less accurate than this give no ETA; between ETA_GOOD_ACCURACY_M and this → degraded. */
export const ETA_MAX_ACCURACY_M = 100;
export const ETA_GOOD_ACCURACY_M = 50;
/** Off-route beyond this (or the school's deviation threshold, whichever is larger) → no ETA. */
export const ETA_OFF_ROUTE_M = 300;
/** Remaining distance up to which the physical estimate is used alone. */
export const BLEND_NEAR_M = 1000;
/** Minimum weight of the physical estimate for far stops. */
export const BLEND_MIN_WEIGHT = 0.6;
export const BLEND_SPAN_M = 20_000;

export interface EtaInput {
  geometry: TripGeometry | null;
  position: { lat: number; lng: number; ms: number; acc: number | null } | null;
  /** Smoothed recent speed (m/s) or null without history. */
  ewmaSpeedMps: number | null;
  /** Previous progress along the route (disambiguates loops / out-and-back roads). */
  hintProgressM: number | null;
  visitedStopIds: readonly string[];
  /** The bus is at this stop now (its dwell is still running). */
  currentStopId: string | null;
  nowMs: number;
  /** Position older than this many seconds → STALE_POSITION. */
  staleAfterS: number;
  routeDeviationM: number;
}

export interface EtaResult {
  eta: TripEta;
  projection: Projection | null;
}

const iso = (ms: number) => new Date(ms).toISOString();
const round1 = (n: number) => Math.round(n * 10) / 10;

function unavailable(nowMs: number, reason: string, projection: Projection | null = null): EtaResult {
  return { eta: { computedAt: iso(nowMs), quality: 'unavailable', reason, speedKmh: 0, stops: [], destinationEtaAt: null }, projection };
}

/** Weight of the physical estimate for a stop `remainingM` ahead (1 near, BLEND_MIN_WEIGHT far). */
export function physicsWeight(remainingM: number): number {
  if (remainingM <= BLEND_NEAR_M) return 1;
  return Math.max(BLEND_MIN_WEIGHT, 1 - ((remainingM - BLEND_NEAR_M) / BLEND_SPAN_M) * (1 - BLEND_MIN_WEIGHT));
}

/** Speed used for the ETA (m/s): EWMA clamped to [floor, ceiling], default without history. */
export function etaSpeedMps(ewmaSpeedMps: number | null): number {
  const kmh = ewmaSpeedMps === null ? ETA_DEFAULT_SPEED_KMH : ewmaSpeedMps * 3.6;
  return Math.min(ETA_SPEED_CEILING_KMH, Math.max(ETA_SPEED_FLOOR_KMH, kmh)) / 3.6;
}

export function computeEta(input: EtaInput): EtaResult {
  const { geometry, position, nowMs } = input;
  if (!geometry || !geometry.polyline) return unavailable(nowMs, 'NO_ROUTE');
  if (!position) return unavailable(nowMs, 'NO_POSITION');
  if ((nowMs - position.ms) / 1000 > input.staleAfterS) return unavailable(nowMs, 'STALE_POSITION');
  const projection = projectOnPolyline(position, geometry.polyline, input.hintProgressM === null ? {} : { hintProgressM: input.hintProgressM });
  if (position.acc !== null && position.acc > ETA_MAX_ACCURACY_M) return unavailable(nowMs, 'LOW_ACCURACY', projection);
  if (projection.distanceFromRouteM > Math.max(ETA_OFF_ROUTE_M, input.routeDeviationM)) return unavailable(nowMs, 'OFF_ROUTE', projection);

  let quality: EtaQuality = 'good';
  let reason: string | null = null;
  if (input.ewmaSpeedMps === null) {
    quality = 'degraded';
    reason = 'NO_SPEED_HISTORY';
  } else if (position.acc !== null && position.acc > ETA_GOOD_ACCURACY_M) {
    quality = 'degraded';
    reason = 'LOW_ACCURACY';
  }
  const speed = etaSpeedMps(input.ewmaSpeedMps);
  const visited = new Set(input.visitedStopIds);
  const progress = projection.progressM;
  const upcoming = geometry.stops.filter((s) => !visited.has(s.id) && s.id !== input.currentStopId && s.progressM >= progress - s.radiusM);

  const stops: StopEta[] = [];
  let firstPhysicsMs: number | null = null;
  let firstPlannedMs: number | null = null;
  // Remaining dwell at the current stop is not modelled (unknown); each stop passed adds ETA_DWELL_S.
  for (let i = 0; i < upcoming.length; i += 1) {
    const s = upcoming[i]!;
    const remainingM = Math.max(0, s.progressM - progress);
    const physicsMs = position.ms + (remainingM / speed) * 1000 + i * ETA_DWELL_S * 1000;
    let etaMs = physicsMs;
    if (firstPhysicsMs === null) {
      firstPhysicsMs = physicsMs;
      firstPlannedMs = s.plannedAtMs;
    } else if (firstPlannedMs !== null && s.plannedAtMs !== null && s.plannedAtMs >= firstPlannedMs) {
      const timetableMs = firstPhysicsMs + (s.plannedAtMs - firstPlannedMs);
      const w = physicsWeight(remainingM);
      etaMs = w * physicsMs + (1 - w) * timetableMs;
    }
    etaMs = Math.max(etaMs, nowMs);
    stops.push({
      stopId: s.id,
      sequence: s.sequence,
      name: s.name,
      remainingM: Math.round(remainingM),
      etaAt: iso(etaMs),
      plannedAt: s.plannedAtMs === null ? null : iso(s.plannedAtMs),
      delayMin: s.plannedAtMs === null ? null : round1((etaMs - s.plannedAtMs) / 60_000),
    });
  }

  let destinationEtaAt: string | null = null;
  const remainingRouteM = Math.max(0, geometry.totalM - progress);
  if (stops.length || remainingRouteM > 0) {
    const last = stops[stops.length - 1];
    const tailM = Math.max(0, geometry.totalM - (upcoming[upcoming.length - 1]?.progressM ?? progress));
    let destMs = position.ms + (remainingRouteM / speed) * 1000;
    if (last) destMs = tailM < 50 ? Date.parse(last.etaAt) : Date.parse(last.etaAt) + ETA_DWELL_S * 1000 + (tailM / speed) * 1000;
    destinationEtaAt = iso(Math.max(destMs, nowMs));
  }
  return { eta: { computedAt: iso(nowMs), quality, reason, speedKmh: round1(speed * 3.6), stops, destinationEtaAt }, projection };
}
