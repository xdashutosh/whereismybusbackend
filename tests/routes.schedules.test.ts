// Trip schedules (BP §8.3 CRUD /school/trip-schedules, §13.3): create/list/detail/update/delete, the
// same-bus overlap rule (shared weekday × estimated duration window × intersecting validity, half-open
// windows, midnight wrap, inactive schedules ignored), bus/route state checks, automatic bus ↔ route
// assignment and reconciliation of the not-yet-started trips generated from a schedule.
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { buildApp, loginSchoolAdmin, schoolAdmin, type TestApp } from './helpers/authApp.js';

let t: TestApp;
let sid: string;
let token: string;
let bus1: f.TenantRow;
let bus2: f.TenantRow;
let bus3: f.TenantRow;
let am1: f.TenantRow;
let am2: f.TenantRow;
let pm1: f.TenantRow;
let bare: f.TenantRow;
let s1: string;

const auth = (tk: string) => ({ Authorization: `Bearer ${tk}` });
const api = (path: string) => `/api/v1${path}`;
const post = (path: string, body: object) => request(t.app).post(api(path)).set(auth(token)).send(body);
const patch = (path: string, body: object) => request(t.app).patch(api(path)).set(auth(token)).send(body);
const get = (path: string) => request(t.app).get(api(path)).set(auth(token));
const del = (path: string) => request(t.app).delete(api(path)).set(auth(token));
const schedule = (body: Record<string, unknown>) => post('/school/trip-schedules', body);
const isoWeekday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay() || 7;

/** Route with stops at the given expected times (owner inserts: no computed polyline, duration = time span). */
async function routeWithTimes(code: string, direction: 'morning' | 'afternoon', times: string[]): Promise<f.TenantRow> {
  const r = await f.route(sid, { code, name: `Route ${code}`, direction });
  for (const [i, time] of times.entries()) await f.stop(sid, r.id, { name: `${code} stop ${i + 1}`, sequence: i + 1, expected_time: time });
  return r;
}

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  sid = (await f.school()).id;
  token = (await loginSchoolAdmin(t.app, String((await schoolAdmin(sid)).email))).accessToken;
  bus1 = await f.bus(sid, { code: 'B1' });
  bus2 = await f.bus(sid, { code: 'B2' });
  bus3 = await f.bus(sid, { code: 'B3' });
  am1 = await routeWithTimes('AM1', 'morning', ['07:00', '07:15', '07:40']);
  am2 = await routeWithTimes('AM2', 'morning', ['07:20', '08:00']);
  pm1 = await routeWithTimes('PM1', 'afternoon', ['14:00', '14:30']);
  bare = await f.route(sid, { code: 'NS', direction: 'morning' });
});
afterAll(closeDb);

describe('create', () => {
  it('creates a schedule (direction from the route, weekdays sorted) and assigns the bus to the route', async () => {
    const res = await schedule({ busId: bus1.id, routeId: am1.id, name: 'B1 morning', plannedStartTime: '07:00', daysOfWeek: [5, 1, 2, 3, 4, 1], school_id: f.nextSeq() });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      busId: bus1.id, busCode: 'B1', routeId: am1.id, routeCode: 'AM1', direction: 'morning', name: 'B1 morning', plannedStartTime: '07:00',
      daysOfWeek: [1, 2, 3, 4, 5], validFrom: null, validTo: null, isActive: true, estimatedDurationMin: 40, estimatedEndTime: '07:40',
    });
    s1 = res.body.data.id;
    const assigned = await ownerQuery('select count(*)::int as n from bus_route_assignments where bus_id = $1 and route_id = $2 and valid_to is null', [bus1.id, am1.id]);
    expect(assigned.rows[0]!.n).toBe(1);
    const audits = await ownerQuery<{ action: string }>("select action from audit_logs where action in ('trip_schedule.create', 'route.assign_bus') order by id");
    expect(audits.rows.map((r) => r.action)).toEqual(['route.assign_bus', 'trip_schedule.create']);
  });

  it('validates direction, times, weekdays and validity order', async () => {
    const dir = await schedule({ busId: bus2.id, routeId: pm1.id, direction: 'morning', plannedStartTime: '14:00', daysOfWeek: [1] });
    expect(dir.status).toBe(400);
    expect(dir.body.error.details).toEqual([{ path: 'direction', message: 'Route PM1 runs in the afternoon' }]);
    const bad = await schedule({ busId: bus2.id, routeId: pm1.id, plannedStartTime: '24:10', daysOfWeek: [0, 8], validFrom: '2027-02-01', validTo: '2027-01-01' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(['daysOfWeek[0]', 'daysOfWeek[1]', 'plannedStartTime']);
    const order = await schedule({ busId: bus2.id, routeId: pm1.id, plannedStartTime: '14:00', daysOfWeek: [1], validFrom: '2027-02-01', validTo: '2027-01-01' });
    expect(order.body.error.details).toEqual([{ path: 'validTo', message: 'validTo must not be before validFrom' }]);
  });

  it('rejects retired buses and inactive routes', async () => {
    const retired = await f.bus(sid, { code: 'OLD', status: 'retired' });
    const r1 = await schedule({ busId: retired.id, routeId: pm1.id, plannedStartTime: '15:00', daysOfWeek: [1] });
    expect([r1.status, r1.body.error.code]).toEqual([409, 'INVALID_STATE']);
    const off = await f.route(sid, { code: 'OFF', direction: 'afternoon', is_active: false });
    const r2 = await schedule({ busId: bus2.id, routeId: off.id, plannedStartTime: '15:00', daysOfWeek: [1] });
    expect([r2.status, r2.body.error.code]).toEqual([409, 'INVALID_STATE']);
    // An inactive schedule may still be prepared for an inactive route.
    expect((await schedule({ busId: bus2.id, routeId: off.id, plannedStartTime: '15:00', daysOfWeek: [1], isActive: false })).status).toBe(201);
  });
});

describe('same-bus overlap', () => {
  it('rejects an overlapping window on a shared weekday and explains the conflict', async () => {
    const res = await schedule({ busId: bus1.id, routeId: am2.id, plannedStartTime: '07:30', daysOfWeek: [1, 6] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(res.body.error.details).toEqual({
      reason: 'SCHEDULE_OVERLAP',
      estimatedDurationMin: 40,
      estimatedEndTime: '08:10',
      conflicts: [{ scheduleId: s1, name: 'B1 morning', routeCode: 'AM1', direction: 'morning', plannedStartTime: '07:00', estimatedEndTime: '07:40', sharedDays: [1] }],
    });
    // A window that starts before and runs into the existing one also collides.
    expect((await schedule({ busId: bus1.id, routeId: am2.id, plannedStartTime: '06:30', daysOfWeek: [2] })).status).toBe(409);
  });

  it('accepts back-to-back windows, other weekdays and other buses', async () => {
    expect((await schedule({ busId: bus1.id, routeId: am2.id, plannedStartTime: '07:40', daysOfWeek: [1, 2] })).status).toBe(201);
    expect((await schedule({ busId: bus1.id, routeId: am2.id, plannedStartTime: '07:10', daysOfWeek: [6, 7] })).status).toBe(201);
    expect((await schedule({ busId: bus2.id, routeId: am1.id, plannedStartTime: '07:00', daysOfWeek: [1, 2, 3, 4, 5] })).status).toBe(201);
  });

  it('only intersecting validity periods (inclusive dates) collide', async () => {
    const first = await schedule({ busId: bus3.id, routeId: pm1.id, plannedStartTime: '14:00', daysOfWeek: [1], validTo: '2027-01-31' });
    expect(first.status).toBe(201);
    expect((await schedule({ busId: bus3.id, routeId: pm1.id, plannedStartTime: '14:10', daysOfWeek: [1], validFrom: '2027-02-01' })).status).toBe(201);
    expect((await schedule({ busId: bus3.id, routeId: pm1.id, plannedStartTime: '14:10', daysOfWeek: [1], validFrom: '2027-01-31', validTo: '2027-01-31' })).status).toBe(409);
  });

  it('uses the default window for a route without times and wraps past midnight into the next weekday', async () => {
    const late = await schedule({ busId: bus3.id, routeId: bare.id, plannedStartTime: '23:30', daysOfWeek: [7] });
    expect(late.body.data).toMatchObject({ estimatedDurationMin: 60, estimatedEndTime: '00:30+1' });
    const monday = await schedule({ busId: bus3.id, routeId: bare.id, plannedStartTime: '00:15', daysOfWeek: [1] });
    expect(monday.status).toBe(409);
    expect(monday.body.error.details.conflicts[0]).toMatchObject({ scheduleId: late.body.data.id, sharedDays: [1] });
    expect((await schedule({ busId: bus3.id, routeId: bare.id, plannedStartTime: '00:30', daysOfWeek: [1] })).status).toBe(201);
  });

  it('ignores inactive schedules until they are reactivated', async () => {
    const idle = await schedule({ busId: bus1.id, routeId: am2.id, plannedStartTime: '07:05', daysOfWeek: [3], isActive: false });
    expect(idle.status).toBe(201);
    const on = await patch(`/school/trip-schedules/${idle.body.data.id}`, { isActive: true });
    expect(on.status).toBe(409);
    expect(on.body.error.details.conflicts.map((c: { scheduleId: string }) => c.scheduleId)).toEqual([s1]);
    expect((await patch(`/school/trip-schedules/${idle.body.data.id}`, { isActive: true, plannedStartTime: '09:00' })).status).toBe(200);
  });

  it('re-checks edits but never collides with itself', async () => {
    expect((await patch(`/school/trip-schedules/${s1}`, { plannedStartTime: '06:55' })).status).toBe(200);
    const clash = await patch(`/school/trip-schedules/${s1}`, { plannedStartTime: '07:45' });
    expect(clash.status).toBe(409);
    const back = await patch(`/school/trip-schedules/${s1}`, { plannedStartTime: '07:00' });
    expect(back.body.data.plannedStartTime).toBe('07:00');
  });
});

describe('trips generated from a schedule', () => {
  it('edits update or cancel pending trips; trips in progress and past trips are never touched', async () => {
    // Valid from d2: no trip today (a schedule created during the day also gets today's run, when still ahead).
    const created = await schedule({ busId: bus2.id, routeId: pm1.id, plannedStartTime: '14:00', daysOfWeek: [1, 2, 3, 4, 5, 6, 7], validFrom: f.isoDay(2) });
    const id = created.body.data.id as string;
    const d2 = f.isoDay(2);
    const d3 = f.isoDay(3);
    const mk = (o: Record<string, unknown>) => f.trip(sid, bus2.id, { schedule_id: id, route_id: pm1.id, direction: 'afternoon', bus_code_snapshot: 'B2', route_code_snapshot: 'PM1', ...o });
    const t2 = await mk({ trip_date: d2, planned_start_at: `${d2}T08:30:00Z` });
    const t3 = await mk({ trip_date: d3, planned_start_at: `${d3}T08:30:00Z` });
    const past = await mk({ trip_date: f.isoDay(-2), status: 'completed', started_at: new Date(Date.now() - 2 * 86_400_000).toISOString(), ended_at: new Date(Date.now() - 2 * 86_400_000 + 3_600_000).toISOString() });
    const running = await mk({ trip_date: f.isoDay(-3), status: 'in_progress', started_at: new Date().toISOString() });

    const moved = await patch(`/school/trip-schedules/${id}`, { plannedStartTime: '15:00', busId: bus3.id });
    expect(moved.status).toBe(200);
    const rows = async () =>
      (await ownerQuery<{ id: string; status: string; bus_id: string; planned: string; bus_code_snapshot: string }>(
        `select id, status, bus_id, to_char(planned_start_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') as planned, bus_code_snapshot
           from trips where schedule_id = $1`,
        [id],
      )).rows.reduce<Record<string, { status: string; bus_id: string; planned: string; bus_code_snapshot: string }>>((m, r) => ({ ...m, [r.id]: r }), {});
    let state = await rows();
    expect(state[t2.id]).toEqual({ id: t2.id, status: 'scheduled', bus_id: bus3.id, planned: `${d2} 15:00`, bus_code_snapshot: 'B3' });
    expect(state[t3.id]).toMatchObject({ status: 'scheduled', bus_id: bus3.id, planned: `${d3} 15:00` });
    expect(state[past.id]).toMatchObject({ status: 'completed', bus_id: bus2.id });
    expect(state[running.id]).toMatchObject({ status: 'in_progress', bus_id: bus2.id });

    const keep = [1, 2, 3, 4, 5, 6, 7].filter((d) => d !== isoWeekday(d2));
    await patch(`/school/trip-schedules/${id}`, { daysOfWeek: keep });
    state = await rows();
    expect(state[t2.id]!.status).toBe('cancelled');
    expect(state[t3.id]!.status).toBe('scheduled');

    await patch(`/school/trip-schedules/${id}`, { isActive: false });
    state = await rows();
    expect(state[t3.id]!.status).toBe('cancelled');
    expect(state[running.id]!.status).toBe('in_progress');
    const audit = await ownerQuery<{ new_values: { tripsUpdated: number; tripsCancelled: number } }>("select new_values from audit_logs where action = 'trip_schedule.update' and entity_id = $1 order by id", [id]);
    expect(audit.rows.map((r) => [r.new_values.tripsUpdated, r.new_values.tripsCancelled])).toEqual([[2, 0], [0, 1], [0, 1]]);
  });

  it('delete soft-deletes the schedule and cancels its pending trips', async () => {
    const created = await schedule({ busId: bus2.id, routeId: pm1.id, plannedStartTime: '16:00', daysOfWeek: [1, 2, 3, 4, 5, 6, 7], validFrom: f.isoDay(2) });
    const id = created.body.data.id as string;
    const pending = await f.trip(sid, bus2.id, { schedule_id: id, route_id: pm1.id, direction: 'afternoon', trip_date: f.isoDay(2) });
    const res = await del(`/school/trip-schedules/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id, deleted: true, tripsCancelled: 1 });
    expect((await ownerQuery('select status, cancel_reason from trips where id = $1', [pending.id])).rows[0]).toEqual({ status: 'cancelled', cancel_reason: 'Schedule deleted' });
    expect((await get(`/school/trip-schedules/${id}`)).status).toBe(404);
    expect((await del(`/school/trip-schedules/${id}`)).status).toBe(404);
  });
});

describe('list', () => {
  it('filters, sorts, paginates and exports', async () => {
    const all = await get('/school/trip-schedules?limit=100');
    expect(all.status).toBe(200);
    const codes = all.body.data.map((s: { busCode: string; plannedStartTime: string }) => `${s.busCode}@${s.plannedStartTime}`);
    expect(codes.slice(0, 3)).toEqual(['B1@07:00', 'B1@07:10', 'B1@07:40']);
    const byBus = await get(`/school/trip-schedules?busId=${bus3.id}&sort=-plannedStartTime`);
    expect(byBus.body.data.map((s: { plannedStartTime: string }) => s.plannedStartTime)).toEqual(['23:30', '15:00', '14:10', '14:00', '00:30']);
    expect((await get(`/school/trip-schedules?routeId=${am1.id}`)).body.data).toHaveLength(2);
    expect((await get('/school/trip-schedules?direction=afternoon&isActive=true&day=1&validOn=2027-01-15')).body.data.map((s: { busCode: string; plannedStartTime: string }) => `${s.busCode}@${s.plannedStartTime}`)).toEqual(['B3@14:00']);
    expect((await get('/school/trip-schedules?isActive=false')).body.data.map((s: { routeCode: string }) => s.routeCode)).toEqual(['OFF', 'PM1']);
    expect((await get('/school/trip-schedules?q=b1 morning')).body.data.map((s: { id: string }) => s.id)).toEqual([s1]);
    expect((await get('/school/trip-schedules?day=9')).status).toBe(400);
    const csv = await get('/school/trip-schedules?format=csv&busId=' + bus1.id);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('Mon Tue Wed Thu Fri');
    expect((await get(`/school/trip-schedules/${s1}`)).body.data.id).toBe(s1);
  });
});

describe('bus ↔ route assignments', () => {
  it('assigns, treats a repeat as unchanged and validates the effective time and states', async () => {
    const res = await post(`/school/routes/${am2.id}/assign-bus`, { busId: bus2.id, note: 'Second bus for the AM2 crowd' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ action: 'assigned', assignment: { busId: bus2.id, routeId: am2.id, routeCode: 'AM2', direction: 'morning', isCurrent: true, validTo: null } });
    expect(res.body.data.buses.map((b: { busCode: string }) => b.busCode)).toEqual(['B1', 'B2']);
    expect((await post(`/school/routes/${am2.id}/assign-bus`, { busId: bus2.id })).body.data.action).toBe('unchanged');
    expect((await post(`/school/routes/${am2.id}/assign-bus`, { busId: bus3.id, effectiveFrom: new Date(Date.now() + 3_600_000).toISOString() })).status).toBe(400);
    const retired = await f.bus(sid, { code: 'RET', status: 'retired' });
    expect((await post(`/school/routes/${am2.id}/assign-bus`, { busId: retired.id })).body.error.code).toBe('INVALID_STATE');
    const inactive = await f.route(sid, { code: 'IN', direction: 'morning', is_active: false });
    expect((await post(`/school/routes/${inactive.id}/assign-bus`, { busId: bus3.id })).body.error.code).toBe('INVALID_STATE');
    expect((await post(`/school/routes/${am2.id}/assign-bus`, { busId: crypto.randomUUID() })).status).toBe(404);
  });

  it('unassigns (blocked by live schedules), keeps history and rejects overlapping back-dated windows', async () => {
    const blocked = await post(`/school/routes/${am1.id}/unassign-bus`, { busId: bus1.id });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatchObject({ code: 'CONFLICT', details: { schedules: 1 } });
    expect((await post(`/school/routes/${pm1.id}/unassign-bus`, { busId: bus1.id })).body.error.code).toBe('INVALID_STATE');

    const off = await post(`/school/routes/${am2.id}/unassign-bus`, { busId: bus2.id });
    expect(off.status).toBe(200);
    expect(off.body.data).toMatchObject({ action: 'unassigned', assignment: { isCurrent: false } });
    expect(off.body.data.assignment.validTo).not.toBeNull();
    const backdated = await post(`/school/routes/${am2.id}/assign-bus`, { busId: bus2.id, effectiveFrom: new Date(Date.now() - 86_400_000).toISOString() });
    expect(backdated.status).toBe(409);
    expect(backdated.body.error.code).toBe('CONFLICT');
    expect((await post(`/school/routes/${am2.id}/assign-bus`, { busId: bus2.id })).body.data.action).toBe('assigned');

    const history = await get(`/school/routes/${am2.id}/bus-assignments?busId=${bus2.id}`);
    expect(history.body.data.map((a: { isCurrent: boolean }) => a.isCurrent)).toEqual([true, false]);
    expect((await get(`/school/bus-route-assignments?busId=${bus2.id}&current=true&sort=routeCode`)).body.data.map((a: { routeCode: string }) => a.routeCode)).toEqual(['AM1', 'AM2', 'PM1']);
    const csv = await get(`/school/bus-route-assignments?format=csv&routeId=${am2.id}`);
    expect(csv.text).toContain('Bus,Bus name,Route,Route name,Direction');
    expect((await get(`/school/routes/${crypto.randomUUID()}/bus-assignments`)).status).toBe(404);
    const audits = await ownerQuery<{ action: string }>("select action from audit_logs where entity_id = $1 and action like 'route.%assign_bus' order by id", [am2.id]);
    expect(audits.rows.map((r) => r.action)).toEqual(['route.assign_bus', 'route.assign_bus', 'route.unassign_bus', 'route.assign_bus']);
  });
});
