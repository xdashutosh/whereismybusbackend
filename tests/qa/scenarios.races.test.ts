// Scenario suite — races and job idempotency (BP §10.2, §10.3, §10.4, §7.3): simultaneous starts by the
// driver and the conductor, double end, end vs admin cancel, end vs stale-trip-closer, jobs run twice
// concurrently. Each test asserts the blueprint behaviour (moved from the pre-release scenario run into the default suite).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { staleTripCloser, tripNotStartedCheck } from '../../src/modules/trips/jobs.js';
import { closeDb, ownerQuery, truncateAll } from '../helpers/db.js';
import { buildApp, type TestApp } from '../helpers/authApp.js';
import { as, asAdmin, endBody, odometerPhoto, startBody, startScheduled, tripWorld, type TripWorld } from '../trips.fixtures.js';

let t: TestApp;
beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
});
afterAll(closeDb);

const tripRow = async (id: string) =>
  (await ownerQuery<{ status: string; end_odometer: string | null; ended_at: string | null }>('select status, end_odometer, ended_at from trips where id = $1', [id])).rows[0]!;
const auditCount = async (id: string, action: string) =>
  Number((await ownerQuery<{ n: number }>('select count(*)::int as n from audit_logs where entity_id = $1 and action = $2', [id, action])).rows[0]!.n);
const busOdo = async (w: TripWorld) => Number((await ownerQuery<{ o: string }>('select last_known_odometer as o from buses where id = $1', [w.bus.id])).rows[0]!.o);

async function endReq(w: TripWorld, reading: number) {
  const photo = await odometerPhoto(w.sid, w.driver.user.id, { type: 'trip', id: w.trip.id });
  return endBody({ odometerReading: reading, odometerFileId: photo.id });
}

describe('simultaneous starts', () => {
  it('driver and conductor pressing Start on their own phones at the same moment → one trip, one 409', async () => {
    const w = await tripWorld(t);
    const p1 = await odometerPhoto(w.sid, w.driver.user.id, { type: 'bus', id: w.bus.id });
    const p2 = await odometerPhoto(w.sid, w.conductor.user.id, { type: 'bus', id: w.bus.id });
    const [a, b] = await Promise.all([
      as(w.t, w.driver).post('/driver/trips/start', startBody({ tripId: w.trip.id, busId: w.bus.id, odometerReading: 1000, odometerFileId: p1.id })),
      as(w.t, w.conductor).post('/driver/trips/start', startBody({ tripId: w.trip.id, busId: w.bus.id, odometerReading: 1001, odometerFileId: p2.id })),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect((await tripRow(w.trip.id)).status).toBe('in_progress');
    expect(await auditCount(w.trip.id, 'trip.start')).toBe(1);
  });
});

describe('end races', () => {
  it('a double-tapped End (two identical requests in flight) completes once', async () => {
    const w = await tripWorld(t);
    expect((await startScheduled(w)).status).toBe(201);
    const body = await endReq(w, 1012);
    const [a, b] = await Promise.all([as(w.t, w.driver).post(`/driver/trips/${w.trip.id}/end`, body), as(w.t, w.driver).post(`/driver/trips/${w.trip.id}/end`, body)]);
    expect([a.status, b.status]).toEqual([200, 200]); // the retry is answered as a replay
    expect([a.body.data.replayed, b.body.data.replayed].sort()).toEqual([false, true]);
    expect(await auditCount(w.trip.id, 'trip.end')).toBe(1);
    expect(await busOdo(w)).toBe(1012);
  });

  it('driver End racing an admin Cancel leaves one consistent outcome', async () => {
    const w = await tripWorld(t);
    expect((await startScheduled(w)).status).toBe(201);
    const body = await endReq(w, 1010);
    const [e, c] = await Promise.all([
      as(w.t, w.driver).post(`/driver/trips/${w.trip.id}/end`, body),
      asAdmin(w.t, w.adminToken).post(`/school/trips/${w.trip.id}/cancel`, { reason: 'Bus breakdown' }),
    ]);
    const row = await tripRow(w.trip.id);
    expect([e.status, c.status].filter((s) => s === 200).length).toBe(1);
    if (e.status === 200) expect(row.status).toBe('completed');
    else expect(row.status).toBe('cancelled');
  });

  it('stale-trip-closer firing while the driver ends keeps one outcome (no auto_closed alert on a completed trip)', async () => {
    const w = await tripWorld(t, { settings: { stale_trip_close_hours: 1 } });
    expect((await startScheduled(w)).status).toBe(201);
    await ownerQuery("update trips set started_at = now() - interval '3 hours' where id = $1", [w.trip.id]);
    const body = await endReq(w, 1015);
    const [e] = await Promise.all([as(w.t, w.driver).post(`/driver/trips/${w.trip.id}/end`, body), staleTripCloser({ schoolId: w.sid })]);
    const row = await tripRow(w.trip.id);
    const alerts = (await ownerQuery<{ alert_type: string }>('select alert_type from alerts where trip_id = $1', [w.trip.id])).rows.map((r) => r.alert_type);
    if (e.status === 200) {
      expect(row.status).toBe('completed');
      expect(alerts).not.toContain('trip_auto_closed');
    } else {
      expect(row.status).toBe('auto_closed');
      expect(e.status).toBe(409);
    }
  });
});

describe('jobs run twice concurrently (two workers / a retry)', () => {
  it('trip-not-started-check raises one alert per trip', async () => {
    const w = await tripWorld(t);
    await ownerQuery("update trips set planned_start_at = now() - interval '40 minutes' where id = $1", [w.trip.id]);
    await Promise.all([tripNotStartedCheck({ schoolId: w.sid }), tripNotStartedCheck({ schoolId: w.sid }), tripNotStartedCheck({ schoolId: w.sid })]);
    const n = (await ownerQuery<{ n: number }>("select count(*)::int as n from alerts where trip_id = $1 and alert_type = 'trip_not_started'", [w.trip.id])).rows[0]!.n;
    expect(n).toBe(1);
  });

  it('stale-trip-closer closes once and raises one alert', async () => {
    const w = await tripWorld(t, { settings: { stale_trip_close_hours: 1 } });
    expect((await startScheduled(w)).status).toBe(201);
    await ownerQuery("update trips set started_at = now() - interval '3 hours' where id = $1", [w.trip.id]);
    const res = await Promise.all([staleTripCloser({ schoolId: w.sid }), staleTripCloser({ schoolId: w.sid })]);
    expect(res.map((r) => r.closed).sort()).toEqual([0, 1]);
    expect(await auditCount(w.trip.id, 'trip.auto_close')).toBe(1);
    const n = (await ownerQuery<{ n: number }>("select count(*)::int as n from alerts where trip_id = $1 and alert_type = 'trip_auto_closed'", [w.trip.id])).rows[0]!.n;
    expect(n).toBe(1);
  });
});
