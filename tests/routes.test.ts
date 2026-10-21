// Routes (BP §8.3 CRUD /school/routes, §13.3; contract §5): create (code + direction unique per school),
// list filters/sort/pagination/CSV, detail, edit rules (direction changes, deactivation), soft delete
// blocked by a trip in progress / students / live schedules, role gates and tenant isolation of every
// endpoint of the module (BP §4.9).
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appPool, closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { buildApp, loginParent, loginSchoolAdmin, loginStaff, passwordHash, staffUser, type TestApp } from './helpers/authApp.js';

let t: TestApp;
let fx: f.TwoSchoolFixture;
let adminA: string;
let adminB: string;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const api = (path: string) => `/api/v1${path}`;
const get = (path: string, token = adminA) => request(t.app).get(api(path)).set(auth(token));
const post = (path: string, body: object, token = adminA) => request(t.app).post(api(path)).set(auth(token)).send(body);
const patch = (path: string, body: object, token = adminA) => request(t.app).patch(api(path)).set(auth(token)).send(body);
const del = (path: string, token = adminA) => request(t.app).delete(api(path)).set(auth(token));

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  fx = await f.twoSchoolFixture();
  await ownerQuery('update users set password_hash = $1 where id = any ($2)', [await passwordHash(), [fx.a.admin.id, fx.b.admin.id]]);
  adminA = (await loginSchoolAdmin(t.app, String(fx.a.admin.email))).accessToken;
  adminB = (await loginSchoolAdmin(t.app, String(fx.b.admin.email))).accessToken;
});
afterAll(closeDb);

describe('create', () => {
  it('creates a route in the token school (school_id in the body is ignored) and audits it', async () => {
    const res = await post('/school/routes', { code: 'M5', name: 'Koramangala Loop', direction: 'morning', description: 'Via 80 Feet Road', school_id: fx.b.school.id });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      code: 'M5', name: 'Koramangala Loop', direction: 'morning', isActive: true, stopCount: 0, buses: [], stops: [],
      polylineSource: null, polylineEncoded: null, warnings: ['too_few_stops'], school: { latitude: 12.9716, longitude: 77.5946 },
    });
    const row = await ownerQuery('select school_id, created_by from routes where id = $1', [res.body.data.id]);
    expect(row.rows[0]).toEqual({ school_id: fx.a.school.id, created_by: fx.a.admin.id });
    const audit = await ownerQuery("select school_id from audit_logs where action = 'route.create' and entity_id = $1", [res.body.data.id]);
    expect(audit.rows).toEqual([{ school_id: fx.a.school.id }]);
  });

  it('code + direction is unique per school; the other direction and the other school are free', async () => {
    const dup = await post('/school/routes', { code: 'M5', direction: 'morning' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE');
    expect((await post('/school/routes', { code: 'M5', direction: 'afternoon' })).status).toBe(201);
    expect((await post('/school/routes', { code: 'M5', direction: 'morning' }, adminB)).status).toBe(201);
  });

  it('replays a create with the same Idempotency-Key', async () => {
    const key = crypto.randomUUID();
    const send = () => request(t.app).post(api('/school/routes')).set(auth(adminA)).set('Idempotency-Key', key).send({ code: 'IK1', direction: 'afternoon' });
    const first = await send();
    const second = await send();
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.data.id).toBe(first.body.data.id);
    await ownerQuery('update routes set deleted_at = now() where id = $1', [first.body.data.id]);
  });

  it('validates the body', async () => {
    const res = await post('/school/routes', { code: '', direction: 'evening' });
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(['code', 'direction']);
  });
});

describe('list and detail', () => {
  it('filters, sorts and paginates', async () => {
    const all = await get('/school/routes?sort=code,direction');
    expect(all.status).toBe(200);
    expect(all.body.data.map((r: { code: string; direction: string }) => `${r.code}/${r.direction}`)).toEqual(['M5/afternoon', 'M5/morning', 'R1/morning', 'R2/morning']);
    expect(all.body.meta).toEqual({ page: 1, limit: 20, total: 4, totalPages: 1 });
    const r1 = all.body.data.find((r: { code: string }) => r.code === 'R1');
    expect(r1).toMatchObject({ stopCount: 2, studentCount: 1, activeScheduleCount: 1, hasActiveTrip: true, firstStopTime: '07:30', lastStopTime: '07:30' });
    expect(r1.buses).toEqual([expect.objectContaining({ busId: fx.a.bus.id, busCode: 'R1', registrationNo: 'KA01AB1234' })]);

    expect((await get('/school/routes?direction=afternoon')).body.data.map((r: { code: string }) => r.code)).toEqual(['M5']);
    expect((await get('/school/routes?hasBus=true')).body.data.map((r: { code: string }) => r.code)).toEqual(['R1']);
    expect((await get(`/school/routes?busId=${fx.a.bus.id}`)).body.data.map((r: { code: string }) => r.code)).toEqual(['R1']);
    expect((await get('/school/routes?q=koramangala')).body.data.map((r: { code: string }) => r.code)).toEqual(['M5']);
    const paged = await get('/school/routes?limit=1&page=2&sort=-code');
    expect(paged.body.meta).toEqual({ page: 2, limit: 1, total: 4, totalPages: 4 });
    expect((await get('/school/routes?sort=secret')).status).toBe(400);
    const bySize = await get('/school/routes?sort=-stopCount,firstStopTime,-studentCount');
    expect(bySize.body.data.map((r: { code: string; stopCount: number }) => `${r.code}:${r.stopCount}`)).toEqual(['R1:2', 'R2:1', 'M5:0', 'M5:0']);
  });

  it('exports CSV', async () => {
    const res = await get('/school/routes?format=csv&direction=morning');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
    expect(lines[0]).toContain('Code,Name,Direction,Active,Stops');
    expect(lines).toHaveLength(4);
  });

  it('returns the route detail with ordered stops and warnings', async () => {
    const res = await get(`/school/routes/${fx.a.route.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.stops.map((s: { name: string; sequence: number }) => [s.sequence, s.name])).toEqual([[1, 'Stop 1'], [2, 'Stop 2']]);
    expect(res.body.data.stops[0]).toMatchObject({ code: 'S1', latitude: 12.9352, longitude: 77.6245, expectedTime: '07:30', arrivalRadiusM: 100, studentCount: 1 });
    expect(res.body.data.activeTripId).toBe(fx.a.trip.id);
    expect(res.body.data.warnings).toEqual(['polyline_missing']);
  });
});

describe('update', () => {
  it('edits fields and audits only the changes', async () => {
    const created = await post('/school/routes', { code: 'E1', name: 'Old', direction: 'morning' });
    const res = await patch(`/school/routes/${created.body.data.id}`, { name: 'HSR Layout Express', description: 'Sector 2 first' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'HSR Layout Express', description: 'Sector 2 first' });
    const audit = await ownerQuery("select old_values, new_values from audit_logs where action = 'route.update' and entity_id = $1", [created.body.data.id]);
    expect(audit.rows[0]).toEqual({ old_values: { name: 'Old', description: null }, new_values: { name: 'HSR Layout Express', description: 'Sector 2 first' } });
    // An unreferenced route may change direction.
    expect((await patch(`/school/routes/${created.body.data.id}`, { direction: 'afternoon' })).body.data.direction).toBe('afternoon');
    expect((await patch(`/school/routes/${created.body.data.id}`, {})).status).toBe(400);
  });

  it('blocks direction changes and deactivation while the route is in use', async () => {
    const trip = await patch(`/school/routes/${fx.a.route.id}`, { isActive: false });
    expect(trip.status).toBe(409);
    expect(trip.body.error).toMatchObject({ code: 'INVALID_STATE', details: { activeTripId: fx.a.trip.id } });

    const r = await post('/school/routes', { code: 'U1', direction: 'morning' });
    await f.tripSchedule(fx.a.school.id, fx.a.otherBus.id, r.body.data.id, { planned_start_time: '13:00' });
    const dir = await patch(`/school/routes/${r.body.data.id}`, { direction: 'afternoon' });
    expect(dir.status).toBe(409);
    expect(dir.body.error).toMatchObject({ code: 'CONFLICT', details: { schedules: 1, studentAssignments: 0 } });
    const off = await patch(`/school/routes/${r.body.data.id}`, { isActive: false });
    expect(off.status).toBe(409);
    expect(off.body.error.details).toEqual({ schedules: 1 });
    await ownerQuery('update trip_schedules set is_active = false where route_id = $1', [r.body.data.id]);
    expect((await patch(`/school/routes/${r.body.data.id}`, { isActive: false })).body.data.isActive).toBe(false);
  });
});

describe('delete', () => {
  it('is blocked by a trip in progress, then by students and live schedules', async () => {
    const res = await del(`/school/routes/${fx.a.route.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE');
    const r = await post('/school/routes', { code: 'D1', direction: 'morning' });
    await f.tripSchedule(fx.a.school.id, fx.a.otherBus.id, r.body.data.id, { planned_start_time: '15:00' });
    const blocked = await del(`/school/routes/${r.body.data.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatchObject({ code: 'CONFLICT', details: { studentAssignments: 0, schedules: 1 } });
  });

  it('soft-deletes a free route: closes bus assignments, retires schedules, cancels pending trips; the code is reusable', async () => {
    const r = await post('/school/routes', { code: 'D2', direction: 'afternoon' });
    const id = r.body.data.id as string;
    await f.busRouteAssignment(fx.a.school.id, fx.a.otherBus.id, id);
    const old = await f.tripSchedule(fx.a.school.id, fx.a.otherBus.id, id, { direction: 'afternoon', planned_start_time: '14:00', is_active: false });
    const pending = await f.trip(fx.a.school.id, fx.a.otherBus.id, { route_id: id, direction: 'afternoon', trip_date: f.isoDay(1) });
    const res = await del(`/school/routes/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id, deleted: true });
    const state = await ownerQuery<{ open: number; sched: string | null; trip: string }>(
      `select (select count(*)::int from bus_route_assignments where route_id = $1 and valid_to is null) as open,
              (select deleted_at::text from trip_schedules where id = $2) as sched,
              (select status from trips where id = $3) as trip`,
      [id, old.id, pending.id],
    );
    expect(state.rows[0]).toMatchObject({ open: 0, trip: 'cancelled' });
    expect(state.rows[0]!.sched).not.toBeNull();
    expect((await get(`/school/routes/${id}`)).status).toBe(404);
    expect((await post('/school/routes', { code: 'D2', direction: 'afternoon' })).status).toBe(201);
    const audit = await ownerQuery("select new_values from audit_logs where action = 'route.delete' and entity_id = $1", [id]);
    expect(audit.rows[0]!.new_values).toEqual({ busAssignmentsClosed: 1, schedulesDeleted: 1, tripsCancelled: 1 });
  });
});

describe('tenant isolation (BP §4.9)', () => {
  it("answers 404 for every endpoint addressed with the other school's ids", async () => {
    const B = fx.b;
    const r = `/school/routes/${B.route.id}`;
    const s = `${r}/stops/${B.stop1.id}`;
    const calls: [string, request.Test][] = [
      ['GET route', get(r)],
      ['PATCH route', patch(r, { name: 'x' })],
      ['DELETE route', del(r)],
      ['recompute', post(`${r}/recompute-polyline`, {})],
      ['GET stops', get(`${r}/stops`)],
      ['POST stop', post(`${r}/stops`, { name: 'x', latitude: 12.9, longitude: 77.6 })],
      ['GET stop', get(s)],
      ['PATCH stop', patch(s, { name: 'x' })],
      ['DELETE stop', del(s)],
      ['reorder', request(t.app).put(api(`${r}/stops/reorder`)).set(auth(adminA)).send({ stopIds: [B.stop2.id, B.stop1.id] })],
      ['assign-bus', post(`${r}/assign-bus`, { busId: fx.a.otherBus.id })],
      ['unassign-bus', post(`${r}/unassign-bus`, { busId: B.bus.id })],
      ['bus-assignments', get(`${r}/bus-assignments`)],
      ['GET schedule', get(`/school/trip-schedules/${B.schedule.id}`)],
      ['PATCH schedule', patch(`/school/trip-schedules/${B.schedule.id}`, { name: 'x' })],
      ['DELETE schedule', del(`/school/trip-schedules/${B.schedule.id}`)],
      ['schedule with B bus', post('/school/trip-schedules', { busId: B.bus.id, routeId: fx.a.otherRoute.id, plannedStartTime: '10:00', daysOfWeek: [7] })],
      ['schedule with B route', post('/school/trip-schedules', { busId: fx.a.otherBus.id, routeId: B.route.id, plannedStartTime: '10:00', daysOfWeek: [7] })],
      ['assign B bus', post(`/school/routes/${fx.a.otherRoute.id}/assign-bus`, { busId: B.bus.id })],
    ];
    for (const [name, call] of calls) {
      const res = await call;
      expect([name, res.status, res.body.error?.code]).toEqual([name, 404, 'NOT_FOUND']);
    }
    // B's data is untouched.
    const b = await ownerQuery<{ name: string; stops: number; sched: boolean }>(
      `select r.name, (select count(*)::int from stops where route_id = r.id and deleted_at is null) as stops,
              (select is_active from trip_schedules where id = $2) as sched from routes r where r.id = $1`,
      [B.route.id, B.schedule.id],
    );
    expect(b.rows[0]).toEqual({ name: 'Route 1', stops: 2, sched: true });
  });

  it("lists never show the other school's rows, even when filtered by its ids", async () => {
    const lists = [
      await get('/school/routes?limit=100'),
      await get('/school/trip-schedules?limit=100'),
      await get('/school/bus-route-assignments?limit=100'),
    ];
    const idsB = new Set([fx.b.route.id, fx.b.otherRoute.id, fx.b.schedule.id, fx.b.bus.id]);
    for (const l of lists) {
      expect(l.status).toBe(200);
      for (const item of l.body.data as Partial<Record<string, string>>[]) {
        expect(idsB.has(item.id ?? '')).toBe(false);
        expect(idsB.has(item.busId ?? '')).toBe(false);
        expect(idsB.has(item.routeId ?? '')).toBe(false);
      }
    }
    expect((await get(`/school/trip-schedules?busId=${fx.b.bus.id}`)).body.data).toEqual([]);
    expect((await get(`/school/bus-route-assignments?routeId=${fx.b.route.id}`)).body.data).toEqual([]);
    expect((await get(`/school/routes?busId=${fx.b.bus.id}`)).body.data).toEqual([]);
  });

  it('the app role without a tenant context sees no routes, stops, assignments or schedules', async () => {
    const pool = appPool();
    for (const table of ['routes', 'stops', 'bus_route_assignments', 'trip_schedules']) {
      const res = await pool.query(`select count(*)::int as n from ${table}`);
      expect([table, res.rows[0].n]).toEqual([table, 0]);
    }
  });
});

describe('role gates', () => {
  it('drivers and parents cannot use the school routes API', async () => {
    const driver = await staffUser(fx.a.school.id, 'driver');
    const driverToken = (await loginStaff(t.app, String(fx.a.school.code), String(driver.phone))).accessToken;
    expect((await get('/school/routes', driverToken)).status).toBe(403);
    expect((await post('/school/trip-schedules', {}, driverToken)).status).toBe(403);
    const parentToken = (await loginParent(t, String(fx.a.parent.phone))).accessToken;
    const res = await request(t.app).get(api('/school/routes')).set(auth(parentToken)).set('X-School-Id', fx.a.school.id);
    expect(res.status).toBe(403);
    expect((await request(t.app).get(api('/school/routes'))).status).toBe(401);
  });
});
