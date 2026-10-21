// Bus documents (BP §8.3 Bus documents, §12, §13.3): create with an uploaded bus_document file,
// one current version per type, replace keeps history (is_current=false, replaced_by), metadata
// corrections, visibility flags, verification, soft delete, expiry badges, file access for staff
// and parents (school parent_visibility + document flags; only current, verified documents), the
// parent document rule itself, and isolation.
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { busVisibilityOf, parentSeesDocumentFile, parentSeesDocumentStatus } from '../src/modules/buses/index.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { buildApp, loginParent, loginSchoolAdmin, loginStaff, passwordHash, type TestApp } from './helpers/authApp.js';

let t: TestApp;
let fx: f.TwoSchoolFixture;
let adminA: string;
let adminB: string;
let driverA: string;
let parentA: string;
let busId: string;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const api = (path: string) => `/api/v1${path}`;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');

function upload(token: string, entityId: string, category = 'bus_document', name = 'doc.pdf') {
  return request(t.app).post(api('/files/upload')).set(auth(token)).field('category', category).field('entityId', entityId).attach('file', PDF, name);
}
async function uploadId(entityId: string, token = adminA): Promise<string> {
  const res = await upload(token, entityId);
  if (res.status !== 201) throw new Error(`upload failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.id as string;
}
const createDoc = (bus: string, body: Record<string, unknown>, token = adminA) => request(t.app).post(api(`/school/buses/${bus}/documents`)).set(auth(token)).send(body);
const fileUrl = (id: string, token: string, schoolId?: string) => {
  const r = request(t.app).get(api(`/files/${id}/url`)).set(auth(token));
  return schoolId ? r.set('X-School-Id', schoolId) : r;
};
const setBusVisibility = (patch: Record<string, boolean>) =>
  ownerQuery("update school_settings set parent_visibility = jsonb_set(parent_visibility, '{bus}', (parent_visibility->'bus') || $2::jsonb) where school_id = $1", [fx.a.school.id, JSON.stringify(patch)]);
async function verify(docId: string, status: 'verified' | 'rejected' | 'pending'): Promise<void> {
  const res = await request(t.app).patch(api(`/school/bus-documents/${docId}/verify`)).set(auth(adminA)).send(status === 'rejected' ? { status, note: 'Seal missing' } : { status });
  if (res.status !== 200) throw new Error(`verify failed ${res.status} ${JSON.stringify(res.body)}`);
}

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  fx = await f.twoSchoolFixture();
  await ownerQuery('update users set password_hash = $1 where id = any ($2)', [await passwordHash(), [fx.a.admin.id, fx.b.admin.id, fx.a.driverUser.id]]);
  adminA = (await loginSchoolAdmin(t.app, String(fx.a.admin.email))).accessToken;
  adminB = (await loginSchoolAdmin(t.app, String(fx.b.admin.email))).accessToken;
  driverA = (await loginStaff(t.app, String(fx.a.school.code), String(fx.a.driverUser.phone))).accessToken;
  parentA = (await loginParent(t, String(fx.a.parent.phone))).accessToken;
  busId = (await f.bus(fx.a.school.id, { code: 'R5' })).id;
});
afterAll(closeDb);

describe('create and list', () => {
  let insuranceId: string;

  it('creates a document linked to an uploaded file and audits it', async () => {
    const fileId = await uploadId(busId);
    const res = await createDoc(busId, { docType: 'insurance', title: 'Comprehensive policy', issuer: 'National Insurance', docNumber: 'POL-77', startDate: f.isoDay(-30), expiryDate: f.isoDay(335), fileId, school_id: fx.b.school.id });
    expect(res.status).toBe(201);
    insuranceId = res.body.data.id;
    expect(res.body.data).toMatchObject({
      busId, docType: 'insurance', title: 'Comprehensive policy', expiryStatus: 'valid', isCurrent: true, replacedBy: null,
      verificationStatus: 'pending', visibleToParentsStatus: true, visibleToParentsFile: false,
      file: { id: fileId, fileName: 'doc.pdf', contentType: 'application/pdf', hasThumbnail: false },
    });
    expect(res.body.data.daysToExpiry).toBeGreaterThan(300);
    expect((await ownerQuery('select school_id from bus_documents where id = $1', [insuranceId])).rows[0]!.school_id).toBe(fx.a.school.id);
    expect((await ownerQuery("select 1 from audit_logs where action = 'bus_document.create' and entity_id = $1", [insuranceId])).rowCount).toBe(1);
  });

  it('allows one current document per type (except "other") and validates the file', async () => {
    const dup = await createDoc(busId, { docType: 'insurance' });
    expect([dup.status, dup.body.error.code, dup.body.error.details]).toEqual([409, 'CONFLICT', { documentId: insuranceId }]);
    expect((await createDoc(busId, { docType: 'other', title: 'Seat belt certificate' })).status).toBe(201);
    expect((await createDoc(busId, { docType: 'other', title: 'GPS device invoice' })).status).toBe(201);

    const otherBusFile = await uploadId(fx.a.otherBus.id);
    const wrongBus = await createDoc(busId, { docType: 'rc', fileId: otherBusFile });
    expect([wrongBus.status, wrongBus.body.error.details[0].path]).toEqual([400, 'fileId']);
    const img = await request(t.app).post(api('/files/upload')).set(auth(adminA)).field('category', 'fuel_bill').field('entityId', busId).attach('file', PDF, 'bill.pdf');
    expect((await createDoc(busId, { docType: 'rc', fileId: img.body.data.id })).status).toBe(400);
    const bFile = await uploadId(fx.b.bus.id, adminB);
    expect((await createDoc(busId, { docType: 'rc', fileId: bFile })).status).toBe(404);
    const used = (await ownerQuery<{ file_id: string }>('select file_id from bus_documents where id = $1', [insuranceId])).rows[0]!.file_id;
    expect((await createDoc(busId, { docType: 'rc', fileId: used })).status).toBe(409);
    const badDates = await createDoc(busId, { docType: 'rc', startDate: '2026-05-01', expiryDate: '2026-04-01' });
    expect(badDates.status).toBe(400);
  });

  it('computes expiry badges against the school-local date and filters buses by them', async () => {
    const expired = await createDoc(busId, { docType: 'pollution', expiryDate: f.isoDay(-2) });
    const expiring = await createDoc(busId, { docType: 'fitness', expiryDate: f.isoDay(10) });
    expect([expired.body.data.expiryStatus, expiring.body.data.expiryStatus]).toEqual(['expired', 'expiring']);
    const permit = await createDoc(busId, { docType: 'permit' });
    expect([permit.body.data.expiryStatus, permit.body.data.daysToExpiry]).toEqual(['none', null]);
    const buses = await request(t.app).get(api('/school/buses?documentStatus=expired')).set(auth(adminA));
    expect(buses.body.data.map((b: { id: string }) => b.id)).toEqual([busId]);
    expect(buses.body.data[0]).toMatchObject({ expiredDocuments: 1, expiringDocuments: 1 });
    const list = await request(t.app).get(api(`/school/buses/${busId}/documents?docType=pollution,fitness`)).set(auth(adminA));
    expect(list.body.data.map((d: { docType: string }) => d.docType)).toEqual(['fitness', 'pollution']);
  });
});

describe('replace keeps history', () => {
  it('creates a new current version and keeps the old one (is_current=false, replaced_by)', async () => {
    const [current] = (await request(t.app).get(api(`/school/buses/${busId}/documents?docType=insurance`)).set(auth(adminA))).body.data;
    const newFile = await uploadId(busId);
    const res = await request(t.app).put(api(`/school/bus-documents/${current.id}`)).set(auth(adminA)).send({ expiryDate: f.isoDay(700), docNumber: 'POL-78', fileId: newFile, visibleToParentsFile: true });
    expect(res.status).toBe(201);
    const fresh = res.body.data;
    expect(fresh).toMatchObject({ docType: 'insurance', docNumber: 'POL-78', isCurrent: true, verificationStatus: 'pending', visibleToParentsStatus: true, visibleToParentsFile: true, file: { id: newFile } });
    expect(fresh.title).toBeNull();
    const old = (await ownerQuery('select is_current, replaced_by, deleted_at from bus_documents where id = $1', [current.id])).rows[0]!;
    expect(old).toEqual({ is_current: false, replaced_by: fresh.id, deleted_at: null });

    const currentOnly = await request(t.app).get(api(`/school/buses/${busId}/documents?docType=insurance`)).set(auth(adminA));
    expect(currentOnly.body.data.map((d: { id: string }) => d.id)).toEqual([fresh.id]);
    const withHistory = await request(t.app).get(api(`/school/buses/${busId}/documents?docType=insurance&includeHistory=true`)).set(auth(adminA));
    expect(withHistory.body.data.map((d: { id: string }) => d.id)).toEqual([fresh.id, current.id]);

    const again = await request(t.app).put(api(`/school/bus-documents/${current.id}`)).set(auth(adminA)).send({ title: 'stale' });
    expect([again.status, again.body.error.code]).toEqual([409, 'INVALID_STATE']);

    // A renewal without a new file keeps the previous file.
    const third = await request(t.app).put(api(`/school/bus-documents/${fresh.id}`)).set(auth(adminA)).send({ expiryDate: f.isoDay(1000) });
    expect(third.body.data.file.id).toBe(newFile);
    const versions = await request(t.app).get(api(`/school/bus-documents/${fresh.id}`)).set(auth(adminA));
    expect(versions.body.data.versions.map((d: { id: string }) => d.id)).toEqual([third.body.data.id, fresh.id, current.id]);
    const audit = await ownerQuery("select old_values->>'documentId' as old_id from audit_logs where action = 'bus_document.replace' and entity_id = $1", [fresh.id]);
    expect(audit.rows).toEqual([{ old_id: current.id }]);
  });
});

describe('metadata, visibility, verification, delete', () => {
  let docId: string;
  beforeAll(async () => {
    docId = (await createDoc(busId, { docType: 'rc', docNumber: 'RC-1' })).body.data.id;
  });

  it('corrects metadata in place', async () => {
    const res = await request(t.app).patch(api(`/school/bus-documents/${docId}`)).set(auth(adminA)).send({ docNumber: 'RC-0001', issuer: 'RTO Bengaluru' });
    expect([res.status, res.body.data.docNumber, res.body.data.issuer, res.body.data.isCurrent]).toEqual([200, 'RC-0001', 'RTO Bengaluru', true]);
    const audit = await ownerQuery("select old_values, new_values from audit_logs where action = 'bus_document.update' and entity_id = $1", [docId]);
    expect(audit.rows[0]).toEqual({ old_values: { docNumber: 'RC-1', issuer: null }, new_values: { docNumber: 'RC-0001', issuer: 'RTO Bengaluru' } });
    expect((await request(t.app).patch(api(`/school/bus-documents/${docId}`)).set(auth(adminA)).send({ fileId: null })).status).toBe(400);
  });

  it('toggles parent visibility flags', async () => {
    const res = await request(t.app).patch(api(`/school/bus-documents/${docId}/visibility`)).set(auth(adminA)).send({ visibleToParentsStatus: false, visibleToParentsFile: true });
    expect([res.body.data.visibleToParentsStatus, res.body.data.visibleToParentsFile]).toEqual([false, true]);
    expect((await request(t.app).patch(api(`/school/bus-documents/${docId}/visibility`)).set(auth(adminA)).send({})).status).toBe(400);
  });

  it('verifies, rejects (note required) and resets verification', async () => {
    const noNote = await request(t.app).patch(api(`/school/bus-documents/${docId}/verify`)).set(auth(adminA)).send({ status: 'rejected' });
    expect(noNote.status).toBe(400);
    const ok = await request(t.app).patch(api(`/school/bus-documents/${docId}/verify`)).set(auth(adminA)).send({ status: 'verified', note: 'Checked original' });
    expect(ok.body.data).toMatchObject({ verificationStatus: 'verified', verifiedBy: fx.a.admin.id, verifiedByName: fx.a.admin.full_name, verificationNote: 'Checked original' });
    expect(ok.body.data.verifiedAt).toEqual(expect.any(String));
    const reset = await request(t.app).patch(api(`/school/bus-documents/${docId}/verify`)).set(auth(adminA)).send({ status: 'pending' });
    expect(reset.body.data).toMatchObject({ verificationStatus: 'pending', verifiedBy: null, verifiedAt: null });
  });

  it('soft deletes', async () => {
    const res = await request(t.app).delete(api(`/school/bus-documents/${docId}`)).set(auth(adminA));
    expect([res.status, res.body.data]).toEqual([200, { id: docId, deleted: true }]);
    expect((await request(t.app).get(api(`/school/bus-documents/${docId}`)).set(auth(adminA))).status).toBe(404);
    expect((await ownerQuery('select deleted_at is not null as d from bus_documents where id = $1', [docId])).rows[0]!.d).toBe(true);
    const list = await request(t.app).get(api(`/school/buses/${busId}/documents?docType=rc`)).set(auth(adminA));
    expect(list.body.data).toEqual([]);
    expect((await createDoc(busId, { docType: 'rc' })).status).toBe(201);
  });
});

describe('document file access (staff and parents)', () => {
  let fileId: string;
  let docId: string;

  beforeAll(async () => {
    // R1 is the parent's child's bus and the driver's assigned bus; its fixture insurance gets a file.
    fileId = await uploadId(fx.a.bus.id);
    const res = await request(t.app).put(api(`/school/bus-documents/${fx.a.busDocument.id}`)).set(auth(adminA)).send({ fileId });
    docId = res.body.data.id as string;
  });

  it('drivers read the current papers of their assigned bus only', async () => {
    expect((await fileUrl(fileId, driverA)).status).toBe(200);
    const otherFile = await uploadId(busId);
    await createDoc(busId, { docType: 'safety_inspection', fileId: otherFile });
    expect((await fileUrl(otherFile, driverA)).status).toBe(404);
  });

  it('parents need the document flag AND the school insurance_file setting', async () => {
    await verify(docId, 'verified'); // the replacement started as 'pending'; parents only ever get verified documents
    expect((await fileUrl(fileId, parentA, fx.a.school.id)).status).toBe(404); // visibleToParentsFile false
    await request(t.app).patch(api(`/school/bus-documents/${docId}/visibility`)).set(auth(adminA)).send({ visibleToParentsFile: true });
    expect((await fileUrl(fileId, parentA, fx.a.school.id)).status).toBe(404); // school insurance_file false (default)
    await setBusVisibility({ insurance_file: true });
    expect((await fileUrl(fileId, parentA, fx.a.school.id)).status).toBe(200);
    expect((await fileUrl(fileId, adminB)).status).toBe(404);
    await request(t.app).delete(api(`/school/bus-documents/${docId}`)).set(auth(adminA));
    expect((await fileUrl(fileId, parentA, fx.a.school.id)).status).toBe(404);
    expect((await fileUrl(fileId, driverA)).status).toBe(404);
    await setBusVisibility({ insurance_file: false });
  });
});

describe('parents and document verification (files)', () => {
  // R1 (the parent's child's bus) gets a fitness certificate with every parent switch on.
  let fitnessId: string;
  let fitnessFile: string;
  const asParent = (id: string) => fileUrl(id, parentA, fx.a.school.id);

  beforeAll(async () => {
    await setBusVisibility({ fitness_status: true, fitness_file: true });
    fitnessFile = await uploadId(fx.a.bus.id);
    const res = await createDoc(fx.a.bus.id, { docType: 'fitness', expiryDate: f.isoDay(300), fileId: fitnessFile, visibleToParentsStatus: true, visibleToParentsFile: true });
    if (res.status !== 201) throw new Error(`create failed ${res.status} ${JSON.stringify(res.body)}`);
    fitnessId = res.body.data.id as string;
  });
  afterAll(() => setBusVisibility({ fitness_file: false }));

  it('refuses the file of a pending or rejected document even with every visibility flag on', async () => {
    expect((await asParent(fitnessFile)).status).toBe(404); // a new document starts as pending
    await verify(fitnessId, 'rejected');
    expect((await asParent(fitnessFile)).status).toBe(404);
    await verify(fitnessId, 'verified');
    expect((await asParent(fitnessFile)).status).toBe(200);
    await verify(fitnessId, 'pending'); // verification reset
    expect((await asParent(fitnessFile)).status).toBe(404);
    expect((await fileUrl(fitnessFile, driverA)).status).toBe(200); // the assigned driver still carries the papers
  });

  it('replaced versions: a renewal does not inherit the verdict, and the old file is no longer served', async () => {
    await verify(fitnessId, 'verified');
    // Renewal keeping the same scan: the new current version is pending → the file is refused.
    const kept = await request(t.app).put(api(`/school/bus-documents/${fitnessId}`)).set(auth(adminA)).send({ expiryDate: f.isoDay(665) });
    expect([kept.status, kept.body.data.verificationStatus, kept.body.data.file.id]).toEqual([201, 'pending', fitnessFile]);
    expect((await asParent(fitnessFile)).status).toBe(404);
    await verify(kept.body.data.id as string, 'verified');
    expect((await asParent(fitnessFile)).status).toBe(200);
    // Renewal with a new scan: the old (verified) scan belongs to a replaced version → refused.
    const newFile = await uploadId(fx.a.bus.id);
    const renewed = await request(t.app).put(api(`/school/bus-documents/${kept.body.data.id}`)).set(auth(adminA)).send({ fileId: newFile });
    expect(renewed.status).toBe(201);
    expect((await asParent(fitnessFile)).status).toBe(404);
    expect((await asParent(newFile)).status).toBe(404); // pending
    await verify(renewed.body.data.id as string, 'verified');
    expect((await asParent(newFile)).status).toBe(200);
    expect((await asParent(fitnessFile)).status).toBe(404);
  });
});

describe('parent document rule (pure)', () => {
  const v = busVisibilityOf({ bus: { insurance_status: true, insurance_file: true } });
  const doc = (o: Partial<Parameters<typeof parentSeesDocumentStatus>[1]> = {}) => ({
    doc_type: 'insurance', visible_to_parents_status: true, visible_to_parents_file: true, file_id: 'f1',
    verification_status: 'verified', is_current: true, deleted_at: null as string | null, ...o,
  });
  const sees = (d: ReturnType<typeof doc>) => [parentSeesDocumentStatus(v, d), parentSeesDocumentFile(v, d)];

  it('shows validity and file only for a current, not deleted, verified document', () => {
    expect(sees(doc())).toEqual([true, true]);
    expect(sees(doc({ doc_type: 'permit' }))).toEqual([true, true]); // no school flag for this type
    for (const o of [{ verification_status: 'pending' }, { verification_status: 'rejected' }, { is_current: false }, { deleted_at: '2026-10-01T00:00:00.000Z' }]) {
      expect(sees(doc(o))).toEqual([false, false]);
      expect(sees(doc({ ...o, doc_type: 'permit' }))).toEqual([false, false]);
    }
    expect(sees(doc({ visible_to_parents_status: false, visible_to_parents_file: false }))).toEqual([false, false]);
  });
});
