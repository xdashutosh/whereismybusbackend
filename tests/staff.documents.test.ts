// Staff documents (BP §8.3 documents CRUD + PATCH /school/staff-documents/:id/verify, §12, §16):
// create with an uploaded staff_document file, one current version per type (training/other
// several), licence documents for drivers only, identity documents admin-only with the last 4
// characters only, replace keeps history, metadata corrections, visibility flags, verification
// (identity/licence sync the profile status), soft delete, expiry badges, and file access for the
// staff member and for parents (school matrix + document flags; RLS backstop).
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { buildApp, loginSchoolAdmin, passwordHash, type TestApp } from './helpers/authApp.js';

let t: TestApp;
let fx: f.TwoSchoolFixture;
let adminA: string;
let driverId: string;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const api = (p: string) => `/api/v1${p}`;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');

async function uploadId(entityId: string, category = 'staff_document'): Promise<string> {
  const res = await request(t.app).post(api('/files/upload')).set(auth(adminA)).field('category', category).field('entityId', entityId).attach('file', PDF, 'doc.pdf');
  if (res.status !== 201) throw new Error(`upload failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.id as string;
}
const createDoc = (staffId: string, body: Record<string, unknown>) => request(t.app).post(api(`/school/staff/${staffId}/documents`)).set(auth(adminA)).send(body);
const docApi = (id: string, suffix = '') => api(`/school/staff-documents/${id}${suffix}`);

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  fx = await f.twoSchoolFixture();
  driverId = fx.a.driver.id;
  await ownerQuery('update users set password_hash = $1 where id = any ($2)', [await passwordHash(), [fx.a.admin.id]]);
  adminA = (await loginSchoolAdmin(t.app, String(fx.a.admin.email))).accessToken;
});
afterAll(closeDb);

describe('create, list, rules', () => {
  it('creates a licence document linked to an uploaded file and audits it', async () => {
    const fileId = await uploadId(driverId);
    const res = await createDoc(driverId, {
      docType: 'licence_front', title: 'DL front', issuer: 'RTO Bengaluru', docNumber: 'KA01-2014-0098765', issueDate: f.isoDay(-3000),
      expiryDate: f.isoDay(10), fileId, visibleToParentsFile: true, school_id: fx.b.school.id,
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      staffId: driverId, docType: 'licence_front', expiryStatus: 'expiring', isCurrent: true, verificationStatus: 'pending',
      visibleToParentsStatus: true, visibleToParentsFile: true, file: { id: fileId, fileName: 'doc.pdf', contentType: 'application/pdf' },
    });
    expect((await ownerQuery('select school_id from staff_documents where id = $1', [res.body.data.id])).rows[0]!.school_id).toBe(fx.a.school.id);
    expect((await ownerQuery("select 1 from audit_logs where action = 'staff_document.create' and entity_id = $1", [res.body.data.id])).rowCount).toBe(1);
  });

  it('allows one current document per type except training/other; licence documents for drivers only', async () => {
    const dup = await createDoc(driverId, { docType: 'police_verification' });
    expect([dup.status, dup.body.error.code, dup.body.error.details]).toEqual([409, 'CONFLICT', { documentId: fx.a.driverDocument.id }]);
    expect((await createDoc(driverId, { docType: 'training', title: 'Defensive driving', expiryDate: f.isoDay(-2) })).status).toBe(201);
    expect((await createDoc(driverId, { docType: 'training', title: 'Child safety refresher' })).status).toBe(201);
    expect((await createDoc(driverId, { docType: 'character_certificate', issuer: 'Police Station Koramangala' })).status).toBe(201);
    const conductor = await createDoc(fx.a.conductor.id, { docType: 'licence_back' });
    expect([conductor.status, conductor.body.error.details[0].path]).toEqual([400, 'docType']);
    const wrongFile = await createDoc(driverId, { docType: 'first_aid', fileId: await uploadId(fx.a.otherDriver.id) });
    expect([wrongFile.status, wrongFile.body.error.details[0].path]).toEqual([400, 'fileId']);
    const dates = await createDoc(driverId, { docType: 'first_aid', issueDate: '2025-01-02', expiryDate: '2025-01-01' });
    expect([dates.status, dates.body.error.details[0].path]).toEqual([400, 'expiryDate']);
  });

  it('keeps identity documents admin-only with the last 4 characters only (never full Aadhaar/PAN)', async () => {
    const sid = fx.a.conductor.id;
    for (const [body, path] of [
      [{ docType: 'identity', docNumber: '2345 6789 0123' }, 'docNumber'],
      [{ docType: 'identity', docNumber: '12345678' }, 'docNumber'],
      [{ docType: 'identity', visibleToParentsFile: true }, 'visibleToParentsFile'],
      [{ docType: 'identity', visibleToParentsStatus: true }, 'visibleToParentsStatus'],
      [{ docType: 'other', docNumber: 'ABCDE1234F' }, 'docNumber'],
    ] as const) {
      const res = await createDoc(sid, body);
      expect([res.status, res.body.error.details[0].path]).toEqual([400, path]);
      if ('docNumber' in body) expect(JSON.stringify(res.body)).not.toContain(body.docNumber);
    }
    const ok = await createDoc(sid, { docType: 'identity', docNumber: '0123', fileId: await uploadId(sid) });
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ docNumber: '0123', visibleToParentsStatus: false, visibleToParentsFile: false });
    const vis = await request(t.app).patch(docApi(ok.body.data.id, '/visibility')).set(auth(adminA)).send({ visibleToParentsFile: true });
    expect([vis.status, vis.body.error.details[0].path]).toEqual([400, 'visibleToParentsFile']);
    const meta = await request(t.app).patch(docApi(ok.body.data.id)).set(auth(adminA)).send({ docNumber: '234567890123' });
    expect(meta.status).toBe(400);
  });

  it('lists current documents in a stable order with expiry badges', async () => {
    const res = await request(t.app).get(api(`/school/staff/${driverId}/documents`)).set(auth(adminA));
    expect(res.status).toBe(200);
    const types = res.body.data.map((d: { docType: string }) => d.docType);
    expect(types.slice(0, 3)).toEqual(['identity', 'licence_front', 'police_verification']);
    expect(res.body.data.find((d: { title: string }) => d.title === 'Defensive driving').expiryStatus).toBe('expired');
    const only = await request(t.app).get(api(`/school/staff/${driverId}/documents?docType=training`)).set(auth(adminA));
    expect(only.body.data).toHaveLength(2);
    const detail = await request(t.app).get(api(`/school/staff/${driverId}`)).set(auth(adminA));
    expect(detail.body.data).toMatchObject({ expiredDocuments: 1 });
    expect(detail.body.data.expiringDocuments).toBeGreaterThanOrEqual(1);
  });
});

describe('replace, update, verify, delete', () => {
  it('replaces a document (history kept, file and flags carried over)', async () => {
    const id = fx.a.driverDocument.id;
    const res = await request(t.app).put(docApi(id)).set(auth(adminA)).send({ title: 'Police verification 2026', expiryDate: f.isoDay(700) });
    expect(res.status).toBe(201);
    const newId = res.body.data.id;
    expect(res.body.data).toMatchObject({ docType: 'police_verification', isCurrent: true, visibleToParentsStatus: true, verificationStatus: 'pending' });
    const old = await request(t.app).get(docApi(id)).set(auth(adminA));
    expect(old.body.data).toMatchObject({ isCurrent: false, replacedBy: newId });
    expect(old.body.data.versions.map((v: { id: string }) => v.id)).toEqual([newId, id]);
    const again = await request(t.app).put(docApi(id)).set(auth(adminA)).send({});
    expect([again.status, again.body.error.code]).toEqual([409, 'INVALID_STATE']);
    const hist = await request(t.app).get(api(`/school/staff/${driverId}/documents?docType=police_verification&includeHistory=true`)).set(auth(adminA));
    expect(hist.body.data).toHaveLength(2);
  });

  it('corrects metadata and audits the diff', async () => {
    const doc = (await request(t.app).get(api(`/school/staff/${driverId}/documents?docType=character_certificate`)).set(auth(adminA))).body.data[0];
    const res = await request(t.app).patch(docApi(doc.id)).set(auth(adminA)).send({ docNumber: 'CC/2026/77', expiryDate: f.isoDay(365) });
    expect(res.body.data).toMatchObject({ docNumber: 'CC/2026/77', expiryStatus: 'valid' });
    const log = await ownerQuery<{ new_values: Record<string, unknown> }>("select new_values from audit_logs where action = 'staff_document.update' and entity_id = $1", [doc.id]);
    expect(log.rows[0]!.new_values).toMatchObject({ docNumber: 'CC/2026/77' });
  });

  it('verifies documents; identity and licence verification update the profile', async () => {
    const reject = await request(t.app).patch(docApi(fx.a.identityDocument.id, '/verify')).set(auth(adminA)).send({ status: 'rejected' });
    expect([reject.status, reject.body.error.details[0].path]).toEqual([400, 'note']);
    const id = await request(t.app).patch(docApi(fx.a.identityDocument.id, '/verify')).set(auth(adminA)).send({ status: 'verified' });
    expect(id.body.data).toMatchObject({ verificationStatus: 'verified', verifiedBy: fx.a.admin.id, verifiedByName: 'Anita Rao' });
    const licence = (await request(t.app).get(api(`/school/staff/${driverId}/documents?docType=licence_front`)).set(auth(adminA))).body.data[0];
    await request(t.app).patch(docApi(licence.id, '/verify')).set(auth(adminA)).send({ status: 'rejected', note: 'Photo unreadable' });
    const profile = await request(t.app).get(api(`/school/staff/${driverId}`)).set(auth(adminA));
    expect(profile.body.data).toMatchObject({ idVerificationStatus: 'verified', licenceVerificationStatus: 'rejected' });
    const back = await request(t.app).patch(docApi(licence.id, '/verify')).set(auth(adminA)).send({ status: 'verified' });
    expect(back.body.data).toMatchObject({ verificationStatus: 'verified', verificationNote: null });
  });

  it('replacing or deleting a verified current licence/identity document resets the profile status to pending', async () => {
    const profile = async (): Promise<Record<string, unknown>> => (await request(t.app).get(api(`/school/staff/${driverId}`)).set(auth(adminA))).body.data as Record<string, unknown>;
    expect(await profile()).toMatchObject({ idVerificationStatus: 'verified', licenceVerificationStatus: 'verified' });
    const licence = (await request(t.app).get(api(`/school/staff/${driverId}/documents?docType=licence_front`)).set(auth(adminA))).body.data[0];
    const renewed = await request(t.app).put(docApi(licence.id)).set(auth(adminA)).send({ expiryDate: f.isoDay(3650) });
    expect(renewed.status).toBe(201);
    expect(renewed.body.data).toMatchObject({ verificationStatus: 'pending', isCurrent: true });
    expect(await profile()).toMatchObject({ idVerificationStatus: 'verified', licenceVerificationStatus: 'pending' });
    const log = await ownerQuery<{ new_values: Record<string, unknown> }>("select new_values from audit_logs where action = 'staff_document.replace' and entity_id = $1", [renewed.body.data.id]);
    expect(log.rows[0]!.new_values).toMatchObject({ profileStatus: 'licence_verification_status' });
    // Verifying the old (history) version must not set the profile again; the new one does.
    await request(t.app).patch(docApi(licence.id, '/verify')).set(auth(adminA)).send({ status: 'verified' });
    expect((await profile()).licenceVerificationStatus).toBe('pending');
    await request(t.app).patch(docApi(renewed.body.data.id, '/verify')).set(auth(adminA)).send({ status: 'verified' });
    expect((await profile()).licenceVerificationStatus).toBe('verified');
    // Deleting the current identity document drops its verdict too; deleting a non-identity one does not touch the profile.
    expect((await request(t.app).delete(docApi(fx.a.identityDocument.id)).set(auth(adminA))).status).toBe(200);
    expect(await profile()).toMatchObject({ idVerificationStatus: 'pending', licenceVerificationStatus: 'verified' });
  });

  it('soft deletes a document', async () => {
    const doc = (await request(t.app).get(api(`/school/staff/${driverId}/documents?docType=training`)).set(auth(adminA))).body.data[1];
    const res = await request(t.app).delete(docApi(doc.id)).set(auth(adminA));
    expect(res.body.data).toEqual({ id: doc.id, deleted: true });
    expect((await request(t.app).get(docApi(doc.id)).set(auth(adminA))).status).toBe(404);
    expect((await ownerQuery('select deleted_at from staff_documents where id = $1', [doc.id])).rows[0]!.deleted_at).not.toBeNull();
  });
});
