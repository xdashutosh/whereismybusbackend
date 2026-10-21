// Data principal requests (BP §16 "deletion/export on request"; privacy module, migration 901):
// per-person export for school admins (documented JSON format, audited, tenant isolated) and
// irreversible erasure of a student or a parent within the school (PII anonymised, photos removed
// from storage, aggregates and the audit trail kept, global parent identity only when not shared).
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PRIVACY_EXPORT_FORMAT } from '@wimb/shared';
import { storage } from '../src/shared/storage.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { buildApp, loginParent, loginSchoolAdmin, loginStaff, schoolAdmin, staffUser, type TestApp } from './helpers/authApp.js';

let t: TestApp;
let fx: f.TwoSchoolFixture;
let adminA: string;
let adminB: string;
let photo: f.TenantRow;

const api = (p: string) => `/api/v1${p}`;
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const exportOf = (token: string, kind: 'students' | 'parents', id: string) => request(t.app).get(api(`/school/privacy/${kind}/${id}/export`)).set(bearer(token));
const erase = (token: string, kind: 'students' | 'parents', id: string, body: Record<string, unknown> = { confirm: 'ERASE' }) =>
  request(t.app).post(api(`/school/privacy/${kind}/${id}/erase`)).set(bearer(token)).send(body);
const objectExists = async (key: string) => (await storage.headObject(key)) !== null;

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  fx = await f.twoSchoolFixture();
  adminA = (await loginSchoolAdmin(t.app, String((await schoolAdmin(fx.a.school.id)).email))).accessToken;
  adminB = (await loginSchoolAdmin(t.app, String((await schoolAdmin(fx.b.school.id)).email))).accessToken;
  // A stored student photo (object + registry row) for the linked child of school A.
  photo = await f.file(fx.a.school.id, { category: 'student_photo', entity_type: 'student', entity_id: fx.a.student.id, original_name: 'aarav.jpg' });
  await storage.putObject({ key: String(photo.key), body: Buffer.from('jpeg'), contentType: 'image/jpeg' });
  await ownerQuery("update students set photo_file_id = $1, notes = 'Allergic to peanuts', roll_no = '12' where id = $2", [photo.id, fx.a.student.id]);
  // The fixture's consent record of the linked parent, with network details.
  await ownerQuery(
    "update parent_consents set app_version = '1.2.0', ip = '203.0.113.7', user_agent = 'ParentApp/1.2.0' where school_id = $1 and parent_account_id = $2",
    [fx.a.school.id, fx.a.parent.id],
  );
  await ownerQuery('update parent_notifications set title = $1 where id = $2', ['Aarav Sharma: bus arriving', fx.a.parentNotification.id]);
  await ownerQuery(`update notification_events set payload = '{"studentName": "Aarav Sharma"}' where id = $1`, [fx.a.notificationEvent.id]);
});
afterAll(closeDb);

describe('GET /school/privacy/students/:id/export', () => {
  it('returns everything the school holds about the student in the documented format', async () => {
    const res = await exportOf(adminA, 'students', fx.a.student.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const doc = res.body.data;
    expect(doc).toMatchObject({ format: PRIVACY_EXPORT_FORMAT, formatVersion: 1, subject: { type: 'student', id: fx.a.student.id }, school: { id: fx.a.school.id } });
    expect(Object.keys(doc.data).sort()).toEqual(['assignments', 'consentRecords', 'files', 'inbox', 'notificationEvents', 'notificationPreferences', 'parents', 'profile', 'trips']);
    expect(doc.data.profile).toMatchObject({ fullName: 'Aarav Sharma', admissionNo: 'ADM-001', notes: 'Allergic to peanuts', rollNo: '12', photoFileId: photo.id, erasedAt: null });
    expect(doc.data.files).toEqual([expect.objectContaining({ id: photo.id, category: 'student_photo', originalName: 'aarav.jpg', status: 'uploaded' })]);
    expect(doc.data.parents.map((p: { parentId: string }) => p.parentId)).toContain(fx.a.schoolParent.id);
    expect(doc.data.parents.find((p: { parentId: string }) => p.parentId === fx.a.schoolParent.id)).toMatchObject({ fullName: 'Priya Sharma', phone: fx.a.parent.phone, isPrimary: true });
    expect(doc.data.assignments).toEqual([expect.objectContaining({ id: fx.a.assignment.id, direction: 'morning', bus: expect.objectContaining({ code: 'R1' }), stop: expect.objectContaining({ id: fx.a.stop1.id, name: 'Stop 1' }) })]);
    expect(doc.data.notificationPreferences).toHaveLength(1);
    expect(doc.data.inbox).toEqual([expect.objectContaining({ id: fx.a.parentNotification.id, parentId: fx.a.schoolParent.id, title: 'Aarav Sharma: bus arriving' })]);
    expect(doc.data.notificationEvents).toEqual([expect.objectContaining({ id: fx.a.notificationEvent.id, eventType: 'trip_started' })]);
    // Consent records of the linked parents — without the network details (those belong to the parent export).
    expect(doc.data.consentRecords).toEqual([{ parentId: fx.a.schoolParent.id, version: '1', acceptedAt: expect.any(String), privacyUrl: null, termsUrl: null, appName: 'parent_app', appVersion: '1.2.0' }]);
    // Trips of the child's bus/direction with the stop event at the child's stop; never the unrelated R2 trip or the non-school trip.
    expect(doc.data.trips).toMatchObject({ total: 1, truncated: false });
    expect(doc.data.trips.items).toEqual([expect.objectContaining({ tripId: fx.a.trip.id, busCode: 'R1', stopEvent: expect.objectContaining({ stopName: 'Stop 1', arrivedAt: expect.any(String) }) })]);
    // The global parent account id never leaves the server; no other school's ids appear.
    const text = JSON.stringify(doc);
    expect(text).not.toContain(fx.a.parent.id);
    expect(text).not.toContain(fx.sharedParent.id);
    expect(text).not.toContain(fx.b.school.id);
    expect(text).not.toContain(fx.b.student.id);
    expect(doc.notes.length).toBeGreaterThan(0);
  });

  it('is audited with counts only', async () => {
    const rows = (await ownerQuery("select school_id, entity_type, entity_id, new_values from audit_logs where action = 'privacy.export' and entity_id = $1", [fx.a.student.id])).rows;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toMatchObject({ school_id: fx.a.school.id, entity_type: 'student', new_values: { sections: { profile: 1, files: 1, trips: 1 } } });
    expect(JSON.stringify(rows[0])).not.toContain('Aarav');
  });

  it('answers 404 for another school\'s student and 403 for non-admins', async () => {
    expect((await exportOf(adminB, 'students', fx.a.student.id)).status).toBe(404);
    expect((await exportOf(adminA, 'students', '00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await exportOf(adminA, 'students', 'not-a-uuid')).status).toBe(400);
    const driver = await staffUser(fx.a.school.id, 'driver');
    const code = (await ownerQuery<{ code: string }>('select code from schools where id = $1', [fx.a.school.id])).rows[0]!.code;
    const driverTok = (await loginStaff(t.app, code, String(driver.phone))).accessToken;
    expect((await exportOf(driverTok, 'students', fx.a.student.id)).status).toBe(403);
    const parent = await loginParent(t, String(fx.a.parent.phone));
    expect((await request(t.app).get(api(`/school/privacy/students/${fx.a.student.id}/export`)).set({ ...bearer(parent.accessToken), 'X-School-Id': fx.a.school.id })).status).toBe(403);
    expect((await ownerQuery<{ n: number }>("select count(*)::int as n from audit_logs where action = 'privacy.export' and school_id = $1", [fx.b.school.id])).rows[0]!.n).toBe(0);
  });
});

describe('GET /school/privacy/parents/:id/export', () => {
  it('returns the school\'s parent record, children, inbox, preferences, consent state and records', async () => {
    const res = await exportOf(adminA, 'parents', fx.a.schoolParent.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const d = res.body.data.data;
    expect(res.body.data.subject).toEqual({ type: 'parent', id: fx.a.schoolParent.id });
    expect(d.profile).toMatchObject({ id: fx.a.schoolParent.id, fullName: 'Priya Sharma', phone: fx.a.parent.phone, relation: 'mother', erasedAt: null });
    expect(d.children).toEqual([expect.objectContaining({ studentId: fx.a.student.id, fullName: 'Aarav Sharma' })]);
    expect(d.assignments).toHaveLength(1);
    expect(d.inbox).toHaveLength(1);
    expect(d.notificationPreferences).toHaveLength(1);
    expect(d.consent).toEqual({ requiredVersion: '1', acceptedVersion: '1', acceptedAt: expect.any(String), consentRequired: false });
    expect(d.consentRecords).toEqual([expect.objectContaining({ version: '1', ip: '203.0.113.7', userAgent: 'ParentApp/1.2.0', redactedAt: null })]);
    expect(d.trips.total).toBe(1);
    expect(JSON.stringify(res.body)).not.toContain(fx.a.parent.id);
  });

  it('the shared parent exported by school B shows only school B\'s data', async () => {
    const spB = (await ownerQuery<{ id: string }>('select id from school_parents where school_id = $1 and parent_account_id = $2', [fx.b.school.id, fx.sharedParent.id])).rows[0]!.id;
    const res = await exportOf(adminB, 'parents', spB);
    expect(res.status).toBe(200);
    expect(res.body.data.data.children.map((c: { studentId: string }) => c.studentId)).toEqual([fx.b.student.id]);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(fx.a.school.id);
    expect(text).not.toContain(fx.a.student.id);
    // School A's id of the same parent is unknown to school B.
    const spA = (await ownerQuery<{ id: string }>('select id from school_parents where school_id = $1 and parent_account_id = $2', [fx.a.school.id, fx.sharedParent.id])).rows[0]!.id;
    expect((await exportOf(adminB, 'parents', spA)).status).toBe(404);
  });
});

describe('POST /school/privacy/students/:id/erase', () => {
  it('requires the explicit confirmation', async () => {
    expect((await erase(adminA, 'students', fx.a.student.id, {})).status).toBe(400);
    expect((await erase(adminA, 'students', fx.a.student.id, { confirm: 'yes' })).status).toBe(400);
    expect((await erase(adminB, 'students', fx.a.student.id)).status).toBe(404);
  });

  it('anonymises the student, removes links/inbox/photo, keeps trips and aggregates', async () => {
    expect(await objectExists(String(photo.key))).toBe(true);
    const res = await erase(adminA, 'students', fx.a.student.id, { confirm: 'ERASE', reason: 'Parent request #42' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toEqual({ subjectType: 'student', id: fx.a.student.id, erasedAt: expect.any(String), filesDeleted: 1 });

    const s = (await ownerQuery('select full_name, admission_no, class_name, section, roll_no, notes, photo_file_id, is_active, deleted_at, erased_at from students where id = $1', [fx.a.student.id])).rows[0]!;
    expect(s).toMatchObject({ full_name: 'Erased student', admission_no: null, class_name: null, section: null, roll_no: null, notes: null, photo_file_id: null, is_active: false });
    expect(s.deleted_at).not.toBeNull();
    expect(s.erased_at).not.toBeNull();
    // Photo removed from storage and marked deleted.
    expect(await objectExists(String(photo.key))).toBe(false);
    expect((await ownerQuery('select status, original_name from files where id = $1', [photo.id])).rows[0]).toEqual({ status: 'deleted', original_name: null });
    // Links, preferences and inbox rows about the child are gone; notification events keep no payload.
    expect((await ownerQuery<{ n: number }>('select count(*)::int as n from student_parents where student_id = $1', [fx.a.student.id])).rows[0]!.n).toBe(0);
    expect((await ownerQuery<{ n: number }>('select count(*)::int as n from notification_preferences where student_id = $1', [fx.a.student.id])).rows[0]!.n).toBe(0);
    expect((await ownerQuery<{ n: number }>('select count(*)::int as n from parent_notifications where student_id = $1', [fx.a.student.id])).rows[0]!.n).toBe(0);
    expect((await ownerQuery('select payload from notification_events where id = $1', [fx.a.notificationEvent.id])).rows[0]).toEqual({ payload: {} });
    // Aggregates stay: the trip, its stop event, location points and the (ended) assignment.
    expect((await ownerQuery<{ n: number }>('select count(*)::int as n from trip_stop_events where trip_id = $1', [fx.a.trip.id])).rows[0]!.n).toBe(1);
    expect((await ownerQuery<{ n: number }>('select count(*)::int as n from location_points where trip_id = $1', [fx.a.trip.id])).rows[0]!.n).toBe(3);
    const a = (await ownerQuery<{ valid_to: string | null }>('select valid_to from student_assignments where id = $1', [fx.a.assignment.id])).rows[0]!;
    expect(a.valid_to).not.toBeNull();
    // Audited without personal data; earlier audit rows are untouched.
    const audit = (await ownerQuery("select actor_type, new_values from audit_logs where action = 'privacy.erase' and entity_id = $1", [fx.a.student.id])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.new_values).toMatchObject({ filesDeleted: 1, parentLinksRemoved: 2, notificationsDeleted: 1, reason: 'Parent request #42' });
    expect(JSON.stringify(audit[0])).not.toMatch(/Aarav|ADM-001|peanut/);
    // The same-named child of school B is untouched.
    expect((await ownerQuery('select full_name, erased_at from students where id = $1', [fx.b.student.id])).rows[0]).toEqual({ full_name: 'Aarav Sharma', erased_at: null });
  });

  it('is irreversible and one-shot: a second erase is refused, the export shows the anonymised record', async () => {
    const again = await erase(adminA, 'students', fx.a.student.id);
    expect([again.status, again.body.error.code]).toEqual([409, 'INVALID_STATE']);
    const doc = (await exportOf(adminA, 'students', fx.a.student.id)).body.data.data;
    expect(doc.profile).toMatchObject({ fullName: 'Erased student', admissionNo: null, notes: null });
    expect(doc.parents).toEqual([]);
    expect(doc.inbox).toEqual([]);
    expect(JSON.stringify(doc)).not.toMatch(/Aarav|peanut/);
  });
});

describe('POST /school/privacy/parents/:id/erase', () => {
  it('a parent used by this school only: school record and global identity anonymised, sessions ended', async () => {
    // A dedicated parent of school A with a session and a device.
    const acc = await f.parentAccount({ display_name: 'Meera Iyer' });
    const sp = await f.schoolParent(fx.a.school.id, acc.id, { full_name: 'Meera Iyer', email: 'meera@example.com', alternate_phone: '+919845011111' });
    const kid = await f.student(fx.a.school.id, { full_name: 'Kabir Iyer' });
    await f.studentParent(fx.a.school.id, kid.id, acc.id);
    await f.notificationPreference(fx.a.school.id, acc.id, kid.id);
    await f.parentNotification(fx.a.school.id, acc.id, { student_id: kid.id });
    await ownerQuery("insert into parent_consents (school_id, parent_account_id, version, ip, user_agent) values ($1, $2, '1', '198.51.100.9', 'ParentApp/1.0')", [fx.a.school.id, acc.id]);
    const login = await loginParent(t, String(acc.phone));
    await request(t.app).post(api('/parent/devices')).set(bearer(login.accessToken)).send({ deviceId: 'meera-phone-1', platform: 'android', fcmToken: 'fcm-token-meera-0001' });

    const res = await erase(adminA, 'parents', sp.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toEqual({ subjectType: 'parent', id: sp.id, erasedAt: expect.any(String), filesDeleted: 0 });

    expect((await ownerQuery('select full_name, email, relation, alternate_phone, is_active, erased_at is not null as erased, deleted_at is not null as deleted from school_parents where id = $1', [sp.id])).rows[0]).toEqual({
      full_name: 'Erased parent', email: null, relation: null, alternate_phone: null, is_active: false, erased: true, deleted: true,
    });
    const pa = (await ownerQuery<{ phone: string; display_name: string | null; password_hash: string | null; is_active: boolean }>('select phone, display_name, password_hash, is_active from parent_accounts where id = $1', [acc.id])).rows[0]!;
    expect(pa.phone).toMatch(/^\+999\d{11}$/);
    expect(pa).toMatchObject({ display_name: null, password_hash: null, is_active: false });
    expect((await ownerQuery<{ n: number }>('select count(*)::int as n from student_parents where parent_account_id = $1', [acc.id])).rows[0]!.n).toBe(0);
    expect((await ownerQuery<{ n: number }>('select count(*)::int as n from parent_notifications where parent_account_id = $1', [acc.id])).rows[0]!.n).toBe(0);
    expect((await ownerQuery<{ n: number }>('select count(*)::int as n from notification_preferences where parent_account_id = $1', [acc.id])).rows[0]!.n).toBe(0);
    expect((await ownerQuery("select ip, user_agent, redacted_at is not null as redacted, version from parent_consents where parent_account_id = $1", [acc.id])).rows[0]).toEqual({ ip: null, user_agent: null, redacted: true, version: '1' });
    expect((await ownerQuery<{ n: number }>("select count(*)::int as n from devices where owner_id = $1 and fcm_token is not null", [acc.id])).rows[0]!.n).toBe(0);
    // Sessions are revoked: the access token and the refresh token stop working.
    expect((await request(t.app).get(api('/auth/me')).set(bearer(login.accessToken))).status).toBe(401);
    expect((await request(t.app).post(api('/auth/refresh')).send({ refreshToken: login.refreshToken })).status).toBe(401);
    // The old phone has no account and no pending sign-in code any more.
    expect((await ownerQuery<{ n: number }>('select count(*)::int as n from parent_accounts where phone = $1', [acc.phone])).rows[0]!.n).toBe(0);
    expect((await ownerQuery<{ n: number }>('select count(*)::int as n from otp_codes where phone = $1', [acc.phone])).rows[0]!.n).toBe(0);
    // Audit without personal data and without revealing whether the identity was shared.
    const audit = (await ownerQuery("select new_values from audit_logs where action = 'privacy.erase' and entity_id = $1", [sp.id])).rows[0]!;
    expect(audit.new_values).toMatchObject({ parentLinksRemoved: 1, notificationsDeleted: 1, consentsRedacted: 1, preferencesRemoved: 1 });
    expect(JSON.stringify(audit)).not.toMatch(/Meera|meera@|anonymised/);
    // The school may register the same number again: a new identity.
    const again = await request(t.app).post(api('/school/parents')).set(bearer(adminA)).send({ fullName: 'Meera Iyer', phone: acc.phone });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect((await ownerQuery<{ n: number }>('select count(*)::int as n from parent_accounts where phone = $1', [acc.phone])).rows[0]!.n).toBe(1);
    expect((await ownerQuery<{ id: string }>('select id from parent_accounts where phone = $1', [acc.phone])).rows[0]!.id).not.toBe(acc.id);
  });

  it('a parent shared with another school: only this school\'s data is erased, the other school is unaffected', async () => {
    const spA = (await ownerQuery<{ id: string }>('select id from school_parents where school_id = $1 and parent_account_id = $2', [fx.a.school.id, fx.sharedParent.id])).rows[0]!.id;
    const before = (await ownerQuery<{ phone: string }>('select phone from parent_accounts where id = $1', [fx.sharedParent.id])).rows[0]!.phone;
    const shared = await loginParent(t, before);
    const res = await erase(adminA, 'parents', spA);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data).sort()).toEqual(['erasedAt', 'filesDeleted', 'id', 'subjectType']); // same shape: no "shared" oracle
    // Global identity, school B's record and links intact; the parent keeps using school B.
    expect((await ownerQuery('select phone, is_active, display_name from parent_accounts where id = $1', [fx.sharedParent.id])).rows[0]).toEqual({ phone: before, is_active: true, display_name: 'Vikram Mehta' });
    expect((await ownerQuery('select full_name, erased_at from school_parents where school_id = $1 and parent_account_id = $2', [fx.b.school.id, fx.sharedParent.id])).rows[0]).toEqual({ full_name: 'Vikram Mehta', erased_at: null });
    expect((await ownerQuery<{ n: number }>('select count(*)::int as n from student_parents where school_id = $1 and parent_account_id = $2', [fx.b.school.id, fx.sharedParent.id])).rows[0]!.n).toBe(1);
    expect((await request(t.app).get(api('/parent/children')).set(bearer(shared.accessToken))).status).toBe(200);
    const children = (await request(t.app).get(api('/auth/me')).set(bearer(shared.accessToken))).body.data.schools.map((s: { school: { id: string } }) => s.school.id);
    expect(children).toEqual([fx.b.school.id]);
    // School A's context is closed for the parent.
    expect((await request(t.app).get(api(`/parent/children/${fx.a.student.id}/bus`)).set({ ...bearer(shared.accessToken), 'X-School-Id': fx.a.school.id })).status).toBe(403);
    // A second erase in A is refused; B can still erase its own record later.
    expect((await erase(adminA, 'parents', spA)).status).toBe(409);
  });

  it('cannot reach another school\'s parent record', async () => {
    const spB = (await ownerQuery<{ id: string }>('select id from school_parents where school_id = $1 and parent_account_id = $2', [fx.b.school.id, fx.b.parent.id])).rows[0]!.id;
    expect((await erase(adminA, 'parents', spB)).status).toBe(404);
    expect((await ownerQuery('select full_name, erased_at from school_parents where id = $1', [spB])).rows[0]).toEqual({ full_name: 'Priya Sharma', erased_at: null });
  });

  it('the global anonymisation function refuses a parent this school has not erased', async () => {
    const { withTenant } = await import('../src/db/tenant.js');
    await expect(
      withTenant({ schoolId: fx.b.school.id, actorId: fx.b.admin.id, role: 'school_admin' }, (tx) => tx.query('select * from school_erase_parent_account($1)', [fx.b.parent.id])),
    ).rejects.toMatchObject({ code: 'P0002' });
    await expect(
      withTenant({ schoolId: fx.b.school.id, actorId: fx.b.parent.id, role: 'parent' }, (tx) => tx.query('select * from school_erase_parent_account($1)', [fx.b.parent.id])),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
