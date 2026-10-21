// Scenario suite — trip lifecycle edge cases (BP §10.3, §10.4): phone dies → auto_closed by the
// stale-trip closer → offline queue arrives later → admin corrects the end reading → next start;
// driver relaunch (GET /driver/trips/active); breakdown (interrupt / cancel while running).
// Each test asserts the blueprint behaviour (moved from the pre-release scenario run into the default suite).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { staleTripCloser } from '../../src/modules/trips/jobs.js';
import { lateFinalize } from '../../src/modules/tracking/persist.js';
import { getJobs } from '../../src/jobs/index.js';
import { closeDb, ownerQuery, truncateAll } from '../helpers/db.js';
import * as f from '../helpers/factories.js';
import { buildApp, type TestApp } from '../helpers/authApp.js';
import { alertsOf, as, asAdmin, odometerPhoto, startBody, startScheduled, tripWorld, type TripWorld } from '../trips.fixtures.js';

let t: TestApp;
beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  lateFinalize.delayMs = 0;
  t = buildApp();
});
afterAll(async () => {
  await getJobs().drain();
  await closeDb();
});

const KM = 1 / 111.195;
const pts = (fromMs: number, n: number, fromKm: number) =>
  Array.from({ length: n }, (_, i) => ({ t: new Date(fromMs + i * 10_000).toISOString(), lat: 12.9716 + (fromKm + i * 0.083) * KM, lng: 77.5946, spd: 30, hdg: 0, acc: 8, bat: 70, net: '4g', mv: true }));
const trip = async (id: string) =>
  (await ownerQuery<{ status: string; ended_at: string; closed_at: string; distance_gps_km: string | null; end_odometer: string | null; last_point_at: string; points_count: number }>(
    'select status, ended_at, closed_at, distance_gps_km, end_odometer, last_point_at, points_count from trips where id = $1', [id])).rows[0]!;

describe('phone dies mid-trip → auto_closed → recovery', () => {
  let w: TripWorld;
  const H = 3_600_000;
  it('closes the stale trip and still takes the offline queue recorded before the close', async () => {
    w = await tripWorld(t, { settings: { stale_trip_close_hours: 1 } });
    expect((await startScheduled(w, 1000)).status).toBe(201);
    const startMs = Date.now() - 3 * H;
    await ownerQuery('update trips set started_at = $2 where id = $1', [w.trip.id, new Date(startMs).toISOString()]);
    const d = as(w.t, w.driver);
    // 10 min of live fixes, then the phone loses network (it keeps recording) and dies an hour later.
    expect((await d.post(`/driver/trips/${w.trip.id}/locations`, { points: pts(startMs + 60_000, 60, 0) })).status).toBe(200);
    await getJobs().drain();
    expect((await staleTripCloser({ schoolId: w.sid })).closed).toBe(1);
    const closed = await trip(w.trip.id);
    expect(closed.status).toBe('auto_closed');
    expect((await alertsOf(w.trip.id)).map((a) => a.alert_type)).toContain('trip_auto_closed');
    // Phone recharged: app relaunches, finds no active trip, uploads its queue (recorded before closed_at).
    const active = await d.get('/driver/trips/active');
    expect(active.status).toBe(200);
    const queue = pts(startMs + 61 * 60_000, 120, 5);
    const up = await d.post(`/driver/trips/${w.trip.id}/locations`, { points: queue.slice(0, 100) });
    expect(up.status).toBe(200);
    expect(up.body.data.accepted).toBe(100);
    await getJobs().drain();
    const after = await trip(w.trip.id);
    expect(Number(after.distance_gps_km)).toBeGreaterThan(Number(closed.distance_gps_km ?? 0));
    // Expected: the trip's end/last-fix reflects the last real fix (reports use ended_at for duration).
    expect(Date.parse(after.ended_at)).toBeGreaterThanOrEqual(Date.parse(queue[99]!.t));
  });

  it('admin enters the corrected end reading; the next start compares against it', async () => {
    const res = await asAdmin(w.t, w.adminToken).post(`/school/trips/${w.trip.id}/correct-odometer`, { kind: 'end', reading: 1022, reason: 'Driver phone died; reading from the logbook' });
    expect(res.status).toBe(200);
    expect(Number((await trip(w.trip.id)).end_odometer)).toBe(1022);
    const bus = (await ownerQuery<{ o: string }>('select last_known_odometer as o from buses where id = $1', [w.bus.id])).rows[0]!;
    expect(Number(bus.o)).toBe(1022);
    const next = await f.trip(w.sid, w.bus.id, { schedule_id: null, route_id: w.route.id, trip_date: w.today, status: 'scheduled', direction: 'afternoon', planned_start_at: new Date().toISOString() });
    const photo = await odometerPhoto(w.sid, w.driver.user.id, { type: 'bus', id: w.bus.id });
    const s = await as(w.t, w.driver).post('/driver/trips/start', startBody({ tripId: next.id, busId: w.bus.id, odometerReading: 1023, odometerFileId: photo.id }));
    expect(s.status).toBe(201);
    expect((await alertsOf(next.id)).map((a) => a.alert_type)).toEqual([]);
  });
});

describe('breakdown', () => {
  it('a trip the school cancels while running still takes the driver’s queued points recorded before the cancel', async () => {
    const w = await tripWorld(t);
    expect((await startScheduled(w)).status).toBe(201);
    const startMs = Date.now() - 20 * 60_000;
    await ownerQuery('update trips set started_at = $2 where id = $1', [w.trip.id, new Date(startMs).toISOString()]);
    const d = as(w.t, w.driver);
    expect((await d.post(`/driver/trips/${w.trip.id}/interrupt`, { reason: 'Engine failure' })).status).toBe(200);
    expect((await asAdmin(w.t, w.adminToken).post(`/school/trips/${w.trip.id}/cancel`, { reason: 'Bus breakdown' })).status).toBe(200);
    const late = await d.post(`/driver/trips/${w.trip.id}/locations`, { points: pts(startMs + 60_000, 30, 0) });
    // Expected (BP §10.3.6 spirit): points recorded while the trip was running are kept for the record.
    expect(late.status).toBe(200);
  });
});
