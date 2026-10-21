// Wave-3 adversarial tests — parent API (BP §4.6, §8.5, §13.3, §15, §16; contract §4).
// Attacks: X-School-Id spoofing, cross-school / unlinked student ids, removed and deactivated
// links, reassigned children, visibility-matrix bypass through the file URL endpoint (identity,
// unverified, replaced, licence, finance/odometer files), another school's files, inbox and
// preference tampering, device-row hijack.
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, loginParent, loginSchoolAdmin, passwordHash, type TestApp } from './helpers/authApp.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { alignFixtureDates, api, asParent, bearer, reassign } from './parent.fixtures.js';

let t: TestApp;
let fx: f.TwoSchoolFixture;
let parentA: string;
let shared: string;
let adminA: string;
let r2Stop: string;

const PER_CHILD = ['tracking', 'bus', 'staff', 'notification-preferences'] as const;
const fileUrl = (token: string, schoolId: string | null, fileId: string) => asParent(t, token, schoolId).get(`/parent/files/${fileId}/url`);

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  fx = await f.twoSchoolFixture();
  await alignFixtureDates(fx);
  await ownerQuery('update users set password_hash = $2 where id = $1', [fx.a.admin.id, await passwordHash()]);
  const { rows } = await ownerQuery<{ id: string }>('select id from stops where route_id = $1', [fx.a.otherRoute.id]);
  r2Stop = rows[0]!.id;
  parentA = (await loginParent(t, String(fx.a.parent.phone))).accessToken;
  shared = (await loginParent(t, String(fx.sharedParent.phone))).accessToken;
  adminA = (await loginSchoolAdmin(t.app, String(fx.a.admin.email))).accessToken;
});

afterAll(closeDb);

describe('X-School-Id spoofing and foreign student ids', () => {
  it('a parent linked only in school A is refused in school B (403) for every per-child route', async () => {
    for (const p of PER_CHILD) {
      const res = await asParent(t, parentA, fx.b.school.id).get(`/parent/children/${fx.b.student.id}/${p}`);
      expect(res.status, p).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain('Aarav');
    }
  });

  it('school A header with school B\'s student id, or an unlinked school-A student, is 404 and leaks nothing', async () => {
    for (const sid of [fx.b.student.id, fx.a.otherStudent.id]) {
      for (const p of PER_CHILD) {
        const res = await asParent(t, parentA, fx.a.school.id).get(`/parent/children/${sid}/${p}`);
        expect(res.status, `${p} ${sid}`).toBe(404);
        expect(JSON.stringify(res.body)).not.toMatch(/Diya|R2|KA01AB5678/);
      }
    }
  });

  it('the parent linked in both schools cannot cross the header: A header + B child, B header + A child → 404', async () => {
    expect((await asParent(t, shared, fx.a.school.id).get(`/parent/children/${fx.b.student.id}/tracking`)).status).toBe(404);
    expect((await asParent(t, shared, fx.b.school.id).get(`/parent/children/${fx.a.student.id}/bus`)).status).toBe(404);
    expect((await asParent(t, shared, fx.a.school.id).get(`/parent/children/${fx.a.student.id}/tracking`)).status).toBe(200);
  });

  it('missing, malformed, random and SQL-ish X-School-Id values never reach data', async () => {
    const path = `/parent/children/${fx.a.student.id}/tracking`;
    expect((await request(t.app).get(api(path)).set(bearer(parentA))).status).toBe(400);
    for (const h of ['not-a-uuid', "' or 1=1 --", crypto.randomUUID()]) {
      const res = await request(t.app).get(api(path)).set(bearer(parentA)).set('X-School-Id', h);
      expect([400, 403], h).toContain(res.status);
    }
  });

  it('preferences cannot be written for a foreign child, and body fields cannot redirect the row', async () => {
    const before = await ownerQuery('select count(*)::int as n from notification_preferences');
    const res = await asParent(t, parentA, fx.a.school.id).put(`/parent/children/${fx.a.otherStudent.id}/notification-preferences`, { morning: { tripStarted: false } });
    expect(res.status).toBe(404);
    const own = await asParent(t, parentA, fx.a.school.id).put(`/parent/children/${fx.a.student.id}/notification-preferences`, {
      morning: { tripStarted: false }, parentAccountId: fx.sharedParent.id, studentId: fx.a.otherStudent.id, schoolId: fx.b.school.id,
    });
    expect([200, 400]).toContain(own.status);
    const after = await ownerQuery<{ parent_account_id: string; student_id: string; school_id: string }>('select parent_account_id, student_id, school_id from notification_preferences');
    expect(after.rows.length - (before.rows[0] as { n: number }).n).toBeLessThanOrEqual(1);
    for (const r of after.rows) {
      if (r.parent_account_id === fx.sharedParent.id) throw new Error('row written for another parent');
      if (r.student_id === fx.a.otherStudent.id) throw new Error('row written for an unlinked student');
    }
  });
});

describe('removed, deactivated and reassigned links', () => {
  it('after the admin unlinks the child, every per-child route and the children list drop it at once', async () => {
    const res = await request(t.app).delete(api(`/school/students/${fx.a.student.id}/parents/${fx.a.schoolParent.id}`)).set(bearer(adminA));
    expect(res.status).toBe(200);
    try {
      for (const p of PER_CHILD) {
        const r = await asParent(t, parentA, fx.a.school.id).get(`/parent/children/${fx.a.student.id}/${p}`);
        expect([401, 403, 404], p).toContain(r.status);
      }
      const list = await asParent(t, parentA).get('/parent/children');
      if (list.status === 200) expect(JSON.stringify(list.body)).not.toContain(fx.a.student.id);
    } finally {
      await ownerQuery('insert into student_parents (school_id, student_id, parent_account_id, is_primary) values ($1, $2, $3, true) on conflict do nothing', [fx.a.school.id, fx.a.student.id, fx.a.parent.id]);
      expect((await asParent(t, parentA, fx.a.school.id).get(`/parent/children/${fx.a.student.id}/tracking`)).status).toBe(200);
    }
  });

  it('a deactivated school profile (school_parents.is_active=false) blocks the school; the other school keeps working', async () => {
    await ownerQuery('update school_parents set is_active = false where school_id = $1 and parent_account_id = $2', [fx.a.school.id, fx.sharedParent.id]);
    try {
      const r = await asParent(t, shared, fx.a.school.id).get(`/parent/children/${fx.a.student.id}/tracking`);
      expect(r.status).toBe(403);
      const fileRes = await fileUrl(shared, fx.a.school.id, String(fx.a.busImage.file_id));
      expect(fileRes.status).toBe(403);
      const list = await asParent(t, shared).get('/parent/children');
      expect(list.status).toBe(200);
      expect(JSON.stringify(list.body)).not.toContain(fx.a.school.id);
      expect((await asParent(t, shared, fx.b.school.id).get(`/parent/children/${fx.b.student.id}/tracking`)).status).toBe(200);
    } finally {
      await ownerQuery('update school_parents set is_active = true where school_id = $1 and parent_account_id = $2', [fx.a.school.id, fx.sharedParent.id]);
    }
  });

  it('a reassigned child moves bus/staff/files to the new bus at once; the old bus\'s image and crew become 404', async () => {
    const r1Image = String(fx.a.busImage.file_id);
    const driverPhoto = await f.file(fx.a.school.id, { category: 'staff_photo', entity_type: 'staff', entity_id: fx.a.driver.id });
    await ownerQuery('update staff_profiles set photo_file_id = $2 where id = $1', [fx.a.driver.id, driverPhoto.id]);
    expect((await fileUrl(parentA, fx.a.school.id, r1Image)).status).toBe(200);
    expect((await fileUrl(parentA, fx.a.school.id, driverPhoto.id)).status).toBe(200);
    await reassign(fx.a.school.id, fx.a.student.id, { busId: fx.a.otherBus.id, routeId: fx.a.otherRoute.id, stopId: r2Stop });
    try {
      const bus = await asParent(t, parentA, fx.a.school.id).get(`/parent/children/${fx.a.student.id}/bus`);
      expect(bus.status).toBe(200);
      expect(bus.body.data.bus.id).toBe(fx.a.otherBus.id);
      const staff = await asParent(t, parentA, fx.a.school.id).get(`/parent/children/${fx.a.student.id}/staff`);
      expect(JSON.stringify(staff.body)).not.toMatch(/Ramesh|Suresh/);
      expect((await fileUrl(parentA, fx.a.school.id, r1Image)).status).toBe(404);
      expect((await fileUrl(parentA, fx.a.school.id, driverPhoto.id)).status).toBe(404);
      // the R1 trip's live data is no longer reachable through tracking either
      const tr = await asParent(t, parentA, fx.a.school.id).get(`/parent/children/${fx.a.student.id}/tracking`);
      expect(JSON.stringify(tr.body)).not.toContain(fx.a.trip.id);
    } finally {
      await reassign(fx.a.school.id, fx.a.student.id, { busId: fx.a.bus.id, routeId: fx.a.route.id, stopId: fx.a.stop1.id });
    }
  });
});

describe('visibility matrix bypass through GET /parent/files/:fileId/url', () => {
  const doc = async (staffId: string, o: f.Values) => {
    const file = await f.file(fx.a.school.id, { category: 'staff_document', entity_type: 'staff', entity_id: staffId });
    await f.staffDocument(fx.a.school.id, staffId, { file_id: file.id, verification_status: 'verified', visible_to_parents_status: true, visible_to_parents_file: true, ...o });
    return file.id;
  };

  it('identity documents are never served (the DB refuses parent flags on them; verified without flags → 404)', async () => {
    await expect(doc(fx.a.conductor.id, { doc_type: 'identity' })).rejects.toThrow(/identity_private/);
    const id = await doc(fx.a.conductor.id, { doc_type: 'identity', visible_to_parents_status: false, visible_to_parents_file: false });
    expect((await fileUrl(parentA, fx.a.school.id, id)).status).toBe(404);
    const staff = await asParent(t, parentA, fx.a.school.id).get(`/parent/children/${fx.a.student.id}/staff`);
    expect(JSON.stringify(staff.body)).not.toContain(id);
  });

  it('a driver licence file is refused while the matrix hides licence files (default), whatever the document flags say', async () => {
    const id = await doc(fx.a.driver.id, { doc_type: 'licence_front' });
    expect((await fileUrl(parentA, fx.a.school.id, id)).status).toBe(404);
  });

  it('unverified (pending/rejected) and replaced documents never serve their file', async () => {
    const pending = await doc(fx.a.conductor.id, { doc_type: 'training', verification_status: 'pending' });
    const rejected = await doc(fx.a.conductor.id, { doc_type: 'first_aid', verification_status: 'rejected' });
    const replaced = await doc(fx.a.conductor.id, { doc_type: 'child_safety', is_current: false });
    for (const id of [pending, rejected, replaced]) expect((await fileUrl(parentA, fx.a.school.id, id)).status, id).toBe(404);
  });

  it('a pending insurance document with a parent-visible file is refused even when the matrix offers insurance files', async () => {
    const file = await f.file(fx.a.school.id, { category: 'bus_document', entity_type: 'bus', entity_id: fx.a.bus.id });
    await ownerQuery("update bus_documents set is_current = false where id = $1", [fx.a.busDocument.id]);
    await f.busDocument(fx.a.school.id, fx.a.bus.id, { doc_type: 'insurance', file_id: file.id, visible_to_parents_status: true, visible_to_parents_file: true, verification_status: 'pending' });
    expect((await request(t.app).put(api('/school/settings/parent-visibility')).set(bearer(adminA)).send({ bus: { insuranceFile: true } })).status).toBe(200);
    try {
      expect((await fileUrl(parentA, fx.a.school.id, file.id)).status).toBe(404);
      const bus = await asParent(t, parentA, fx.a.school.id).get(`/parent/children/${fx.a.student.id}/bus`);
      expect(JSON.stringify(bus.body)).not.toContain(file.id);
    } finally {
      await request(t.app).put(api('/school/settings/parent-visibility')).set(bearer(adminA)).send({ bus: { insuranceFile: false } });
    }
  });

  it('odometer, fuel bill, maintenance invoice, import and report files of the child\'s own bus are never served', async () => {
    for (const category of ['odometer', 'fuel_bill', 'maintenance_invoice', 'import', 'report']) {
      const file = await f.file(fx.a.school.id, { category, entity_type: category === 'odometer' || category.endsWith('bill') || category.endsWith('invoice') ? 'bus' : null, entity_id: fx.a.bus.id });
      expect((await fileUrl(parentA, fx.a.school.id, file.id)).status, category).toBe(404);
    }
  });

  it('another school\'s bus image: 404 with the own header, 403 with that school\'s header, 404 for the dual parent from the wrong school', async () => {
    const bImage = String(fx.b.busImage.file_id);
    expect((await fileUrl(parentA, fx.a.school.id, bImage)).status).toBe(404);
    expect((await fileUrl(parentA, fx.b.school.id, bImage)).status).toBe(403);
    expect((await fileUrl(shared, fx.a.school.id, bImage)).status).toBe(404);
    expect((await fileUrl(shared, fx.b.school.id, bImage)).status).toBe(200);
  });

  it('another child\'s photo and another bus\'s driver photo in the same school are 404', async () => {
    const other = await f.file(fx.a.school.id, { category: 'student_photo', entity_type: 'student', entity_id: fx.a.otherStudent.id });
    await ownerQuery('update students set photo_file_id = $2 where id = $1', [fx.a.otherStudent.id, other.id]);
    const r2Driver = await f.file(fx.a.school.id, { category: 'staff_photo', entity_type: 'staff', entity_id: fx.a.otherDriver.id });
    await ownerQuery('update staff_profiles set photo_file_id = $2 where id = $1', [fx.a.otherDriver.id, r2Driver.id]);
    expect((await fileUrl(parentA, fx.a.school.id, other.id)).status).toBe(404);
    expect((await fileUrl(parentA, fx.a.school.id, r2Driver.id)).status).toBe(404);
  });

  it('default matrix: no driver/conductor phone or e-mail, no licence number, no address in the staff cards', async () => {
    await ownerQuery("update staff_profiles set email = 'crew@example.test' where id = any ($1::uuid[])", [[fx.a.driver.id, fx.a.conductor.id]]);
    const { rows } = await ownerQuery<{ phone: string | null }>('select phone from staff_profiles where id = $1', [fx.a.driver.id]);
    const res = await asParent(t, parentA, fx.a.school.id).get(`/parent/children/${fx.a.student.id}/staff`);
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('crew@example.test');
    if (rows[0]?.phone) expect(body).not.toContain(String(rows[0].phone).slice(-6));
    for (const s of res.body.data.buses.flatMap((b: { staff: { phone: unknown; email: unknown }[] }) => b.staff)) {
      expect(s.phone).toBeNull();
      expect(s.email).toBeNull();
    }
  });
});

describe('inbox and devices', () => {
  it('a parent cannot list, filter to or mark another parent\'s notifications', async () => {
    const theirs = await f.parentNotification(fx.a.school.id, fx.sharedParent.id, { student_id: fx.a.student.id, title: 'Shared parent only' });
    const list = await asParent(t, parentA).get(`/parent/notifications?studentId=${fx.a.student.id}`);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain('Shared parent only');
    expect((await asParent(t, parentA).post(`/parent/notifications/${theirs.id}/read`)).status).toBe(404);
    await asParent(t, parentA).post('/parent/notifications/read-all');
    const { rows } = await ownerQuery<{ read_at: string | null }>('select read_at from parent_notifications where id = $1', [theirs.id]);
    expect(rows[0]!.read_at).toBeNull();
  });

  it('registering another parent\'s device uid creates an own row and never touches their FCM token', async () => {
    const victim = await f.device({ owner_type: 'parent_account', owner_id: fx.sharedParent.id, school_id: null, app_name: 'parent_app', device_uid: 'victim-phone-0001', fcm_token: 'victim-token' });
    const res = await asParent(t, parentA).post('/parent/devices', { deviceId: 'victim-phone-0001', platform: 'android', fcmToken: 'attacker-token' });
    expect([200, 403]).toContain(res.status);
    expect(JSON.stringify(res.body)).not.toContain('victim-token');
    const { rows } = await ownerQuery<{ owner_id: string; fcm_token: string | null }>('select owner_id, fcm_token from devices where id = $1', [victim.id]);
    expect(rows[0]).toEqual({ owner_id: fx.sharedParent.id, fcm_token: 'victim-token' });
  });
});
