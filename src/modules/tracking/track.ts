// Post-trip track math (BP §9.6, §10.3) — pure: outlier filtering, GPS distance with jitter
// suppression, stop visits from geofences, deviation from the planned polyline and over-speed runs.
import { haversineMeters, projectOnPolyline, type LatLng } from '../../shared/geo.js';
import type { GeoStop } from './geometry.js';

export interface TrackPoint {
  ms: number;
  lat: number;
  lng: number;
  acc: number | null;
  spd: number | null;
}

/** Fixes less accurate than this are discarded. */
export const MAX_TRACK_ACCURACY_M = 100;
/** Implied speeds above this between consecutive fixes mark a GPS spike. */
export const MAX_PLAUSIBLE_KMH = 150;
/** Steps shorter than this (or the fixes' accuracy, capped) are jitter, not movement. */
export const MIN_STEP_M = 8;
export const MAX_STEP_THRESHOLD_M = 30;

/** Implied speed (km/h) between two fixes in time order; Infinity when b is not later than a. */
export const impliedKmh = (a: Pick<TrackPoint, 'ms' | 'lat' | 'lng'>, b: Pick<TrackPoint, 'ms' | 'lat' | 'lng'>): number =>
  b.ms > a.ms ? (haversineMeters(a, b) / ((b.ms - a.ms) / 1000)) * 3.6 : Infinity;
const kmh = impliedKmh;

/** Drops inaccurate fixes and single-point spikes (implausible speed in and out). */
export function filterTrack(points: readonly TrackPoint[]): { kept: TrackPoint[]; outliers: number } {
  const accurate = points.filter((p) => p.acc === null || p.acc <= MAX_TRACK_ACCURACY_M);
  let outliers = points.length - accurate.length;
  const kept: TrackPoint[] = [];
  for (let i = 0; i < accurate.length; i += 1) {
    const p = accurate[i]!;
    const prev = kept[kept.length - 1];
    if (prev && kmh(prev, p) > MAX_PLAUSIBLE_KMH) {
      const next = accurate[i + 1];
      // A spike: implausible from the previous fix and to the next one, while previous → next is fine.
      if (!next || kmh(p, next) > MAX_PLAUSIBLE_KMH || kmh(prev, next) <= MAX_PLAUSIBLE_KMH) {
        outliers += 1;
        continue;
      }
    }
    kept.push(p);
  }
  return { kept, outliers };
}

/** Sum of segment distances (m) with an accuracy-aware jitter threshold anchored at the last counted fix. */
export function trackDistanceM(kept: readonly TrackPoint[]): number {
  if (kept.length < 2) return 0;
  let anchor = kept[0]!;
  let total = 0;
  for (let i = 1; i < kept.length; i += 1) {
    const p = kept[i]!;
    const d = haversineMeters(anchor, p);
    const threshold = Math.min(MAX_STEP_THRESHOLD_M, Math.max(MIN_STEP_M, anchor.acc ?? 0, p.acc ?? 0));
    if (d >= threshold) {
      total += d;
      anchor = p;
    }
  }
  return total;
}

export const toKm1 = (m: number) => Math.round(m / 100) / 10;

export interface StopVisit {
  stopId: string;
  arrivedMs: number;
  departedMs: number | null;
  distanceM: number;
}

/** First entry into each stop geofence and the exit (radius × exitFactor), in time order. */
export function detectStopVisits(kept: readonly TrackPoint[], stops: readonly GeoStop[], exitFactor = 1.25): StopVisit[] {
  const visits: StopVisit[] = [];
  const seen = new Set<string>();
  let current: { stop: GeoStop; visit: StopVisit } | null = null;
  for (const p of kept) {
    if (current) {
      const d = haversineMeters(p, current.stop);
      if (d <= current.stop.radiusM * exitFactor) {
        current.visit.distanceM = Math.min(current.visit.distanceM, d);
        continue;
      }
      current.visit.departedMs = p.ms;
      current = null;
    }
    let best: { stop: GeoStop; d: number } | null = null;
    for (const s of stops) {
      if (seen.has(s.id)) continue;
      const d = haversineMeters(p, s);
      if (d <= s.radiusM && (!best || d < best.d)) best = { stop: s, d };
    }
    if (best) {
      seen.add(best.stop.id);
      const visit: StopVisit = { stopId: best.stop.id, arrivedMs: p.ms, departedMs: null, distanceM: best.d };
      visits.push(visit);
      current = { stop: best.stop, visit };
    }
  }
  return visits;
}

export interface DeviationStats {
  maxM: number;
  avgM: number;
  pointsOverThreshold: number;
  /** Longest run of consecutive fixes beyond the threshold. */
  longestRunOverThreshold: number;
  thresholdM: number;
}

export function deviationStats(kept: readonly TrackPoint[], polyline: readonly LatLng[], thresholdM: number): DeviationStats | null {
  if (!kept.length || polyline.length < 2) return null;
  let max = 0;
  let sum = 0;
  let over = 0;
  let run = 0;
  let longest = 0;
  let hint: number | undefined;
  for (const p of kept) {
    const proj = projectOnPolyline(p, polyline, hint === undefined ? {} : { hintProgressM: hint });
    hint = proj.progressM;
    const d = proj.distanceFromRouteM;
    max = Math.max(max, d);
    sum += d;
    if (d > thresholdM) {
      over += 1;
      run += 1;
      longest = Math.max(longest, run);
    } else run = 0;
  }
  return { maxM: Math.round(max), avgM: Math.round(sum / kept.length), pointsOverThreshold: over, longestRunOverThreshold: longest, thresholdM };
}

export interface SpeedStats {
  maxKmh: number | null;
  avgMovingKmh: number | null;
  limitKmh: number | null;
  overSpeedPoints: number | null;
  /** Runs of ≥ minRun consecutive fixes above the limit. */
  overSpeedEvents: number | null;
}

export function speedStats(kept: readonly TrackPoint[], limitKmh: number | null, movingKmh: number, minRun = 3): SpeedStats {
  const speeds = kept.map((p) => p.spd).filter((s): s is number => s !== null);
  const moving = speeds.filter((s) => s > movingKmh);
  let points = 0;
  let events = 0;
  let run = 0;
  if (limitKmh !== null) {
    for (const p of kept) {
      if (p.spd !== null && p.spd > limitKmh) {
        points += 1;
        run += 1;
        if (run === minRun) events += 1;
      } else run = 0;
    }
  }
  const round1 = (n: number) => Math.round(n * 10) / 10;
  return {
    maxKmh: speeds.length ? round1(speeds.reduce((a, b) => Math.max(a, b), 0)) : null,
    avgMovingKmh: moving.length ? round1(moving.reduce((a, b) => a + b, 0) / moving.length) : null,
    limitKmh,
    overSpeedPoints: limitKmh === null ? null : points,
    overSpeedEvents: limitKmh === null ? null : events,
  };
}

/** Longest gap between consecutive fixes (s). */
export function maxGapS(points: readonly TrackPoint[]): number {
  let max = 0;
  for (let i = 1; i < points.length; i += 1) max = Math.max(max, (points[i]!.ms - points[i - 1]!.ms) / 1000);
  return Math.round(max);
}
