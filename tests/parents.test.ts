// Parents (BP §4.6, §8.3 Parents, §13.3; contract §4, §6): parent_accounts is a GLOBAL identity by
// E.164 phone — registering the same number in two schools reuses one account while each school
// keeps its own name/e-mail/relation; list/filters/CSV, phone corrections (only for parents of this
// school alone), deactivation/deletion/reset-access revoke the parent's sessions, links with one
// primary per child, and isolation (B's admin gets 404 for A's parents; ids never cross schools).
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { buildApp, loginParent, loginSchoolAdmin, passwordHash, type TestApp } from './helpers/authApp.js';

let t: TestApp;
let fx: f.TwoSchoolFixture;
let adminA: string;
let adminB: string;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const api = (path: string) => `/api/v1${path}`;
const createParent = (token: string, body: Record<string, unknown>) => request(t.app).post(api('/school/parents')).set(auth(token)).send(body);
const link = (studentId: string, body: Record<string, unknown>, token = adminA) => request(t.app).post(api(`/school/students/${studentId}/parents`)).set(auth(token)).send(body);
const openSessions = async (accountId: string) =>
  (await ownerQuery<{ n: number }>("select count(*)::int as n from sessions where owner_type = 'parent_account' and owner_id = $1 and revoked_at is null", [accountId])).rows[0]!.n;
/** Parent OTP sign-in that ignores earlier codes of the same number (fresh KV + no pending code). */
async function signIn(phone: string) {
  await ownerQuery('delete from otp_codes where phone = $1', [phone]);
  return loginParent(buildApp(), phone);
}
const accountOf = async (phone: string) => (await ownerQuery<{ id: string }>('select id from parent_accounts where phone = $1', [phone])).rows;

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  fx = await f.twoSchoolFixture();
  await ownerQuery('update users set password_hash = $1 where id = any ($2)', [await passwordHash(), [fx.a.admin.id, fx.b.admin.id]]);
  adminA = (await loginSchoolAdmin(t.app, String(fx.a.admin.email))).accessToken;
  adminB = (await loginSchoolAdmin(t.app, String(fx.b.admin.email))).accessToken;
});
afterAll(closeDb);

describe('global identity', () => {
  it('reuses one parent account for the same phone in two schools, with per-school details', async () => {
    const a = await createParent(adminA, { phone: '98450 77001', fullName: 'Meera Iyer', email: 'Meera@Example.com', relation: 'mother', school_id: fx.b.school.id });
    expect(a.status).toBe(201);
    expect(a.body.data).toMatchObject({ phone: '+919845077001', fullName: 'Meera Iyer', email: 'meera@example.com', relation: 'mother', childCount: 0, hasSignedIn: false });
    const b = await createParent(adminB, { phone: '+91 98450-77001', fullName: 'Meera R. Iyer', relation: 'guardian' });
    expect(b.status).toBe(201);
    expect(b.body.data).toMatchObject({ phone: '+919845077001', fullName: 'Meera R. Iyer', relation: 'guardian' });
    expect(Object.keys(b.body.data)).not.toContain('accountReused');
    expect(b.body.data.id).not.toBe(a.body.data.id);
    const accounts = await accountOf('+919845077001');
    expect(accounts).toHaveLength(1);
    const rows = await ownerQuery<{ school_id: string; full_name: string }>('select school_id, full_name from school_parents where parent_account_id = $1 order by full_name', [accounts[0]!.id]);
    expect(rows.rows).toEqual([
      { school_id: fx.a.school.id, full_name: 'Meera Iyer' },
      { school_id: fx.b.school.id, full_name: 'Meera R. Iyer' },
    ]);
    // Linked to a child in each school → one sign-in shows both schools.
    await link(fx.a.otherStudent.id, { parentId: a.body.data.id }).expect(200);
    await link(fx.b.otherStudent.id, { parentId: b.body.data.id }, adminB).expect(200);
    const token = (await signIn('+919845077001')).accessToken;
    const me = await request(t.app).get(api('/auth/me')).set(auth(token));
    expect(JSON.stringify(me.body.data)).toContain(fx.a.school.id);
    expect(JSON.stringify(me.body.data)).toContain(fx.b.school.id);
    // hasSignedIn is per school (migration 854): set once the parent has used this school's children.
    expect((await request(t.app).get(api(`/school/parents/${a.body.data.id}`)).set(auth(adminA))).body.data.hasSignedIn).toBe(false);
    await request(t.app).get(api('/parent/children')).set(auth(token)).expect(200);
    expect((await request(t.app).get(api(`/school/parents/${a.body.data.id}`)).set(auth(adminA))).body.data.hasSignedIn).toBe(true);
  });

  it('refuses a second registration in the same school and invalid numbers', async () => {
    const dup = await createParent(adminA, { phone: '+919845077001', fullName: 'Again' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE');
    const bad = await createParent(adminA, { phone: '12345', fullName: 'Bad Number' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details[0]).toMatchObject({ path: 'phone' });
    expect((await createParent(adminA, { phone: '+919845077009', fullName: 'X', email: 'not-an-email' })).status).toBe(400);
  });
});

describe('list and detail', () => {
  it('lists the school parents with their children and filters', async () => {
    const res = await request(t.app).get(api('/school/parents?sort=fullName')).set(auth(adminA));
    expect(res.status).toBe(200);
    expect(res.body.data.map((p: { fullName: string }) => p.fullName)).toEqual(['Meera Iyer', 'Priya Sharma', 'Vikram Mehta']);
    const priya = res.body.data[1];
    expect(priya).toMatchObject({ id: fx.a.schoolParent.id, phone: fx.a.parent.phone, childCount: 1 });
    expect(priya.children).toEqual([{ studentId: fx.a.student.id, fullName: 'Aarav Sharma', admissionNo: 'ADM-001', className: '5', section: 'A', relation: 'mother', isPrimary: true }]);
    expect(JSON.stringify(res.body)).not.toContain(fx.b.schoolParent.id);
    const byPhone = await request(t.app).get(api('/school/parents')).query({ q: '98450 77001' }).set(auth(adminA));
    expect(byPhone.body.data.map((p: { fullName: string }) => p.fullName)).toEqual(['Meera Iyer']);
    const byStudent = await request(t.app).get(api('/school/parents')).query({ studentId: fx.a.student.id, sort: 'fullName' }).set(auth(adminA));
    expect(byStudent.body.data.map((p: { fullName: string }) => p.fullName)).toEqual(['Priya Sharma', 'Vikram Mehta']);
    await createParent(adminA, { phone: '+919845077002', fullName: 'Unlinked Parent' }).expect(201);
    const unlinked = await request(t.app).get(api('/school/parents?hasChildren=false')).set(auth(adminA));
    expect(unlinked.body.data.map((p: { fullName: string }) => p.fullName)).toEqual(['Unlinked Parent']);
    const csv = await request(t.app).get(api('/school/parents?format=csv&sort=fullName')).set(auth(adminA));
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('Aarav Sharma (ADM-001)');
  });
});

describe('update and phone corrections', () => {
  it('updates the school details and corrects the phone of a parent of this school alone', async () => {
    const p = await createParent(adminA, { phone: '+919845077003', fullName: 'Typo Name' });
    const res = await request(t.app).patch(api(`/school/parents/${p.body.data.id}`)).set(auth(adminA)).send({ fullName: 'Fixed Name', phone: '9845077004', alternatePhone: '9845077005' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ fullName: 'Fixed Name', phone: '+919845077004', alternatePhone: '+919845077005' });
    expect(await accountOf('+919845077003')).toEqual([]);
    const audit = await ownerQuery<{ old_values: unknown; new_values: unknown }>('select old_values, new_values from audit_logs where action = $1 and entity_id = $2', ['parent.update', p.body.data.id]);
    expect(audit.rows[0]).toMatchObject({ old_values: { phone: '+919845077003', fullName: 'Typo Name' }, new_values: { phone: '+919845077004', fullName: 'Fixed Name' } });
  });

  it('refuses phone changes of a parent shared with another school, and numbers in use', async () => {
    const vikram = (await ownerQuery<{ id: string }>('select id from school_parents where school_id = $1 and parent_account_id = $2', [fx.a.school.id, fx.sharedParent.id])).rows[0]!;
    const shared = await request(t.app).patch(api(`/school/parents/${vikram.id}`)).set(auth(adminA)).send({ phone: '+919845077006' });
    expect(shared.status).toBe(409);
    expect(shared.body.error).toMatchObject({ code: 'INVALID_STATE', details: { reason: 'SHARED_PARENT' } });
    const p = await createParent(adminA, { phone: '+919845077007', fullName: 'Taken Test' });
    const taken = await request(t.app).patch(api(`/school/parents/${p.body.data.id}`)).set(auth(adminA)).send({ phone: String(fx.b.parent.phone) });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('DUPLICATE');
  });

  it("returns 404 for A's parents with B's token", async () => {
    const id = fx.a.schoolParent.id;
    expect((await request(t.app).get(api(`/school/parents/${id}`)).set(auth(adminB))).status).toBe(404);
    expect((await request(t.app).patch(api(`/school/parents/${id}`)).set(auth(adminB)).send({ fullName: 'Hijack' })).status).toBe(404);
    expect((await request(t.app).delete(api(`/school/parents/${id}`)).set(auth(adminB))).status).toBe(404);
    expect((await request(t.app).post(api(`/school/parents/${id}/reset-access`)).set(auth(adminB)).send({})).status).toBe(404);
    expect((await link(fx.b.student.id, { parentId: id }, adminB)).status).toBe(404);
    expect((await ownerQuery('select full_name, deleted_at from school_parents where id = $1', [id])).rows).toEqual([{ full_name: 'Priya Sharma', deleted_at: null }]);
  });
});

describe('access: deactivation, deletion, reset', () => {
  it('reset-access revokes every session of the parent and clears a sign-in lock', async () => {
    const session = await signIn(String(fx.a.parent.phone));
    expect(await openSessions(fx.a.parent.id)).toBeGreaterThan(0);
    await ownerQuery("update parent_accounts set failed_login_count = 5, locked_until = now() + interval '10 minutes' where id = $1", [fx.a.parent.id]);
    const res = await request(t.app).post(api(`/school/parents/${fx.a.schoolParent.id}/reset-access`)).set(auth(adminA)).send({ reason: 'Lost phone' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ parentId: fx.a.schoolParent.id, otpReady: true, blockers: [], unlocked: true });
    expect(res.body.data.revokedSessions).toBeGreaterThan(0);
    expect(await openSessions(fx.a.parent.id)).toBe(0);
    expect((await ownerQuery('select failed_login_count, locked_until from parent_accounts where id = $1', [fx.a.parent.id])).rows).toEqual([{ failed_login_count: 0, locked_until: null }]);
    expect((await request(t.app).get(api('/auth/me')).set(auth(session.accessToken))).status).toBe(401);
    const audit = await ownerQuery<{ new_values: Record<string, unknown> }>('select new_values from audit_logs where action = $1 and entity_id = $2', ['parent.reset_access', fx.a.schoolParent.id]);
    expect(audit.rows[0]!.new_values).toMatchObject({ reason: 'Lost phone', unlocked: true, signInReady: true });
    // The parent signs in again with an OTP.
    expect((await signIn(String(fx.a.parent.phone))).accessToken).toBeTruthy();
  });

  it('reports blockers when the parent cannot sign in by OTP', async () => {
    const p = await createParent(adminA, { phone: '+919845077008', fullName: 'No Children' });
    const res = await request(t.app).post(api(`/school/parents/${p.body.data.id}/reset-access`)).set(auth(adminA)).send({});
    expect(res.body.data).toMatchObject({ otpReady: false, blockers: ['NO_ACTIVE_CHILD'], revokedSessions: 0, unlocked: false });
  });

  it('deactivating a parent revokes its sessions; the other school still works for a shared parent', async () => {
    const vikramA = (await ownerQuery<{ id: string }>('select id from school_parents where school_id = $1 and parent_account_id = $2', [fx.a.school.id, fx.sharedParent.id])).rows[0]!;
    const before = await signIn(String(fx.sharedParent.phone));
    const res = await request(t.app).patch(api(`/school/parents/${vikramA.id}`)).set(auth(adminA)).send({ isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.data.isActive).toBe(false);
    expect(await openSessions(fx.sharedParent.id)).toBe(0);
    expect((await request(t.app).get(api('/auth/me')).set(auth(before.accessToken))).status).toBe(401);
    const again = (await signIn(String(fx.sharedParent.phone))).accessToken;
    const me = await request(t.app).get(api('/auth/me')).set(auth(again));
    expect(JSON.stringify(me.body.data)).toContain(fx.b.school.id);
    expect(JSON.stringify(me.body.data)).not.toContain(fx.a.school.id);
    await request(t.app).patch(api(`/school/parents/${vikramA.id}`)).set(auth(adminA)).send({ isActive: true }).expect(200);
  });

  it('deleting removes the links and sessions; registering the number again restores the parent', async () => {
    const p = await createParent(adminA, { phone: '+919845077010', fullName: 'Temp Parent' });
    await link(fx.a.otherStudent.id, { parentId: p.body.data.id }).expect(200);
    await signIn('+919845077010');
    const account = (await accountOf('+919845077010'))[0]!.id;
    const res = await request(t.app).delete(api(`/school/parents/${p.body.data.id}`)).set(auth(adminA));
    expect(res.status).toBe(200);
    expect(await openSessions(account)).toBe(0);
    expect((await ownerQuery('select count(*)::int as n from student_parents where parent_account_id = $1', [account])).rows[0]).toEqual({ n: 0 });
    expect((await request(t.app).get(api(`/school/parents/${p.body.data.id}`)).set(auth(adminA))).status).toBe(404);
    const back = await createParent(adminA, { phone: '+919845077010', fullName: 'Temp Parent Again' });
    expect(back.status).toBe(201);
    expect(back.body.data).toMatchObject({ id: p.body.data.id, fullName: 'Temp Parent Again', isActive: true, childCount: 0 });
    expect((await ownerQuery('select 1 from audit_logs where action = $1 and entity_id = $2', ['parent.restore', p.body.data.id])).rowCount).toBe(1);
  });
});

describe('links', () => {
  it('links existing or new (create-or-reuse) parents and keeps one primary per child', async () => {
    const student = await f.student(fx.a.school.id, { full_name: 'Link Student', admission_no: 'ADM-LINK' });
    const first = await link(student.id, { parent: { phone: '9845077011', fullName: 'First Parent', relation: 'father' } });
    expect(first.status).toBe(200);
    expect(first.body.data).toEqual([expect.objectContaining({ fullName: 'First Parent', phone: '+919845077011', relation: 'father', isPrimary: true })]);
    const second = await link(student.id, { parentId: fx.a.schoolParent.id, relation: 'aunt', isPrimary: true });
    expect(second.body.data.map((p: { fullName: string; isPrimary: boolean; relation: string }) => [p.fullName, p.isPrimary, p.relation])).toEqual([
      ['Priya Sharma', true, 'aunt'],
      ['First Parent', false, 'father'],
    ]);
    // The same phone again reuses the school's parent (no duplicate) and only updates the link.
    const reuse = await link(student.id, { parent: { phone: '+919845077011', fullName: 'Ignored Name' } });
    expect(reuse.body.data).toHaveLength(2);
    expect((await ownerQuery('select count(*)::int as n from school_parents where school_id = $1 and full_name = $2', [fx.a.school.id, 'First Parent'])).rows[0]).toEqual({ n: 1 });
    // Unlinking the primary promotes the remaining parent.
    const un = await request(t.app).delete(api(`/school/students/${student.id}/parents/${fx.a.schoolParent.id}`)).set(auth(adminA));
    expect(un.status).toBe(200);
    expect(un.body.data.map((p: { fullName: string; isPrimary: boolean }) => [p.fullName, p.isPrimary])).toEqual([['First Parent', true]]);
    const again = await link(student.id, { action: 'unlink', parentId: fx.a.schoolParent.id });
    expect(again.status).toBe(404);
    expect((await link(student.id, { parentId: fx.b.schoolParent.id })).status).toBe(404);
    expect((await link(student.id, {})).status).toBe(400);
    expect((await ownerQuery('select count(*)::int as n from audit_logs where entity_id = $1 and action like $2', [student.id, 'student.parent_%'])).rows[0]).toEqual({ n: 4 });
  });
});
