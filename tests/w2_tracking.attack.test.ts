// Wave-2 adversarial suite, part 2: tracking ingest (device binding, trip state, 10-s floor, timestamps,
// flooding, duplicates, out-of-order backfill), reassignment vs ingest, fleet/path isolation.
// Tests marked "Regression" reproduce defects found by the wave-2 adversarial review (now fixed).
import { HEADERS } from '@wimb/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lateFinalize } from '../src/modules/tracking/persist.js';
import { staleTripCloser } from '../src/modules/trips/jobs.js';
import { buildApp, DEVICE, loginStaff, staffUser, type TestApp } from './helpers/authApp.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { auth, drainJobs, KM_LAT, northbound, ORIGIN, postPoints, storedPoints, trackingWorld, type TrackingWorld } from './helpers/trackingWorld.js';

let t: TestApp;
let seq = 0;

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  lateFinalize.delayMs = 0;
});
afterAll(async () => {
  await drainJobs();
  await closeDb();
});

/** A fresh world on its own device uid (sessions are device-bound). */
async function world(o: { settings?: f.Values; startedMinAgo?: number } = {}): Promise<TrackingWorld & { uid: string }> {
  seq += 1;
  const uid = `atk-device-${seq}`;
  const w = await trackingWorld(t.app, { ...o, device: { ...DEVICE, deviceId: uid } });
  return Object.assign(w, { uid });
}
const post = (w: TrackingWorld & { uid: string }, points: ReturnType<typeof northbound>, o: Parameters<typeof postPoints>[3] = {}) => postPoints(t.app, w, points, { deviceUid: w.uid, ...o });

async function liveOf(w: TrackingWorld & { uid: string }) {
  const res = await request(t.app).get(`/api/v1/driver/trips/${w.trip.id}/route`).set(auth(w.driver.accessToken)).set(HEADERS.DEVICE_ID, w.uid);
  expect(res.status).toBe(200);
  return res.body.data.live as { point: { t: string; lat: number } | null } | null;
}

describe('device binding and trip ownership', () => {
  it('a second phone of the same driver, a spoofed X-Device-Id and a foreign school driver are all refused', async () => {
    const w = await world();
    const b = await world();
    const pts = northbound({ baseMs: Date.now() - 5000, count: 1 });
    const phone2 = await loginStaff(t.app, String(w.school.code), String(w.driverUser.phone), { ...DEVICE, deviceId: `${w.uid}-second` });
    const second = await postPoints(t.app, w, pts, { token: phone2.accessToken, deviceUid: `${w.uid}-second` });
    expect(second.status).toBe(403);
    expect(second.body.error.code).toBe('DEVICE_NOT_BOUND');
    const spoof = await postPoints(t.app, w, pts, { token: phone2.accessToken, deviceUid: w.uid });
    expect(spoof.status).toBe(403);
    const foreign = await postPoints(t.app, w, pts, { token: b.driver.accessToken, deviceUid: b.uid });
    expect(foreign.status).toBe(404);
    await drainJobs();
    expect(await storedPoints(w.trip.id)).toHaveLength(0);
  });

  // Regression: a running trip stays bound to its start phone after an admin reassigns the driver
  // (trips module rule), so ingest must accept the user who started it (repository.ingestTrip, same
  // rule as trips.isParticipant) — otherwise nobody could send locations and the trip went dark.
  it('after an admin reassigns the driver of a running trip, the start phone can still send locations', async () => {
    const w = await world();
    const sub = await f.staffProfile(w.school.id, { staff_type: 'driver', full_name: 'Substitute Driver', user_id: (await staffUser(w.school.id, 'driver')).id });
    const re = await request(t.app).post(`/api/v1/school/trips/${w.trip.id}/reassign`).set(auth(w.admin.accessToken)).send({ driverId: sub.id, reason: 'Shift change' });
    expect(re.status).toBe(200);
    const res = await post(w, northbound({ baseMs: Date.now() - 5000, count: 1 }));
    expect(res.status, JSON.stringify(res.body.error ?? {})).toBe(200);
  });
});

describe('trip state', () => {
  it('a trip cancelled while running takes only its queued points recorded before the cancel; completed trips take only points recorded before the end', async () => {
    const w = await world();
    const before = Date.now() - 60_000;
    expect((await request(t.app).post(`/api/v1/school/trips/${w.trip.id}/cancel`).set(auth(w.admin.accessToken)).send({ reason: 'Breakdown' })).status).toBe(200);
    // Breakdown (BP §10.4): the driver's offline queue up to the cancel is kept for the record (backfill only).
    const queued = await post(w, northbound({ baseMs: before, count: 1 }));
    expect(queued.status).toBe(200);
    expect(queued.body.data).toMatchObject({ tripStatus: 'cancelled', accepted: 1, backfilled: 1 });
    // Nothing recorded after the cancel (beyond the end tolerance) is taken.
    await ownerQuery("update trips set closed_at = now() - interval '20 minutes', ended_at = now() - interval '20 minutes', started_at = least(started_at, now() - interval '30 minutes') where id = $1", [w.trip.id]);
    const afterCancel = await post(w, northbound({ baseMs: Date.now() - 5 * 60_000, count: 2 }));
    expect(afterCancel.status).toBe(200);
    expect(afterCancel.body.data.accepted).toBe(0);

    const c = await world();
    const endedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    await ownerQuery("update trips set status = 'completed', ended_at = $2, end_odometer = start_odometer where id = $1", [c.trip.id, endedAt]);
    const after = await post(c, northbound({ baseMs: Date.now() - 5 * 60_000, count: 3 }));
    expect(after.status).toBe(200);
    expect(after.body.data.accepted).toBe(0);
    const beforeEnd = await post(c, northbound({ baseMs: Date.parse(endedAt) - 60_000, count: 3 }));
    expect(beforeEnd.body.data).toMatchObject({ accepted: 3, backfilled: 3 });
    const tooLate = await world();
    await ownerQuery("update trips set status = 'completed', ended_at = now() - interval '25 hours', started_at = now() - interval '26 hours' where id = $1", [tooLate.trip.id]);
    expect((await post(tooLate, northbound({ baseMs: Date.now() - 25.5 * 3600_000, count: 2 }))).status).toBe(409);
    await drainJobs();
    expect(await storedPoints(w.trip.id)).toHaveLength(1);
  });

  // Regression: an auto-closed trip has ended_at = its last fix; late points are now accepted up to
  // its close instant (trips.closed_at, migration 500), so the offline queue recorded during the
  // outage that caused the auto-close is stored (BP §10.3.6) and re-finalized.
  it('an auto-closed trip accepts the offline queue recorded during the outage that closed it', async () => {
    const w = await world({ settings: { stale_trip_close_hours: 1 }, startedMinAgo: 240 });
    const first = await post(w, northbound({ baseMs: Date.now() - 230 * 60_000, count: 3 }));
    expect(first.body.data.accepted).toBe(3);
    await drainJobs();
    expect(await staleTripCloser({ schoolId: w.school.id })).toEqual({ closed: 1 });
    // Queue recorded 20…70 minutes after the last stored point (before the close at ~now).
    const queued = northbound({ baseMs: Date.now() - 210 * 60_000, fromKm: 0.2, count: 6, stepS: 600 });
    const res = await post(w, queued);
    expect(res.status).toBe(200);
    expect(res.body.data.accepted).toBe(6);
  });
});

describe('10-s floor, timestamps, duplicates and flooding', () => {
  it('drops far-future and pre-trip points, de-duplicates replays and keeps the floor inside a batch', async () => {
    const w = await world();
    const now = Date.now();
    const mixed = [
      ...northbound({ baseMs: now + 10 * 60_000, count: 1 }), // far future
      ...northbound({ baseMs: now - 3 * 3600_000, count: 1 }), // before the trip
      ...northbound({ baseMs: now - 60_000, count: 30, stepS: 1 }), // 1-Hz flood → floor
    ];
    const res = await post(w, mixed);
    expect(res.status).toBe(200);
    expect(res.body.data.accepted).toBeLessThanOrEqual(4);
    const replay = await post(w, mixed);
    expect(replay.status).toBe(200); // replays are re-queued as "backfill" but the PK keeps storage unique
    await drainJobs();
    const stored = await storedPoints(w.trip.id);
    expect(stored.length).toBe(res.body.data.accepted);
    expect(stored.every((p) => Date.parse(p.recorded_at) <= now + 2 * 60_000)).toBe(true);
  });

  it('out-of-order backfill never moves the live marker backwards', async () => {
    const w = await world();
    const now = Date.now();
    await post(w, northbound({ baseMs: now - 5000, fromKm: 3, count: 1 }));
    const old = await post(w, northbound({ baseMs: now - 30 * 60_000, fromKm: 0, count: 5 }));
    expect(old.body.data.backfilled).toBe(5);
    const live = await liveOf(w);
    expect(live!.point!.lat).toBeCloseTo(ORIGIN.lat + 3 * KM_LAT, 6);
  });

  // Regression: the 9-s floor is enforced against STORED points too (repository.insertPoints and the
  // synchronous storedNeighbours check in ingest), so re-sent or shifted backfill windows cannot flood
  // storage (BP §9.1).
  it('repeated backfill batches shifted by one second cannot exceed the 10-s floor for a time window', async () => {
    const w = await world();
    const now = Date.now();
    await post(w, northbound({ baseMs: now - 3000, count: 1 }));
    const windowStart = now - 30 * 60_000;
    for (let k = 0; k < 5; k += 1) {
      const res = await post(w, northbound({ baseMs: windowStart + k * 1000, count: 30, stepS: 10 }));
      expect(res.status).toBe(200);
    }
    await drainJobs();
    const inWindow = (await storedPoints(w.trip.id)).filter((p) => {
      const ms = Date.parse(p.recorded_at);
      return ms >= windowStart && ms < windowStart + 300_000;
    });
    // 300 s of recorded time at ≥ 9 s spacing → at most 34 points.
    expect(inWindow.length).toBeLessThanOrEqual(34);
  });

  // Regression: a forward-dated live reference (recorded > LIVE_AHEAD_MS ahead of the server clock at
  // its arrival) no longer turns the following real points into backfill (motion.classifyBatch).
  it('one forward-dated point does not freeze the live marker for the following real points', async () => {
    const w = await world();
    const now = Date.now();
    await post(w, northbound({ baseMs: now + 110_000, fromKm: 0, count: 1 }));
    const real = await post(w, northbound({ baseMs: now - 1000, fromKm: 2, count: 1 }));
    expect(real.status).toBe(200);
    const live = await liveOf(w);
    expect(live!.point!.lat).toBeCloseTo(ORIGIN.lat + 2 * KM_LAT, 6);
  });

  it('rejects oversized batches and non-numeric / out-of-range coordinates', async () => {
    const w = await world();
    const big = northbound({ baseMs: Date.now() - 600 * 10_000, count: 501 });
    expect((await post(w, big)).status).toBe(400);
    const bad = [{ t: new Date().toISOString(), lat: 91, lng: 77.6 }];
    expect((await post(w, bad as never)).status).toBe(400);
    const nan = [{ t: 'yesterday', lat: 12.9, lng: 77.6 }];
    expect((await post(w, nan as never)).status).toBe(400);
  });
});
