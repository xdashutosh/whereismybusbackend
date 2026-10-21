// Student assignments (BP §8.3 Assignments, §13.3 "bus → route → stop per direction", §19 #8):
// validation rules (stop on route, route direction/active, bus serves route, bus not retired,
// foreign ids → 404, effective date window), closing the previous open assignment with history,
// future-dated changes, ending a direction, capacity warnings, bulk assignment and isolation.
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/tenant.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { buildApp, loginSchoolAdmin, passwordHash, type TestApp } from './helpers/authApp.js';

let t: TestApp;
let fx: f.TwoSchoolFixture;
let adminA: string;
let adminB: string;
let today: string;
let pmRoute: f.TenantRow;
let pmStop: f.TenantRow;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const api = (path: string) => `/api/v1${path}`;
const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const assign = (studentId: string, body: Record<string, unknown>, token = adminA) => request(t.app).put(api(`/school/students/${studentId}/assignment`)).set(auth(token)).send(body);
const target = (stop: f.TenantRow, route = fx.a.route, bus = fx.a.bus) => ({ busId: bus.id, routeId: route.id, stopId: stop.id });
const rowsOf = async (studentId: string, direction = 'morning') =>
  (await ownerQuery<{ stop_id: string; valid_from: string; valid_to: string | null }>(
    'select stop_id, valid_from, valid_to from student_assignments where student_id = $1 and trip_direction = $2 order by valid_from, created_at',
    [studentId, direction],
  )).rows;

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  fx = await f.twoSchoolFixture();
  await ownerQuery('update users set password_hash = $1 where id = any ($2)', [await passwordHash(), [fx.a.admin.id, fx.b.admin.id]]);
  adminA = (await loginSchoolAdmin(t.app, String(fx.a.admin.email))).accessToken;
  adminB = (await loginSchoolAdmin(t.app, String(fx.b.admin.email))).accessToken;
  today = (await ownerQuery<{ d: string }>('select school_local_date($1)::text as d', [fx.a.school.id])).rows[0]!.d;
  pmRoute = await f.route(fx.a.school.id, { code: 'R1', name: 'Route 1 PM', direction: 'afternoon' });
  pmStop = await f.stop(fx.a.school.id, pmRoute.id, { name: 'PM Stop 1', sequence: 1 });
  await f.busRouteAssignment(fx.a.school.id, fx.a.bus.id, pmRoute.id);
});
afterAll(closeDb);

describe('rules', () => {
  it('validates stop ↔ route, route direction, bus ↔ route and the bus status', async () => {
    const stopOfOther = (await ownerQuery<{ id: string }>('select id from stops where route_id = $1', [fx.a.otherRoute.id])).rows[0]!;
    const notOnRoute = await assign(fx.a.student.id, { morning: { ...target(fx.a.stop1), stopId: stopOfOther.id } });
    expect(notOnRoute.status).toBe(400);
    expect(notOnRoute.body.error.details).toEqual([{ path: 'morning.stopId', message: 'The stop does not belong to the route' }]);
    const wrongDirection = await assign(fx.a.student.id, { morning: target(pmStop, pmRoute) });
    expect(wrongDirection.body.error.details[0]).toMatchObject({ path: 'morning.routeId' });
    const notServing = await assign(fx.a.student.id, { morning: target(fx.a.stop1, fx.a.route, fx.a.otherBus) });
    expect(notServing.status).toBe(400);
    expect(notServing.body.error.details[0]).toMatchObject({ path: 'morning.busId', message: expect.stringContaining('does not serve') });
    // A live schedule of the bus on the route also counts as "serves".
    await f.tripSchedule(fx.a.school.id, fx.a.otherBus.id, fx.a.route.id);
    const viaSchedule = await assign(fx.a.otherStudent.id, { morning: target(fx.a.stop1, fx.a.route, fx.a.otherBus), effectiveFrom: plusDays(today, 30) });
    expect(viaSchedule.status).toBe(200);
    const retired = await f.bus(fx.a.school.id, { code: 'R9', status: 'retired' });
    await f.busRouteAssignment(fx.a.school.id, retired.id, fx.a.route.id);
    expect((await assign(fx.a.student.id, { morning: target(fx.a.stop1, fx.a.route, retired) })).body.error.details[0]).toMatchObject({ path: 'morning.busId', message: 'The bus is retired' });
    const inactive = await f.route(fx.a.school.id, { code: 'R7', direction: 'morning', is_active: false });
    const inactiveStop = await f.stop(fx.a.school.id, inactive.id, { sequence: 1 });
    await f.busRouteAssignment(fx.a.school.id, fx.a.bus.id, inactive.id);
    expect((await assign(fx.a.student.id, { morning: target(inactiveStop, inactive) })).body.error.details[0]).toMatchObject({ path: 'morning.routeId', message: 'The route is inactive' });
  });

  it('treats ids of another school as missing (404) and checks the effective date window', async () => {
    const foreign = await assign(fx.a.student.id, { morning: target(fx.a.stop1, fx.a.route, fx.b.bus) });
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.details).toEqual({ field: 'morning.busId' });
    expect((await assign(fx.a.student.id, { morning: target(fx.b.stop1, fx.a.route) })).status).toBe(404);
    expect((await assign(fx.a.student.id, { morning: target(fx.a.stop1), effectiveFrom: plusDays(today, -1) })).status).toBe(400);
    expect((await assign(fx.a.student.id, { morning: target(fx.a.stop1), effectiveFrom: plusDays(today, 400) })).status).toBe(400);
    expect((await assign(fx.a.student.id, {})).status).toBe(400);
    expect((await rowsOf(fx.a.student.id)).length).toBe(1); // nothing changed
  });
});

describe('changes and history', () => {
  it('leaves an identical assignment alone', async () => {
    const res = await assign(fx.a.student.id, { morning: target(fx.a.stop1) });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ studentId: fx.a.student.id, effectiveFrom: today, changed: [] });
    expect(await rowsOf(fx.a.student.id)).toHaveLength(1);
  });

  it('closes the previous open assignment and opens the new one today; history keeps both', async () => {
    const res = await assign(fx.a.student.id, { morning: target(fx.a.stop2), afternoon: target(pmStop, pmRoute) });
    expect(res.status).toBe(200);
    expect(res.body.data.changed).toEqual(['morning', 'afternoon']);
    expect(res.body.data.assignments.morning).toMatchObject({ stopId: fx.a.stop2.id, stopName: 'Stop 2', validFrom: today, validTo: null, state: 'current' });
    expect(res.body.data.assignments.afternoon).toMatchObject({ routeName: 'Route 1 PM', stopName: 'PM Stop 1', state: 'current' });
    const rows = await rowsOf(fx.a.student.id);
    expect(rows.map((r) => [r.stop_id, r.valid_to])).toEqual([
      [fx.a.stop1.id, today],
      [fx.a.stop2.id, null],
    ]);
    const hist = await request(t.app).get(api(`/school/students/${fx.a.student.id}/assignment-history?direction=morning`)).set(auth(adminA));
    expect(hist.status).toBe(200);
    expect(hist.body.data.map((a: { stopName: string; state: string }) => [a.stopName, a.state])).toEqual([
      ['Stop 2', 'current'],
      ['Stop 1', 'ended'],
    ]);
    expect(hist.body.meta.total).toBe(2);
    const audit = await ownerQuery<{ new_values: Record<string, unknown> }>('select new_values from audit_logs where action = $1 and entity_id = $2', ['student.assignment_change', fx.a.student.id]);
    expect(audit.rows[0]!.new_values).toMatchObject({ effectiveFrom: today, morning: { stopId: fx.a.stop2.id } });
  });

  it('schedules a future change: the current row runs until then, upcoming rows can be superseded', async () => {
    const in7 = plusDays(today, 7);
    const in3 = plusDays(today, 3);
    const first = await assign(fx.a.student.id, { morning: target(fx.a.stop1), effectiveFrom: in7 });
    expect(first.body.data.assignments.morning).toMatchObject({ stopId: fx.a.stop2.id, validTo: in7, state: 'current' });
    expect(first.body.data.effectiveAssignments.filter((a: { direction: string }) => a.direction === 'morning').map((a: { state: string; validFrom: string }) => [a.state, a.validFrom])).toEqual([
      ['current', today],
      ['upcoming', in7],
    ]);
    await assign(fx.a.student.id, { morning: target(fx.a.stop1), effectiveFrom: in3 }).expect(200);
    const rows = await rowsOf(fx.a.student.id);
    expect(rows.map((r) => [r.stop_id, r.valid_from, r.valid_to])).toEqual([
      [fx.a.stop1.id, String(fx.a.assignment.valid_from), today],
      [fx.a.stop2.id, today, in3],
      [fx.a.stop1.id, in3, null],
      [fx.a.stop1.id, in7, in7], // superseded upcoming row (empty window, kept as history)
    ].sort((x, y) => String(x[1]).localeCompare(String(y[1]))));
    const open = await ownerQuery('select count(*)::int as n from student_assignments where student_id = $1 and trip_direction = $2 and valid_to is null', [fx.a.student.id, 'morning']);
    expect(open.rows[0]).toEqual({ n: 1 });
  });

  it('parents see only the assignment in force today (RLS)', async () => {
    const rows = await withTenant(f.contexts.parent(fx.a.parent.id, fx.a.school.id), (tx) =>
      tx.many<{ stop_id: string }>('select stop_id from student_assignments where trip_direction = $1', ['morning']),
    );
    expect(rows).toEqual([{ stop_id: fx.a.stop2.id }]);
  });

  it('ends a direction with null and reports capacity warnings', async () => {
    const ended = await assign(fx.a.student.id, { afternoon: null });
    expect(ended.body.data.changed).toEqual(['afternoon']);
    expect(ended.body.data.assignments.afternoon).toBeNull();
    expect((await assign(fx.a.student.id, { afternoon: null })).body.data.changed).toEqual([]);
    await ownerQuery('update buses set capacity = 1 where id = $1', [fx.a.bus.id]);
    const res = await assign(fx.a.otherStudent.id, { afternoon: target(pmStop, pmRoute) });
    expect(res.body.data.warnings).toEqual([]);
    const second = await f.student(fx.a.school.id, { full_name: 'Third Student' });
    const over = await assign(second.id, { afternoon: target(pmStop, pmRoute) });
    expect(over.body.data.warnings).toEqual([{ code: 'BUS_OVER_CAPACITY', busId: fx.a.bus.id, busCode: 'R1', direction: 'afternoon', capacity: 1, assigned: 2 }]);
    await ownerQuery('update buses set capacity = 40 where id = $1', [fx.a.bus.id]);
  });
});

describe('bulk', () => {
  it('assigns many students in one transaction, skipping those already assigned', async () => {
    const extra = await f.student(fx.a.school.id, { full_name: 'Bulk Student' });
    const ids = [fx.a.student.id, fx.a.otherStudent.id, extra.id];
    const res = await request(t.app).post(api('/school/assignments/bulk')).set(auth(adminA)).send({ studentIds: [...ids, extra.id], afternoon: target(pmStop, pmRoute) });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ effectiveFrom: today, students: 3, directions: [{ direction: 'afternoon', assigned: 2, ended: 0, unchanged: 1 }] });
    const open = await ownerQuery<{ n: number }>('select count(*)::int as n from student_assignments where student_id = any ($1) and trip_direction = $2 and valid_to is null', [ids, 'afternoon']);
    expect(open.rows[0]!.n).toBe(3);
    const end = await request(t.app).post(api('/school/assignments/bulk')).set(auth(adminA)).send({ studentIds: ids, afternoon: null });
    expect(end.body.data.directions).toEqual([{ direction: 'afternoon', assigned: 0, ended: 3, unchanged: 0 }]);
    expect((await ownerQuery('select 1 from audit_logs where action = $1', ['student.assignment_bulk'])).rowCount).toBe(2);
  });

  it('refuses unknown or foreign students and invalid targets without changing anything', async () => {
    const before = (await ownerQuery('select count(*)::int as n from student_assignments')).rows[0];
    const foreign = await request(t.app).post(api('/school/assignments/bulk')).set(auth(adminA)).send({ studentIds: [fx.a.student.id, fx.b.student.id], afternoon: target(pmStop, pmRoute) });
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.details).toEqual({ studentIds: [fx.b.student.id] });
    const invalid = await request(t.app).post(api('/school/assignments/bulk')).set(auth(adminA)).send({ studentIds: [fx.a.student.id], morning: target(pmStop, pmRoute) });
    expect(invalid.status).toBe(400);
    const crossTenant = await request(t.app).post(api('/school/assignments/bulk')).set(auth(adminB)).send({ studentIds: [fx.a.student.id], morning: null });
    expect(crossTenant.status).toBe(404);
    expect((await request(t.app).post(api('/school/assignments/bulk')).set(auth(adminA)).send({ studentIds: [] })).status).toBe(400);
    expect((await ownerQuery('select count(*)::int as n from student_assignments')).rows[0]).toEqual(before);
  });
});
