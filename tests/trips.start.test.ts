// POST /driver/trips/start (BP §10.2): every validation rule, idempotent clientStartId, device binding,
// backup driver / conductor starts, non-school trip rules, odometer photo rules and the start-time
// odometer alerts (decrease vs last known reading, gap vs previous closed trip, critical gaps).
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type TestApp } from './helpers/authApp.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { alertsOf, as, odometerPhoto, startBody, startScheduled, tripWorld, type TripWorld } from './trips.fixtures.js';

let t: TestApp;

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
});
afterAll(closeDb);

const world = (settings?: f.Values) => tripWorld(t, settings ? { settings } : {});

describe('start a scheduled trip', () => {
  it('starts it in one transaction: status, device binding, evidence, snapshots, config and audit', async () => {
    const w = await world();
    const res = await startScheduled(w, 1000);
    expect(res.status).toBe(201);
    expect(res.body.data.replayed).toBe(false);
    expect(res.body.data.trip).toMatchObject({
      id: w.trip.id, status: 'in_progress', tripType: 'school', direction: 'morning', busId: w.bus.id, busCode: 'R1', startOdometer: 1000,
      driverStaffId: w.driver.staff.id, driverName: 'Ramesh Kumar', conductorStaffId: w.conductor.staff.id, onThisDevice: true,
    });
    expect(res.body.data.config).toMatchObject({ minIntervalS: 10, movingIntervalS: 10, latePointsWindowHours: 24, odometerGalleryAllowed: false, allowNonSchoolTrips: false });
    expect(res.body.data.alerts).toEqual([]);
    const { rows } = await ownerQuery('select status, device_id, started_by, start_lat, start_device_time, client_start_id, bus_registration_snapshot from trips where id = $1', [w.trip.id]);
    expect(rows[0]).toMatchObject({ status: 'in_progress', device_id: w.driver.deviceRowId, started_by: w.driver.user.id, start_lat: 12.9716, bus_registration_snapshot: w.bus.registration_no });
    const ev = await ownerQuery('select kind, reading, source, sha256, device_id, recorded_by, latitude from trip_odometer_evidence where trip_id = $1', [w.trip.id]);
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0]).toMatchObject({ kind: 'start', reading: 1000, source: 'camera', device_id: w.driver.deviceRowId, recorded_by: w.driver.user.id, latitude: 12.9716 });
    expect(ev.rows[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    const audits = await ownerQuery<{ action: string; new_values: Record<string, unknown> }>("select action, new_values from audit_logs where entity_id = $1 and action = 'trip.start'", [w.trip.id]);
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0]!.new_values).toMatchObject({ assignmentRole: 'primary_driver', photoSource: 'camera' });
  });

  it('is idempotent on clientStartId and refuses the id for another start', async () => {
    const w = await world();
    const photo = await odometerPhoto(w.sid, w.driver.user.id, { type: 'trip', id: w.trip.id });
    const body = startBody({ tripId: w.trip.id, busId: w.bus.id, odometerReading: 1001.26, odometerFileId: photo.id });
    const first = await as(t, w.driver).post('/driver/trips/start', body);
    expect(first.status).toBe(201);
    expect(first.body.data.trip.startOdometer).toBe(1001.3);
    const again = await as(t, w.driver).post('/driver/trips/start', body);
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ replayed: true, trip: { id: w.trip.id, status: 'in_progress' } });
    const other = await f.bus(w.sid, { code: 'R9' });
    const reused = await as(t, w.driver).post('/driver/trips/start', { ...body, busId: other.id });
    expect(reused.status).toBe(409);
    expect(reused.body.error.details.reason).toBe('CLIENT_START_ID_REUSED');
    const ev = await ownerQuery('select count(*)::int as n from trip_odometer_evidence where trip_id = $1', [w.trip.id]);
    expect(ev.rows[0]!.n).toBe(1);
  });

  it('requires the bound device (header present and matching)', async () => {
    const w = await world();
    const photo = await odometerPhoto(w.sid, w.driver.user.id, { type: 'bus', id: w.bus.id });
    const body = startBody({ tripId: w.trip.id, busId: w.bus.id, odometerReading: 1000, odometerFileId: photo.id });
    const missing = await as(t, { token: w.driver.token, deviceId: '' }).post('/driver/trips/start', body);
    expect(missing.status).toBe(403);
    expect(missing.body.error.code).toBe('DEVICE_NOT_BOUND');
    const wrong = await as(t, { token: w.driver.token, deviceId: 'another-phone-0001' }).post('/driver/trips/start', body);
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('DEVICE_NOT_BOUND');
    const admin = await as(t, { token: w.adminToken, deviceId: w.driver.deviceId }).post('/driver/trips/start', body);
    expect(admin.status).toBe(403);
    expect(admin.body.error.code).toBe('FORBIDDEN');
  });

  it('refuses staff not assigned to the bus now and inactive users', async () => {
    const w = await world();
    await ownerQuery("update bus_staff_assignments set valid_to = now() - interval '1 minute' where staff_id = $1", [w.driver.staff.id]);
    const res = await startScheduled(w);
    expect(res.status).toBe(403);
    expect(res.body.error.details.reason).toBe('NOT_ASSIGNED');
    await ownerQuery('update users set is_active = false where id = $1', [w.conductor.user.id]);
    const photo = await odometerPhoto(w.sid, w.conductor.user.id, { type: 'bus', id: w.bus.id });
    const inactive = await as(t, w.conductor).post('/driver/trips/start', startBody({ tripId: w.trip.id, busId: w.bus.id, odometerReading: 1000, odometerFileId: photo.id }));
    expect(inactive.status).toBe(401);
  });

  it('lets a backup driver start (school setting) and records the actual driver', async () => {
    const w = await world();
    const photo = await odometerPhoto(w.sid, w.backup.user.id, { type: 'bus', id: w.bus.id });
    const body = startBody({ tripId: w.trip.id, busId: w.bus.id, odometerReading: 1000, odometerFileId: photo.id });
    await f.schoolSettings(w.sid, { allow_backup_driver_start: false });
    const refused = await as(t, w.backup).post('/driver/trips/start', body);
    expect(refused.status).toBe(403);
    expect(refused.body.error.details.reason).toBe('BACKUP_START_NOT_ALLOWED');
    await f.schoolSettings(w.sid, { allow_backup_driver_start: true });
    const ok = await as(t, w.backup).post('/driver/trips/start', body);
    expect(ok.status).toBe(201);
    expect(ok.body.data.trip).toMatchObject({ driverStaffId: w.backup.staff.id, driverName: 'Mahesh Gowda', conductorStaffId: w.conductor.staff.id });
  });

  it('lets the conductor start: conductor = caller, driver = the planned driver', async () => {
    const w = await world();
    const photo = await odometerPhoto(w.sid, w.conductor.user.id, { type: 'bus', id: w.bus.id });
    const res = await as(t, w.conductor).post('/driver/trips/start', startBody({ tripId: w.trip.id, busId: w.bus.id, odometerReading: 1000, odometerFileId: photo.id }));
    expect(res.status).toBe(201);
    expect(res.body.data.trip).toMatchObject({ conductorStaffId: w.conductor.staff.id, driverStaffId: w.driver.staff.id });
  });

  it('allows one trip in progress per bus and per user', async () => {
    const w = await world();
    expect((await startScheduled(w)).status).toBe(201);
    const second = await f.trip(w.sid, w.bus.id, { schedule_id: null, route_id: w.route.id, trip_date: w.today, status: 'scheduled', direction: 'afternoon' });
    const photo = await odometerPhoto(w.sid, w.backup.user.id, { type: 'bus', id: w.bus.id });
    const busBusy = await as(t, w.backup).post('/driver/trips/start', startBody({ tripId: second.id, busId: w.bus.id, odometerReading: 1000, odometerFileId: photo.id }));
    expect(busBusy.status).toBe(409);
    expect(busBusy.body.error).toMatchObject({ code: 'TRIP_ALREADY_ACTIVE', details: { reason: 'BUS_BUSY', tripId: w.trip.id } });
    const bus2 = await f.bus(w.sid, { code: 'R2' });
    await f.busStaffAssignment(w.sid, bus2.id, w.driver.staff.id, { assignment_role: 'backup_driver' });
    const t2 = await f.trip(w.sid, bus2.id, { trip_date: w.today, status: 'scheduled' });
    const photo2 = await odometerPhoto(w.sid, w.driver.user.id, { type: 'bus', id: bus2.id });
    const userBusy = await as(t, w.driver).post('/driver/trips/start', startBody({ tripId: t2.id, busId: bus2.id, odometerReading: 10, odometerFileId: photo2.id }));
    expect(userBusy.status).toBe(409);
    expect(userBusy.body.error.details.reason).toBe('ALREADY_ON_TRIP');
  });

  it('checks the bus, the trip state, its date and its bus', async () => {
    const w = await world();
    await ownerQuery("update buses set status = 'maintenance' where id = $1", [w.bus.id]);
    const maint = await startScheduled(w);
    expect(maint.status).toBe(409);
    expect(maint.body.error).toMatchObject({ code: 'INVALID_STATE', details: { reason: 'BUS_UNAVAILABLE' } });
    await ownerQuery("update buses set status = 'active' where id = $1", [w.bus.id]);

    await ownerQuery("update trips set trip_date = trip_date + 1 where id = $1", [w.trip.id]);
    const tomorrow = await startScheduled(w);
    expect(tomorrow.status).toBe(409);
    expect(tomorrow.body.error.details.reason).toBe('NOT_TODAY');
    await ownerQuery("update trips set trip_date = trip_date - 1, status = 'cancelled' where id = $1", [w.trip.id]);
    const cancelled = await startScheduled(w);
    expect(cancelled.status).toBe(409);
    expect(cancelled.body.error.details).toMatchObject({ reason: 'NOT_SCHEDULED', status: 'cancelled' });

    const other = await f.bus(w.sid, { code: 'R3' });
    const otherTrip = await f.trip(w.sid, other.id, { trip_date: w.today, status: 'scheduled' });
    const photo = await odometerPhoto(w.sid, w.driver.user.id, { type: 'bus', id: w.bus.id });
    const mismatch = await as(t, w.driver).post('/driver/trips/start', startBody({ tripId: otherTrip.id, busId: w.bus.id, odometerReading: 1000, odometerFileId: photo.id }));
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error.details[0].path).toBe('busId');
    const unknown = await as(t, w.driver).post('/driver/trips/start', startBody({ tripId: crypto.randomUUID(), busId: w.bus.id, odometerReading: 1000, odometerFileId: photo.id }));
    expect(unknown.status).toBe(404);
  });

  it('validates the body (reading, photo, coordinates, trip/purpose combination)', async () => {
    const w = await world();
    const bad = await as(t, w.driver).post('/driver/trips/start', { clientStartId: 'x', busId: w.bus.id, odometerReading: -1, latitude: 100, longitude: 0, deviceTime: 'now', school_id: w.sid });
    expect(bad.status).toBe(400);
    const paths = bad.body.error.details.map((d: { path: string }) => d.path);
    for (const p of ['clientStartId', 'odometerReading', 'odometerFileId', 'latitude', 'deviceTime']) expect(paths).toContain(p);
    const mixed = await as(t, w.driver).post('/driver/trips/start', startBody({ tripId: w.trip.id, tripType: 'non_school', busId: w.bus.id, odometerReading: 1, odometerFileId: crypto.randomUUID() }));
    expect(mixed.status).toBe(400);
    expect(mixed.body.error.details.map((d: { path: string }) => d.path)).toEqual(expect.arrayContaining(['tripId', 'purpose']));
  });
});

describe('odometer photo rules', () => {
  it('requires an uploaded odometer photo taken by the caller for this bus/trip, used once', async () => {
    const w = await world();
    const start = (fileId: string) => as(t, w.driver).post('/driver/trips/start', startBody({ tripId: w.trip.id, busId: w.bus.id, odometerReading: 1000, odometerFileId: fileId }));
    const expect400 = async (fileId: string, message: RegExp) => {
      const res = await start(fileId);
      expect(res.status).toBe(400);
      expect(res.body.error.details).toEqual([{ path: 'odometerFileId', message: expect.stringMatching(message) }]);
    };
    await expect400(crypto.randomUUID(), /not found/);
    await expect400((await f.file(w.sid, { category: 'bus_image', entity_type: 'bus', entity_id: w.bus.id, uploaded_by: w.driver.user.id })).id, /not found/);
    await expect400((await odometerPhoto(w.sid, w.driver.user.id, { type: 'bus', id: w.bus.id }, { status: 'pending' })).id, /not complete/);
    await expect400((await odometerPhoto(w.sid, w.conductor.user.id, { type: 'bus', id: w.bus.id })).id, /taken by you/);
    const otherBus = await f.bus(w.sid, { code: 'R4' });
    await expect400((await odometerPhoto(w.sid, w.driver.user.id, { type: 'bus', id: otherBus.id })).id, /another bus or trip/);
    await expect400((await odometerPhoto(w.sid, w.driver.user.id, { type: 'bus', id: w.bus.id }, { source: 'gallery' })).id, /live camera/);
    await expect400((await odometerPhoto(w.sid, w.driver.user.id, { type: 'bus', id: w.bus.id }, { source: null })).id, /live camera/);
    const other = await tripWorld(t);
    await expect400((await odometerPhoto(other.sid, w.driver.user.id, { type: 'bus', id: w.bus.id })).id, /not found/);

    const used = await odometerPhoto(w.sid, w.driver.user.id, { type: 'bus', id: w.bus.id });
    const prior = await f.trip(w.sid, w.bus.id, { status: 'completed', started_at: new Date(Date.now() - 7200_000).toISOString(), ended_at: new Date(Date.now() - 3600_000).toISOString(), start_odometer: 900, end_odometer: 1000 });
    await f.tripOdometerEvidence(w.sid, prior.id, { file_id: used.id, kind: 'end', reading: 1000 });
    await expect400(used.id, /already used/);
  });

  it('accepts gallery photos when the school allows them (source recorded)', async () => {
    const w = await world({ odometer_gallery_allowed: true });
    const photo = await odometerPhoto(w.sid, w.driver.user.id, { type: 'bus', id: w.bus.id }, { source: 'gallery' });
    const res = await as(t, w.driver).post('/driver/trips/start', startBody({ tripId: w.trip.id, busId: w.bus.id, odometerReading: 1000, odometerFileId: photo.id }));
    expect(res.status).toBe(201);
    const ev = await ownerQuery('select source from trip_odometer_evidence where trip_id = $1', [w.trip.id]);
    expect(ev.rows[0]!.source).toBe('gallery');
  });
});

describe('start-time odometer alerts (BP §10.3 rule 4)', () => {
  async function previousTrip(w: TripWorld, end: number) {
    return f.trip(w.sid, w.bus.id, {
      status: 'completed', trip_date: w.today, started_at: new Date(Date.now() - 7200_000).toISOString(), ended_at: new Date(Date.now() - 3600_000).toISOString(),
      start_odometer: end - 20, end_odometer: end, bus_code_snapshot: 'R1',
    });
  }

  it('no alert when the reading continues the previous trip within the threshold', async () => {
    const w = await world();
    await previousTrip(w, 1000);
    const res = await startScheduled(w, 1004);
    expect(res.status).toBe(201);
    expect(res.body.data.alerts).toEqual([]);
    expect(await alertsOf(w.trip.id)).toEqual([]);
  });

  it('raises odometer_gap (warning, critical above 4× the threshold) for unexplained distance', async () => {
    const w = await world();
    const prev = await previousTrip(w, 1000);
    const res = await startScheduled(w, 1012);
    expect(res.status).toBe(201);
    expect(res.body.data.alerts).toEqual([{ type: 'odometer_gap', severity: 'warning', title: expect.stringContaining('12 km') }]);
    const alerts = await alertsOf(w.trip.id);
    expect(alerts).toEqual([expect.objectContaining({ alert_type: 'odometer_gap', severity: 'warning', dedupe_key: `odometer_gap:${w.trip.id}`, details: expect.objectContaining({ previousTripId: prev.id, gapKm: 12, thresholdKm: 5 }) })]);

    const w2 = await world({ odometer_mismatch_threshold_km: 2 });
    await previousTrip(w2, 1000);
    const critical = await startScheduled(w2, 1009);
    expect(critical.body.data.alerts[0]).toMatchObject({ type: 'odometer_gap', severity: 'critical' });
  });

  it('raises odometer_decrease (critical) below the previous end or the last known reading', async () => {
    const w = await world();
    await previousTrip(w, 1000);
    const res = await startScheduled(w, 990);
    expect(res.status).toBe(201);
    expect(res.body.data.alerts).toEqual([{ type: 'odometer_decrease', severity: 'critical', title: expect.stringContaining('decreased') }]);

    const w2 = await world();
    await ownerQuery('update buses set last_known_odometer = 1500 where id = $1', [w2.bus.id]);
    const below = await startScheduled(w2, 1200);
    expect(below.status).toBe(201);
    const alerts = await alertsOf(w2.trip.id);
    expect(alerts).toEqual([expect.objectContaining({ alert_type: 'odometer_decrease', severity: 'critical', details: expect.objectContaining({ phase: 'start', lastKnownOdometer: 1500 }) })]);
    const lastKnown = await ownerQuery('select last_known_odometer from buses where id = $1', [w2.bus.id]);
    expect(lastKnown.rows[0]!.last_known_odometer).toBe(1500);
  });
});

describe('non-school trips (BP §10.1)', () => {
  it('are refused unless the school allows them, and need a purpose', async () => {
    const w = await world();
    const photo = await odometerPhoto(w.sid, w.driver.user.id, { type: 'bus', id: w.bus.id });
    const body = startBody({ tripType: 'non_school', busId: w.bus.id, purpose: 'Fuel station and workshop', odometerReading: 1000, odometerFileId: photo.id });
    const refused = await as(t, w.driver).post('/driver/trips/start', body);
    expect(refused.status).toBe(403);
    expect(refused.body.error.details.reason).toBe('NON_SCHOOL_TRIPS_DISABLED');
    await f.schoolSettings(w.sid, { allow_non_school_trips: true });
    const noPurpose = await as(t, w.driver).post('/driver/trips/start', { ...body, purpose: '  ' });
    expect(noPurpose.status).toBe(400);
    expect(noPurpose.body.error.details).toEqual([{ path: 'purpose', message: 'Required for a non-school trip' }]);
    const ok = await as(t, w.driver).post('/driver/trips/start', body);
    expect(ok.status).toBe(201);
    expect(ok.body.data.trip).toMatchObject({ tripType: 'non_school', direction: null, purpose: 'Fuel station and workshop', tripDate: w.today, driverStaffId: w.driver.staff.id, conductorStaffId: w.conductor.staff.id, routeId: null });
  });
});
