// Buses (BP §8.3 Buses, §13.3; contract §5, §9): list filters/sort/pagination/CSV, detail, create
// with code/registration uniqueness per school and the plan limit, edit, status rules, soft delete
// (blocked by an active trip / students / schedules), audit, and tenant isolation (identical codes
// in two schools; B's admin gets 404 for every A id; body school_id ignored; app role w/o context).
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, appPool, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { buildApp, loginParent, loginSchoolAdmin, loginStaff, passwordHash, type TestApp } from './helpers/authApp.js';

let t: TestApp;
let fx: f.TwoSchoolFixture;
let adminA: string;
let adminB: string;
let driverA: string;
let parentA: string;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const api = (path: string) => `/api/v1${path}`;

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  fx = await f.twoSchoolFixture();
  await ownerQuery('update users set password_hash = $1 where id = any ($2)', [await passwordHash(), [fx.a.admin.id, fx.b.admin.id, fx.a.driverUser.id]]);
  adminA = (await loginSchoolAdmin(t.app, String(fx.a.admin.email))).accessToken;
  adminB = (await loginSchoolAdmin(t.app, String(fx.b.admin.email))).accessToken;
  driverA = (await loginStaff(t.app, String(fx.a.school.code), String(fx.a.driverUser.phone))).accessToken;
  parentA = (await loginParent(t, String(fx.a.parent.phone))).accessToken;
});
afterAll(closeDb);

async function createBus(token: string, body: Record<string, unknown>) {
  return request(t.app).post(api('/school/buses')).set(auth(token)).send({ registrationNo: `KA01ZZ${String(f.nextSeq()).padStart(4, '0')}`, ...body });
}

describe('list', () => {
  it('lists only the caller school buses with display names, badges and pagination meta', async () => {
    const res = await request(t.app).get(api('/school/buses?sort=code')).set(auth(adminA));
    expect(res.status).toBe(200);
    expect(res.body.data.map((b: { code: string }) => b.code)).toEqual(['R1', 'R2']);
    expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 2, totalPages: 1 });
    const r1 = res.body.data[0];
    expect(r1).toMatchObject({ id: fx.a.bus.id, registrationNo: 'KA01AB1234', primaryDriverName: 'Ramesh Kumar', conductorName: 'Suresh Babu', imageCount: 1, hasActiveTrip: true });
    expect(r1.coverThumbnailUrl).toEqual(expect.stringContaining('/api/v1/files/local/download?token='));
    expect(JSON.stringify(res.body)).not.toContain(fx.b.bus.id);
    expect(JSON.stringify(res.body)).not.toContain('whereismybus-test/');
  });

  it('filters by status, plate search (formatting ignored), primary driver and sorts descending', async () => {
    const plate = await request(t.app).get(api('/school/buses')).query({ q: 'ka-01 ab 1234' }).set(auth(adminA));
    expect(plate.body.data.map((b: { code: string }) => b.code)).toEqual(['R1']);
    const desc = await request(t.app).get(api('/school/buses?sort=-code&limit=1&page=2')).set(auth(adminA));
    expect(desc.body.data.map((b: { code: string }) => b.code)).toEqual(['R1']);
    expect(desc.body.meta).toMatchObject({ page: 2, limit: 1, total: 2, totalPages: 2 });
    const none = await request(t.app).get(api('/school/buses?status=maintenance,retired')).set(auth(adminA));
    expect(none.body.meta.total).toBe(0);
    const noDriver = await request(t.app).get(api('/school/buses?hasPrimaryDriver=false')).set(auth(adminA));
    expect(noDriver.body.data).toEqual([]);
    const bad = await request(t.app).get(api('/school/buses?sort=secret')).set(auth(adminA));
    expect([bad.status, bad.body.error.code]).toEqual([400, 'VALIDATION_ERROR']);
  });

  it('exports CSV with the same filters', async () => {
    const res = await request(t.app).get(api('/school/buses?format=csv&sort=code')).set(auth(adminA));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.text.replace(/^\uFEFF/, '').trim().split('\r\n');
    expect(lines[0]).toContain('Code,Name,Type,Registration');
    expect(lines.slice(1).map((l) => l.split(',')[0])).toEqual(['R1', 'R2']);
  });
});

describe('detail', () => {
  it('returns images with signed URLs, current staff, current documents and the active trip', async () => {
    const res = await request(t.app).get(api(`/school/buses/${fx.a.bus.id}`)).set(auth(adminA));
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.activeTripId).toBe(fx.a.trip.id);
    expect(d.staff.primaryDriver).toMatchObject({ staffId: fx.a.driver.id, fullName: 'Ramesh Kumar' });
    expect(d.staff.conductor).toMatchObject({ staffId: fx.a.conductor.id });
    expect(d.staff.backupDriver).toBeNull();
    expect(d.images).toHaveLength(1);
    expect(d.images[0]).toMatchObject({ id: fx.a.busImage.id, fileId: fx.a.busImage.file_id });
    expect(d.images[0].url).toEqual(expect.stringContaining('token='));
    expect(d.documents.map((x: { docType: string }) => x.docType).sort()).toEqual(['insurance', 'permit']);
    expect(d.documents.find((x: { docType: string }) => x.docType === 'insurance')).toMatchObject({ expiryStatus: 'valid', isCurrent: true });
  });
});

describe('create and edit', () => {
  it('creates in the token school (body school_id ignored), normalises the plate and audits', async () => {
    const res = await createBus(adminA, { code: 'R9', displayName: 'Green Van', vehicleType: 'van', capacity: 18, fuelType: 'cng', registrationNo: 'ka-05 mn 4321', lastKnownOdometer: 12045.5, school_id: fx.b.school.id });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ code: 'R9', displayName: 'Green Van', registrationNo: 'KA05MN4321', status: 'active', lastKnownOdometer: 12045.5, imageCount: 0, hasActiveTrip: false });
    expect(res.body.data.odometerUpdatedAt).toEqual(expect.any(String));
    const row = (await ownerQuery('select school_id, created_by from buses where id = $1', [res.body.data.id])).rows[0]!;
    expect(row).toEqual({ school_id: fx.a.school.id, created_by: fx.a.admin.id });
    const audit = await ownerQuery("select school_id, new_values from audit_logs where action = 'bus.create' and entity_id = $1", [res.body.data.id]);
    expect(audit.rows[0]).toMatchObject({ school_id: fx.a.school.id, new_values: { code: 'R9', registrationNo: 'KA05MN4321' } });
  });

  it('keeps codes and plates unique per school only', async () => {
    const dupCode = await createBus(adminA, { code: 'R1' });
    expect([dupCode.status, dupCode.body.error.code]).toEqual([409, 'DUPLICATE']);
    expect(dupCode.body.error.message).toBe('A bus with this code already exists.');
    const dupPlate = await createBus(adminA, { code: 'R10', registrationNo: 'KA 01 AB 1234' });
    expect([dupPlate.status, dupPlate.body.error.message]).toEqual([409, 'A bus with this registration number already exists.']);
    // Identical code AND plate in the other school are fine.
    const inB = await createBus(adminB, { code: 'R9', registrationNo: 'KA05MN4321' });
    expect(inB.status).toBe(201);
  });

  it('validates input', async () => {
    const res = await request(t.app).post(api('/school/buses')).set(auth(adminA)).send({ capacity: 500, registrationNo: '!!', fuelType: 'coal' });
    expect(res.status).toBe(400);
    const paths = res.body.error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['code', 'capacity', 'registrationNo', 'fuelType']));
    const empty = await request(t.app).patch(api(`/school/buses/${fx.a.otherBus.id}`)).set(auth(adminA)).send({});
    expect(empty.status).toBe(400);
  });

  it('enforces the subscription bus limit (every non-deleted bus counts, one rule with the platform)', async () => {
    const used = (await ownerQuery<{ n: number }>('select count(*)::int as n from buses where school_id = $1 and deleted_at is null', [fx.a.school.id])).rows[0]!.n;
    await ownerQuery("update school_subscriptions set max_buses = $2 where school_id = $1 and status = 'active'", [fx.a.school.id, used + 1]);
    try {
      const retired = await createBus(adminA, { code: 'R12', status: 'retired' });
      expect(retired.status).toBe(201);
      const res = await createBus(adminA, { code: 'R11' });
      expect([res.status, res.body.error.code, res.body.error.details]).toEqual([403, 'FORBIDDEN', { reason: 'SUBSCRIPTION_LIMIT', resource: 'buses', limit: used + 1, used: used + 1, adding: 1 }]);
      // Re-activating a retired bus needs no new slot (it already counts).
      const reactivate = await request(t.app).patch(api(`/school/buses/${retired.body.data.id}/status`)).set(auth(adminA)).send({ status: 'active' });
      expect(reactivate.status).toBe(200);
      // Deleting a bus frees its slot.
      expect((await request(t.app).delete(api(`/school/buses/${retired.body.data.id}`)).set(auth(adminA))).status).toBe(200);
      expect((await createBus(adminA, { code: 'R11' })).status).toBe(201);
    } finally {
      await ownerQuery("update school_subscriptions set max_buses = 50 where school_id = $1 and status = 'active'", [fx.a.school.id]);
    }
  });

  it('edits fields and audits only the changed ones', async () => {
    const res = await request(t.app).patch(api(`/school/buses/${fx.a.otherBus.id}`)).set(auth(adminA)).send({ displayName: 'Blue Bus', capacity: 42, color: '' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ displayName: 'Blue Bus', capacity: 42, color: null });
    const audit = await ownerQuery("select old_values, new_values from audit_logs where action = 'bus.update' and entity_id = $1", [fx.a.otherBus.id]);
    expect(audit.rows[0]).toEqual({ old_values: { displayName: null, capacity: 40 }, new_values: { displayName: 'Blue Bus', capacity: 42 } });
  });
});

describe('status', () => {
  it('refuses to take a bus on a trip out of service and audits real changes with the reason', async () => {
    const onTrip = await request(t.app).patch(api(`/school/buses/${fx.a.bus.id}/status`)).set(auth(adminA)).send({ status: 'maintenance' });
    expect([onTrip.status, onTrip.body.error.code, onTrip.body.error.details]).toEqual([409, 'INVALID_STATE', { activeTripId: fx.a.trip.id }]);
    const viaPatch = await request(t.app).patch(api(`/school/buses/${fx.a.bus.id}`)).set(auth(adminA)).send({ status: 'retired' });
    expect(viaPatch.status).toBe(409);

    const bus = (await createBus(adminA, { code: 'S1' })).body.data;
    const res = await request(t.app).patch(api(`/school/buses/${bus.id}/status`)).set(auth(adminA)).send({ status: 'maintenance', reason: 'Brake service' });
    expect([res.status, res.body.data.status]).toEqual([200, 'maintenance']);
    const same = await request(t.app).patch(api(`/school/buses/${bus.id}/status`)).set(auth(adminA)).send({ status: 'maintenance' });
    expect(same.status).toBe(200);
    const audit = await ownerQuery("select old_values, new_values from audit_logs where action = 'bus.status_change' and entity_id = $1", [bus.id]);
    expect(audit.rows).toEqual([{ old_values: { status: 'active' }, new_values: { status: 'maintenance', reason: 'Brake service' } }]);
    const filtered = await request(t.app).get(api('/school/buses?status=maintenance')).set(auth(adminA));
    expect(filtered.body.data.map((b: { id: string }) => b.id)).toEqual([bus.id]);
    const invalid = await request(t.app).patch(api(`/school/buses/${bus.id}/status`)).set(auth(adminA)).send({ status: 'scrapped' });
    expect(invalid.status).toBe(400);
  });
});

describe('soft delete', () => {
  it('is blocked while the bus is on a trip', async () => {
    const res = await request(t.app).delete(api(`/school/buses/${fx.a.bus.id}`)).set(auth(adminA));
    expect([res.status, res.body.error.code]).toEqual([409, 'INVALID_STATE']);
  });

  it('is blocked while students or schedules still use the bus', async () => {
    const bus = (await createBus(adminA, { code: 'D1' })).body.data;
    const route = await f.route(fx.a.school.id, { code: 'D1', direction: 'afternoon' });
    const stop = await f.stop(fx.a.school.id, route.id, { sequence: 1 });
    await f.studentAssignment(fx.a.school.id, { studentId: fx.a.otherStudent.id, busId: bus.id, routeId: route.id, stopId: stop.id, direction: 'afternoon' });
    await f.tripSchedule(fx.a.school.id, bus.id, route.id, { direction: 'afternoon' });
    const res = await request(t.app).delete(api(`/school/buses/${bus.id}`)).set(auth(adminA));
    expect([res.status, res.body.error.code, res.body.error.details]).toEqual([409, 'CONFLICT', { studentAssignments: 1, schedules: 1 }]);
  });

  it('marks the bus deleted, closes assignments, cancels scheduled trips, frees the code and keeps history', async () => {
    const bus = (await createBus(adminA, { code: 'D2', registrationNo: 'KA01DD0002' })).body.data;
    const a = await f.busStaffAssignment(fx.a.school.id, bus.id, fx.a.otherDriver.id, { assignment_role: 'backup_driver' });
    const route = await f.route(fx.a.school.id, { code: 'D2' });
    await f.busRouteAssignment(fx.a.school.id, bus.id, route.id);
    const trip = await f.trip(fx.a.school.id, bus.id, { route_id: route.id, trip_date: f.isoDay(1) });
    const res = await request(t.app).delete(api(`/school/buses/${bus.id}`)).set(auth(adminA));
    expect([res.status, res.body.data]).toEqual([200, { id: bus.id, deleted: true }]);
    expect((await request(t.app).get(api(`/school/buses/${bus.id}`)).set(auth(adminA))).status).toBe(404);
    expect((await request(t.app).delete(api(`/school/buses/${bus.id}`)).set(auth(adminA))).status).toBe(404);
    const state = await ownerQuery(
      `select (select deleted_at is not null from buses where id = $1) as deleted,
              (select valid_to is not null from bus_staff_assignments where id = $2) as staff_closed,
              (select count(*)::int from bus_route_assignments where bus_id = $1 and valid_to is null) as open_routes,
              (select status from trips where id = $3) as trip_status`,
      [bus.id, a.id, trip.id],
    );
    expect(state.rows[0]).toEqual({ deleted: true, staff_closed: true, open_routes: 0, trip_status: 'cancelled' });
    const audit = await ownerQuery("select new_values from audit_logs where action = 'bus.delete' and entity_id = $1", [bus.id]);
    expect(audit.rows[0]!.new_values).toEqual({ staffAssignmentsClosed: 1, routeAssignmentsClosed: 1, tripsCancelled: 1 });
    const again = await createBus(adminA, { code: 'D2', registrationNo: 'KA01DD0002' });
    expect(again.status).toBe(201);
    const list = await request(t.app).get(api('/school/buses?q=D2')).set(auth(adminA));
    expect(list.body.data.map((b: { id: string }) => b.id)).toEqual([again.body.data.id]);
  });
});

describe('tenant isolation and roles', () => {
  it("answers 404 to school B's admin for every A bus endpoint", async () => {
    const id = fx.a.otherBus.id;
    const doc = fx.a.busDocument.id;
    const img = fx.a.busImage.id;
    const calls: [string, string, Record<string, unknown>?][] = [
      ['get', `/school/buses/${id}`],
      ['patch', `/school/buses/${id}`, { displayName: 'x' }],
      ['patch', `/school/buses/${id}/status`, { status: 'inactive' }],
      ['delete', `/school/buses/${id}`],
      ['get', `/school/buses/${fx.a.bus.id}/images`],
      ['patch', `/school/buses/${fx.a.bus.id}/images/${img}`, { caption: 'x' }],
      ['put', `/school/buses/${fx.a.bus.id}/images/order`, { imageIds: [img] }],
      ['delete', `/school/buses/${fx.a.bus.id}/images/${img}`],
      ['post', `/school/buses/${id}/assign-staff`, { primaryDriverId: null }],
      ['get', `/school/buses/${id}/assignment-history`],
      ['get', `/school/buses/${id}/documents`],
      ['post', `/school/buses/${id}/documents`, { docType: 'rc' }],
      ['get', `/school/bus-documents/${doc}`],
      ['put', `/school/bus-documents/${doc}`, { title: 'x' }],
      ['patch', `/school/bus-documents/${doc}`, { title: 'x' }],
      ['patch', `/school/bus-documents/${doc}/visibility`, { visibleToParentsFile: true }],
      ['patch', `/school/bus-documents/${doc}/verify`, { status: 'verified' }],
      ['delete', `/school/bus-documents/${doc}`],
    ];
    for (const [method, path, body] of calls) {
      const res = await (request(t.app) as unknown as Record<string, (p: string) => request.Test>)[method]!(api(path)).set(auth(adminB)).send(body ?? {});
      expect([method, path, res.status, res.body.error?.code]).toEqual([method, path, 404, 'NOT_FOUND']);
    }
    const untouched = await ownerQuery('select display_name, status, deleted_at from buses where id = $1', [id]);
    expect(untouched.rows[0]).toEqual({ display_name: 'Blue Bus', status: 'active', deleted_at: null });
  });

  it('refuses drivers and parents; the app role without context sees no buses', async () => {
    expect((await request(t.app).get(api('/school/buses')).set(auth(driverA))).status).toBe(403);
    const parent = await request(t.app).get(api('/school/buses')).set(auth(parentA)).set('X-School-Id', fx.a.school.id);
    expect(parent.status).toBe(403);
    expect((await request(t.app).get(api('/school/buses'))).status).toBe(401);
    const { rows } = await appPool().query<{ n: number }>('select count(*)::int as n from buses');
    expect(rows[0]!.n).toBe(0);
  });

  it('replays an idempotent create instead of creating twice', async () => {
    const body = { code: 'IDEM1', registrationNo: 'KA01ID0001' };
    const first = await request(t.app).post(api('/school/buses')).set(auth(adminA)).set('Idempotency-Key', 'bus-create-0001').send(body);
    const second = await request(t.app).post(api('/school/buses')).set(auth(adminA)).set('Idempotency-Key', 'bus-create-0001').send(body);
    expect([first.status, second.status, second.headers['idempotent-replayed']]).toEqual([201, 201, 'true']);
    expect(second.body.data.id).toBe(first.body.data.id);
  });
});
