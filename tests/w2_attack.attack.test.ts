// Wave-2 adversarial suite, part 1: trips module (start / end / admin actions / jobs / alert dedupe).
// Attacks: foreign-school and unassigned buses/trips, concurrent double starts and ends, odometer
// photo and reading bypasses, admin corrections without audit, duplicate trips/alerts from jobs.
// Tests marked "Regression" reproduce defects found by the wave-2 adversarial review (now fixed).
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateDailyTrips, staleTripCloser, tripNotStartedCheck } from '../src/modules/trips/jobs.js';
import { buildApp, type TestApp } from './helpers/authApp.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { alertsOf, as, asAdmin, endBody, localDate, odometerPhoto, startBody, startScheduled, staffActor, tripWorld, type TripWorld } from './trips.fixtures.js';

let t: TestApp;

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
});
afterAll(closeDb);

const world = (settings?: f.Values) => tripWorld(t, settings ? { settings } : {});

async function started(w: TripWorld, reading = 1000) {
  const res = await startScheduled(w, reading);
  expect(res.status).toBe(201);
  return res;
}

function endWith(w: TripWorld, actor: TripWorld['driver'], reading: number, fileId: string) {
  return as(t, actor).post(`/driver/trips/${w.trip.id}/end`, endBody({ odometerReading: reading, odometerFileId: fileId }));
}

describe('cross-school and unassigned starts/ends', () => {
  it('never starts, ends or administers a trip of another school (404/400, nothing changes)', async () => {
    const a = await world();
    const b = await world();
    // A's driver: B's bus + A's photo; A's bus + B's trip; A's bus + B's photo.
    const photoA = await odometerPhoto(a.sid, a.driver.user.id, { type: 'bus', id: a.bus.id });
    const busB = await as(t, a.driver).post('/driver/trips/start', startBody({ tripId: b.trip.id, busId: b.bus.id, odometerReading: 1000, odometerFileId: photoA.id }));
    expect(busB.status).toBe(404);
    const tripB = await as(t, a.driver).post('/driver/trips/start', startBody({ tripId: b.trip.id, busId: a.bus.id, odometerReading: 1000, odometerFileId: photoA.id }));
    expect(tripB.status).toBe(404);
    const photoB = await odometerPhoto(b.sid, b.driver.user.id, { type: 'bus', id: b.bus.id });
    const foreignPhoto = await as(t, a.driver).post('/driver/trips/start', startBody({ tripId: a.trip.id, busId: a.bus.id, odometerReading: 1000, odometerFileId: photoB.id }));
    expect(foreignPhoto.status).toBe(400);
    expect(JSON.stringify(foreignPhoto.body.error)).toContain('odometerFileId');

    await started(b, 1000);
    const endPhoto = await odometerPhoto(a.sid, a.driver.user.id, { type: 'bus', id: a.bus.id });
    const endB = await as(t, a.driver).post(`/driver/trips/${b.trip.id}/end`, endBody({ odometerReading: 1010, odometerFileId: endPhoto.id }));
    expect(endB.status).toBe(404);
    for (const [path, body] of [
      ['cancel', { reason: 'attack' }],
      ['correct-odometer', { kind: 'start', reading: 1, reason: 'attack' }],
      ['reassign', { driverId: a.driver.staff.id, reason: 'attack' }],
    ] as const) {
      const res = await asAdmin(t, a.adminToken).post(`/school/trips/${b.trip.id}/${path}`, body);
      expect(res.status, path).toBe(404);
    }
    expect((await asAdmin(t, a.adminToken).get(`/school/trips/${b.trip.id}`)).status).toBe(404);
    const { rows } = await ownerQuery<{ status: string; start_odometer: number; driver_staff_id: string }>('select status, start_odometer, driver_staff_id from trips where id = $1', [b.trip.id]);
    expect(rows[0]).toMatchObject({ status: 'in_progress', start_odometer: 1000, driver_staff_id: b.driver.staff.id });
  });

  it('refuses a driver of the same school who is not assigned to the bus or uses the trip of another bus', async () => {
    const w = await world();
    const outsider = await staffActor(t, w.school, 'driver', 'Outsider Driver');
    const photo = await odometerPhoto(w.sid, outsider.user.id, { type: 'bus', id: w.bus.id });
    const res = await as(t, outsider).post('/driver/trips/start', startBody({ tripId: w.trip.id, busId: w.bus.id, odometerReading: 1000, odometerFileId: photo.id }));
    expect(res.status).toBe(403);
    expect(res.body.error.details.reason).toBe('NOT_ASSIGNED');
    // Outsider assigned to another bus tries the world trip with their own bus.
    const bus2 = await f.bus(w.sid, { code: 'R2' });
    await f.busStaffAssignment(w.sid, bus2.id, outsider.staff.id, { assignment_role: 'primary_driver', valid_from: new Date(Date.now() - 86_400_000).toISOString() });
    const photo2 = await odometerPhoto(w.sid, outsider.user.id, { type: 'bus', id: bus2.id });
    const mismatch = await as(t, outsider).post('/driver/trips/start', startBody({ tripId: w.trip.id, busId: bus2.id, odometerReading: 1000, odometerFileId: photo2.id }));
    expect(mismatch.status).toBe(400);
    // An expired assignment no longer authorizes.
    await ownerQuery("update bus_staff_assignments set valid_to = now() - interval '1 minute' where staff_id = $1", [outsider.staff.id]);
    const expired = await as(t, outsider).post('/driver/trips/start', startBody({ tripType: 'non_school', purpose: 'Joy ride', busId: bus2.id, odometerReading: 1000, odometerFileId: photo2.id }));
    expect([403]).toContain(expired.status);
    expect((await ownerQuery("select count(*)::int as n from trips where school_id = $1 and status = 'in_progress'", [w.sid])).rows[0]!.n).toBe(0);
  });

  it('a conductor cannot end the driver-started trip from their own phone, nor with the driver device header', async () => {
    const w = await world();
    await started(w);
    const photo = await odometerPhoto(w.sid, w.conductor.user.id, { type: 'trip', id: w.trip.id });
    const own = await endWith(w, w.conductor, 1010, photo.id);
    expect(own.status).toBe(403);
    expect(own.body.error.code).toBe('DEVICE_NOT_BOUND');
    const spoof = await as(t, { token: w.conductor.token, deviceId: w.driver.deviceId }).post(`/driver/trips/${w.trip.id}/end`, endBody({ odometerReading: 1010, odometerFileId: photo.id }));
    expect(spoof.status).toBe(403);
    expect((await ownerQuery('select status from trips where id = $1', [w.trip.id])).rows[0]!.status).toBe('in_progress');
  });
});

describe('double start / end races', () => {
  // Regression: concurrent retries of one start now queue on a transaction-scoped advisory lock on the
  // clientStartId BEFORE the replay lookup (trips/start.ts), so they replay instead of 409.
  it('five concurrent retries with the same clientStartId create one start (one 201, the rest replays)', async () => {
    const w = await world();
    const photo = await odometerPhoto(w.sid, w.driver.user.id, { type: 'bus', id: w.bus.id });
    const body = startBody({ tripId: w.trip.id, busId: w.bus.id, odometerReading: 1000, odometerFileId: photo.id });
    const all = await Promise.all(Array.from({ length: 5 }, () => as(t, w.driver).post('/driver/trips/start', body)));
    const statuses = all.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 200, 200, 201]);
    expect(new Set(all.map((r) => String(r.body.data?.trip?.id)))).toEqual(new Set([w.trip.id]));
    const ev = await ownerQuery('select count(*)::int as n from trip_odometer_evidence where trip_id = $1', [w.trip.id]);
    expect(ev.rows[0]!.n).toBe(1);
    const audits = await ownerQuery("select count(*)::int as n from audit_logs where entity_id = $1 and action = 'trip.start'", [w.trip.id]);
    expect(audits.rows[0]!.n).toBe(1);
  });

  // Regression (same root cause, non-school trips).
  it('concurrent retries of a non-school start with one clientStartId replay instead of 409 BUS_BUSY', async () => {
    const w = await world({ allow_non_school_trips: true });
    const photo = await odometerPhoto(w.sid, w.driver.user.id, { type: 'bus', id: w.bus.id });
    const body = startBody({ tripType: 'non_school', purpose: 'Workshop run', busId: w.bus.id, odometerReading: 1000, odometerFileId: photo.id });
    const all = await Promise.all(Array.from({ length: 3 }, () => as(t, w.driver).post('/driver/trips/start', body)));
    const errors = all.filter((r) => r.status >= 400).map((r) => `${r.status} ${r.body.error.code} ${r.body.error.details?.reason ?? ''}`);
    expect(errors).toEqual([]);
    expect(all.map((r) => r.status).sort()).toEqual([200, 200, 201]);
  });

  it('driver and conductor starting the same trip at once: exactly one wins, the other gets 409', async () => {
    const w = await world();
    const pd = await odometerPhoto(w.sid, w.driver.user.id, { type: 'bus', id: w.bus.id });
    const pc = await odometerPhoto(w.sid, w.conductor.user.id, { type: 'bus', id: w.bus.id });
    const [d, c] = await Promise.all([
      as(t, w.driver).post('/driver/trips/start', startBody({ tripId: w.trip.id, busId: w.bus.id, odometerReading: 1000, odometerFileId: pd.id })),
      as(t, w.conductor).post('/driver/trips/start', startBody({ tripId: w.trip.id, busId: w.bus.id, odometerReading: 1000, odometerFileId: pc.id })),
    ]);
    expect([d.status, c.status].sort()).toEqual([201, 409]);
    const ev = await ownerQuery('select count(*)::int as n from trip_odometer_evidence where trip_id = $1', [w.trip.id]);
    expect(ev.rows[0]!.n).toBe(1);
  });

  it('the same clientStartId sent by two different users at once never yields two trips or a 500', async () => {
    const w = await world({ allow_non_school_trips: true });
    const id = crypto.randomUUID();
    const pd = await odometerPhoto(w.sid, w.driver.user.id, { type: 'bus', id: w.bus.id });
    const pc = await odometerPhoto(w.sid, w.conductor.user.id, { type: 'bus', id: w.bus.id });
    const [d, c] = await Promise.all([
      as(t, w.driver).post('/driver/trips/start', startBody({ clientStartId: id, tripType: 'non_school', purpose: 'Workshop run', busId: w.bus.id, odometerReading: 1000, odometerFileId: pd.id })),
      as(t, w.conductor).post('/driver/trips/start', startBody({ clientStartId: id, tripType: 'non_school', purpose: 'Workshop run', busId: w.bus.id, odometerReading: 1000, odometerFileId: pc.id })),
    ]);
    expect([d.status, c.status].sort()).toEqual([201, 409]);
    const n = await ownerQuery('select count(*)::int as n from trips where client_start_id = $1', [id]);
    expect(n.rows[0]!.n).toBe(1);
  });

  it('one driver racing non-school starts on two buses gets one trip and a clean 409 (never 500)', async () => {
    const w = await world({ allow_non_school_trips: true });
    const bus2 = await f.bus(w.sid, { code: 'R2', last_known_odometer: 500 });
    await f.busStaffAssignment(w.sid, bus2.id, w.driver.staff.id, { assignment_role: 'primary_driver', valid_from: new Date(Date.now() - 86_400_000).toISOString() });
    const p1 = await odometerPhoto(w.sid, w.driver.user.id, { type: 'bus', id: w.bus.id });
    const p2 = await odometerPhoto(w.sid, w.driver.user.id, { type: 'bus', id: bus2.id });
    const [r1, r2] = await Promise.all([
      as(t, w.driver).post('/driver/trips/start', startBody({ tripType: 'non_school', purpose: 'Fuel', busId: w.bus.id, odometerReading: 1000, odometerFileId: p1.id })),
      as(t, w.driver).post('/driver/trips/start', startBody({ tripType: 'non_school', purpose: 'Fuel', busId: bus2.id, odometerReading: 500, odometerFileId: p2.id })),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    const loser = r1.status === 409 ? r1 : r2;
    expect(loser.body.error.code).toBe('TRIP_ALREADY_ACTIVE');
    const n = await ownerQuery("select count(*)::int as n from trips where school_id = $1 and status = 'in_progress'", [w.sid]);
    expect(n.rows[0]!.n).toBe(1);
  });

  it('two concurrent ends with different readings: one completes, the other is refused; bus reading = winner', async () => {
    const w = await world();
    await started(w);
    const e1 = await odometerPhoto(w.sid, w.driver.user.id, { type: 'trip', id: w.trip.id });
    const e2 = await odometerPhoto(w.sid, w.driver.user.id, { type: 'trip', id: w.trip.id });
    const [a, b] = await Promise.all([endWith(w, w.driver, 1010, e1.id), endWith(w, w.driver, 1500, e2.id)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const won = a.status === 200 ? 1010 : 1500;
    const { rows } = await ownerQuery<{ end_odometer: number; last_known_odometer: number }>(
      'select t.end_odometer, b.last_known_odometer from trips t join buses b on b.id = t.bus_id where t.id = $1',
      [w.trip.id],
    );
    expect(rows[0]).toEqual({ end_odometer: won, last_known_odometer: won });
    const ev = await ownerQuery("select count(*)::int as n from trip_odometer_evidence where trip_id = $1 and kind = 'end'", [w.trip.id]);
    expect(ev.rows[0]!.n).toBe(1);
  });
});

describe('odometer bypass attempts', () => {
  it('start: gallery / unknown source, unfinished upload, photo of another trip or another person are all refused', async () => {
    const w = await world();
    const otherTrip = await f.trip(w.sid, w.bus.id, { trip_date: w.today, status: 'scheduled', direction: 'afternoon', planned_start_at: new Date(Date.now() + 7200_000).toISOString() });
    const photos = {
      gallery: await odometerPhoto(w.sid, w.driver.user.id, { type: 'bus', id: w.bus.id }, { source: 'gallery' }),
      noSource: await odometerPhoto(w.sid, w.driver.user.id, { type: 'bus', id: w.bus.id }, { source: null }),
      pending: await odometerPhoto(w.sid, w.driver.user.id, { type: 'bus', id: w.bus.id }, { status: 'pending' }),
      otherTrip: await odometerPhoto(w.sid, w.driver.user.id, { type: 'trip', id: otherTrip.id }),
      conductors: await odometerPhoto(w.sid, w.conductor.user.id, { type: 'bus', id: w.bus.id }),
      notOdometer: await f.file(w.sid, { category: 'bus_image', entity_type: 'bus', entity_id: w.bus.id, uploaded_by: w.driver.user.id, uploader_type: 'user', status: 'uploaded', metadata: { capture: { source: 'camera' } } }),
    };
    for (const [name, photo] of Object.entries(photos)) {
      const res = await as(t, w.driver).post('/driver/trips/start', startBody({ tripId: w.trip.id, busId: w.bus.id, odometerReading: 1000, odometerFileId: photo.id }));
      expect(res.status, name).toBe(400);
      expect(JSON.stringify(res.body.error), name).toContain('odometerFileId');
    }
    expect((await ownerQuery('select status from trips where id = $1', [w.trip.id])).rows[0]!.status).toBe('scheduled');
  });

  it('end: below start (422), missing photo (400), the start photo again, a gallery photo — all refused', async () => {
    const w = await world();
    await started(w, 1000);
    const startPhoto = (await ownerQuery<{ file_id: string }>("select file_id from trip_odometer_evidence where trip_id = $1 and kind = 'start'", [w.trip.id])).rows[0]!.file_id;
    const fresh = await odometerPhoto(w.sid, w.driver.user.id, { type: 'trip', id: w.trip.id });
    const below = await endWith(w, w.driver, 999.9, fresh.id);
    expect(below.status).toBe(422);
    expect(below.body.error.code).toBe('ODOMETER_INVALID');
    const noPhoto = await as(t, w.driver).post(`/driver/trips/${w.trip.id}/end`, endBody({ odometerReading: 1010 }));
    expect(noPhoto.status).toBe(400);
    expect((await endWith(w, w.driver, 1010, startPhoto)).status).toBe(400);
    const gallery = await odometerPhoto(w.sid, w.driver.user.id, { type: 'trip', id: w.trip.id }, { source: 'gallery' });
    expect((await endWith(w, w.driver, 1010, gallery.id)).status).toBe(400);
    const negative = await endWith(w, w.driver, -5, fresh.id);
    expect(negative.status).toBe(400);
    expect((await ownerQuery('select status from trips where id = $1', [w.trip.id])).rows[0]!.status).toBe('in_progress');
  });

  // Regression: the decrease baseline includes every reading recorded on a started trip of the bus
  // (repository.highestRecordedReading), so an auto-closed trip's start reading counts.
  it('a start below the start reading of an auto-closed trip of the same bus is flagged as odometer_decrease', async () => {
    const w = await world({ allow_non_school_trips: true, stale_trip_close_hours: 1 });
    await started(w, 2000); // 1000 km gap → odometer_gap, fine
    await ownerQuery("update trips set started_at = now() - interval '3 hours' where id = $1", [w.trip.id]);
    expect(await staleTripCloser({ schoolId: w.sid })).toEqual({ closed: 1 });
    const photo = await odometerPhoto(w.sid, w.driver.user.id, { type: 'bus', id: w.bus.id });
    const res = await as(t, w.driver).post('/driver/trips/start', startBody({ tripType: 'non_school', purpose: 'Workshop', busId: w.bus.id, odometerReading: 1010, odometerFileId: photo.id }));
    expect(res.status).toBe(201);
    const types = (await alertsOf(res.body.data.trip.id)).map((a) => a.alert_type);
    expect(types).toContain('odometer_decrease');
  });

  // Regression: with no usable GPS data the end raises odometer_gps_mismatch (reason no_gps_data) for
  // trips of at least odometerGpsMinKm (odometer.noGpsDataAlert), so keeping GPS off hides nothing.
  it('an end reading 5000 km above the start with no GPS data at all raises some odometer flag', async () => {
    const w = await world();
    await started(w, 1000);
    const photo = await odometerPhoto(w.sid, w.driver.user.id, { type: 'trip', id: w.trip.id });
    const res = await endWith(w, w.driver, 6000, photo.id);
    expect(res.status).toBe(200);
    const types = (await alertsOf(w.trip.id)).map((a) => a.alert_type);
    expect(types.some((x) => x.startsWith('odometer_'))).toBe(true);
  });
});

describe('admin corrections are audited and admin-only', () => {
  it('correct-odometer / cancel / reassign each leave exactly one audit row with old and new values; staff are refused', async () => {
    const w = await world();
    await started(w, 1000);
    const photo = await odometerPhoto(w.sid, w.driver.user.id, { type: 'trip', id: w.trip.id });
    expect((await endWith(w, w.driver, 1010, photo.id)).status).toBe(200);
    // Staff tokens on admin endpoints.
    const staffTry = await as(t, w.driver).post(`/school/trips/${w.trip.id}/correct-odometer`, { kind: 'end', reading: 1500, reason: 'mine' });
    expect(staffTry.status).toBe(403);
    const fix = await asAdmin(t, w.adminToken).post(`/school/trips/${w.trip.id}/correct-odometer`, { kind: 'end', reading: 1012, reason: 'Typo by driver' });
    expect(fix.status).toBe(200);
    const audits = await ownerQuery<{ action: string; actor_id: string; old_values: Record<string, unknown>; new_values: Record<string, unknown> }>(
      "select action, actor_id, old_values, new_values from audit_logs where entity_id = $1 and action = 'trip.correct_odometer'",
      [w.trip.id],
    );
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0]).toMatchObject({ actor_id: w.admin.id, old_values: { endOdometer: 1010 }, new_values: { reading: 1012, reason: 'Typo by driver', busOdometerUpdated: true } });
    const ev = await ownerQuery<{ reading: number }>("select reading from trip_odometer_evidence where trip_id = $1 and kind = 'end'", [w.trip.id]);
    expect(ev.rows[0]!.reading).toBe(1010); // evidence untouched

    const w2 = await world();
    const reassign = await asAdmin(t, w2.adminToken).post(`/school/trips/${w2.trip.id}/reassign`, { driverId: w2.backup.staff.id, reason: 'Driver sick' });
    expect(reassign.status).toBe(200);
    const cancel = await asAdmin(t, w2.adminToken).post(`/school/trips/${w2.trip.id}/cancel`, { reason: 'Rain' });
    expect(cancel.status).toBe(200);
    const actions = await ownerQuery<{ action: string; actor_id: string }>("select action, actor_id from audit_logs where entity_id = $1 and action in ('trip.reassign', 'trip.cancel') order by action", [w2.trip.id]);
    expect(actions.rows).toEqual([
      { action: 'trip.cancel', actor_id: w2.admin.id },
      { action: 'trip.reassign', actor_id: w2.admin.id },
    ]);
  });
});

describe('jobs never duplicate trips or alerts', () => {
  it('generate-daily-trips run three times concurrently creates one trip per schedule and date', async () => {
    const w = await world();
    const tomorrow = await localDate('Asia/Kolkata', 1);
    const results = await Promise.all([1, 2, 3].map(() => generateDailyTrips({ schoolId: w.sid, localDate: tomorrow })));
    expect(results.reduce((n, r) => n + r.created, 0)).toBe(1);
    const n = await ownerQuery('select count(*)::int as n from trips where schedule_id = $1 and trip_date = $2', [w.schedule.id, tomorrow]);
    expect(n.rows[0]!.n).toBe(1);
  });

  it('trip-not-started-check run concurrently raises one alert per trip and never re-raises after close', async () => {
    const w = await world();
    await ownerQuery("update trips set planned_start_at = now() - interval '30 minutes' where id = $1", [w.trip.id]);
    await Promise.all([1, 2, 3].map(() => tripNotStartedCheck({ schoolId: w.sid })));
    let alerts = await alertsOf(w.trip.id);
    expect(alerts.filter((a) => a.alert_type === 'trip_not_started')).toHaveLength(1);
    await ownerQuery("update alerts set status = 'closed' where trip_id = $1", [w.trip.id]);
    await tripNotStartedCheck({ schoolId: w.sid });
    alerts = await alertsOf(w.trip.id);
    expect(alerts.filter((a) => a.alert_type === 'trip_not_started')).toHaveLength(1);
  });

  it('stale-trip-closer run concurrently closes once (one alert, one audit row)', async () => {
    const w = await world({ stale_trip_close_hours: 1 });
    await started(w);
    await ownerQuery("update trips set started_at = now() - interval '3 hours' where id = $1", [w.trip.id]);
    const res = await Promise.all([1, 2].map(() => staleTripCloser({ schoolId: w.sid })));
    expect(res.reduce((n, r) => n + r.closed, 0)).toBe(1);
    expect((await alertsOf(w.trip.id)).filter((a) => a.alert_type === 'trip_auto_closed')).toHaveLength(1);
    const audit = await ownerQuery("select count(*)::int as n from audit_logs where entity_id = $1 and action = 'trip.auto_close'", [w.trip.id]);
    expect(audit.rows[0]!.n).toBe(1);
  });

  it('device events sent concurrently keep one open alert per trip and type', async () => {
    const w = await world();
    await started(w);
    const ev = { events: [{ type: 'low_battery', occurredAt: new Date().toISOString(), batteryPct: 9 }] };
    const all = await Promise.all([1, 2, 3, 4].map(() => as(t, w.driver).post(`/driver/trips/${w.trip.id}/events`, ev)));
    expect(all.every((r) => r.status === 200)).toBe(true);
    const open = (await alertsOf(w.trip.id)).filter((a) => a.alert_type === 'low_battery' && a.status === 'open');
    expect(open).toHaveLength(1);
  });

  it('device events for a trip of another device / not running are refused', async () => {
    const w = await world();
    await started(w);
    const ev = { events: [{ type: 'gps_disabled', occurredAt: new Date().toISOString() }] };
    expect((await as(t, w.conductor).post(`/driver/trips/${w.trip.id}/events`, ev)).status).toBe(403);
    await asAdmin(t, w.adminToken).post(`/school/trips/${w.trip.id}/cancel`, { reason: 'Breakdown' });
    expect((await as(t, w.driver).post(`/driver/trips/${w.trip.id}/events`, ev)).status).toBe(409);
    expect((await alertsOf(w.trip.id)).filter((a) => a.alert_type === 'gps_disabled')).toHaveLength(0);
  });
});
