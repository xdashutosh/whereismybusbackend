// Students (BP §8.3 Students, §13.3; contract §5, §9): list filters (class, bus, route, unassigned,
// parents) / sort / pagination / CSV, detail, create with admission numbers unique per school (the
// same numbers live in both fixture schools), edit + photo via the files module (parent read hook),
// plan limit, soft delete, audit, role gates and tenant isolation (B's admin gets 404 for every A
// id, bodies carrying school_id are ignored, the app role without context sees nothing).
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appPool, closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { buildApp, loginParent, loginSchoolAdmin, loginStaff, passwordHash, type TestApp } from './helpers/authApp.js';

let t: TestApp;
let fx: f.TwoSchoolFixture;
let adminA: string;
let adminB: string;
let driverA: string;
let parentA: string;
let jpeg: Buffer;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const api = (path: string) => `/api/v1${path}`;
type Item = { id: string; fullName: string; admissionNo: string };
const names = (res: request.Response) => (res.body.data as Item[]).map((s) => s.fullName);

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  fx = await f.twoSchoolFixture();
  await ownerQuery('update users set password_hash = $1 where id = any ($2)', [await passwordHash(), [fx.a.admin.id, fx.b.admin.id, fx.a.driverUser.id]]);
  adminA = (await loginSchoolAdmin(t.app, String(fx.a.admin.email))).accessToken;
  adminB = (await loginSchoolAdmin(t.app, String(fx.b.admin.email))).accessToken;
  driverA = (await loginStaff(t.app, String(fx.a.school.code), String(fx.a.driverUser.phone))).accessToken;
  parentA = (await loginParent(t, String(fx.a.parent.phone))).accessToken;
  jpeg = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#ffcc00' } }).jpeg().toBuffer();
});
afterAll(closeDb);

describe('list', () => {
  it('lists only the caller school students with parents and assignment summaries', async () => {
    const res = await request(t.app).get(api('/school/students?sort=fullName')).set(auth(adminA));
    expect(res.status).toBe(200);
    expect(names(res)).toEqual(['Aarav Sharma', 'Diya Patel']);
    expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 2, totalPages: 1 });
    const aarav = res.body.data[0];
    expect(aarav).toMatchObject({ id: fx.a.student.id, admissionNo: 'ADM-001', className: '5', section: 'A', isActive: true, parentCount: 2 });
    expect(aarav.primaryParent).toMatchObject({ id: fx.a.schoolParent.id, fullName: 'Priya Sharma', phone: fx.a.parent.phone });
    expect(aarav.assignments.morning).toMatchObject({ busId: fx.a.bus.id, busCode: 'R1', routeCode: 'R1', routeName: 'Route 1', stopName: 'Stop 1', state: 'current', validTo: null });
    expect(aarav.assignments.afternoon).toBeNull();
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(fx.b.student.id);
    expect(body).not.toContain(fx.a.parent.id); // the global parent account id never leaves the server
  });

  it('filters by bus, route, direction, unassigned, class, parents and search', async () => {
    const q = (query: Record<string, string>) => request(t.app).get(api('/school/students')).query({ sort: 'fullName', ...query }).set(auth(adminA));
    expect(names(await q({ busId: fx.a.bus.id }))).toEqual(['Aarav Sharma']);
    expect(names(await q({ routeId: fx.a.otherRoute.id, direction: 'morning' }))).toEqual(['Diya Patel']);
    expect(names(await q({ busId: fx.a.bus.id, direction: 'afternoon' }))).toEqual([]);
    expect(names(await q({ unassigned: 'true', direction: 'morning' }))).toEqual([]);
    expect(names(await q({ unassigned: 'true', direction: 'afternoon' }))).toEqual(['Aarav Sharma', 'Diya Patel']);
    expect(names(await q({ unassigned: 'true' }))).toEqual(['Aarav Sharma', 'Diya Patel']);
    expect(names(await q({ unassigned: 'false' }))).toEqual([]);
    expect(names(await q({ hasParents: 'false' }))).toEqual(['Diya Patel']);
    expect(names(await q({ q: 'adm-002' }))).toEqual(['Diya Patel']);
    expect(names(await q({ className: '5', section: 'a' }))).toEqual(['Aarav Sharma', 'Diya Patel']);
    expect(names(await q({ busId: fx.b.bus.id }))).toEqual([]);
    const sorted = await request(t.app).get(api('/school/students?sort=-admissionNo&limit=1&page=2')).set(auth(adminA));
    expect(names(sorted)).toEqual(['Aarav Sharma']);
    expect((await request(t.app).get(api('/school/students?sort=secret')).set(auth(adminA))).status).toBe(400);
  });

  it('exports CSV with assignments and parents', async () => {
    const res = await request(t.app).get(api('/school/students?format=csv&sort=admissionNo')).set(auth(adminA));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.text.replace(/^\uFEFF/, '').trim().split('\r\n');
    expect(lines[0]).toContain('Admission no,Name,Class');
    expect(lines[1]).toContain('ADM-001,Aarav Sharma,5,A');
    expect(lines[1]).toContain('R1,R1,Stop 1');
    expect(lines).toHaveLength(3);
  });
});

describe('create, read, update', () => {
  let createdId: string;

  it('creates a student (school_id in the body is ignored) and audits it', async () => {
    const res = await request(t.app)
      .post(api('/school/students'))
      .set(auth(adminA))
      .send({ admissionNo: 'ADM-100', fullName: '  Kabir Rao ', className: '2', section: 'B', rollNo: '4', notes: 'Allergic to peanuts', school_id: fx.b.school.id, schoolId: fx.b.school.id });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ admissionNo: 'ADM-100', fullName: 'Kabir Rao', className: '2', isActive: true, parentCount: 0, assignments: { morning: null, afternoon: null } });
    createdId = res.body.data.id;
    const row = (await ownerQuery<{ school_id: string; created_by: string }>('select school_id, created_by from students where id = $1', [createdId])).rows[0]!;
    expect(row).toEqual({ school_id: fx.a.school.id, created_by: fx.a.admin.id });
    const audit = await ownerQuery('select school_id from audit_logs where action = $1 and entity_id = $2', ['student.create', createdId]);
    expect(audit.rows).toEqual([{ school_id: fx.a.school.id }]);
  });

  it('keeps admission numbers unique per school only', async () => {
    const dup = await request(t.app).post(api('/school/students')).set(auth(adminA)).send({ admissionNo: 'ADM-001', fullName: 'Someone Else' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE');
    // ADM-001 exists in both fixture schools; B may also take A's new number.
    const inB = await request(t.app).post(api('/school/students')).set(auth(adminB)).send({ admissionNo: 'ADM-100', fullName: 'Kabir Rao' });
    expect(inB.status).toBe(201);
    expect(inB.body.data.id).not.toBe(createdId);
    expect((await request(t.app).post(api('/school/students')).set(auth(adminA)).send({ fullName: '' })).status).toBe(400);
  });

  it('returns the detail with parents and effective assignments', async () => {
    const res = await request(t.app).get(api(`/school/students/${fx.a.student.id}`)).set(auth(adminA));
    expect(res.status).toBe(200);
    expect(res.body.data.parents.map((p: { fullName: string; isPrimary: boolean }) => [p.fullName, p.isPrimary])).toEqual([
      ['Priya Sharma', true],
      ['Vikram Mehta', false],
    ]);
    expect(res.body.data.effectiveAssignments).toHaveLength(1);
    expect(res.body.data.notes).toBeNull();
  });

  it('updates fields, sets a photo uploaded for the student and audits the diff', async () => {
    const upload = await request(t.app).post(api('/files/upload')).set(auth(adminA)).field('category', 'student_photo').field('entityId', createdId).attach('file', jpeg, 'kabir.jpg');
    expect(upload.status).toBe(201);
    const res = await request(t.app).patch(api(`/school/students/${createdId}`)).set(auth(adminA)).send({ className: '3', photoFileId: upload.body.data.id });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ className: '3', photoFileId: upload.body.data.id });
    const detail = await request(t.app).get(api(`/school/students/${createdId}`)).set(auth(adminA));
    expect(detail.body.data.photoUrl).toEqual(expect.stringContaining('/api/v1/files/local/download?token='));
    expect(detail.body.data.photoThumbnailUrl).toEqual(expect.stringContaining('/api/v1/files/local/download?token='));
    const audit = await ownerQuery<{ old_values: unknown; new_values: unknown }>('select old_values, new_values from audit_logs where action = $1 and entity_id = $2', ['student.update', createdId]);
    expect(audit.rows[0]).toMatchObject({ old_values: { className: '2', photoFileId: null }, new_values: { className: '3', photoFileId: upload.body.data.id } });
  });

  it('refuses photos of another student/category/school or still pending', async () => {
    const other = await request(t.app).post(api('/files/upload')).set(auth(adminA)).field('category', 'student_photo').field('entityId', fx.a.otherStudent.id).attach('file', jpeg, 'x.jpg');
    expect((await request(t.app).patch(api(`/school/students/${createdId}`)).set(auth(adminA)).send({ photoFileId: other.body.data.id })).status).toBe(400);
    const fromB = await request(t.app).post(api('/files/upload')).set(auth(adminB)).field('category', 'student_photo').field('entityId', fx.b.student.id).attach('file', jpeg, 'x.jpg');
    expect((await request(t.app).patch(api(`/school/students/${createdId}`)).set(auth(adminA)).send({ photoFileId: fromB.body.data.id })).status).toBe(404);
    const pending = await f.file(fx.a.school.id, { category: 'student_photo', entity_type: 'student', entity_id: createdId, status: 'pending' });
    expect((await request(t.app).patch(api(`/school/students/${createdId}`)).set(auth(adminA)).send({ photoFileId: pending.id })).status).toBe(409);
    expect((await request(t.app).patch(api(`/school/students/${createdId}`)).set(auth(adminA)).send({})).status).toBe(400);
  });

  it('lets a linked parent read the child photo, nobody else', async () => {
    const upload = await request(t.app).post(api('/files/upload')).set(auth(adminA)).field('category', 'student_photo').field('entityId', fx.a.student.id).attach('file', jpeg, 'aarav.jpg');
    await request(t.app).patch(api(`/school/students/${fx.a.student.id}`)).set(auth(adminA)).send({ photoFileId: upload.body.data.id }).expect(200);
    const url = (token: string) => request(t.app).get(api(`/files/${upload.body.data.id}/url`)).set(auth(token)).set('X-School-Id', fx.a.school.id);
    expect((await url(parentA)).status).toBe(200);
    const stranger = await f.parentAccount();
    await f.schoolParent(fx.a.school.id, stranger.id, { full_name: 'Other Parent' });
    await f.studentParent(fx.a.school.id, fx.a.otherStudent.id, stranger.id);
    const strangerToken = (await loginParent(t, String(stranger.phone))).accessToken;
    expect((await url(strangerToken)).status).toBe(404);
    expect((await url(driverA)).status).toBe(404);
    expect((await request(t.app).get(api(`/files/${upload.body.data.id}/url`)).set(auth(adminB))).status).toBe(404);
  });

  it('enforces the plan limit on active students', async () => {
    await ownerQuery('update school_subscriptions set max_students = (select count(*) from students where school_id = $1 and deleted_at is null and is_active) where school_id = $1', [fx.a.school.id]);
    const res = await request(t.app).post(api('/school/students')).set(auth(adminA)).send({ fullName: 'Over Limit' });
    expect(res.status).toBe(403);
    expect(res.body.error.details).toMatchObject({ reason: 'SUBSCRIPTION_LIMIT', resource: 'students' });
    const inactive = await request(t.app).post(api('/school/students')).set(auth(adminA)).send({ fullName: 'Alumnus', isActive: false });
    expect(inactive.status).toBe(201);
    expect((await request(t.app).patch(api(`/school/students/${inactive.body.data.id}`)).set(auth(adminA)).send({ isActive: true })).status).toBe(403);
    await ownerQuery('update school_subscriptions set max_students = null where school_id = $1', [fx.a.school.id]);
  });

  it('soft deletes: assignments end, links go, the admission number is free again', async () => {
    const s = await f.student(fx.a.school.id, { admission_no: 'ADM-DEL', full_name: 'Leaving Student' });
    await f.studentParent(fx.a.school.id, s.id, fx.a.parent.id, { is_primary: false });
    await f.studentAssignment(fx.a.school.id, { studentId: s.id, busId: fx.a.bus.id, routeId: fx.a.route.id, stopId: fx.a.stop1.id });
    const res = await request(t.app).delete(api(`/school/students/${s.id}`)).set(auth(adminA));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: s.id, deleted: true });
    const row = (await ownerQuery<{ open: number; links: number }>(
      `select (select count(*)::int from student_assignments where student_id = $1 and (valid_to is null or valid_to > school_local_date($2))) as open,
              (select count(*)::int from student_parents where student_id = $1) as links`,
      [s.id, fx.a.school.id],
    )).rows[0]!;
    expect(row).toEqual({ open: 0, links: 0 });
    expect((await request(t.app).get(api(`/school/students/${s.id}`)).set(auth(adminA))).status).toBe(404);
    expect((await request(t.app).post(api('/school/students')).set(auth(adminA)).send({ admissionNo: 'ADM-DEL', fullName: 'New Student' })).status).toBe(201);
    const audit = await ownerQuery<{ new_values: unknown }>('select new_values from audit_logs where action = $1 and entity_id = $2', ['student.delete', s.id]);
    expect(audit.rows[0]!.new_values).toEqual({ assignmentsEnded: 1, parentLinksRemoved: 1 });
  });
});

describe('isolation and roles', () => {
  it("returns 404 for every A student id used with B's token", async () => {
    const id = fx.a.student.id;
    expect((await request(t.app).get(api(`/school/students/${id}`)).set(auth(adminB))).status).toBe(404);
    expect((await request(t.app).patch(api(`/school/students/${id}`)).set(auth(adminB)).send({ className: '9' })).status).toBe(404);
    expect((await request(t.app).delete(api(`/school/students/${id}`)).set(auth(adminB))).status).toBe(404);
    expect((await request(t.app).get(api(`/school/students/${id}/assignment-history`)).set(auth(adminB))).status).toBe(404);
    expect((await request(t.app).put(api(`/school/students/${id}/assignment`)).set(auth(adminB)).send({ morning: null })).status).toBe(404);
    expect((await request(t.app).post(api(`/school/students/${id}/parents`)).set(auth(adminB)).send({ parentId: fx.b.schoolParent.id })).status).toBe(404);
    expect((await request(t.app).delete(api(`/school/students/${id}/parents/${fx.a.schoolParent.id}`)).set(auth(adminB))).status).toBe(404);
    const stillThere = await ownerQuery('select class_name, deleted_at from students where id = $1', [id]);
    expect(stillThere.rows).toEqual([{ class_name: '5', deleted_at: null }]);
  });

  it('refuses drivers, parents and anonymous callers', async () => {
    expect((await request(t.app).get(api('/school/students')).set(auth(driverA))).status).toBe(403);
    expect((await request(t.app).get(api('/school/students')).set(auth(parentA)).set('X-School-Id', fx.a.school.id)).status).toBe(403);
    expect((await request(t.app).get(api('/school/students'))).status).toBe(401);
  });

  it('the app role without a tenant context sees no students, links or assignments', async () => {
    const pool = appPool();
    for (const table of ['students', 'student_parents', 'student_assignments', 'school_parents', 'parent_accounts']) {
      expect((await pool.query(`select count(*)::int as n from ${table}`)).rows[0], table).toEqual({ n: 0 });
    }
  });
});
