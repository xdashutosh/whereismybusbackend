// ETA v1 (BP §9.5) on a synthetic straight route and the parent status derivation (BP §9.4).
import type { TripLiveState } from '@wimb/shared';
import { describe, expect, it } from 'vitest';
import {
  BLEND_MIN_WEIGHT,
  computeEta,
  ETA_DEFAULT_SPEED_KMH,
  ETA_DWELL_S,
  ETA_SPEED_CEILING_KMH,
  ETA_SPEED_FLOOR_KMH,
  etaSpeedMps,
  physicsWeight,
  type EtaInput,
} from '../src/modules/tracking/eta.js';
import { buildGeometry, type TripGeometry } from '../src/modules/tracking/geometry.js';
import { parentStatus } from '../src/modules/tracking/status.js';

const KM = 1 / 111.195;
const T0 = Date.parse('2026-10-19T01:30:00.000Z'); // 07:00 IST

/** 4 stops 1 km apart northwards + the school 1 km after the last stop; timetable 5 min apart. */
function geometry(): TripGeometry {
  return buildGeometry({
    trip_id: 't1',
    route_id: 'r1',
    direction: 'morning',
    trip_date: '2026-10-19',
    polyline_encoded: null,
    polyline_source: null,
    school_lat: 12.9 + 4 * KM,
    school_lng: 77.6,
    school_radius_m: 150,
    timezone: 'Asia/Kolkata',
    stops: [0, 1, 2, 3].map((i) => ({
      id: `s${i + 1}`,
      sequence: i + 1,
      name: `Stop ${i + 1}`,
      latitude: 12.9 + i * KM,
      longitude: 77.6,
      expected_time: null,
      arrival_radius_m: 100,
      planned_at: new Date(T0 + (10 + i * 5) * 60_000).toISOString(),
    })),
  });
}

function input(over: Partial<EtaInput> = {}): EtaInput {
  return {
    geometry: geometry(),
    position: { lat: 12.9 + 0.5 * KM, lng: 77.6, ms: T0, acc: 8 },
    ewmaSpeedMps: 30 / 3.6,
    hintProgressM: null,
    visitedStopIds: ['s1'],
    currentStopId: null,
    nowMs: T0,
    staleAfterS: 30,
    routeDeviationM: 300,
    ...over,
  };
}

describe('geometry', () => {
  it('builds the straight path through the stops and the school with stop progress', () => {
    const g = geometry();
    expect(g.source).toBe('straight');
    expect(g.polyline).toHaveLength(5);
    expect(g.totalM).toBeGreaterThan(3990);
    expect(g.totalM).toBeLessThan(4010);
    expect(g.stops.map((s) => Math.round(s.progressM / 10) * 10)).toEqual([0, 1000, 2000, 3000]);
    expect(g.stops[0]!.plannedAtMs).toBe(T0 + 10 * 60_000);
  });
});

describe('ETA v1 math', () => {
  it('divides the remaining distance by the smoothed speed and adds a dwell per intermediate stop', () => {
    const { eta, projection } = computeEta(input());
    expect(eta.quality).toBe('good');
    expect(Math.round(projection!.progressM)).toBeGreaterThan(495);
    expect(eta.stops.map((s) => s.stopId)).toEqual(['s2', 's3', 's4']);
    const s2 = eta.stops[0]!;
    // 500 m at 30 km/h = 60 s
    expect(s2.remainingM).toBeGreaterThan(495);
    expect(s2.remainingM).toBeLessThan(505);
    expect(Math.abs(Date.parse(s2.etaAt) - (T0 + 60_000))).toBeLessThan(1500);
    // s3: physics = 1500 m / 8.33 m/s + 1 dwell = 180 s + 30 s; timetable = s2 eta + 5 min; blended by distance.
    const s3 = eta.stops[1]!;
    const physics = T0 + 180_000 + ETA_DWELL_S * 1000;
    const timetable = Date.parse(s2.etaAt) + 5 * 60_000;
    const w = physicsWeight(s3.remainingM);
    expect(Math.abs(Date.parse(s3.etaAt) - (w * physics + (1 - w) * timetable))).toBeLessThan(1500);
    expect(eta.speedKmh).toBe(30);
    expect(eta.destinationEtaAt).not.toBeNull();
    expect(Date.parse(eta.destinationEtaAt!)).toBeGreaterThan(Date.parse(eta.stops[2]!.etaAt));
  });

  it('reports the delay against the timetable', () => {
    const late = computeEta(input({ nowMs: T0 + 20 * 60_000, position: { lat: 12.9 + 0.5 * KM, lng: 77.6, ms: T0 + 20 * 60_000, acc: 8 } }));
    const s2 = late.eta.stops[0]!;
    // planned 07:15, ETA ≈ 07:21 → ≈ 6 min late
    expect(s2.delayMin).toBeGreaterThan(5.5);
    expect(s2.delayMin).toBeLessThan(6.5);
  });

  it('applies the speed floor (red light) and ceiling (GPS spike) and a default without history', () => {
    expect(etaSpeedMps(0) * 3.6).toBeCloseTo(ETA_SPEED_FLOOR_KMH, 5);
    expect(etaSpeedMps(200 / 3.6) * 3.6).toBeCloseTo(ETA_SPEED_CEILING_KMH, 5);
    expect(etaSpeedMps(null) * 3.6).toBeCloseTo(ETA_DEFAULT_SPEED_KMH, 5);
    const stopped = computeEta(input({ ewmaSpeedMps: 0 }));
    const s2 = stopped.eta.stops[0]!;
    // 500 m at the 10 km/h floor = 180 s, never infinite
    expect(Math.abs(Date.parse(s2.etaAt) - (T0 + 180_000))).toBeLessThan(2000);
  });

  it('weights the physical estimate 1 near the bus and down to the minimum far away', () => {
    expect(physicsWeight(500)).toBe(1);
    expect(physicsWeight(1000)).toBe(1);
    expect(physicsWeight(11_000)).toBeCloseTo(0.8, 5);
    expect(physicsWeight(100_000)).toBe(BLEND_MIN_WEIGHT);
  });

  it('skips visited stops, the current stop and stops already passed', () => {
    const { eta } = computeEta(input({ position: { lat: 12.9 + 1.5 * KM, lng: 77.6, ms: T0, acc: 8 }, visitedStopIds: ['s1'], currentStopId: null }));
    expect(eta.stops.map((s) => s.stopId)).toEqual(['s3', 's4']);
    const atStop = computeEta(input({ position: { lat: 12.9 + 2 * KM, lng: 77.6, ms: T0, acc: 8 }, visitedStopIds: ['s1', 's2', 's3'], currentStopId: 's3' }));
    expect(atStop.eta.stops.map((s) => s.stopId)).toEqual(['s4']);
  });

  it('never predicts an arrival in the past', () => {
    const { eta } = computeEta(input({ nowMs: T0 + 10_000, position: { lat: 12.9 + 0.99 * KM, lng: 77.6, ms: T0, acc: 8 }, staleAfterS: 60 }));
    expect(Date.parse(eta.stops[0]!.etaAt)).toBeGreaterThanOrEqual(T0 + 10_000);
  });
});

describe('ETA quality gating', () => {
  it('gives no ETA without a route, without a position or with a stale position', () => {
    expect(computeEta(input({ geometry: null })).eta).toMatchObject({ quality: 'unavailable', reason: 'NO_ROUTE', stops: [] });
    expect(computeEta(input({ position: null })).eta.reason).toBe('NO_POSITION');
    expect(computeEta(input({ nowMs: T0 + 31_000 })).eta).toMatchObject({ quality: 'unavailable', reason: 'STALE_POSITION' });
  });

  it('gives no ETA for inaccurate or off-route fixes, a degraded one for mediocre accuracy or no history', () => {
    expect(computeEta(input({ position: { lat: 12.9 + 0.5 * KM, lng: 77.6, ms: T0, acc: 150 } })).eta.reason).toBe('LOW_ACCURACY');
    const off = computeEta(input({ position: { lat: 12.9 + 0.5 * KM, lng: 77.6 + 0.01, ms: T0, acc: 8 } }));
    expect(off.eta).toMatchObject({ quality: 'unavailable', reason: 'OFF_ROUTE' });
    expect(off.projection!.distanceFromRouteM).toBeGreaterThan(1000);
    expect(computeEta(input({ position: { lat: 12.9 + 0.5 * KM, lng: 77.6, ms: T0, acc: 70 } })).eta).toMatchObject({ quality: 'degraded', reason: 'LOW_ACCURACY' });
    expect(computeEta(input({ ewmaSpeedMps: null })).eta).toMatchObject({ quality: 'degraded', reason: 'NO_SPEED_HISTORY' });
  });
});

function live(over: Partial<TripLiveState> = {}): TripLiveState {
  const { eta } = computeEta(input());
  return {
    tripId: 't1', busId: 'b1', routeId: 'r1', direction: 'morning', tripStatus: 'in_progress',
    point: { t: new Date(T0).toISOString(), lat: 12.9, lng: 77.6, spd: 30, hdg: 0, acc: 8, bat: 80, net: '4g', mv: true },
    receivedAt: new Date(T0).toISOString(), motion: 'moving', stoppedSince: null, freshness: 'live', ageS: 0, locationUnavailable: false,
    progressM: 500, distanceFromRouteM: 0, currentStop: null, visitedStopIds: ['s1'], eta, ...over,
  };
}
const opts = { nowMs: T0, delayThresholdMin: 10, notStartedGraceMin: 10 };

describe('parentStatus (BP §9.4)', () => {
  it('derives not started / delayed (past grace) / completed from the trip', () => {
    const planned = new Date(T0).toISOString();
    expect(parentStatus({ status: 'scheduled', plannedStartAt: planned }, null, { stopId: 's2' }, { ...opts, nowMs: T0 + 5 * 60_000 }).status).toBe('not_started');
    const late = parentStatus({ status: 'scheduled', plannedStartAt: planned }, null, { stopId: 's2' }, { ...opts, nowMs: T0 + 11 * 60_000 });
    expect(late).toMatchObject({ status: 'delayed', reason: 'NOT_STARTED_PAST_GRACE', delayMin: 11 });
    expect(parentStatus({ status: 'missed', plannedStartAt: planned }, null, null, opts).status).toBe('delayed');
    expect(parentStatus({ status: 'completed', plannedStartAt: planned }, live(), null, opts).status).toBe('completed');
    expect(parentStatus({ status: 'cancelled', plannedStartAt: planned }, null, null, opts)).toMatchObject({ status: 'not_started', reason: 'TRIP_CANCELLED' });
  });

  it('derives on route / bus stopped with the ETA to the child’s stop', () => {
    const r = parentStatus({ status: 'in_progress', plannedStartAt: null }, live(), { stopId: 's2' }, opts);
    expect(r.status).toBe('on_route');
    expect(r.etaMinutes).toBe(1);
    expect(r.etaAt).not.toBeNull();
    expect(r.lastUpdatedAt).toBe(new Date(T0).toISOString());
    expect(parentStatus({ status: 'in_progress', plannedStartAt: null }, live({ motion: 'stopped' }), { stopId: 's2' }, opts).status).toBe('bus_stopped');
  });

  it('derives arrived at stop from the geofence and location unavailable from staleness', () => {
    const atStop = live({ currentStop: { stopId: 's2', name: 'Stop 2', sequence: 2, arrivedAt: new Date(T0).toISOString() }, visitedStopIds: ['s1', 's2'] });
    expect(parentStatus({ status: 'in_progress', plannedStartAt: null }, atStop, { stopId: 's2' }, opts)).toMatchObject({ status: 'arrived_at_stop', etaMinutes: 0, stopPassed: false });
    expect(parentStatus({ status: 'in_progress', plannedStartAt: null }, live({ freshness: 'stale', locationUnavailable: true }), { stopId: 's2' }, opts)).toMatchObject({ status: 'location_unavailable', etaAt: null });
    expect(parentStatus({ status: 'in_progress', plannedStartAt: null }, null, { stopId: 's2' }, opts).reason).toBe('NO_POSITION_YET');
  });

  it('derives delayed when the ETA exceeds the timetable + threshold, and hides the ETA when quality is unavailable', () => {
    const lateEta = computeEta(input({ nowMs: T0 + 30 * 60_000, position: { lat: 12.9 + 0.5 * KM, lng: 77.6, ms: T0 + 30 * 60_000, acc: 8 } })).eta;
    const r = parentStatus({ status: 'in_progress', plannedStartAt: null }, live({ eta: lateEta }), { stopId: 's2' }, { ...opts, nowMs: T0 + 30 * 60_000 });
    expect(r).toMatchObject({ status: 'delayed', reason: 'ETA_LATE' });
    expect(r.delayMin!).toBeGreaterThan(10);
    const noEta = live({ eta: { computedAt: new Date(T0).toISOString(), quality: 'unavailable', reason: 'OFF_ROUTE', speedKmh: 0, stops: [], destinationEtaAt: null } });
    expect(parentStatus({ status: 'in_progress', plannedStartAt: null }, noEta, { stopId: 's2', plannedAt: new Date(T0 + 15 * 60_000).toISOString() }, opts)).toMatchObject({ status: 'on_route', etaAt: null, plannedAt: new Date(T0 + 15 * 60_000).toISOString() });
  });

  it('flags a stop already passed (pickup/drop done)', () => {
    const r = parentStatus({ status: 'in_progress', plannedStartAt: null }, live({ visitedStopIds: ['s1', 's2'] }), { stopId: 's1' }, opts);
    expect(r.stopPassed).toBe(true);
    expect(r.status).toBe('on_route');
  });
});
