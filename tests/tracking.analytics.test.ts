// Per-point analytics through the real pipeline (ingest → points-persist job → analytics): stop
// arrival + departure + dwell (trip_stop_events), school exit, ETA in the live state, the
// feature-flagged checks (speeding, route deviation over N points, long unscheduled stop) raising
// deduplicated alerts, Socket.IO fan-out (fleet every point, trip room coalesced, status changes).
import { SOCKET_EVENTS } from '@wimb/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { liveStore } from '../src/modules/tracking/liveState.js';
import { useRealtime } from '../src/modules/tracking/publish.js';
import type { Realtime } from '../src/shared/realtime.js';
import { events } from '../src/shared/events.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import { buildApp, type TestApp } from './helpers/authApp.js';
import { drainJobs, KM_LAT, northbound, ORIGIN, parked, postPoints, trackingWorld, type GenPoint, type TrackingWorld } from './helpers/trackingWorld.js';

let t: TestApp;
let w: TrackingWorld;
let restore: () => void;
const emitted: { room: string; event: string; payload: { change?: string; live?: { point?: { t: string } } } }[] = [];
const appEvents: string[] = [];
let cursor = 0;

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  w = await trackingWorld(t.app, {
    settings: { speed_limit_kmh: 40, enable_speeding_alert: true, enable_route_deviation_alert: true, route_deviation_m: 150, stop_duration_alert_min: 2, stopped_after_s: 60 },
  });
  const fake = {
    emit: async (room: string, event: string, payload: unknown) => {
      emitted.push({ room, event, payload: payload as never });
    },
    disconnectSessions: async () => undefined,
    disconnectSchool: async () => undefined,
  } as unknown as Realtime;
  restore = useRealtime(fake);
  for (const name of ['tracking.stop_arrived', 'tracking.stop_departed', 'tracking.left_school', 'tracking.eta_updated'] as const) {
    events.on(name, () => {
      appEvents.push(name);
    });
  }
  cursor = Date.now() - 50 * 60_000;
});
afterAll(async () => {
  restore();
  await drainJobs();
  await closeDb();
});

async function send(points: GenPoint[]) {
  const res = await postPoints(t.app, w, points);
  expect(res.status).toBe(200);
  await drainJobs();
  cursor = Date.parse(points.at(-1)!.t) + 10_000;
  return res.body.data as { accepted: number; nextIntervalS: number };
}

const stopEvents = async () =>
  (
    await ownerQuery<{ stop_id: string; arrived_at: string; departed_at: string | null; dwell_s: number | null; distance_m: number; source: string }>(
      'select stop_id, arrived_at, departed_at, dwell_s, distance_m, source from trip_stop_events where trip_id = $1 order by arrived_at',
      [w.trip.id],
    )
  ).rows;
const alerts = async () => (await ownerQuery<{ alert_type: string; dedupe_key: string; trip_id: string; entity_type: string }>('select alert_type, dedupe_key, trip_id, entity_type from alerts where school_id = $1 order by created_at', [w.school.id])).rows;

describe('stop arrival and dwell', () => {
  it('records the arrival when the bus enters the stop geofence', async () => {
    await send(northbound({ baseMs: cursor, fromKm: -0.5, kmh: 30, count: 6 }));
    const ev = await stopEvents();
    expect(ev).toHaveLength(1);
    expect(ev[0]!).toMatchObject({ stop_id: w.stops[0]!.id, departed_at: null, source: 'live' });
    expect(ev[0]!.distance_m).toBeLessThanOrEqual(100);
    const state = await liveStore.get(String(w.school.id), w.trip.id);
    expect(state!.currentStop?.stopId).toBe(w.stops[0]!.id);
    expect(state!.visitedStopIds).toEqual([w.stops[0]!.id]);
    expect(appEvents).toContain('tracking.stop_arrived');
  });

  it('records the departure and the dwell when the bus leaves the geofence', async () => {
    const arrived = Date.parse((await stopEvents())[0]!.arrived_at);
    const dwell = parked({ baseMs: cursor, km: 0, stepS: 10, count: 9 });
    const r = await send(dwell);
    expect(r.nextIntervalS).toBe(90); // stopped after 60 s at 0 km/h → stopped interval
    await send(northbound({ baseMs: cursor, fromKm: 0.1, kmh: 30, count: 12 }));
    const ev = await stopEvents();
    const s1 = ev.find((e) => e.stop_id === w.stops[0]!.id)!;
    expect(s1.departed_at).not.toBeNull();
    expect(s1.dwell_s).toBe(Math.round((Date.parse(s1.departed_at!) - arrived) / 1000));
    expect(s1.dwell_s!).toBeGreaterThanOrEqual(90);
    expect(ev.find((e) => e.stop_id === w.stops[1]!.id)).toBeDefined();
    expect(appEvents).toContain('tracking.stop_departed');
    const statusChanges = emitted.filter((e) => e.event === SOCKET_EVENTS.LIVE_STATUS).map((e) => e.payload.change);
    expect(statusChanges).toEqual(expect.arrayContaining(['stop_arrived', 'stop_departed', 'motion']));
  });

  it('fans every live point out to the fleet room and coalesces the trip room', async () => {
    const fleet = emitted.filter((e) => e.room === `school:${w.school.id}:fleet` && e.event === SOCKET_EVENTS.LIVE_POSITION);
    const trip = emitted.filter((e) => e.room === `trip:${w.trip.id}` && e.event === SOCKET_EVENTS.LIVE_POSITION);
    expect(fleet.length).toBe(3); // one per request with live points
    expect(trip.length).toBeLessThanOrEqual(fleet.length);
    expect(trip.length).toBeGreaterThanOrEqual(1);
    expect(emitted.every((e) => !e.room.includes('undefined'))).toBe(true);
  });
});

describe('feature-flagged checks', () => {
  it('raises one speeding alert after 3 consecutive fixes above the limit', async () => {
    const start = (await liveStore.get(String(w.school.id), w.trip.id))!.point!;
    const km = (start.lat - ORIGIN.lat) / KM_LAT;
    await send(northbound({ baseMs: cursor, fromKm: km + 0.05, kmh: 60, count: 5 }));
    await send(northbound({ baseMs: cursor, fromKm: km + 0.9, kmh: 65, count: 4 }));
    const speeding = (await alerts()).filter((a) => a.alert_type === 'speeding');
    expect(speeding).toHaveLength(1);
    expect(speeding[0]).toMatchObject({ dedupe_key: `speeding:${w.trip.id}`, trip_id: w.trip.id, entity_type: 'trip' });
    const bell = emitted.filter((e) => e.event === SOCKET_EVENTS.ALERT_NEW);
    expect(bell.length).toBe(0); // alerts go through the alerts service's realtime (not the tracking fake)
  });

  it('raises route_deviation after N consecutive off-route fixes', async () => {
    const pts = northbound({ baseMs: cursor, fromKm: 2.2, kmh: 20, count: 4 }).map((x) => ({ ...x, lng: ORIGIN.lng + 0.003 }));
    await send(pts);
    const dev = (await alerts()).filter((a) => a.alert_type === 'route_deviation');
    expect(dev).toHaveLength(1);
    const state = await liveStore.get(String(w.school.id), w.trip.id);
    expect(state!.distanceFromRouteM!).toBeGreaterThan(150);
  });

  it('raises long_stop for an unscheduled stop outside every geofence beyond the threshold', async () => {
    await send(parked({ baseMs: cursor, km: 2.3, stepS: 90, count: 4, lngOffset: 0.003 }));
    const longStop = (await alerts()).filter((a) => a.alert_type === 'long_stop');
    expect(longStop).toHaveLength(1);
    expect(longStop[0]!.dedupe_key).toMatch(new RegExp(`^long_stop:${w.trip.id}:\\d+$`));
  });

  it('does not repeat alerts while they are open', async () => {
    await send(northbound({ baseMs: cursor, fromKm: 2.4, kmh: 70, count: 4 }).map((x) => ({ ...x, lng: ORIGIN.lng + 0.003 })));
    const byType = (await alerts()).reduce<Record<string, number>>((m, a) => ({ ...m, [a.alert_type]: (m[a.alert_type] ?? 0) + 1 }), {});
    expect(byType.speeding).toBe(1);
    expect(byType.route_deviation).toBe(1);
  });
});

describe('ETA in the live state', () => {
  it('computes a quality-gated ETA for the upcoming stops from a fresh fix', async () => {
    const now = Date.now();
    await send([{ t: new Date(now - 20_000).toISOString(), lat: ORIGIN.lat + 1.5 * KM_LAT, lng: ORIGIN.lng, spd: 30, acc: 8 }, { t: new Date(now - 5_000).toISOString(), lat: ORIGIN.lat + 1.62 * KM_LAT, lng: ORIGIN.lng, spd: 30, acc: 8 }]);
    const state = await liveStore.get(String(w.school.id), w.trip.id);
    expect(state!.eta).not.toBeNull();
    expect(state!.eta!.quality).not.toBe('unavailable');
    // Stops 1–3 were reached earlier in this trip; only stop 4 is still ahead.
    expect(state!.visitedStopIds).toEqual(w.stops.slice(0, 3).map((s) => s.id));
    expect(state!.eta!.stops.map((s) => s.stopId)).toEqual([w.stops[3]!.id]);
    expect(Date.parse(state!.eta!.stops[0]!.etaAt)).toBeGreaterThan(now - 10_000);
    expect(appEvents).toContain('tracking.eta_updated');
  });

  it('reports a stale-position ETA as unavailable', async () => {
    const state = await liveStore.get(String(w.school.id), w.trip.id);
    expect(['good', 'degraded']).toContain(state!.eta!.quality);
    const { computeEta } = await import('../src/modules/tracking/eta.js');
    const r = computeEta({ geometry: null, position: null, ewmaSpeedMps: null, hintProgressM: null, visitedStopIds: [], currentStopId: null, nowMs: Date.now(), staleAfterS: 30, routeDeviationM: 150 });
    expect(r.eta.quality).toBe('unavailable');
  });
});
