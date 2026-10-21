// School admin trip endpoints (BP §13.3 Trips & Audit, §10.4): list filters/sort/CSV, detail with
// evidence URLs, flags, stop events and the planned route, cancel, odometer correction (audited, original
// preserved, distances and last known reading follow) and reassignment (audited, staff checks).
import crypto from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type TestApp } from './helpers/authApp.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { as, asAdmin, endBody, odometerPhoto, startScheduled, tripWorld, type TripWorld } from './trips.fixtures.js';

let t: TestApp;
let w: TripWorld;
let completed: f.TenantRow;
let nonSchool: f.TenantRow;

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  w = await tripWorld(t);
  completed = await f.trip(w.sid, w.bus.id, {
    route_id: w.route.id, trip_date: '2026-10-01', status: 'completed', started_at: '2026-10-01T01:30:00Z', ended_at: '2026-10-01T02:30:00Z',
    start_odometer: 900, end_odometer: 930, distance_odometer_km: 30, distance_gps_km: 29.2, driver_staff_id: w.driver.staff.id, driver_name_snapshot: 'Ramesh Kumar',
    bus_code_snapshot: 'R1', route_code_snapshot: 'R1', route_name_snapshot: 'Route 1', started_by: w.driver.user.id,
  });
  await f.tripOdometerEvidence(w.sid, completed.id, { kind: 'start', reading: 900, recorded_by: w.driver.user.id });
  await f.tripOdometerEvidence(w.sid, completed.id, { kind: 'end', reading: 930 });
  await f.tripStopEvent(w.sid, completed.id, w.stops[0]!.id, { arrived_at: '2026-10-01T01:40:00Z', departed_at: '2026-10-01T01:41:00Z', dwell_s: 60 });
  await f.alert(w.sid, { alert_type: 'odometer_gap', trip_id: completed.id, bus_id: w.bus.id, title: 'Gap', dedupe_key: `odometer_gap:${completed.id}` });
  nonSchool = await f.trip(w.sid, w.bus.id, { trip_type: 'non_school', direction: null, purpose: 'Workshop visit', trip_date: '2026-10-02', status: 'completed', started_at: '2026-10-02T05:00:00Z', ended_at: '2026-10-02T06:00:00Z', start_odometer: 930, end_odometer: 950, bus_code_snapshot: 'R1', driver_staff_id: w.backup.staff.id, driver_name_snapshot: 'Mahesh Gowda' });
});
afterAll(closeDb);

const admin = () => asAdmin(t, w.adminToken);

describe('GET /school/trips', () => {
  it('lists trips with flags, filters, sort and pagination', async () => {
    const all = await admin().get('/school/trips?limit=10');
    expect(all.status).toBe(200);
    expect(all.body.meta).toMatchObject({ page: 1, limit: 10, total: 3 });
    expect(all.body.data.map((r: { id: string }) => r.id)).toEqual([w.trip.id, nonSchool.id, completed.id]);
    expect(all.body.data[2]).toMatchObject({ busCode: 'R1', routeCode: 'R1', driverName: 'Ramesh Kumar', distanceOdometerKm: 30, distanceGpsKm: 29.2, alertCount: 1, openAlertCount: 1, alertTypes: ['odometer_gap'], odometerCorrected: false });
    const ids = async (qs: string): Promise<string[]> => ((await admin().get(`/school/trips?${qs}`)).body.data as { id: string }[]).map((r) => r.id);
    expect(await ids('type=non_school')).toEqual([nonSchool.id]);
    expect(await ids('status=completed&sort=tripDate')).toEqual([completed.id, nonSchool.id]);
    expect(await ids('from=2026-10-01&to=2026-10-01')).toEqual([completed.id]);
    expect(await ids(`driverId=${w.backup.staff.id}`)).toEqual([nonSchool.id]);
    expect(await ids(`routeId=${w.route.id}&direction=morning`)).toEqual([w.trip.id, completed.id]);
    expect(await ids('flagged=true')).toEqual([completed.id]);
    expect(await ids('q=workshop')).toEqual([nonSchool.id]);
    expect(await ids(`busId=${crypto.randomUUID()}`)).toEqual([]);
    expect((await admin().get('/school/trips?status=bogus')).status).toBe(400);
    expect((await admin().get('/school/trips?sort=password')).status).toBe(400);
  });

  it('exports CSV', async () => {
    const res = await admin().get('/school/trips?format=csv&status=completed');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
    expect(lines[0]).toContain('Date,Type,Direction,Status,Bus');
    expect(lines).toHaveLength(3);
    expect(res.text).toContain('Workshop visit');
  });

  it('exports a printable PDF (BP §13.3 Trips & Audit: export CSV/PDF)', async () => {
    const binary = (r: request.Request) => r.buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    const res = await binary(admin().get('/school/trips?format=pdf&status=completed'));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain('trips.pdf');
    const pdf = res.body as Buffer;
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect((pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length).toBe(1);
    expect((await admin().get('/school/trips?format=xlsx')).status).toBe(400);
  });
});

describe('GET /school/trips/:id', () => {
  it('returns snapshots, evidence with signed URLs, flags, stop events and the planned route', async () => {
    const res = await admin().get(`/school/trips/${completed.id}`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d).toMatchObject({ id: completed.id, status: 'completed', startOdometer: 900, endOdometer: 930, startedBy: { id: w.driver.user.id, name: 'Ramesh Kumar' }, odometerCorrection: null });
    expect(d.evidence.map((e: { kind: string }) => e.kind)).toEqual(['start', 'end']);
    expect(d.evidence[0]).toMatchObject({ reading: 900, source: 'camera', recordedByName: 'Ramesh Kumar' });
    expect(d.evidence[0].photoUrl).toMatch(/^http/);
    expect(d.evidence[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(d.flags).toEqual([expect.objectContaining({ type: 'odometer_gap', status: 'open' })]);
    expect(d.stopEvents).toEqual([expect.objectContaining({ stopId: w.stops[0]!.id, stopName: 'Stop 1', sequence: 1, expectedTime: '07:10', dwellS: 60 })]);
    expect(d.route).toMatchObject({ id: w.route.id, code: 'R1', direction: 'morning' });
    expect(d.route.stops.map((s: { name: string }) => s.name)).toEqual(['Stop 1', 'Stop 2']);
    expect((await admin().get(`/school/trips/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await admin().get('/school/trips/not-a-uuid')).status).toBe(400);
  });
});

describe('POST /school/trips/:id/cancel', () => {
  it('cancels scheduled and running trips (audited) but not finished ones', async () => {
    const own = await tripWorld(t);
    const sched = await asAdmin(t, own.adminToken).post(`/school/trips/${own.trip.id}/cancel`, { reason: 'Road closed for a festival' });
    expect(sched.status).toBe(200);
    expect(sched.body.data).toMatchObject({ status: 'cancelled', cancelReason: 'Road closed for a festival', cancelledBy: { id: own.admin.id } });
    expect((await asAdmin(t, own.adminToken).post(`/school/trips/${own.trip.id}/cancel`, { reason: 'Again please' })).status).toBe(409);

    const running = await tripWorld(t);
    expect((await startScheduled(running)).status).toBe(201);
    const res = await asAdmin(t, running.adminToken).post(`/school/trips/${running.trip.id}/cancel`, { reason: 'Bus breakdown' });
    expect(res.body.data).toMatchObject({ status: 'cancelled' });
    expect(res.body.data.endedAt).not.toBeNull();
    const active = await as(t, running.driver).get('/driver/trips/active');
    expect(active.body.data.trip).toBeNull();
    const audit = await ownerQuery<{ old_values: Record<string, unknown> }>("select old_values from audit_logs where entity_id = $1 and action = 'trip.cancel'", [running.trip.id]);
    expect(audit.rows[0]!.old_values).toEqual({ status: 'in_progress' });
    expect((await admin().post(`/school/trips/${completed.id}/cancel`, { reason: 'Too late' })).status).toBe(409);
    expect((await admin().post(`/school/trips/${completed.id}/cancel`, {})).status).toBe(400);
  });
});

describe('POST /school/trips/:id/correct-odometer', () => {
  it('corrects a reading with a reason, keeps the original and the evidence, recomputes the distance (audited)', async () => {
    const own = await tripWorld(t);
    const trip = await f.trip(own.sid, own.bus.id, { status: 'completed', started_at: hoursAgo(3), ended_at: hoursAgo(2), start_odometer: 1000, end_odometer: 1100, distance_odometer_km: 100, distance_gps_km: 20, bus_code_snapshot: 'R1' });
    await f.tripOdometerEvidence(own.sid, trip.id, { kind: 'end', reading: 1100 });
    const res = await asAdmin(t, own.adminToken).post(`/school/trips/${trip.id}/correct-odometer`, { kind: 'end', reading: 1020, reason: 'Driver typed an extra digit' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ endOdometer: 1020, distanceOdometerKm: 20, odometerCorrected: true });
    expect(res.body.data.odometerCorrection).toMatchObject({ original: { start: 1000, end: 1100 }, history: [{ kind: 'end', from: 1100, to: 1020, reason: 'Driver typed an extra digit', by: own.admin.id }] });
    expect(res.body.data.evidence.find((e: { kind: string }) => e.kind === 'end').reading).toBe(1100);
    const bus = await ownerQuery('select last_known_odometer from buses where id = $1', [own.bus.id]);
    expect(bus.rows[0]!.last_known_odometer).toBe(1020);
    const again = await asAdmin(t, own.adminToken).post(`/school/trips/${trip.id}/correct-odometer`, { kind: 'start', reading: 1001, reason: 'Second look at the photo' });
    expect(again.body.data.odometerCorrection.original).toEqual({ start: 1000, end: 1100 });
    expect(again.body.data.odometerCorrection.history).toHaveLength(2);
    const audit = await ownerQuery<{ old_values: Record<string, unknown>; new_values: Record<string, unknown> }>("select old_values, new_values from audit_logs where entity_id = $1 and action = 'trip.correct_odometer' order by id", [trip.id]);
    expect(audit.rows[0]).toMatchObject({ old_values: { endOdometer: 1100 }, new_values: { kind: 'end', reading: 1020, reason: 'Driver typed an extra digit', busOdometerUpdated: true } });
  });

  it('validates order, state and value; an older trip does not move the bus reading', async () => {
    const own = await tripWorld(t);
    await ownerQuery('update buses set last_known_odometer = 5000 where id = $1', [own.bus.id]);
    const older = await f.trip(own.sid, own.bus.id, { status: 'completed', started_at: hoursAgo(30), ended_at: hoursAgo(29), start_odometer: 4000, end_odometer: 4050 });
    await f.trip(own.sid, own.bus.id, { status: 'completed', started_at: hoursAgo(3), ended_at: hoursAgo(2), start_odometer: 4950, end_odometer: 5000 });
    const post = (id: string, body: object) => asAdmin(t, own.adminToken).post(`/school/trips/${id}/correct-odometer`, body);
    const invalid = await post(older.id, { kind: 'end', reading: 3999, reason: 'Typo in the photo' });
    expect(invalid.status).toBe(422);
    expect(invalid.body.error.code).toBe('ODOMETER_INVALID');
    expect((await post(older.id, { kind: 'end', reading: 4050, reason: 'Same value' })).status).toBe(400);
    expect((await post(older.id, { kind: 'end', reading: 4060, reason: 'x' })).status).toBe(400);
    expect((await post(older.id, { kind: 'end', reading: 4060, reason: 'Correct value from the photo' })).status).toBe(200);
    const bus = await ownerQuery('select last_known_odometer from buses where id = $1', [own.bus.id]);
    expect(bus.rows[0]!.last_known_odometer).toBe(5000);
    expect((await post(own.trip.id, { kind: 'start', reading: 10, reason: 'Not started yet' })).status).toBe(409);
  });

  it('lets the school enter the missing end reading of an auto-closed trip and re-checks GPS', async () => {
    const own = await tripWorld(t);
    const trip = await f.trip(own.sid, own.bus.id, { status: 'auto_closed', started_at: hoursAgo(10), ended_at: hoursAgo(9), start_odometer: 1000, distance_gps_km: 5, bus_code_snapshot: 'R1', close_reason: 'No location data' });
    const res = await asAdmin(t, own.adminToken).post(`/school/trips/${trip.id}/correct-odometer`, { kind: 'end', reading: 1030, reason: 'Reading from the evening check' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'auto_closed', endOdometer: 1030, distanceOdometerKm: 30 });
    expect(res.body.data.flags.map((x: { type: string }) => x.type)).toEqual(['odometer_gps_mismatch']);
  });
});

describe('POST /school/trips/:id/reassign', () => {
  it('reassigns driver/conductor of a scheduled or running trip with snapshots (audited)', async () => {
    const own = await tripWorld(t);
    const newDriver = await f.staffProfile(own.sid, { staff_type: 'driver', full_name: 'Prakash Rao' });
    const res = await asAdmin(t, own.adminToken).post(`/school/trips/${own.trip.id}/reassign`, { driverId: newDriver.id, conductorId: null, reason: 'Ramesh on leave today' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ driverStaffId: newDriver.id, driverName: 'Prakash Rao', conductorStaffId: null, conductorName: null });
    const audit = await ownerQuery<{ old_values: Record<string, unknown>; new_values: Record<string, unknown> }>("select old_values, new_values from audit_logs where entity_id = $1 and action = 'trip.reassign'", [own.trip.id]);
    expect(audit.rows[0]).toMatchObject({ old_values: { driverStaffId: own.driver.staff.id, driverName: 'Ramesh Kumar' }, new_values: { driverStaffId: newDriver.id, reason: 'Ramesh on leave today' } });
    const post = (body: object) => asAdmin(t, own.adminToken).post(`/school/trips/${own.trip.id}/reassign`, body);
    expect((await post({ driverId: own.conductor.staff.id, reason: 'Wrong type of staff' })).status).toBe(400);
    expect((await post({ driverId: crypto.randomUUID(), reason: 'Unknown staff member' })).status).toBe(404);
    await ownerQuery('update staff_profiles set is_active = false where id = $1', [own.backup.staff.id]);
    expect((await post({ driverId: own.backup.staff.id, reason: 'Inactive staff member' })).status).toBe(409);
    expect((await post({ reason: 'Nothing to change' })).status).toBe(400);
  });

  it('refuses staff busy on another running trip and finished trips', async () => {
    const own = await tripWorld(t);
    expect((await startScheduled(own)).status).toBe(201);
    const bus2 = await f.bus(own.sid, { code: 'R2' });
    const busy = await f.staffProfile(own.sid, { staff_type: 'driver', full_name: 'Busy Driver' });
    await f.activeTrip(own.sid, bus2.id, { driver_staff_id: busy.id });
    const res = await asAdmin(t, own.adminToken).post(`/school/trips/${own.trip.id}/reassign`, { driverId: busy.id, reason: 'Swap drivers' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'TRIP_ALREADY_ACTIVE', details: { reason: 'STAFF_BUSY' } });
    expect((await asAdmin(t, own.adminToken).post(`/school/trips/${own.trip.id}/reassign`, { driverId: null, reason: 'Remove the driver' })).status).toBe(400);
    expect((await admin().post(`/school/trips/${completed.id}/reassign`, { driverId: w.driver.staff.id, reason: 'History is fixed' })).status).toBe(409);
  });
});

describe('roles and tenant isolation', () => {
  it("school B never sees or changes school A's trips; staff and parents cannot use admin endpoints", async () => {
    const b = await tripWorld(t);
    const bAdmin = asAdmin(t, b.adminToken);
    for (const res of [
      await bAdmin.get(`/school/trips/${completed.id}`),
      await bAdmin.post(`/school/trips/${w.trip.id}/cancel`, { reason: 'Cross-school attempt' }),
      await bAdmin.post(`/school/trips/${completed.id}/correct-odometer`, { kind: 'end', reading: 999, reason: 'Cross-school attempt' }),
      await bAdmin.post(`/school/trips/${w.trip.id}/reassign`, { driverId: b.driver.staff.id, reason: 'Cross-school attempt' }),
    ]) {
      expect(res.status).toBe(404);
    }
    const list = await bAdmin.get(`/school/trips?busId=${w.bus.id}`);
    expect(list.body.data).toEqual([]);
    const allB = await bAdmin.get('/school/trips?limit=100');
    expect(allB.body.data.map((r: { id: string }) => r.id)).toEqual([b.trip.id]);
    const csv = await bAdmin.get('/school/trips?format=csv');
    expect(csv.text).not.toContain(completed.id);
    expect(csv.text).not.toContain('Workshop visit');

    // B's driver cannot start/end/report on A's trip or use A's bus.
    const photo = await odometerPhoto(b.sid, b.driver.user.id, { type: 'bus', id: b.bus.id });
    const start = await as(t, b.driver).post('/driver/trips/start', { clientStartId: crypto.randomUUID(), tripId: w.trip.id, busId: w.bus.id, odometerReading: 1, odometerFileId: photo.id, latitude: 1, longitude: 1, deviceTime: new Date().toISOString() });
    expect(start.status).toBe(404);
    expect((await as(t, b.driver).post(`/driver/trips/${completed.id}/end`, endBody({ odometerReading: 2000, odometerFileId: photo.id }))).status).toBe(404);
    expect((await as(t, b.driver).post(`/driver/trips/${w.trip.id}/events`, { events: [{ type: 'gps_disabled', occurredAt: new Date().toISOString() }] })).status).toBe(404);
    expect((await as(t, b.driver).post(`/driver/trips/${w.trip.id}/interrupt`, { reason: 'Cross-school attempt' })).status).toBe(404);
    const history = await as(t, b.driver).get('/driver/trips/history?status=completed,scheduled,in_progress');
    expect(history.body.data.map((r: { id: string }) => r.id)).not.toContain(completed.id);

    // Wrong roles.
    expect((await request(t.app).get('/api/v1/school/trips').set({ Authorization: `Bearer ${w.driver.token}` })).status).toBe(403);
    expect((await as(t, { token: w.adminToken, deviceId: 'x-device-0001' }).get('/driver/home')).status).toBe(403);
    expect((await request(t.app).get('/api/v1/school/trips')).status).toBe(401);
    // Nothing of school A changed.
    const rows = await ownerQuery('select status, end_odometer from trips where id = $1', [completed.id]);
    expect(rows.rows[0]).toMatchObject({ status: 'completed', end_odometer: 930 });
    const auditsByB = await ownerQuery('select count(*)::int as n from audit_logs where school_id = $1 and actor_id = $2', [w.sid, b.admin.id]);
    expect(auditsByB.rows[0]!.n).toBe(0);
  });
});
