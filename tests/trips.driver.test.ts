// Driver/conductor app endpoints besides start/end (BP §8.4, §10.4, §14): /driver/me, /driver/home,
// /driver/trips/active (resume), /driver/trips/history (own only), device events → alerts (dedupe,
// mock location, trip interrupted), the interrupt action and POST /driver/devices.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { events, type AppEvents } from '../src/shared/events.js';
import { buildApp, type TestApp } from './helpers/authApp.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { alertsOf, as, localDate, odometerPhoto, startBody, startScheduled, tripWorld } from './trips.fixtures.js';

let t: TestApp;

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
});
afterAll(closeDb);

describe('GET /driver/me', () => {
  it('returns the profile, the school and the current bus/route assignments', async () => {
    const w = await tripWorld(t);
    const res = await as(t, w.driver).get('/driver/me');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      user: { id: w.driver.user.id, role: 'driver', fullName: 'Ramesh Kumar' },
      staff: { id: w.driver.staff.id, staffType: 'driver', fullName: 'Ramesh Kumar', photoUrl: null },
      school: { id: w.sid, code: w.school.code, timezone: 'Asia/Kolkata', logoUrl: null },
      assignments: [{ busId: w.bus.id, busCode: 'R1', role: 'primary_driver', lastKnownOdometer: 1000, routes: [{ routeId: w.route.id, code: 'R1', direction: 'morning' }] }],
    });
    await ownerQuery("update bus_staff_assignments set valid_to = now() where staff_id = $1", [w.driver.staff.id]);
    expect((await as(t, w.driver).get('/driver/me')).body.data.assignments).toEqual([]);
  });
});

describe('GET /driver/home', () => {
  it("lists today's trips by direction with start eligibility, announcements and config", async () => {
    const w = await tripWorld(t, { settings: { allow_non_school_trips: true } });
    const pm = await f.route(w.sid, { code: 'R1', name: 'Route 1 PM', direction: 'afternoon' });
    const afternoon = await f.trip(w.sid, w.bus.id, { route_id: pm.id, trip_date: w.today, status: 'scheduled', direction: 'afternoon', planned_start_at: new Date(Date.now() + 7 * 3600_000).toISOString() });
    await f.trip(w.sid, w.bus.id, { trip_date: await localDate('Asia/Kolkata', -1), status: 'scheduled', direction: 'morning' }); // yesterday: not listed
    await f.announcement(w.sid, { title: 'Drivers meeting', audience: 'drivers' });
    await f.announcement(w.sid, { title: 'Parents only', audience: 'parents' });
    await f.schoolSettings(w.sid, { allow_backup_driver_start: false });

    const res = await as(t, w.driver).get('/driver/home');
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.date).toBe(w.today);
    expect(d.morning).toEqual([expect.objectContaining({ id: w.trip.id, myRole: 'primary_driver', canStart: true, blockedReason: null })]);
    expect(d.afternoon).toEqual([expect.objectContaining({ id: afternoon.id, canStart: true })]);
    expect(d.activeTrip).toBeNull();
    expect(d.announcements.map((a: { title: string }) => a.title)).toEqual(['Drivers meeting']);
    expect(d.config).toMatchObject({ allowNonSchoolTrips: true, allowBackupDriverStart: false, minIntervalS: 10 });
    expect(d.buses).toEqual([expect.objectContaining({ busId: w.bus.id, role: 'primary_driver' })]);

    const backup = await as(t, w.backup).get('/driver/home');
    expect(backup.body.data.morning[0]).toMatchObject({ myRole: 'backup_driver', canStart: false, blockedReason: 'BACKUP_START_NOT_ALLOWED' });

    expect((await startScheduled(w)).status).toBe(201);
    const after = (await as(t, w.driver).get('/driver/home')).body.data;
    expect(after.activeTrip).toMatchObject({ id: w.trip.id, status: 'in_progress', onThisDevice: true });
    expect(after.morning[0]).toMatchObject({ status: 'in_progress', canStart: false, blockedReason: 'NOT_SCHEDULED' });
    expect(after.afternoon[0]).toMatchObject({ canStart: false, blockedReason: 'BUS_BUSY' });
  });
});

describe('resume and history', () => {
  it('GET /driver/trips/active returns the running trip (flagged when bound to another phone)', async () => {
    const w = await tripWorld(t);
    expect((await as(t, w.driver).get('/driver/trips/active')).body.data).toMatchObject({ trip: null, config: { minIntervalS: 10 } });
    await startScheduled(w);
    const mine = await as(t, w.driver).get('/driver/trips/active');
    expect(mine.body.data.trip).toMatchObject({ id: w.trip.id, onThisDevice: true });
    const conductor = await as(t, w.conductor).get('/driver/trips/active');
    expect(conductor.body.data.trip).toMatchObject({ id: w.trip.id, onThisDevice: false });
    expect((await as(t, w.backup).get('/driver/trips/active')).body.data.trip).toBeNull();
  });

  it("GET /driver/trips/history lists only the caller's trips (no scheduled ones by default)", async () => {
    const w = await tripWorld(t);
    const mine = await f.trip(w.sid, w.bus.id, { status: 'completed', trip_date: w.today, driver_staff_id: w.driver.staff.id, started_at: new Date(Date.now() - 7200_000).toISOString(), ended_at: new Date(Date.now() - 3600_000).toISOString(), start_odometer: 900, end_odometer: 950 });
    await f.trip(w.sid, w.bus.id, { status: 'completed', trip_date: w.today, driver_staff_id: w.backup.staff.id, started_at: new Date(Date.now() - 9000_000).toISOString(), ended_at: new Date(Date.now() - 8000_000).toISOString() });
    const res = await as(t, w.driver).get('/driver/trips/history');
    expect(res.status).toBe(200);
    expect(res.body.data.map((x: { id: string }) => x.id)).toEqual([mine.id]);
    expect(res.body.meta).toMatchObject({ page: 1, total: 1 });
    const scheduled = await as(t, w.driver).get('/driver/trips/history?status=scheduled');
    expect(scheduled.body.data.map((x: { id: string }) => x.id)).toEqual([w.trip.id]);
    const old = await as(t, w.driver).get(`/driver/trips/history?to=2000-01-01`);
    expect(old.body.data).toEqual([]);
    expect((await as(t, w.driver).get('/driver/trips/history?status=flying')).status).toBe(400);
  });
});

describe('device events', () => {
  it('raises gps/battery/network alerts once per trip and maps mock locations to a critical alert', async () => {
    const w = await tripWorld(t);
    await startScheduled(w);
    const at = new Date().toISOString();
    const res = await as(t, w.driver).post(`/driver/trips/${w.trip.id}/events`, {
      events: [
        { type: 'gps_disabled', occurredAt: at },
        { type: 'low_battery', occurredAt: at, batteryPct: 12 },
        { type: 'no_network', occurredAt: at, networkType: 'none' },
        { type: 'mock_location', occurredAt: at, latitude: 12.9, longitude: 77.6 },
        { type: 'gps_disabled', occurredAt: at },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.accepted).toBe(5);
    expect(res.body.data.alerts.map((a: { type: string; severity: string }) => `${a.type}/${a.severity}`)).toEqual(['gps_disabled/warning', 'low_battery/warning', 'no_network/warning', 'gps_disabled/critical']);
    expect(res.body.data.alerts[1].title).toContain('(12%)');
    const again = await as(t, w.driver).post(`/driver/trips/${w.trip.id}/events`, { events: [{ type: 'low_battery', occurredAt: at, batteryPct: 8 }] });
    expect(again.body.data.alerts).toEqual([]);
    // Alerts of one transaction share created_at and uuid_v7() is not ordered within a millisecond:
    // compare as a set.
    expect((await alertsOf(w.trip.id)).map((a) => a.dedupe_key).sort()).toEqual([`gps_disabled:${w.trip.id}`, `gps_disabled:mock:${w.trip.id}`, `low_battery:${w.trip.id}`, `no_network:${w.trip.id}`].sort());
  });

  it('refuses other devices, other trips and finished trips beyond the late window', async () => {
    const w = await tripWorld(t);
    await startScheduled(w);
    const body = { events: [{ type: 'gps_disabled', occurredAt: new Date().toISOString() }] };
    expect((await as(t, { token: w.driver.token, deviceId: 'other-device-1234' }).post(`/driver/trips/${w.trip.id}/events`, body)).status).toBe(403);
    expect((await as(t, w.backup).post(`/driver/trips/${w.trip.id}/events`, body)).status).toBe(404);
    await ownerQuery("update trips set status = 'completed', ended_at = now() - interval '25 hours', started_at = now() - interval '26 hours' where id = $1", [w.trip.id]);
    const late = await as(t, w.driver).post(`/driver/trips/${w.trip.id}/events`, body);
    expect(late.status).toBe(409);
    expect((await as(t, w.driver).post(`/driver/trips/${w.trip.id}/events`, { events: [] })).status).toBe(400);
  });
});

describe('trip interrupted', () => {
  it('marks the running trip interrupted (still in progress), audited, with an event', async () => {
    const w = await tripWorld(t);
    await startScheduled(w);
    const seen: AppEvents['trip.interrupted'][] = [];
    const off = events.on('trip.interrupted', (p) => void seen.push(p));
    const res = await as(t, w.driver).post(`/driver/trips/${w.trip.id}/interrupt`, { reason: 'Engine overheating near Silk Board' });
    off();
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'in_progress', closeReason: 'Engine overheating near Silk Board' });
    expect(res.body.data.interruptedAt).not.toBeNull();
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual([expect.objectContaining({ tripId: w.trip.id, interrupted: true, reason: 'Engine overheating near Silk Board' })]);
    const audit = await ownerQuery("select count(*)::int as n from audit_logs where entity_id = $1 and action = 'trip.interrupt'", [w.trip.id]);
    expect(audit.rows[0]!.n).toBe(1);
    const viaEvents = await as(t, w.driver).post(`/driver/trips/${w.trip.id}/events`, { events: [{ type: 'trip_interrupted', occurredAt: new Date().toISOString(), message: 'Flat tyre' }] });
    expect(viaEvents.status).toBe(200);
    const row = await ownerQuery('select close_reason, status from trips where id = $1', [w.trip.id]);
    expect(row.rows[0]).toMatchObject({ close_reason: 'Flat tyre', status: 'in_progress' });
    // The interrupted trip can still be ended normally.
    const photo = await odometerPhoto(w.sid, w.driver.user.id, { type: 'trip', id: w.trip.id });
    const ended = await as(t, w.driver).post(`/driver/trips/${w.trip.id}/end`, { odometerReading: 1003, odometerFileId: photo.id, latitude: 12.9, longitude: 77.6, deviceTime: new Date().toISOString() });
    expect(ended.status).toBe(200);
    expect((await as(t, w.driver).post(`/driver/trips/${w.trip.id}/interrupt`, { reason: 'Too late now' })).status).toBe(409);
  });
});

describe('POST /driver/devices', () => {
  it('stores the FCM token and versions of the bound device (token redacted in the audit)', async () => {
    const w = await tripWorld(t);
    const res = await as(t, w.driver).post('/driver/devices', { fcmToken: 'fcm-token-abc', osVersion: 'Android 15', appVersion: '1.2.0', model: 'Pixel 9' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: w.driver.deviceRowId, deviceId: w.driver.deviceId, hasFcmToken: true, osVersion: 'Android 15', appVersion: '1.2.0', model: 'Pixel 9' });
    const row = await ownerQuery('select fcm_token, os_version from devices where id = $1', [w.driver.deviceRowId]);
    expect(row.rows[0]).toMatchObject({ fcm_token: 'fcm-token-abc', os_version: 'Android 15' });
    const cleared = await as(t, w.driver).post('/driver/devices', { fcmToken: null });
    expect(cleared.body.data.hasFcmToken).toBe(false);
    expect((await as(t, w.driver).post('/driver/devices', {})).status).toBe(400);
    const audit = await ownerQuery<{ new_values: string }>("select new_values::text from audit_logs where entity_id = $1 and action = 'device.update'", [w.driver.deviceRowId]);
    expect(audit.rows.length).toBe(2);
    expect(audit.rows.map((r) => r.new_values).join(' ')).not.toContain('fcm-token-abc');
  });
});

describe('start body for scheduled trips started by id only', () => {
  it('rejects a school trip without a tripId', async () => {
    const w = await tripWorld(t);
    const photo = await odometerPhoto(w.sid, w.driver.user.id, { type: 'bus', id: w.bus.id });
    const res = await as(t, w.driver).post('/driver/trips/start', startBody({ tripType: 'school', busId: w.bus.id, odometerReading: 1000, odometerFileId: photo.id }));
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([{ path: 'tripId', message: 'Required for a school trip' }]);
  });
});
