// Bus staff assignment (BP §8.3 POST /school/buses/:id/assign-staff, GET /:id/assignment-history;
// BP §6.2 history + one open primary driver): replacing closes the previous open assignment and
// keeps history, null unassigns, unchanged ids are no-ops, role moves on the same bus, staff type
// and activity checks, effectiveFrom rules, the database backstop, history filters/CSV, isolation.
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { buildApp, loginSchoolAdmin, passwordHash, type TestApp } from './helpers/authApp.js';

let t: TestApp;
let fx: f.TwoSchoolFixture;
let adminA: string;
let adminB: string;
let busId: string;
let d1: f.TenantRow;
let d2: f.TenantRow;
let d3: f.TenantRow;
let c1: f.TenantRow;
let c2: f.TenantRow;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const api = (path: string) => `/api/v1${path}`;
const assign = (body: Record<string, unknown>, id = busId, token = adminA) => request(t.app).post(api(`/school/buses/${id}/assign-staff`)).set(auth(token)).send(body);
const openRows = (bus: string) =>
  ownerQuery<{ assignment_role: string; staff_id: string }>('select assignment_role, staff_id from bus_staff_assignments where bus_id = $1 and valid_to is null order by assignment_role', [bus]);

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  fx = await f.twoSchoolFixture();
  await ownerQuery('update users set password_hash = $1 where id = any ($2)', [await passwordHash(), [fx.a.admin.id, fx.b.admin.id]]);
  adminA = (await loginSchoolAdmin(t.app, String(fx.a.admin.email))).accessToken;
  adminB = (await loginSchoolAdmin(t.app, String(fx.b.admin.email))).accessToken;
  const sid = fx.a.school.id;
  busId = (await f.bus(sid, { code: 'R7' })).id;
  d1 = await f.staffProfile(sid, { full_name: 'Anil Driver' });
  d2 = await f.staffProfile(sid, { full_name: 'Bala Driver' });
  d3 = await f.staffProfile(sid, { full_name: 'Charan Driver' });
  c1 = await f.staffProfile(sid, { staff_type: 'conductor', full_name: 'Deepa Conductor', licence_no: null });
  c2 = await f.staffProfile(sid, { staff_type: 'conductor', full_name: 'Esha Conductor', licence_no: null });
});
afterAll(closeDb);

describe('assign-staff', () => {
  it('assigns all four roles in one request', async () => {
    const res = await assign({ primaryDriverId: d1.id, backupDriverId: d2.id, conductorId: c1.id, backupConductorId: c2.id, school_id: fx.b.school.id });
    expect(res.status).toBe(200);
    expect(res.body.data.staff).toMatchObject({
      primaryDriver: { staffId: d1.id, fullName: 'Anil Driver' },
      backupDriver: { staffId: d2.id },
      conductor: { staffId: c1.id },
      backupConductor: { staffId: c2.id },
    });
    expect(res.body.data.changes.map((c: { action: string }) => c.action)).toEqual(['assigned', 'assigned', 'assigned', 'assigned']);
    const rows = await ownerQuery('select distinct school_id, created_by from bus_staff_assignments where bus_id = $1', [busId]);
    expect(rows.rows).toEqual([{ school_id: fx.a.school.id, created_by: fx.a.admin.id }]);
  });

  it('replacing the primary driver closes the previous open assignment — one open primary driver', async () => {
    const res = await assign({ primaryDriverId: d3.id });
    expect(res.status).toBe(200);
    expect(res.body.data.changes).toEqual([{ role: 'primary_driver', action: 'assigned', staffId: d3.id, previousStaffIds: [d1.id] }]);
    const primaries = await ownerQuery<{ staff_id: string; closed: boolean }>(
      "select staff_id, valid_to is not null as closed from bus_staff_assignments where bus_id = $1 and assignment_role = 'primary_driver' order by valid_from, created_at",
      [busId],
    );
    expect(primaries.rows).toEqual([{ staff_id: d1.id, closed: true }, { staff_id: d3.id, closed: false }]);
    const audit = await ownerQuery("select old_values, new_values from audit_logs where action = 'bus.assign_staff' and entity_id = $1 order by id desc limit 1", [busId]);
    expect(audit.rows[0]!.old_values).toMatchObject({ primary_driver: d1.id });
    expect(audit.rows[0]!.new_values).toMatchObject({ primary_driver: d3.id, backup_driver: d2.id });
  });

  it('treats an unchanged id as a no-op and null as unassign', async () => {
    const before = (await ownerQuery<{ n: number }>('select count(*)::int as n from bus_staff_assignments where bus_id = $1', [busId])).rows[0]!.n;
    const same = await assign({ primaryDriverId: d3.id });
    expect(same.body.data.changes).toEqual([{ role: 'primary_driver', action: 'unchanged', staffId: d3.id, previousStaffIds: [] }]);
    expect((await ownerQuery<{ n: number }>('select count(*)::int as n from bus_staff_assignments where bus_id = $1', [busId])).rows[0]!.n).toBe(before);
    const off = await assign({ backupConductorId: null });
    expect(off.body.data.staff.backupConductor).toBeNull();
    expect(off.body.data.changes).toEqual([{ role: 'backup_conductor', action: 'unassigned', staffId: null, previousStaffIds: [c2.id] }]);
  });

  it('moves a staff member between roles on the same bus (backup driver promoted)', async () => {
    const res = await assign({ primaryDriverId: d2.id });
    expect(res.status).toBe(200);
    expect(res.body.data.staff.primaryDriver.staffId).toBe(d2.id);
    expect(res.body.data.staff.backupDriver).toBeNull();
    expect(res.body.data.changes).toContainEqual({ role: 'backup_driver', action: 'moved_out', staffId: null, previousStaffIds: [d2.id] });
    expect((await openRows(busId)).rows).toEqual([
      { assignment_role: 'conductor', staff_id: c1.id },
      { assignment_role: 'primary_driver', staff_id: d2.id },
    ]);
  });

  it('swaps two staff members between roles in one request', async () => {
    await assign({ backupDriverId: d3.id });
    const res = await assign({ primaryDriverId: d3.id, backupDriverId: d2.id });
    expect(res.status).toBe(200);
    expect([res.body.data.staff.primaryDriver.staffId, res.body.data.staff.backupDriver.staffId]).toEqual([d3.id, d2.id]);
  });

  it('checks staff type, activity, school and duplicates', async () => {
    const wrongType = await assign({ primaryDriverId: c1.id });
    expect([wrongType.status, wrongType.body.error.details]).toEqual([400, [{ path: 'primaryDriverId', message: 'Must be a driver' }]]);
    const inactive = await f.staffProfile(fx.a.school.id, { full_name: 'Inactive Driver', is_active: false });
    const inactiveRes = await assign({ backupDriverId: inactive.id });
    expect([inactiveRes.status, inactiveRes.body.error.code]).toEqual([409, 'INVALID_STATE']);
    const deleted = await f.staffProfile(fx.a.school.id, { deleted_at: new Date().toISOString() });
    expect((await assign({ backupDriverId: deleted.id })).status).toBe(404);
    const fromB = await assign({ backupDriverId: fx.b.driver.id });
    expect([fromB.status, fromB.body.error.code]).toEqual([404, 'NOT_FOUND']);
    const dup = await assign({ primaryDriverId: d1.id, backupDriverId: d1.id });
    expect(dup.status).toBe(400);
    const nothing = await assign({ note: 'nothing' });
    expect(nothing.status).toBe(400);
  });

  it('applies effectiveFrom: never in the future, never before the assignment it closes', async () => {
    const future = await assign({ conductorId: c2.id, effectiveFrom: new Date(Date.now() + 3_600_000).toISOString() });
    expect([future.status, future.body.error.details[0].path]).toEqual([400, 'effectiveFrom']);
    const tooEarly = await assign({ conductorId: c2.id, effectiveFrom: '2020-01-01T00:00:00Z' });
    expect([tooEarly.status, tooEarly.body.error.details[0].path]).toEqual([400, 'effectiveFrom']);

    const bus = await f.bus(fx.a.school.id, { code: 'R8' });
    const start = new Date(Date.now() - 3 * 86_400_000).toISOString();
    expect((await assign({ conductorId: c2.id, effectiveFrom: start }, bus.id)).status).toBe(200);
    const row = (await ownerQuery<{ valid_from: string }>('select valid_from from bus_staff_assignments where bus_id = $1', [bus.id])).rows[0]!;
    expect(Date.parse(row.valid_from)).toBe(Date.parse(start));
  });

  it('refuses new assignments for a retired bus but allows unassigning', async () => {
    const bus = await f.bus(fx.a.school.id, { code: 'R99', status: 'retired' });
    await f.busStaffAssignment(fx.a.school.id, bus.id, d1.id, { assignment_role: 'backup_driver' });
    expect((await assign({ primaryDriverId: d1.id }, bus.id)).status).toBe(409);
    expect((await assign({ backupDriverId: null }, bus.id)).status).toBe(200);
  });

  it('the database refuses a second open primary driver (one_primary_driver backstop)', async () => {
    await expect(
      ownerQuery("insert into bus_staff_assignments (school_id, bus_id, staff_id, assignment_role) values ($1, $2, $3, 'primary_driver')", [fx.a.school.id, busId, d1.id]),
    ).rejects.toMatchObject({ code: '23505', constraint: 'one_primary_driver' });
  });
});

describe('assignment history', () => {
  it('lists every assignment with names, newest first, filterable and exportable', async () => {
    const res = await request(t.app).get(api(`/school/buses/${busId}/assignment-history`)).set(auth(adminA));
    expect(res.status).toBe(200);
    const items = res.body.data as { role: string; staffId: string; validFrom: string; isCurrent: boolean; createdByName: string }[];
    expect(items.length).toBe(res.body.meta.total);
    expect(items.map((i) => i.validFrom)).toEqual([...items.map((i) => i.validFrom)].sort().reverse());
    expect(items.find((i) => i.staffId === d1.id && i.role === 'primary_driver')).toMatchObject({ isCurrent: false, createdByName: String(fx.a.admin.full_name) });

    const primaries = await request(t.app).get(api(`/school/buses/${busId}/assignment-history?role=primary_driver&sort=validFrom`)).set(auth(adminA));
    expect(primaries.body.data.map((i: { staffId: string }) => i.staffId)).toEqual([d1.id, d3.id, d2.id, d3.id]);
    const current = await request(t.app).get(api(`/school/buses/${busId}/assignment-history?current=true`)).set(auth(adminA));
    expect(current.body.data.map((i: { role: string }) => i.role).sort()).toEqual(['backup_driver', 'conductor', 'primary_driver']);
    const byStaff = await request(t.app).get(api(`/school/buses/${busId}/assignment-history?staffId=${c2.id}`)).set(auth(adminA));
    expect(byStaff.body.data).toHaveLength(1);

    const csv = await request(t.app).get(api(`/school/buses/${busId}/assignment-history?format=csv`)).set(auth(adminA));
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('Role,Staff,Staff type');
    expect(csv.text).toContain('Anil Driver');
  });

  it('is isolated per school', async () => {
    expect((await request(t.app).get(api(`/school/buses/${busId}/assignment-history`)).set(auth(adminB))).status).toBe(404);
    const res = await assign({ primaryDriverId: fx.b.driver.id }, busId, adminB);
    expect(res.status).toBe(404);
    const bOwn = await assign({ primaryDriverId: d1.id }, fx.b.otherBus.id, adminB);
    expect(bOwn.status).toBe(404); // A's staff id is unknown in school B
  });
});
