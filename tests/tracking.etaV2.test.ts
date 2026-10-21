// ETA v2 (BP §9.5 optional routing-API ETA every N minutes, cached; contract §2 "behind a setting"): the
// traffic-aware Google request (origin + upcoming stops + route end, key header, TRAFFIC_AWARE), the per-trip
// refresh interval across calls, the school-scoped kv key, the fallback to ETA v1 when the feature is off, the
// key is missing or Google fails (Routes API not enabled → 403), and applying a fresh snapshot in analyzePoints.
import { describe, expect, it } from 'vitest';
import { analyzePoints } from '../src/modules/tracking/analytics.js';
import { toTrackingConfig, type TrackingConfig } from '../src/modules/tracking/config.js';
import { applyEtaV2, ETA_V2_MAX_AGE_S, etaV2Key, readEtaV2, refreshEtaV2, type EtaV2Snapshot } from '../src/modules/tracking/etaV2.js';
import type { TripGeometry } from '../src/modules/tracking/geometry.js';
import { newLiveState, type StoredLiveState } from '../src/modules/tracking/liveState.js';
import { encodePolyline } from '../src/shared/geo.js';
import { createMemoryKv } from '../src/shared/kv.js';
import type { FetchLike } from '../src/shared/routing.js';

const T0 = Date.parse('2026-10-19T01:30:00.000Z');
const KM = 1 / 111.195; // degrees of latitude per km
const LAT0 = 12.9;
const LNG = 77.6;
const at = (km: number) => ({ lat: LAT0 + km * KM, lng: LNG });

// Straight route north: S1 at 2 km, S2 at 4 km, school at 6 km.
const geometry: TripGeometry = {
  tripId: 'trip-1', routeId: 'route-1', direction: 'morning', tripDate: '2026-10-19', timezone: 'Asia/Kolkata',
  polyline: [at(0), at(6)], encoded: null, source: 'straight', totalM: 6000, school: { ...at(6), radiusM: 200 },
  stops: [
    { id: 'S1', sequence: 1, name: 'Stop 1', ...at(2), radiusM: 75, expectedTime: '07:05', plannedAtMs: T0 + 5 * 60_000, progressM: 2000 },
    { id: 'S2', sequence: 2, name: 'Stop 2', ...at(4), radiusM: 75, expectedTime: '07:10', plannedAtMs: T0 + 10 * 60_000, progressM: 4000 },
  ],
};

const cfg = (etaV2Enabled: boolean): TrackingConfig => ({
  movingIntervalS: 10, stoppedIntervalS: 90, movingSpeedKmh: 4, stoppedAfterS: 60, speedLimitKmh: null, speedingEnabled: false,
  routeDeviationEnabled: false, routeDeviationM: 300, stopDurationAlertMin: 10, tripDelayThresholdMin: 10, tripNotStartedGraceMin: 10,
  approachingStopMinutes: 5, etaV2Enabled,
});

function liveAt(km: number, ms = T0): StoredLiveState {
  const s = newLiveState({ schoolId: 'school-A', tripId: 'trip-1', busId: 'bus-1', routeId: 'route-1', direction: 'morning', tripStatus: 'in_progress', lastPointAt: null });
  s.point = { t: new Date(ms).toISOString(), ...at(km), spd: 30, hdg: 0, acc: 8, bat: 80, net: '4g', mv: true };
  s.ewmaSpeedMps = 30 / 3.6;
  return s;
}

/** analyzePoints with no new points recomputes the ETA from state.point. */
function withEta(s: StoredLiveState, nowMs: number, snapshot: EtaV2Snapshot | null = null, enabled = false) {
  analyzePoints(s, [], geometry, cfg(enabled), nowMs, snapshot);
  return s;
}

function fakeGoogle(legSeconds: number[], status = 200) {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> });
    const pts = 2 + ((JSON.parse(init.body) as { intermediates: unknown[] }).intermediates.length);
    return {
      ok: status === 200,
      status,
      json: async () => ({
        routes: [{
          distanceMeters: 6000,
          duration: `${legSeconds.reduce((a, b) => a + b, 0)}s`,
          polyline: { encodedPolyline: encodePolyline(Array.from({ length: pts }, (_, i) => at(i))) },
          legs: legSeconds.slice(0, pts - 1).map((d) => ({ distanceMeters: 2000, duration: `${d}s` })),
        }],
      }),
    };
  };
  return { calls, fetchImpl };
}

describe('ETA v2 refresh', () => {
  it('asks Google once per interval (traffic-aware, origin + upcoming stops + route end) and caches a school-scoped snapshot', async () => {
    const store = createMemoryKv();
    const s = withEta(liveAt(0.5), T0);
    expect(s.eta?.stops.map((x) => x.stopId)).toEqual(['S1', 'S2']);
    const g = fakeGoogle([300, 360, 240]);
    const snap = await refreshEtaV2(s, geometry, cfg(true), { store, routing: { apiKey: 'test-key', fetchImpl: g.fetchImpl }, nowMs: T0 });
    expect(snap).toEqual({ v: 1, originMs: T0, computedAtMs: T0, stops: [{ stopId: 'S1', driveS: 300 }, { stopId: 'S2', driveS: 660 }], destinationDriveS: 900 });
    expect(g.calls).toHaveLength(1);
    expect(g.calls[0]!.headers['X-Goog-Api-Key']).toBe('test-key');
    expect(g.calls[0]!.body).toMatchObject({ routingPreference: 'TRAFFIC_AWARE', travelMode: 'DRIVE' });
    expect((g.calls[0]!.body.intermediates as unknown[]).length).toBe(2); // S1, S2 between the bus and the school
    expect(etaV2Key('school-A', 'trip-1')).toContain('school-A');
    expect(await readEtaV2('school-A', 'trip-1', store)).toEqual(snap);

    // Within the refresh interval nothing is asked again (claim held), whatever the caller.
    expect(await refreshEtaV2(s, geometry, cfg(true), { store, routing: { apiKey: 'test-key', fetchImpl: g.fetchImpl } })).toBeNull();
    expect(g.calls).toHaveLength(1);
    // Another school's trip with the same id has its own claim and key.
    const other = { ...s, schoolId: 'school-B' };
    expect(await refreshEtaV2(other, geometry, cfg(true), { store, routing: { apiKey: 'test-key', fetchImpl: g.fetchImpl }, nowMs: T0 })).not.toBeNull();
    expect(await readEtaV2('school-B', 'trip-1', store)).not.toBeNull();
  });

  it('asks nothing while the feature is off, without a key, without a usable v1 ETA or after the trip ended', async () => {
    const g = fakeGoogle([300, 360, 240]);
    const s = withEta(liveAt(0.5), T0);
    const opts = { routing: { apiKey: 'k', fetchImpl: g.fetchImpl } };
    expect(await refreshEtaV2(s, geometry, cfg(false), { store: createMemoryKv(), ...opts })).toBeNull();
    expect(await refreshEtaV2(s, geometry, cfg(true), { store: createMemoryKv(), routing: { apiKey: null, fetchImpl: g.fetchImpl } })).toBeNull();
    const stale = withEta(liveAt(0.5), T0 + 3600_000); // position an hour old → v1 unavailable
    expect(stale.eta?.quality).toBe('unavailable');
    expect(await refreshEtaV2(stale, geometry, cfg(true), { store: createMemoryKv(), ...opts })).toBeNull();
    expect(await refreshEtaV2({ ...s, tripStatus: 'completed' }, geometry, cfg(true), { store: createMemoryKv(), ...opts })).toBeNull();
    expect(g.calls).toHaveLength(0);
  });

  it('keeps ETA v1 when Google refuses (Routes API not enabled → 403) and does not retry within the interval', async () => {
    const store = createMemoryKv();
    const g = fakeGoogle([300, 360, 240], 403);
    const s = withEta(liveAt(0.5), T0);
    expect(await refreshEtaV2(s, geometry, cfg(true), { store, routing: { apiKey: 'k', fetchImpl: g.fetchImpl } })).toBeNull();
    expect(await readEtaV2('school-A', 'trip-1', store)).toBeNull();
    expect(await refreshEtaV2(s, geometry, cfg(true), { store, routing: { apiKey: 'k', fetchImpl: g.fetchImpl } })).toBeNull();
    expect(g.calls).toHaveLength(1);
  });
});

describe('applying ETA v2', () => {
  const snap: EtaV2Snapshot = { v: 1, originMs: T0, computedAtMs: T0, stops: [{ stopId: 'S1', driveS: 600 }, { stopId: 'S2', driveS: 1200 }], destinationDriveS: 1500 };

  it('replaces the stop times with origin + drive time + dwell and marks source v2 (feature on only)', () => {
    const v1 = withEta(liveAt(0.5), T0).eta!;
    expect(v1.source).toBeUndefined();
    const s = withEta(liveAt(0.5), T0, snap, true);
    expect(s.eta!.source).toBe('v2');
    expect(s.eta!.stops.map((x) => [x.stopId, x.etaAt, x.delayMin])).toEqual([
      ['S1', new Date(T0 + 600_000).toISOString(), 5],
      ['S2', new Date(T0 + 1_230_000).toISOString(), 10.5], // + 30 s dwell at S1
    ]);
    expect(s.eta!.destinationEtaAt).toBe(new Date(T0 + 1_560_000).toISOString());
    expect(s.eta!.stops.map((x) => x.remainingM)).toEqual(v1.stops.map((x) => x.remainingM));
    // Feature off: the snapshot is ignored.
    expect(withEta(liveAt(0.5), T0, snap, false).eta).toEqual(v1);
  });

  it('ignores stale snapshots, unknown stops and unavailable ETAs; passed stops drop out', () => {
    const v1 = withEta(liveAt(0.5), T0).eta!;
    expect(applyEtaV2(v1, { ...snap, computedAtMs: T0 - (ETA_V2_MAX_AGE_S + 1) * 1000 }, T0)).toBe(v1);
    expect(applyEtaV2(v1, { ...snap, stops: [{ stopId: 'X', driveS: 1 }] }, T0)).toBe(v1);
    const unavailable = { ...v1, quality: 'unavailable' as const, stops: [] };
    expect(applyEtaV2(unavailable, snap, T0)).toBe(unavailable);
    // Past S1 two minutes later: only S2 remains, still on the snapshot's absolute time.
    const later = withEta(liveAt(2.6, T0 + 120_000), T0 + 120_000, snap, true).eta!;
    expect(later.stops.map((x) => [x.stopId, x.etaAt])).toEqual([['S2', new Date(T0 + 1_230_000).toISOString()]]);
    // Never in the past.
    const late = applyEtaV2(v1, { ...snap, computedAtMs: T0 + 2_990_000 }, T0 + 3_000_000); // fresh snapshot, early origin
    expect(late.source).toBe('v2');
    expect(late.stops.map((x) => x.etaAt)).toEqual([new Date(T0 + 3_000_000).toISOString(), new Date(T0 + 3_000_000).toISOString()]);
  });

  it('the tracking config carries the effective etaV2 feature', () => {
    const base = { effective: { movingIntervalS: 10, stoppedIntervalS: 90, movingSpeedKmh: 4, stoppedAfterS: 60, features: { etaV2: true } } };
    expect(toTrackingConfig(base as never).etaV2Enabled).toBe(true);
    expect(toTrackingConfig({ effective: { ...base.effective, features: { etaV2: false } } } as never).etaV2Enabled).toBe(false);
  });
});
