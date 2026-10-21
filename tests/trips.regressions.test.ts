// Wave-2 integration regressions of the trips module (edge cases around the fixes of the adversarial
// review): the odometer-decrease baseline, closed_at on every close path, and the "no GPS data" flag
// being closed by the trip-finalizer once late points give the trip a GPS distance.
import { HEADERS } from '@wimb/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lateFinalize } from '../src/modules/tracking/persist.js';
import { staleTripCloser } from '../src/modules/trips/jobs.js';
import { buildApp, type TestApp } from './helpers/authApp.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import { drainJobs } from './helpers/trackingWorld.js';
import { alertsOf, as, asAdmin, endBody, odometerPhoto, startBody, startScheduled, tripWorld, type TripWorld } from './trips.fixtures.js';

let t: TestApp;

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  lateFinalize.delayMs = 0;
});
afterAll(async () => {
  await drainJobs();
  await closeDb();
});

async function endTrip(w: TripWorld, reading: number, extra: Record<string, unknown> = {}) {
  const photo = await odometerPhoto(w.sid, w.driver.user.id, { type: 'trip', id: w.trip.id });
  return as(t, w.driver).post(`/driver/trips/${w.trip.id}/end`, endBody({ odometerReading: reading, odometerFileId: photo.id, ...extra }));
}

async function nonSchoolStart(w: TripWorld, reading: number) {
  const photo = await odometerPhoto(w.sid, w.driver.user.id, { type: 'bus', id: w.bus.id });
  return as(t, w.driver).post('/driver/trips/start', startBody({ tripType: 'non_school', purpose: 'Workshop', busId: w.bus.id, odometerReading: reading, odometerFileId: photo.id }));
}

describe('odometer decrease baseline', () => {
  it('a start equal to the highest recorded reading is not a decrease; a cancelled trip reading is no baseline', async () => {
    const w = await tripWorld(t, { settings: { allow_non_school_trips: true, stale_trip_close_hours: 1 } });
    expect((await startScheduled(w, 1000)).status).toBe(201);
    await ownerQuery("update trips set started_at = now() - interval '3 hours' where id = $1", [w.trip.id]);
    expect(await staleTripCloser({ schoolId: w.sid })).toEqual({ closed: 1 });
    const same = await nonSchoolStart(w, 1000);
    expect(same.status).toBe(201);
    expect((await alertsOf(same.body.data.trip.id)).map((a) => a.alert_type)).not.toContain('odometer_decrease');
    // The school cancels the running trip after a typo (99999 km): it never becomes the baseline.
    await ownerQuery('update trips set start_odometer = 99999 where id = $1', [same.body.data.trip.id]);
    expect((await asAdmin(t, w.adminToken).post(`/school/trips/${same.body.data.trip.id}/cancel`, { reason: 'Typo' })).status).toBe(200);
    const next = await nonSchoolStart(w, 1001);
    expect(next.status).toBe(201);
    expect((await alertsOf(next.body.data.trip.id)).map((a) => a.alert_type)).not.toContain('odometer_decrease');
  });
});

describe('closed_at (migration 500)', () => {
  it('is the close instant of completed, auto-closed and cancelled-while-running trips, null for never-run trips', async () => {
    const done = await tripWorld(t);
    await startScheduled(done, 1000);
    expect((await endTrip(done, 1001)).status).toBe(200);
    const auto = await tripWorld(t, { settings: { stale_trip_close_hours: 1 } });
    await startScheduled(auto, 1000);
    await ownerQuery("update trips set started_at = now() - interval '3 hours' where id = $1", [auto.trip.id]);
    await staleTripCloser({ schoolId: auto.sid });
    const running = await tripWorld(t);
    await startScheduled(running, 1000);
    await asAdmin(t, running.adminToken).post(`/school/trips/${running.trip.id}/cancel`, { reason: 'Breakdown' });
    const never = await tripWorld(t);
    await asAdmin(t, never.adminToken).post(`/school/trips/${never.trip.id}/cancel`, { reason: 'Rain' });
    const { rows } = await ownerQuery<{ id: string; status: string; ended_at: string | null; closed_at: string | null; recent: boolean | null }>(
      `select id, status, ended_at, closed_at, closed_at > now() - interval '1 minute' as recent from trips where id = any($1::uuid[])`,
      [[done.trip.id, auto.trip.id, running.trip.id, never.trip.id]],
    );
    const by = new Map(rows.map((r) => [r.id, r]));
    expect(by.get(done.trip.id)).toMatchObject({ status: 'completed', recent: true });
    expect(by.get(done.trip.id)!.closed_at).toBe(by.get(done.trip.id)!.ended_at);
    // Auto-closed: ended_at = last fix (here the start, 3 h ago), closed_at = now.
    expect(by.get(auto.trip.id)).toMatchObject({ status: 'auto_closed', recent: true });
    expect(Date.parse(by.get(auto.trip.id)!.ended_at!)).toBeLessThan(Date.now() - 2 * 3600_000);
    expect(by.get(running.trip.id)).toMatchObject({ status: 'cancelled', recent: true });
    expect(by.get(never.trip.id)).toMatchObject({ status: 'cancelled', closed_at: null });
  });
});

describe('no GPS data at trip end', () => {
  it('flags the trip, and the finalizer closes the flag (audited) once late points give a GPS distance', async () => {
    const w = await tripWorld(t);
    await startScheduled(w, 1000);
    await ownerQuery("update trips set started_at = now() - interval '20 minutes' where id = $1", [w.trip.id]);
    const end = await endTrip(w, 1005, { pendingPoints: 12 });
    expect(end.status).toBe(200);
    expect(end.body.data.alerts.map((a: { type: string }) => a.type)).toEqual(['odometer_gps_mismatch']);
    const [flag] = await alertsOf(w.trip.id);
    expect(flag).toMatchObject({ status: 'open', dedupe_key: `odometer_gps_mismatch:${w.trip.id}:no_gps`, details: expect.objectContaining({ pendingPoints: 12 }) });
    await drainJobs();
    // The offline queue arrives: ~5 km over the 20 minutes of the trip.
    const base = Date.now() - 19 * 60_000;
    const points = Array.from({ length: 12 }, (_, i) => ({ t: new Date(base + i * 90_000).toISOString(), lat: 12.9 + (i * 0.42) / 111.195, lng: 77.6, spd: 17, acc: 6 }));
    const late = await request(t.app)
      .post(`/api/v1/driver/trips/${w.trip.id}/locations`)
      .set('Authorization', `Bearer ${w.driver.token}`)
      .set(HEADERS.DEVICE_ID, w.driver.deviceId)
      .send({ device_id: w.driver.deviceId, points });
    expect(late.status).toBe(200);
    expect(late.body.data).toMatchObject({ accepted: 12, backfilled: 12, tripStatus: 'completed' });
    await drainJobs();
    const after = await alertsOf(w.trip.id);
    expect(after.find((a) => a.dedupe_key === `odometer_gps_mismatch:${w.trip.id}:no_gps`)!.status).toBe('closed');
    const { rows } = await ownerQuery<{ distance_gps_km: number }>('select distance_gps_km from trips where id = $1', [w.trip.id]);
    expect(rows[0]!.distance_gps_km).toBeGreaterThan(4);
    const audits = await ownerQuery("select count(*)::int as n from audit_logs where action = 'alert.auto_close' and new_values->>'tripId' = $1", [w.trip.id]);
    expect(audits.rows[0]!.n).toBe(1);
  });
});
