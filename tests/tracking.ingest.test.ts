// Location ingestion (BP §9.1, §9.2; contract §5, §12): authorization matrix, the hard 10-s floor,
// backfill ordering + de-duplication, device binding, deactivated school/user, late backfill after
// the trip ended, batched persistence (one row per accepted point, idempotent retries).
import { HEADERS } from '@wimb/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidateSchoolState } from '../src/middleware/resolveTenant.js';
import { liveStore } from '../src/modules/tracking/liveState.js';
import { lateFinalize } from '../src/modules/tracking/persist.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { buildApp, DEVICE, loginParent, loginStaff, staffUser, type TestApp } from './helpers/authApp.js';
import { auth, drainJobs, northbound, postPoints, storedPoints, trackingWorld, type TrackingWorld } from './helpers/trackingWorld.js';

let t: TestApp;
let w: TrackingWorld;
let other: TrackingWorld;

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  lateFinalize.delayMs = 0;
  t = buildApp();
  w = await trackingWorld(t.app);
  other = await trackingWorld(t.app, { device: { ...DEVICE, deviceId: 'device-bbbb-0002' } });
});
afterAll(async () => {
  await drainJobs();
  await closeDb();
});

const secondsAgo = (s: number) => Date.now() - s * 1000;

describe('authorization matrix', () => {
  const pts = () => northbound({ baseMs: secondsAgo(30), count: 1 });

  it('refuses anonymous callers and wrong roles', async () => {
    const anon = await request(t.app).post(`/api/v1/driver/trips/${w.trip.id}/locations`).send({ points: pts() });
    expect(anon.status).toBe(401);
    const admin = await postPoints(t.app, w, pts(), { token: w.admin.accessToken });
    expect(admin.status).toBe(403);
    expect(admin.body.error.code).toBe('FORBIDDEN');
  });

  it('refuses parents', async () => {
    const student = await f.student(w.school.id);
    const parent = await f.parentAccount();
    await f.schoolParent(w.school.id, parent.id);
    await f.studentParent(w.school.id, student.id, parent.id);
    const p = await loginParent(t, String(parent.phone));
    const res = await postPoints(t.app, w, pts(), { token: p.accessToken });
    expect(res.status).toBe(403);
  });

  it('requires the X-Device-Id header of the bound device', async () => {
    const missing = await request(t.app).post(`/api/v1/driver/trips/${w.trip.id}/locations`).set(auth(w.driver.accessToken)).send({ points: pts() });
    expect(missing.status).toBe(403);
    expect(missing.body.error.code).toBe('DEVICE_NOT_BOUND');
    const wrong = await postPoints(t.app, w, pts(), { deviceUid: 'some-other-phone' });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('DEVICE_NOT_BOUND');
  });

  it('refuses a body device_id that differs from the bound device', async () => {
    const res = await postPoints(t.app, w, pts(), { body: { device_id: 'spoofed-device' } });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('DEVICE_NOT_BOUND');
  });

  it('refuses a driver of the same school who is not on the trip', async () => {
    const intruder = await staffUser(w.school.id, 'driver');
    await f.staffProfile(w.school.id, { staff_type: 'driver', user_id: intruder.id });
    const tok = await loginStaff(t.app, String(w.school.code), String(intruder.phone), { ...DEVICE, deviceId: 'intruder-phone' });
    const res = await postPoints(t.app, w, pts(), { token: tok.accessToken, deviceUid: 'intruder-phone' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('refuses the trip crew on another device than the start device (two phones)', async () => {
    const second = await loginStaff(t.app, String(w.school.code), String(w.driverUser.phone), { ...DEVICE, deviceId: 'second-phone' });
    const res = await postPoints(t.app, w, pts(), { token: second.accessToken, deviceUid: 'second-phone' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('DEVICE_NOT_BOUND');
  });

  it('accepts the conductor of the trip when the trip is bound to the conductor device', async () => {
    const { rows } = await ownerQuery<{ device_id: string }>('select device_id from sessions where id = $1', [w.conductor.sessionId]);
    await ownerQuery('update trips set device_id = $2 where id = $1', [w.trip.id, rows[0]!.device_id]);
    try {
      const res = await postPoints(t.app, w, northbound({ baseMs: secondsAgo(200), count: 1 }), { token: w.conductor.accessToken, deviceUid: `${DEVICE.deviceId}-c` });
      expect(res.status).toBe(200);
      expect(res.body.data.accepted).toBe(1);
      const driverNow = await postPoints(t.app, w, pts());
      expect(driverNow.status).toBe(403);
    } finally {
      await ownerQuery('update trips set device_id = $2 where id = $1', [w.trip.id, w.deviceId]);
      await drainJobs();
      await ownerQuery('delete from location_points where trip_id = $1', [w.trip.id]);
      await ownerQuery('update trips set points_count = 0, last_point_at = null where id = $1', [w.trip.id]);
      await liveStore.del(String(w.school.id), w.trip.id);
    }
  });

  it('answers 404 for another school’s trip id (no existence leak)', async () => {
    const res = await postPoints(t.app, w, pts(), { tripId: other.trip.id });
    expect(res.status).toBe(404);
    const unknown = await postPoints(t.app, w, pts(), { tripId: '0190a5b0-0000-7000-8000-000000000000' });
    expect(unknown.status).toBe(404);
  });

  it('answers 409 for trips that are not running', async () => {
    for (const status of ['scheduled', 'cancelled', 'missed'] as const) {
      const trip = await f.trip(w.school.id, w.bus.id, { status, driver_staff_id: w.driverProfile.id, device_id: w.deviceId, ...(status === 'cancelled' ? {} : {}) });
      const res = await postPoints(t.app, w, pts(), { tripId: trip.id });
      expect(res.status, status).toBe(409);
      expect(res.body.error.code).toBe('INVALID_STATE');
    }
  });

  it('validates the payload (BP §9.1 keys, batch size)', async () => {
    const bad = await postPoints(t.app, w, [{ t: 'yesterday', lat: 91, lng: 0 }]);
    expect(bad.status).toBe(400);
    const empty = await postPoints(t.app, w, []);
    expect(empty.status).toBe(400);
  });
});

describe('floor, backfill and dedupe', () => {
  it('accepts live points ≥ 9 s apart, drops faster ones and answers serverTime/nextIntervalS/tripStatus', async () => {
    const base = secondsAgo(100);
    const points = [0, 3, 10, 15, 21, 40].map((s) => ({ t: new Date(base + s * 1000).toISOString(), lat: 12.9, lng: 77.6, spd: 30, acc: 8 }));
    const res = await postPoints(t.app, w, points);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ tripStatus: 'in_progress', nextIntervalS: 10, accepted: 4, dropped: 2, backfilled: 0 });
    expect(Date.parse(res.body.data.serverTime)).toBeGreaterThan(Date.now() - 5000);
    await drainJobs();
    const rows = await storedPoints(w.trip.id);
    expect(rows.map((r) => (Date.parse(r.recorded_at) - base) / 1000)).toEqual([0, 10, 21, 40]);
  });

  it('drops a live point closer than 9 s to the previous accepted one across requests', async () => {
    const state = await liveStore.get(String(w.school.id), w.trip.id);
    const last = state!.lastLiveAtMs!;
    const res = await postPoints(t.app, w, [{ t: new Date(last + 5000).toISOString(), lat: 12.9, lng: 77.6, spd: 30 }]);
    expect(res.body.data).toMatchObject({ accepted: 0, dropped: 1 });
    const ok = await postPoints(t.app, w, [{ t: new Date(last + 9500).toISOString(), lat: 12.9, lng: 77.6, spd: 30 }]);
    expect(ok.body.data).toMatchObject({ accepted: 1, dropped: 0 });
  });

  it('accepts older backfill points (sorted, de-duplicated, flagged) and ignores replays', async () => {
    await drainJobs();
    const before = await storedPoints(w.trip.id);
    const first = Date.parse(before[0]!.recorded_at);
    // Offline queue sent out of order, with a duplicate and an already-stored timestamp.
    const back = [-30, -50, -40, -40, 0].map((s) => ({ t: new Date(first + s * 1000).toISOString(), lat: 12.9, lng: 77.6, spd: 20 }));
    const res = await postPoints(t.app, w, back);
    expect(res.status).toBe(200);
    // The already-stored instant is dropped synchronously (exact counts), like the in-batch duplicate.
    expect(res.body.data.backfilled).toBe(3);
    expect(res.body.data.dropped).toBe(2);
    await drainJobs();
    const after = await storedPoints(w.trip.id);
    expect(after.length).toBe(before.length + 3);
    const times = after.map((r) => Date.parse(r.recorded_at));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(after.filter((r) => r.is_backfilled).length).toBeGreaterThanOrEqual(3);
    // Replaying the same batch stores nothing new (ON CONFLICT DO NOTHING).
    await postPoints(t.app, w, back);
    await drainJobs();
    expect((await storedPoints(w.trip.id)).length).toBe(after.length);
  });

  it('drops points from the future and from before the trip start', async () => {
    const res = await postPoints(t.app, w, [
      { t: new Date(Date.now() + 10 * 60_000).toISOString(), lat: 12.9, lng: 77.6 },
      { t: new Date(Date.parse(String(w.trip.started_at)) - 60 * 60_000).toISOString(), lat: 12.9, lng: 77.6 },
    ]);
    expect(res.body.data).toMatchObject({ accepted: 0, dropped: 2 });
  });

  it('updates trips.last_point_at and points_count from the batched insert', async () => {
    await drainJobs();
    const { rows } = await ownerQuery<{ last_point_at: string; points_count: number; n: number }>(
      'select t.last_point_at, t.points_count, (select count(*)::int from location_points p where p.trip_id = t.id) as n from trips t where t.id = $1',
      [w.trip.id],
    );
    expect(rows[0]!.points_count).toBe(rows[0]!.n);
    const newest = (await storedPoints(w.trip.id)).at(-1)!;
    expect(Date.parse(rows[0]!.last_point_at)).toBe(Date.parse(newest.recorded_at));
  });
});

describe('trip and school state', () => {
  it('accepts late backfill for 24 h after the trip completed, recorded before its end', async () => {
    const ended = secondsAgo(600);
    const trip = await f.trip(w.school.id, (await f.bus(w.school.id)).id, {
      status: 'completed', driver_staff_id: w.driverProfile.id, device_id: w.deviceId, start_odometer: 1000, end_odometer: 1010,
      started_at: new Date(secondsAgo(3600)).toISOString(), ended_at: new Date(ended).toISOString(),
    });
    const res = await postPoints(t.app, w, [
      { t: new Date(ended - 60_000).toISOString(), lat: 12.9, lng: 77.6 },
      { t: new Date(ended + 5 * 60_000).toISOString(), lat: 12.9, lng: 77.6 },
    ], { tripId: trip.id });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ tripStatus: 'completed', accepted: 1, backfilled: 1, dropped: 1 });
    await ownerQuery('update trips set started_at = $2, ended_at = $3 where id = $1', [trip.id, new Date(secondsAgo(26 * 3600)).toISOString(), new Date(secondsAgo(25 * 3600)).toISOString()]);
    const late = await postPoints(t.app, w, [{ t: new Date(secondsAgo(25.5 * 3600)).toISOString(), lat: 12.9, lng: 77.6 }], { tripId: trip.id });
    expect(late.status).toBe(409);
  });

  it('blocks ingestion for a deactivated driver (401) and a suspended school (403 SCHOOL_INACTIVE)', async () => {
    const x = await trackingWorld(t.app, { device: { ...DEVICE, deviceId: 'device-cccc-0003' } });
    const pts = northbound({ baseMs: secondsAgo(20), count: 1 });
    const okRes = await postPoints(t.app, x, pts, { deviceUid: 'device-cccc-0003' });
    expect(okRes.status).toBe(200);
    await ownerQuery("update schools set status = 'suspended' where id = $1", [x.school.id]);
    invalidateSchoolState(String(x.school.id));
    const suspended = await postPoints(t.app, x, northbound({ baseMs: secondsAgo(5), count: 1 }), { deviceUid: 'device-cccc-0003' });
    expect(suspended.status).toBe(403);
    expect(suspended.body.error.code).toBe('SCHOOL_INACTIVE');
    await ownerQuery("update schools set status = 'active' where id = $1", [x.school.id]);
    invalidateSchoolState(String(x.school.id));
    await ownerQuery('update users set is_active = false where id = $1', [x.driverUser.id]);
    const inactive = await postPoints(t.app, x, northbound({ baseMs: secondsAgo(5), count: 1 }), { deviceUid: 'device-cccc-0003' });
    expect(inactive.status).toBe(401);
  });

  it('ignores school_id smuggled in the body', async () => {
    const res = await postPoints(t.app, w, northbound({ baseMs: Date.now() - 1000, count: 1 }), { body: { school_id: other.school.id, schoolId: other.school.id } });
    expect([200]).toContain(res.status);
    await drainJobs();
    const { rows } = await ownerQuery<{ n: number }>('select count(*)::int as n from location_points where school_id = $1 and trip_id = $2', [other.school.id, w.trip.id]);
    expect(rows[0]!.n).toBe(0);
  });

  it('keeps live state keys per school (kv key includes school_id)', async () => {
    expect(await liveStore.get(String(other.school.id), w.trip.id)).toBeNull();
    expect(await liveStore.get(String(w.school.id), w.trip.id)).not.toBeNull();
    expect(HEADERS.DEVICE_ID).toBe('X-Device-Id');
  });
});
