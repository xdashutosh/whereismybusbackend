// Pure ingestion and post-trip math (BP §9.1, §9.6): batch classification (floor, backfill,
// dedupe, windows), the moving/stopped state machine, outlier filtering, GPS distance, stop visits,
// deviation and over-speed statistics, and the gap alert type.
import type { LocationPoint } from '@wimb/shared';
import { describe, expect, it } from 'vitest';
import { gapAlertType } from '../src/modules/tracking/gap.js';
import { newLiveState } from '../src/modules/tracking/liveState.js';
import { applyLivePoints, classifyBatch, LIVE_FLOOR_MS, median } from '../src/modules/tracking/motion.js';
import { deviationStats, detectStopVisits, filterTrack, maxGapS, speedStats, toKm1, trackDistanceM, type TrackPoint } from '../src/modules/tracking/track.js';

const T0 = Date.parse('2026-10-19T01:30:00.000Z');
const KM = 1 / 111.195;
const p = (s: number, o: Partial<LocationPoint> = {}): LocationPoint => ({ t: new Date(T0 + s * 1000).toISOString(), lat: 12.9, lng: 77.6, ...o });
const win = { lastLiveAtMs: null, nowMs: T0 + 3600_000, windowStartMs: T0 - 600_000, windowEndMs: null };
const secs = (pts: { ms: number }[]) => pts.map((x) => (x.ms - T0) / 1000);

describe('classifyBatch', () => {
  it('sorts, de-duplicates and applies the 10-s floor (9-s tolerance) to live points', () => {
    const b = classifyBatch([p(30), p(0), p(5), p(9), p(9), p(18), p(27.5)], win);
    expect(secs(b.live)).toEqual([0, 9, 18, 27.5]);
    expect(b.dropped).toMatchObject({ floor: 2, duplicate: 1 });
    expect(LIVE_FLOOR_MS).toBe(9000);
  });

  it('applies the floor against the previous accepted live point of earlier requests', () => {
    const b = classifyBatch([p(105), p(112)], { ...win, lastLiveAtMs: T0 + 100_000 });
    expect(secs(b.live)).toEqual([112]);
    expect(b.dropped.floor).toBe(1);
  });

  it('accepts older points as backfill (ascending, thinned with the floor, flagged)', () => {
    const b = classifyBatch([p(50), p(20), p(10), p(15), p(100), p(110)], { ...win, lastLiveAtMs: T0 + 100_000 });
    expect(secs(b.backfill)).toEqual([10, 20, 50]);
    expect(b.backfill.every((x) => x.backfilled)).toBe(true);
    expect(secs(b.live)).toEqual([110]);
    expect(b.dropped).toMatchObject({ floor: 1, duplicate: 1 });
  });

  it('drops points in the future or outside the trip window', () => {
    const b = classifyBatch([p(-700), p(10), p(4000)], { ...win, nowMs: T0 + 3600_000, windowEndMs: T0 + 3700_000 });
    expect(secs(b.live)).toEqual([10]);
    expect(b.dropped).toMatchObject({ outsideTrip: 1, future: 1 });
  });

  it('flags live points that arrive long after they were recorded', () => {
    const b = classifyBatch([p(0), p(3590)], win);
    expect(b.live.map((x) => x.backfilled)).toEqual([true, false]);
  });

  it('normalises heading 360 → 0 and network to lower case', () => {
    const b = classifyBatch([p(0, { hdg: 360, net: 'WIFI' })], win);
    expect(b.live[0]).toMatchObject({ hdg: 0, net: 'wifi' });
  });
});

describe('moving / stopped state machine', () => {
  const cfg = { movingSpeedKmh: 4, stoppedAfterS: 60 };
  const seed = () => newLiveState({ schoolId: 's', tripId: 't', busId: 'b', routeId: null, direction: 'morning', tripStatus: 'in_progress', lastPointAt: null });

  it('stops after ≥ 60 s at or below the threshold (median of 3) and resumes on the first fast sample', () => {
    const s = seed();
    const pts = classifyBatch([p(0, { spd: 30 }), p(10, { spd: 30 }), p(20, { spd: 2 }), p(30, { spd: 1 }), p(40, { spd: 0 }), p(60, { spd: 0 }), p(90, { spd: 0 })], win).live;
    applyLivePoints(s, pts.slice(0, 4), cfg, T0 + 30_000);
    expect(s.motion).toBe('moving');
    expect(applyLivePoints(s, pts.slice(4), cfg, T0 + 90_000)).toBe(true);
    expect(s.motion).toBe('stopped');
    expect(s.stoppedSinceMs).toBe(T0 + 30_000); // median of (30, 2, 1) = 2 → low since t=30
    const resume = classifyBatch([p(100, { spd: 35 }), p(110, { spd: 40 })], { ...win, lastLiveAtMs: T0 + 90_000 }).live;
    applyLivePoints(s, resume.slice(0, 1), cfg, T0 + 100_000);
    expect(s.motion).toBe('stopped'); // median(0, 0, 35) = 0
    applyLivePoints(s, resume.slice(1), cfg, T0 + 110_000);
    expect(s.motion).toBe('moving');
    expect(s.point?.t).toBe(new Date(T0 + 110_000).toISOString());
    expect(s.lastLiveAtMs).toBe(T0 + 110_000);
    expect(s.receivedAtMs).toBe(T0 + 110_000);
  });

  it('ignores inaccurate fixes (> 50 m) for state changes and derives speed from positions when spd is missing', () => {
    const s = seed();
    applyLivePoints(s, classifyBatch([p(0, { spd: 30 }), p(10, { spd: 0, acc: 120 }), p(20, { spd: 0, acc: 200 })], win).live, cfg, T0 + 20_000);
    expect(s.speeds).toEqual([30]);
    const t = seed();
    applyLivePoints(t, classifyBatch([p(0), p(10, { lat: 12.9 + 0.1 * KM }), p(20, { lat: 12.9 + 0.2 * KM }), p(30, { lat: 12.9 + 0.3 * KM })], win).live, cfg, T0 + 30_000);
    expect(t.speeds.length).toBe(3);
    expect(median(t.speeds)).toBeGreaterThan(35);
    expect(t.ewmaSpeedMps! * 3.6).toBeGreaterThan(30);
  });

  it('keeps an exponentially weighted speed that decays towards new samples', () => {
    const s = seed();
    applyLivePoints(s, classifyBatch([p(0, { spd: 36 })], win).live, cfg, T0);
    expect(s.ewmaSpeedMps).toBeCloseTo(10, 5);
    applyLivePoints(s, classifyBatch([p(180, { spd: 0 }), p(190, { spd: 0 }), p(200, { spd: 0 })], { ...win, lastLiveAtMs: T0 }).live, cfg, T0 + 200_000);
    const afterStop = s.ewmaSpeedMps!;
    expect(afterStop).toBeLessThan(7); // median smoothing (36, 0, 0) then decay over ~3 min
    expect(afterStop).toBeGreaterThan(0);
    applyLivePoints(s, classifyBatch([p(400, { spd: 0 }), p(600, { spd: 0 })], { ...win, lastLiveAtMs: T0 + 200_000 }).live, cfg, T0 + 600_000);
    expect(s.ewmaSpeedMps!).toBeLessThan(afterStop / 3);
  });
});

const track = (pts: [number, number, number?, number?][]): TrackPoint[] => pts.map(([s, km, acc = 8, spd = 30]) => ({ ms: T0 + s * 1000, lat: 12.9 + km * KM, lng: 77.6, acc, spd }));

describe('post-trip track math', () => {
  it('drops inaccurate fixes and single GPS spikes but keeps genuine movement', () => {
    const pts = track([[0, 0], [10, 0.08], [20, 5], [30, 0.25], [40, 0.33, 300], [50, 0.42]]);
    const { kept, outliers } = filterTrack(pts);
    expect(outliers).toBe(2);
    expect(kept.map((x) => (x.ms - T0) / 1000)).toEqual([0, 10, 30, 50]);
  });

  it('sums segment distances and suppresses stationary jitter', () => {
    const moving = track(Array.from({ length: 101 }, (_, i) => [i * 10, i * 0.0833] as [number, number]));
    expect(toKm1(trackDistanceM(moving))).toBeCloseTo(8.3, 1);
    const jitter: TrackPoint[] = Array.from({ length: 60 }, (_, i) => ({ ms: T0 + i * 10_000, lat: 12.9 + (i % 2 ? 3 : -3) / 111_195, lng: 77.6, acc: 10, spd: 0 }));
    expect(trackDistanceM(jitter)).toBe(0);
  });

  it('detects stop visits (first entry, exit with hysteresis, closest approach)', () => {
    const stops = [0, 1].map((i) => ({ id: `s${i}`, sequence: i + 1, name: `S${i}`, lat: 12.9 + i * KM, lng: 77.6, radiusM: 100, expectedTime: null, plannedAtMs: null, progressM: i * 1000 }));
    const pts = track([[0, -0.5], [10, -0.05], [20, 0], [80, 0.01], [90, 0.2], [100, 0.95], [110, 1.0], [140, 1.3]]);
    const v = detectStopVisits(pts, stops);
    expect(v.map((x) => [x.stopId, (x.arrivedMs - T0) / 1000, x.departedMs === null ? null : (x.departedMs - T0) / 1000])).toEqual([
      ['s0', 10, 90],
      ['s1', 100, 140],
    ]);
    expect(v[0]!.distanceM).toBeLessThan(1);
  });

  it('computes deviation from the planned polyline and over-speed runs', () => {
    const polyline = [{ lat: 12.9, lng: 77.6 }, { lat: 12.9 + 2 * KM, lng: 77.6 }];
    const pts: TrackPoint[] = [0, 0.5, 1, 1.5].map((km, i) => ({ ms: T0 + i * 10_000, lat: 12.9 + km * KM, lng: 77.6 + (i >= 1 ? 0.004 : 0), acc: 8, spd: 30 }));
    const d = deviationStats(pts, polyline, 300)!;
    expect(d.maxM).toBeGreaterThan(400);
    expect(d.pointsOverThreshold).toBe(3);
    expect(d.longestRunOverThreshold).toBe(3);
    const speeds = track([[0, 0, 8, 50], [10, 0.1, 8, 70], [20, 0.3, 8, 72], [30, 0.5, 8, 75], [40, 0.7, 8, 40], [50, 0.8, 8, 66], [60, 0.9, 8, 61]]);
    expect(speedStats(speeds, 60, 4)).toMatchObject({ maxKmh: 75, overSpeedPoints: 5, overSpeedEvents: 1, limitKmh: 60 });
    expect(speedStats(speeds, null, 4)).toMatchObject({ overSpeedPoints: null, overSpeedEvents: null });
    expect(maxGapS(speeds)).toBe(10);
  });
});

describe('gap alert type', () => {
  it('follows the last fix: low battery, no network, otherwise GPS disabled', () => {
    const base = { t: '', lat: 0, lng: 0, spd: null, hdg: null, acc: null, mv: null };
    expect(gapAlertType({ ...base, bat: 5, net: '4g' })).toBe('low_battery');
    expect(gapAlertType({ ...base, bat: 60, net: 'none' })).toBe('no_network');
    expect(gapAlertType({ ...base, bat: 60, net: '4g' })).toBe('gps_disabled');
    expect(gapAlertType(null)).toBe('gps_disabled');
  });
});
