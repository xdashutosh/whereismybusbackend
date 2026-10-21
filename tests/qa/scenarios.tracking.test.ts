// Scenario suite — live tracking reliability (BP §9.1, §9.2, §9.6, §11.2): GPS spikes in live
// analytics, process restart mid-trip (in-memory live state lost), concurrent ingest batches.
// Each test asserts the blueprint behaviour (moved from the pre-release scenario run into the default suite).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lateFinalize } from '../../src/modules/tracking/persist.js';
import { liveStore } from '../../src/modules/tracking/liveState.js';
import { events } from '../../src/shared/events.js';
import { closeDb, ownerQuery, truncateAll } from '../helpers/db.js';
import { buildApp, DEVICE, type TestApp } from '../helpers/authApp.js';
import { drainJobs, KM_LAT, northbound, ORIGIN, postPoints, trackingWorld, type GenPoint, type TrackingWorld } from '../helpers/trackingWorld.js';

let t: TestApp;
let n = 0;
const world = async (): Promise<TrackingWorld> => trackingWorld(t.app, { device: { ...DEVICE, deviceId: `device-scn-${++n}` } });
const post = (w: TrackingWorld, pts: GenPoint[]) => postPoints(t.app, w, pts, { deviceUid: `device-scn-${n}` });

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  lateFinalize.delayMs = 0;
  t = buildApp();
});
afterAll(async () => {
  await drainJobs();
  await closeDb();
});

const arrivals = async (tripId: string) =>
  (await ownerQuery<{ stop_id: string; arrived_at: string }>('select stop_id, arrived_at from trip_stop_events where trip_id = $1 order by arrived_at', [tripId])).rows;

function captureArrivals(): { got: { tripId: string; stopId: string; at: string }[]; off: () => void } {
  const got: { tripId: string; stopId: string; at: string }[] = [];
  const fn = (p: { tripId: string; stopId: string; at: string }) => void got.push({ tripId: p.tripId, stopId: p.stopId, at: p.at });
  events.on('tracking.stop_arrived', fn);
  return { got, off: () => events.off('tracking.stop_arrived', fn) };
}

describe('GPS spike (single implausible fix) during a live trip', () => {
  it('does not record "arrived" at a stop the bus never reached (parents would get a false Arrived push)', async () => {
    const w = await world();
    const cap = captureArrivals();
    const base = Date.now() - 200_000;
    const before = northbound({ baseMs: base, fromKm: 0.3, count: 5 }); // km 0.30 … 0.63, after Stop 1
    // One accurate-looking fix exactly on Stop 4 (2.7 km away 10 s later ≈ 970 km/h), then back on track.
    const spike: GenPoint = { t: new Date(base + 50_000).toISOString(), lat: ORIGIN.lat + 3 * KM_LAT, lng: ORIGIN.lng, spd: 30, hdg: 0, acc: 8, bat: 80, net: '4g', mv: true };
    const after = northbound({ baseMs: base + 60_000, fromKm: 0.8, count: 5 });
    for (const batch of [before, [spike], after]) {
      const r = await post(w, batch);
      expect(r.status).toBe(200);
      await drainJobs();
    }
    cap.off();
    const stop4 = String(w.stops[3]!.id);
    // Expected: no arrival at Stop 4 (the filterTrack spike rule used post-trip should apply live too).
    expect(cap.got.filter((e) => e.tripId === w.trip.id).map((e) => e.stopId)).not.toContain(stop4);
    expect((await arrivals(w.trip.id)).map((r) => r.stop_id)).not.toContain(stop4);
  });
});

describe('GPS spike reference recovery', () => {
  it('accepts the new position after a few consistent fixes when the reference fix itself was wrong', async () => {
    const w = await world();
    const base = Date.now() - 200_000;
    // A stale first fix at the origin, then the real stream around Stop 4 (2.98 km away, 10 s later).
    const r0 = await post(w, northbound({ baseMs: base, fromKm: 0, count: 1 }));
    expect(r0.status).toBe(200);
    await drainJobs();
    const r1 = await post(w, northbound({ baseMs: base + 10_000, fromKm: 2.98, kmh: 2, count: 6 }));
    expect(r1.status).toBe(200);
    await drainJobs();
    // MAX_SPIKE_RUN rejected fixes, then the position is trusted and the arrival is recorded.
    expect((await arrivals(w.trip.id)).map((r) => r.stop_id)).toContain(String(w.stops[3]!.id));
  });
});

describe('process restart mid-trip (in-memory KV: live state lost)', () => {
  it('does not re-announce an arrival already recorded for the trip', async () => {
    const w = await world();
    const cap = captureArrivals();
    const base = Date.now() - 300_000;
    // Approach and enter Stop 2 (km 1.0), stay inside its geofence.
    const r1 = await post(w, northbound({ baseMs: base, fromKm: 0.75, kmh: 18, count: 6 })); // 0.75 … 1.0 km
    expect(r1.status).toBe(200);
    await drainJobs();
    expect(cap.got.map((e) => e.stopId)).toContain(String(w.stops[1]!.id));
    await liveStore.del(String(w.school.id), w.trip.id); // what a restart does without Redis
    const r2 = await post(w, northbound({ baseMs: base + 70_000, fromKm: 1.0, kmh: 2, count: 3 })); // still at Stop 2
    expect(r2.status).toBe(200);
    await drainJobs();
    cap.off();
    const stop2 = cap.got.filter((e) => e.stopId === String(w.stops[1]!.id));
    expect((await arrivals(w.trip.id)).filter((a) => a.stop_id === String(w.stops[1]!.id)).length).toBe(1);
    expect(stop2.length).toBe(1); // a second tracking.stop_arrived re-emits the admin/parent socket status
    // The stop stays the current one: leaving it records the departure against the original arrival.
    const r3 = await post(w, northbound({ baseMs: base + 110_000, fromKm: 1.25, kmh: 30, count: 3 }));
    expect(r3.status).toBe(200);
    await drainJobs();
    const row = (await ownerQuery<{ arrived_at: string; departed_at: string | null; dwell_s: number | null }>(
      'select arrived_at, departed_at, dwell_s from trip_stop_events where trip_id = $1 and stop_id = $2', [w.trip.id, String(w.stops[1]!.id)])).rows[0]!;
    expect(row.departed_at).not.toBeNull();
    expect(row.dwell_s).toBe(Math.round((Date.parse(row.departed_at!) - Date.parse(row.arrived_at)) / 1000));
    expect(Date.parse(row.arrived_at)).toBeLessThan(base + 70_000);
  });
});

describe('concurrent ingest batches for one trip (app retry overlapping the original request)', () => {
  it('stores each fix once and keeps points_count equal to the stored rows', async () => {
    const w = await world();
    const pts = northbound({ baseMs: Date.now() - 600_000, fromKm: 0, count: 40 });
    const a = pts.slice(0, 30);
    const b = pts.slice(10, 40);
    const [ra, rb, rc] = await Promise.all([post(w, a), post(w, b), post(w, a)]);
    expect([ra.status, rb.status, rc.status]).toEqual([200, 200, 200]);
    await drainJobs();
    const { rows } = await ownerQuery<{ stored: number; distinct_t: number; points_count: number }>(
      `select count(*)::int as stored, count(distinct recorded_at)::int as distinct_t,
              (select points_count from trips where id = $1)::int as points_count
         from location_points where trip_id = $1`, [w.trip.id]);
    expect(rows[0]!.stored).toBe(rows[0]!.distinct_t);
    expect(rows[0]!.stored).toBe(40);
    expect(rows[0]!.points_count).toBe(rows[0]!.stored);
  });
});
