// Per accepted live point (BP §9.2, worker side): stop-arrival detection on the stop geofences
// (trip_stop_events arrived/departed/dwell), school-geofence exit, the feature-flagged checks
// (speeding, route deviation over N consecutive points, long unscheduled stop outside every stop
// geofence) and the ETA recompute (v1, with a fresh ETA v2 snapshot applied on top when given). Pure state transitions here; the caller performs the writes
// it returns inside one transaction and publishes after commit.
import { haversineMeters, projectOnPolyline } from '../../shared/geo.js';
import type { RaiseAlertInput } from '../alerts/service.js';
import { staleAfterS, type TrackingConfig } from './config.js';
import { computeEta } from './eta.js';
import { applyEtaV2, type EtaV2Snapshot } from './etaV2.js';
import { schoolRadiusM, type GeoStop, type TripGeometry } from './geometry.js';
import type { StoredLiveState } from './liveState.js';
import type { ParsedPoint } from './motion.js';
import { impliedKmh, MAX_PLAUSIBLE_KMH } from './track.js';

/** Fixes less accurate than this are ignored for geofences and checks. */
export const ANALYTICS_ACCURACY_M = 100;
/** Leaving a geofence needs this factor of its radius (hysteresis against GPS jitter). */
export const EXIT_FACTOR = 1.25;
/** Consecutive off-route fixes before route_deviation (BP §11.1: "for N points"). */
export const DEVIATION_POINTS = 3;
/** Consecutive fixes above the limit before speeding (≈ 30 s at the moving interval). */
export const SPEEDING_POINTS = 3;
/**
 * GPS spikes: an accurate-looking fix whose implied speed from the last accepted fix exceeds
 * MAX_PLAUSIBLE_KMH (the post-trip filterTrack rule) is ignored by geofences, school exit, checks and
 * the ETA, and does not become the reference. After this many rejected fixes in a row the next one is
 * accepted (the reference itself was wrong, or the bus really moved during a data gap).
 */
export const MAX_SPIKE_RUN = 3;

export type StopWrite =
  | { kind: 'arrival'; stopId: string; at: string; distanceM: number }
  | { kind: 'departure'; stopId: string; at: string; minDistanceM: number | null; dwellS: number };

export type AnalyticsEvent =
  | { kind: 'stop_arrived'; stopId: string; at: string; distanceM: number }
  | { kind: 'stop_departed'; stopId: string; at: string; dwellS: number }
  | { kind: 'left_school'; at: string };

export interface AnalyticsOutcome {
  writes: StopWrite[];
  alerts: RaiseAlertInput[];
  events: AnalyticsEvent[];
  /** The ETA changed enough to broadcast (stops, quality or ≥ 1 min). */
  etaChanged: boolean;
}

const accurate = (p: ParsedPoint) => p.acc === null || p.acc <= ANALYTICS_ACCURACY_M;

function nearestStop(stops: readonly GeoStop[], p: ParsedPoint, exclude: ReadonlySet<string>): { stop: GeoStop; d: number } | null {
  let best: { stop: GeoStop; d: number } | null = null;
  for (const s of stops) {
    if (exclude.has(s.id)) continue;
    const d = haversineMeters(p, s);
    if (d <= s.radiusM && (!best || d < best.d)) best = { stop: s, d };
  }
  return best;
}

function insideAnyGeofence(geometry: TripGeometry | null, p: ParsedPoint): boolean {
  if (!geometry) return false;
  if (geometry.school && haversineMeters(p, geometry.school) <= schoolRadiusM(geometry.school)) return true;
  return geometry.stops.some((s) => haversineMeters(p, s) <= s.radiusM * EXIT_FACTOR);
}

function etaSignature(s: StoredLiveState): string {
  if (!s.eta) return 'none';
  return `${s.eta.quality}|${s.eta.stops.map((x) => `${x.stopId}@${Math.round(Date.parse(x.etaAt) / 60_000)}`).join(',')}`;
}

/**
 * Applies new live points (ascending, newer than state.analyzedUpToMs) to the analytics part of
 * the state and returns the writes/alerts/events to perform.
 */
export function analyzePoints(
  state: StoredLiveState,
  points: readonly ParsedPoint[],
  geometry: TripGeometry | null,
  cfg: TrackingConfig,
  nowMs: number,
  etaV2: EtaV2Snapshot | null = null,
): AnalyticsOutcome {
  const out: AnalyticsOutcome = { writes: [], alerts: [], events: [], etaChanged: false };
  const before = etaSignature(state);
  const fresh = points.filter((p) => state.analyzedUpToMs === null || p.ms > state.analyzedUpToMs);
  const base = { tripId: state.tripId, busId: state.busId, entity: { type: 'trip' as const, id: state.tripId } };
  let lastRejected = false;
  for (const p of fresh) {
    state.analyzedUpToMs = p.ms;
    if (!accurate(p)) continue;
    const ref = state.analyticsRef ?? null;
    if (ref && impliedKmh(ref, p) > MAX_PLAUSIBLE_KMH && (state.spikeRun ?? 0) < MAX_SPIKE_RUN) {
      state.spikeRun = (state.spikeRun ?? 0) + 1;
      lastRejected = true;
      continue;
    }
    state.spikeRun = 0;
    state.analyticsRef = { ms: p.ms, lat: p.lat, lng: p.lng };
    lastRejected = false;

    // ── stop geofences ──
    if (geometry) {
      if (state.currentStop) {
        const stop = geometry.stops.find((s) => s.id === state.currentStop!.stopId);
        const d = stop ? haversineMeters(p, stop) : Infinity;
        if (stop && d <= stop.radiusM * EXIT_FACTOR) {
          state.currentStopMinM = Math.min(state.currentStopMinM ?? d, d);
        } else {
          const dwellS = Math.max(0, Math.round((p.ms - Date.parse(state.currentStop.arrivedAt)) / 1000));
          out.writes.push({ kind: 'departure', stopId: state.currentStop.stopId, at: p.t, minDistanceM: state.currentStopMinM, dwellS });
          out.events.push({ kind: 'stop_departed', stopId: state.currentStop.stopId, at: p.t, dwellS });
          state.currentStop = null;
          state.currentStopMinM = null;
        }
      }
      if (!state.currentStop) {
        const hit = nearestStop(geometry.stops, p, new Set(state.visitedStopIds));
        if (hit) {
          state.currentStop = { stopId: hit.stop.id, name: hit.stop.name, sequence: hit.stop.sequence, arrivedAt: p.t };
          state.currentStopMinM = hit.d;
          state.visitedStopIds = [...state.visitedStopIds, hit.stop.id];
          const distanceM = Math.round(hit.d);
          out.writes.push({ kind: 'arrival', stopId: hit.stop.id, at: p.t, distanceM });
          out.events.push({ kind: 'stop_arrived', stopId: hit.stop.id, at: p.t, distanceM });
        }
      }
      // ── school geofence (bus left school; radius from Settings → Profile) ──
      if (geometry.school) {
        const d = haversineMeters(p, geometry.school);
        const radiusM = schoolRadiusM(geometry.school);
        if (d <= radiusM) state.wasInSchool = true;
        else if (state.wasInSchool && state.leftSchoolAtMs === null && d > radiusM * EXIT_FACTOR) {
          state.leftSchoolAtMs = p.ms;
          out.events.push({ kind: 'left_school', at: p.t });
        }
      }
    }

    // ── speeding (feature flag + configured limit) ──
    if (cfg.speedingEnabled && cfg.speedLimitKmh !== null && p.spd !== null) {
      if (p.spd > cfg.speedLimitKmh) {
        state.speedingRun = { count: state.speedingRun.count + 1, alerted: state.speedingRun.alerted, maxKmh: Math.max(state.speedingRun.maxKmh, p.spd) };
        if (state.speedingRun.count >= SPEEDING_POINTS && !state.speedingRun.alerted) {
          state.speedingRun.alerted = true;
          out.alerts.push({
            ...base,
            type: 'speeding',
            severity: 'warning',
            title: `Speeding: ${Math.round(state.speedingRun.maxKmh)} km/h (limit ${cfg.speedLimitKmh} km/h)`,
            details: { speedKmh: Math.round(state.speedingRun.maxKmh * 10) / 10, limitKmh: cfg.speedLimitKmh, at: p.t, lat: p.lat, lng: p.lng, points: state.speedingRun.count },
            dedupeKey: `speeding:${state.tripId}`,
          });
        }
      } else {
        state.speedingRun = { count: 0, alerted: false, maxKmh: 0 };
      }
    }

    // ── route deviation over N consecutive points ──
    if (geometry?.polyline) {
      const projection = projectOnPolyline(p, geometry.polyline, state.progressM === null ? {} : { hintProgressM: state.progressM });
      {
        state.progressM = projection.progressM;
        state.distanceFromRouteM = projection.distanceFromRouteM;
        if (projection.distanceFromRouteM > cfg.routeDeviationM) state.offRouteCount += 1;
        else state.offRouteCount = 0;
        if (cfg.routeDeviationEnabled && state.offRouteCount === DEVIATION_POINTS) {
          out.alerts.push({
            ...base,
            type: 'route_deviation',
            severity: 'warning',
            title: `Route deviation: ${Math.round(projection.distanceFromRouteM)} m from the planned route`,
            details: { distanceM: Math.round(projection.distanceFromRouteM), thresholdM: cfg.routeDeviationM, points: DEVIATION_POINTS, at: p.t, lat: p.lat, lng: p.lng },
            dedupeKey: `route_deviation:${state.tripId}`,
          });
        }
      }
    }

    // ── long unscheduled stop (outside every stop / school geofence) ──
    if (state.motion === 'stopped' && state.stoppedSinceMs !== null && !insideAnyGeofence(geometry, p)) {
      if (!state.longStop || state.longStop.sinceMs !== state.stoppedSinceMs) state.longStop = { sinceMs: state.stoppedSinceMs, lat: p.lat, lng: p.lng, alerted: false };
      const minutes = (p.ms - state.longStop.sinceMs) / 60_000;
      if (!state.longStop.alerted && minutes >= cfg.stopDurationAlertMin) {
        state.longStop.alerted = true;
        out.alerts.push({
          ...base,
          type: 'long_stop',
          severity: 'warning',
          title: `Unscheduled stop for ${Math.round(minutes)} min`,
          details: { since: new Date(state.longStop.sinceMs).toISOString(), minutes: Math.round(minutes), thresholdMin: cfg.stopDurationAlertMin, lat: state.longStop.lat, lng: state.longStop.lng },
          dedupeKey: `long_stop:${state.tripId}:${state.longStop.sinceMs}`,
        });
      }
    } else if (state.motion === 'moving') {
      state.longStop = null;
    }
  }

  // ── ETA v1 from the newest point (+ the cached ETA v2 stop times while fresh) ──
  // A batch ending on a rejected spike keeps the previous ETA (no false "approaching" from it).
  const newest = state.point;
  if (newest && !lastRejected) {
    const result = computeEta({
      geometry,
      position: { lat: newest.lat, lng: newest.lng, ms: Date.parse(newest.t), acc: newest.acc },
      ewmaSpeedMps: state.ewmaSpeedMps,
      hintProgressM: state.progressM,
      visitedStopIds: state.visitedStopIds,
      currentStopId: state.currentStop?.stopId ?? null,
      nowMs,
      staleAfterS: staleAfterS(cfg, state.motion),
      routeDeviationM: cfg.routeDeviationM,
    });
    state.eta = cfg.etaV2Enabled ? applyEtaV2(result.eta, etaV2, nowMs) : result.eta;
  }
  out.etaChanged = etaSignature(state) !== before || out.events.length > 0;
  return out;
}
