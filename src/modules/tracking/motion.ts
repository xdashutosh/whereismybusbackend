// Pure ingestion rules (BP §9.1): sorting, de-duplication, the hard 10-s floor for live points,
// backfill classification, and the server-side moving/stopped state machine (median of the last 3
// accurate speed samples, accuracy filter for state changes, stopped after `stoppedAfterS` at or
// below the moving threshold, first fast sample switches back to moving).
import type { LocationPoint } from '@wimb/shared';
import { haversineMeters } from '../../shared/geo.js';
import { correctedMs, FUTURE_TOLERANCE_MS, resolveClockOffset, type ClockResolution } from './clock.js';
import type { TrackingConfig } from './config.js';
import type { StoredLiveState } from './liveState.js';

/** Live points closer than this to the previous accepted live point are dropped (10 s − jitter). */
export const LIVE_FLOOR_MS = 9_000;
/** Device clocks may run slightly ahead; later points are refused (clock.ts). */
export { FUTURE_TOLERANCE_MS };
/**
 * A live reference recorded more than this ahead of the server clock at its arrival is forward-dated
 * (bogus device timestamp): it must not turn the following real points into "backfill".
 */
export const LIVE_AHEAD_MS = 5_000;
/** Points this much older than their arrival are flagged is_backfilled even when newest. */
export const BACKFILL_AGE_MS = 2 * 60_000;
/** Accuracy above this is ignored for motion/state changes (BP §9.1: ~50 m). */
export const STATE_ACCURACY_M = 50;
/** EWMA time constant for the ETA speed (BP §9.5: last 3–5 minutes). */
export const EWMA_TAU_S = 180;

export interface ParsedPoint {
  ms: number;
  t: string;
  lat: number;
  lng: number;
  spd: number | null;
  hdg: number | null;
  acc: number | null;
  bat: number | null;
  net: string | null;
  mv: boolean | null;
  backfilled: boolean;
}

export interface BatchWindow {
  /** recorded_at (ms) of the newest accepted live point, if any. */
  lastLiveAtMs: number | null;
  /** Server time (ms) at which that live point arrived (null when unknown). */
  lastReceivedAtMs?: number | null;
  nowMs: number;
  /** Earliest acceptable recorded_at (trip start minus tolerance). */
  windowStartMs: number;
  /** Latest acceptable recorded_at (ended trips: end plus tolerance). */
  windowEndMs: number | null;
  /** Batch `sentAt` of the device (ms), when the app sent one (BP §14.3 drift check, clock.ts). */
  sentAtMs?: number | null;
  /** Clock offset already applied to this trip (live state), when known. */
  storedClockOffsetMs?: number | null;
  /** Infer a wrong device clock from implausible timestamps (default true; false for late backfill of ended trips). */
  inferClock?: boolean;
}

export interface ClassifiedBatch {
  /** New points beyond the newest live point, ascending, respecting the floor. */
  live: ParsedPoint[];
  /** Older points (offline backfill), ascending, de-duplicated. */
  backfill: ParsedPoint[];
  dropped: { floor: number; duplicate: number; future: number; outsideTrip: number; clockDrift: number };
  /** Device clock handling of the batch: timestamps were used as sent, corrected (shifted) or rejected. */
  clock: ClockResolution;
}

function parse(p: LocationPoint): ParsedPoint {
  const hdg = p.hdg ?? null;
  return {
    ms: Date.parse(p.t),
    t: new Date(Date.parse(p.t)).toISOString(),
    lat: p.lat,
    lng: p.lng,
    spd: p.spd ?? null,
    hdg: hdg === null ? null : hdg % 360,
    acc: p.acc ?? null,
    bat: p.bat ?? null,
    net: p.net ? p.net.toLowerCase() : null,
    mv: p.mv ?? null,
    backfilled: false,
  };
}

/**
 * Sorts, de-duplicates and splits a batch into live points (floor applied) and backfill. Device
 * timestamps are first put on the server clock (clock.ts): shifted when the phone clock is off beyond
 * the tolerance, the whole batch dropped (dropped.clockDrift) beyond the maximum correction.
 */
export function classifyBatch(points: readonly LocationPoint[], w: BatchWindow): ClassifiedBatch {
  const dropped = { floor: 0, duplicate: 0, future: 0, outsideTrip: 0, clockDrift: 0 };
  const parsedAll = points.map(parse);
  const clock = resolveClockOffset(
    parsedAll.map((p) => p.ms),
    { nowMs: w.nowMs, sentAtMs: w.sentAtMs ?? null, storedOffsetMs: w.storedClockOffsetMs ?? null, windowStartMs: w.windowStartMs, infer: w.inferClock },
  );
  if (clock.action === 'rejected') {
    dropped.clockDrift = points.length;
    return { live: [], backfill: [], dropped, clock };
  }
  const parsed: ParsedPoint[] = [];
  for (const raw of parsedAll) {
    const p = clock.action === 'corrected' && Number.isFinite(raw.ms) ? { ...raw, ms: correctedMs(raw.ms, clock), t: new Date(correctedMs(raw.ms, clock)).toISOString() } : raw;
    if (!Number.isFinite(p.ms)) {
      dropped.outsideTrip += 1;
      continue;
    }
    if (p.ms > w.nowMs + FUTURE_TOLERANCE_MS) dropped.future += 1;
    else if (p.ms < w.windowStartMs || (w.windowEndMs !== null && p.ms > w.windowEndMs)) dropped.outsideTrip += 1;
    else parsed.push(p);
  }
  parsed.sort((a, b) => a.ms - b.ms);

  const live: ParsedPoint[] = [];
  const backfill: ParsedPoint[] = [];
  // Backfill = older than the newest live point. When that point was forward-dated (recorded more than
  // LIVE_AHEAD_MS ahead of the server clock at its arrival), points recorded after its arrival still
  // count as live: one bogus timestamp must not freeze the marker until the clock catches up.
  const last = w.lastLiveAtMs;
  const received = w.lastReceivedAtMs ?? null;
  const forwardDated = last !== null && received !== null && last > received + LIVE_AHEAD_MS;
  const backfillBefore = last === null ? null : forwardDated ? Math.min(last, received - LIVE_AHEAD_MS) : last;
  let liveRef = last;
  let backRef: number | null = null;
  let previousMs: number | null = null;
  for (const p of parsed) {
    if (p.ms === previousMs || p.ms === last) {
      dropped.duplicate += 1;
      continue;
    }
    previousMs = p.ms;
    if (backfillBefore !== null && p.ms < backfillBefore) {
      // Offline backfill: accepted (sorted, de-duplicated), thinned with the same floor so a buggy
      // client cannot flood storage.
      if (backRef !== null && p.ms - backRef < LIVE_FLOOR_MS) {
        dropped.floor += 1;
        continue;
      }
      backRef = p.ms;
      backfill.push({ ...p, backfilled: true });
      continue;
    }
    // The floor applies to points newer than the reference (a point older than a forward-dated
    // reference supersedes it).
    if (liveRef !== null && p.ms >= liveRef && p.ms - liveRef < LIVE_FLOOR_MS) {
      dropped.floor += 1;
      continue;
    }
    liveRef = p.ms;
    live.push({ ...p, backfilled: w.nowMs - p.ms > BACKFILL_AGE_MS });
  }
  return { live, backfill, dropped, clock };
}

export function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const isAccurate = (p: ParsedPoint) => p.acc === null || p.acc <= STATE_ACCURACY_M;

/**
 * Applies accepted live points (ascending) to the state: newest point, motion state machine,
 * speed samples and the EWMA speed. Returns true when the motion state changed.
 */
export function applyLivePoints(state: StoredLiveState, points: readonly ParsedPoint[], cfg: Pick<TrackingConfig, 'movingSpeedKmh' | 'stoppedAfterS'>, nowMs: number): boolean {
  const before = state.motion;
  let prev = state.point ? { ms: Date.parse(state.point.t), lat: state.point.lat, lng: state.point.lng } : null;
  for (const p of points) {
    let sample: number | null = p.spd;
    if (sample === null && prev && p.ms > prev.ms) sample = (haversineMeters(prev, p) / ((p.ms - prev.ms) / 1000)) * 3.6;
    if (isAccurate(p) && sample !== null && Number.isFinite(sample)) {
      state.speeds = [...state.speeds, sample].slice(-3);
      const smoothed = median(state.speeds);
      // EWMA (m/s) with a time-based weight: older history decays over ~EWMA_TAU_S.
      const v = smoothed / 3.6;
      if (state.ewmaSpeedMps === null || state.ewmaAtMs === null || p.ms <= state.ewmaAtMs) {
        state.ewmaSpeedMps = state.ewmaSpeedMps === null ? v : state.ewmaSpeedMps;
      } else {
        const alpha = 1 - Math.exp(-(p.ms - state.ewmaAtMs) / 1000 / EWMA_TAU_S);
        state.ewmaSpeedMps += alpha * (v - state.ewmaSpeedMps);
      }
      state.ewmaAtMs = Math.max(state.ewmaAtMs ?? 0, p.ms);
      if (smoothed > cfg.movingSpeedKmh) {
        state.motion = 'moving';
        state.lowSpeedSinceMs = null;
        state.stoppedSinceMs = null;
      } else {
        state.lowSpeedSinceMs ??= p.ms;
        if (p.ms - state.lowSpeedSinceMs >= cfg.stoppedAfterS * 1000) {
          state.motion = 'stopped';
          state.stoppedSinceMs ??= state.lowSpeedSinceMs;
        }
      }
    } else if (sample === null && p.mv !== null && isAccurate(p)) {
      // No speed at all: fall back to the app's own state machine flag.
      if (p.mv) {
        state.motion = 'moving';
        state.lowSpeedSinceMs = null;
        state.stoppedSinceMs = null;
      } else {
        state.lowSpeedSinceMs ??= p.ms;
        state.motion = 'stopped';
        state.stoppedSinceMs ??= state.lowSpeedSinceMs;
      }
    }
    state.point = { t: p.t, lat: p.lat, lng: p.lng, spd: p.spd, hdg: p.hdg, acc: p.acc, bat: p.bat, net: p.net, mv: p.mv };
    state.lastLiveAtMs = p.ms;
    prev = { ms: p.ms, lat: p.lat, lng: p.lng };
  }
  if (points.length) {
    state.receivedAtMs = nowMs;
  }
  return state.motion !== before;
}
