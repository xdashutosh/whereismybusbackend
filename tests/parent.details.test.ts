// Parent module — bus details, driver/conductor cards and file URLs filtered by the school's
// parent_visibility matrix (BP §8.5, §13.3, §15.2, §12, §16): default matrix, matrix changes made by
// the school admin through the API, files only when the matrix and the document flags allow them and
// only for the child's own bus/staff/photo; other buses, other schools and hidden documents → 404.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ParentBusDetails, ParentStaffResponse } from '@wimb/shared';
import { buildApp, loginParent, loginSchoolAdmin, passwordHash, type TestApp } from './helpers/authApp.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { alignFixtureDates, api, asParent, bearer } from './parent.fixtures.js';
import request from 'supertest';

let t: TestApp;
let fx: f.TwoSchoolFixture;
let parentA: string;
let shared: string;
let adminA: string;
let insuranceFile: f.TenantRow;
let permitFile: f.TenantRow;
let driverPhoto: f.TenantRow;
let childPhoto: f.TenantRow;
let otherChildPhoto: f.TenantRow;
let r2Image: f.TenantRow;
let bImage: f.TenantRow;

const bus = async (token = parentA, schoolId = fx.a.school.id, studentId = fx.a.student.id) =>
  (await asParent(t, token, schoolId).get(`/parent/children/${studentId}/bus`)).body.data as ParentBusDetails;
const staff = async () => (await asParent(t, parentA, fx.a.school.id).get(`/parent/children/${fx.a.student.id}/staff`)).body.data as ParentStaffResponse;
const fileUrl = (fileId: string, schoolId: string | null = fx.a.school.id, token = parentA, query = '') => asParent(t, token, schoolId).get(`/parent/files/${fileId}/url${query}`);
const setMatrix = (body: object) => request(t.app).put(api('/school/settings/parent-visibility')).set(bearer(adminA)).send(body);

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  fx = await f.twoSchoolFixture();
  await alignFixtureDates(fx);
  const sid = fx.a.school.id;
  await ownerQuery(`update users set password_hash = $2 where id = $1`, [fx.a.admin.id, await passwordHash()]);
  // Current, verified insurance with a file; the permit (hidden from parents) also gets a file.
  insuranceFile = await f.file(sid, { category: 'bus_document', entity_type: 'bus', entity_id: fx.a.bus.id });
  permitFile = await f.file(sid, { category: 'bus_document', entity_type: 'bus', entity_id: fx.a.bus.id });
  await ownerQuery(`update bus_documents set file_id = $2, visible_to_parents_file = true, verification_status = 'verified' where id = $1`, [fx.a.busDocument.id, insuranceFile.id]);
  await ownerQuery(`update bus_documents set file_id = $2, verification_status = 'verified' where id = $1`, [fx.a.hiddenBusDocument.id, permitFile.id]);
  driverPhoto = await f.file(sid, { category: 'staff_photo', entity_type: 'staff', entity_id: fx.a.driver.id });
  await ownerQuery(`update staff_profiles set photo_file_id = $2, email = 'ramesh@example.test' where id = $1`, [fx.a.driver.id, driverPhoto.id]);
  childPhoto = await f.file(sid, { category: 'student_photo', entity_type: 'student', entity_id: fx.a.student.id });
  otherChildPhoto = await f.file(sid, { category: 'student_photo', entity_type: 'student', entity_id: fx.a.otherStudent.id });
  await ownerQuery('update students set photo_file_id = $2 where id = $1', [fx.a.student.id, childPhoto.id]);
  await ownerQuery('update students set photo_file_id = $2 where id = $1', [fx.a.otherStudent.id, otherChildPhoto.id]);
  r2Image = await f.busImage(sid, fx.a.otherBus.id);
  bImage = fx.b.busImage;
  parentA = (await loginParent(t, String(fx.a.parent.phone))).accessToken;
  shared = (await loginParent(t, String(fx.sharedParent.phone))).accessToken;
  adminA = (await loginSchoolAdmin(t.app, String(fx.a.admin.email))).accessToken;
});

afterAll(closeDb);

describe('default visibility matrix (BP §6.2)', () => {
  it('bus: plate and images shown, capacity hidden, verified insurance validity without its file, hidden documents left out', async () => {
    const d = await bus();
    expect(d.direction).toBe('morning');
    expect(d.route).toMatchObject({ id: fx.a.route.id, code: 'R1' });
    expect(d.bus).toMatchObject({ id: fx.a.bus.id, code: 'R1', capacity: null, registrationNo: 'KA01AB1234' });
    expect(d.bus.images).toHaveLength(1);
    expect(d.bus.images[0]).toMatchObject({ fileId: fx.a.busImage.file_id, url: expect.stringContaining('token=') });
    expect(d.bus.documents).toEqual([expect.objectContaining({ docType: 'insurance', expiryStatus: 'valid', fileId: null })]);
    expect(JSON.stringify(d)).not.toMatch(/permit|school_id|fuel|odometer|chassis/i);
  });

  it('staff: driver and conductor cards without phone/e-mail, with photo, licence validity and experience', async () => {
    const d = await staff();
    expect(d.buses).toHaveLength(1);
    const [entry] = d.buses;
    expect(entry).toMatchObject({ busId: fx.a.bus.id, busCode: 'R1', direction: 'morning' });
    expect(entry!.staff.map((s) => [s.role, s.fullName])).toEqual([['primary_driver', 'Ramesh Kumar'], ['conductor', 'Suresh Babu']]);
    const driver = entry!.staff[0]!;
    expect(driver).toMatchObject({ phone: null, email: null, photo: { fileId: driverPhoto.id }, licence: { expiryStatus: expect.any(String) } });
    expect(driver.experience).not.toBeNull();
    expect(driver.documents.map((x) => x.docType)).not.toContain('identity');
    // Never the licence number, address or identity details.
    expect(JSON.stringify(d)).not.toMatch(/licenceNo|licence_no|address|aadhaar|KA01[A-Z0-9]*\d{2}/i);
  });
});

describe('matrix changes by the school admin apply at once', () => {
  it('bus: capacity shown, plate and images hidden, insurance file offered', async () => {
    expect((await setMatrix({ bus: { capacity: true, plate: false, images: false, insuranceFile: true } })).status).toBe(200);
    const d = await bus();
    expect(d.bus).toMatchObject({ capacity: 40, registrationNo: null, images: [] });
    expect(d.bus.documents).toEqual([expect.objectContaining({ docType: 'insurance', fileId: insuranceFile.id })]);
  });

  it('driver: phone and e-mail shown, photo and licence hidden', async () => {
    expect((await setMatrix({ driver: { phone: true, email: true, photo: false, licenceValidity: false } })).status).toBe(200);
    const driver = (await staff()).buses[0]!.staff[0]!;
    expect(driver).toMatchObject({ phone: expect.stringMatching(/^\+91/), email: 'ramesh@example.test', photo: null, licence: null });
  });
});

describe('GET /parent/files/:fileId/url', () => {
  it('signs the insurance file only while the matrix and the document flag allow it', async () => {
    const ok = await fileUrl(insuranceFile.id);
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ url: expect.stringContaining('token='), contentType: 'image/jpeg', variant: 'original' });
    await ownerQuery('update bus_documents set visible_to_parents_file = false where id = $1', [fx.a.busDocument.id]);
    expect((await fileUrl(insuranceFile.id)).status).toBe(404);
    await ownerQuery('update bus_documents set visible_to_parents_file = true where id = $1', [fx.a.busDocument.id]);
    expect((await setMatrix({ bus: { insuranceFile: false } })).status).toBe(200);
    expect((await fileUrl(insuranceFile.id)).status).toBe(404);
  });

  it('follows the images flag for bus photos and the photo flag for staff photos', async () => {
    expect((await fileUrl(String(fx.a.busImage.file_id))).status).toBe(404);
    expect((await setMatrix({ bus: { images: true } })).status).toBe(200);
    expect((await fileUrl(String(fx.a.busImage.file_id))).status).toBe(200);
    expect((await fileUrl(driverPhoto.id)).status).toBe(404);
    expect((await setMatrix({ driver: { photo: true } })).status).toBe(200);
    expect((await fileUrl(driverPhoto.id)).status).toBe(200);
  });

  it('serves the own child\'s photo and the school logo, never another child\'s photo', async () => {
    expect((await fileUrl(childPhoto.id)).status).toBe(200);
    expect((await fileUrl(otherChildPhoto.id)).status).toBe(404);
    const logo = await f.file(fx.a.school.id, { category: 'school_logo', entity_type: 'school', entity_id: fx.a.school.id });
    await ownerQuery('update schools set logo_file_id = $2 where id = $1', [fx.a.school.id, logo.id]);
    expect((await fileUrl(logo.id)).status).toBe(200);
    expect((await fileUrl(logo.id, fx.b.school.id, shared)).status).toBe(404);
    const home = await asParent(t, parentA).get('/parent/children');
    expect(home.body.data.schools[0]).toMatchObject({ logoUrl: expect.stringContaining('token=') });
    expect(home.body.data.schools[0].children[0]).toMatchObject({ photoUrl: expect.stringContaining('token=') });
  });

  it('refuses hidden documents, other buses, other schools and missing/foreign headers', async () => {
    expect((await fileUrl(permitFile.id)).status).toBe(404);
    expect((await fileUrl(String(r2Image.file_id))).status).toBe(404);
    expect((await fileUrl(String(bImage.file_id))).status).toBe(404);
    expect((await fileUrl(String(bImage.file_id), fx.a.school.id, shared)).status).toBe(404);
    expect((await fileUrl(String(bImage.file_id), fx.b.school.id, shared)).status).toBe(200);
    expect((await fileUrl(insuranceFile.id, fx.b.school.id)).status).toBe(403);
    expect((await fileUrl(insuranceFile.id, null)).status).toBe(400);
    expect((await fileUrl('not-a-uuid')).status).toBe(400);
    expect((await fileUrl(String(fx.a.busImage.file_id), fx.a.school.id, parentA, '?variant=thumbnail')).status).toBe(404);
  });

  it('refuses a file the parent could see once the child is no longer assigned to that bus', async () => {
    await ownerQuery(`update student_assignments set valid_from = (now() at time zone 'Asia/Kolkata')::date + 1 where id = $1`, [fx.a.assignment.id]);
    try {
      expect((await fileUrl(String(fx.a.busImage.file_id))).status).toBe(404);
      expect((await asParent(t, parentA, fx.a.school.id).get(`/parent/children/${fx.a.student.id}/bus`)).status).toBe(404);
    } finally {
      await ownerQuery(`update student_assignments set valid_from = (now() at time zone 'Asia/Kolkata')::date - 30 where id = $1`, [fx.a.assignment.id]);
    }
  });
});
