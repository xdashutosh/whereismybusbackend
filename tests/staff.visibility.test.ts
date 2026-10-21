// Parent visibility of drivers/conductors (BP §13.3 parent-visibility preview, §15 staff cards,
// §12 file access, §16): GET /school/staff/:id/parent-preview follows the school matrix and the
// document flags and never exposes internal fields; validity and files only for current, verified
// documents (pending/rejected ones are listed as "not verified", replaced versions never count);
// the exported parent card builders return the same card in a parent context (RLS: only staff on
// the child's buses); staff_photo / staff_document file URLs for parents apply the matrix and the
// verification, for drivers only their own files.
import type { ParentStaffPreview } from '@wimb/shared';
import type { Request } from 'express';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/tenant.js';
import { parentStaffCard, parentStaffForBus } from '../src/modules/staff/index.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { buildApp, loginParent, loginSchoolAdmin, loginStaff, passwordHash, type TestApp } from './helpers/authApp.js';

let t: TestApp;
let fx: f.TwoSchoolFixture;
let adminA: string;
let driverA: string;
let parentA: string;
let photoId: string;
let otherPhotoId: string;
let licenceFileId: string;
let identityFileId: string;
let policeFileId: string;
let licenceDocId: string;
let policeDocId: string;
let licenceExpiry: string;
let policeExpiry: string;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const api = (p: string) => `/api/v1${p}`;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const fakeReq = { protocol: 'http', get: () => 'localhost' } as unknown as Request;

async function upload(entityId: string, category: string): Promise<string> {
  const body = category === 'staff_photo' ? await sharp({ create: { width: 48, height: 48, channels: 3, background: '#f0ab00' } }).png().toBuffer() : PDF;
  const res = await request(t.app).post(api('/files/upload')).set(auth(adminA)).field('category', category).field('entityId', entityId).attach('file', body, category === 'staff_photo' ? 'p.png' : 'd.pdf');
  if (res.status !== 201) throw new Error(`upload failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.id as string;
}
const fileStatus = async (id: string, token: string, schoolId?: string) => {
  const r = request(t.app).get(api(`/files/${id}/url`)).set(auth(token));
  return (await (schoolId ? r.set('X-School-Id', schoolId) : r)).status;
};
const preview = async (staffId: string): Promise<ParentStaffPreview> => (await request(t.app).get(api(`/school/staff/${staffId}/parent-preview`)).set(auth(adminA))).body.data as ParentStaffPreview;
const setMatrix = async (body: Record<string, unknown>) => {
  const res = await request(t.app).put(api('/school/settings/parent-visibility')).set(auth(adminA)).send(body);
  if (res.status !== 200) throw new Error(`matrix update failed ${res.status} ${JSON.stringify(res.body)}`);
};
const verifyDoc = async (docId: string, status: 'verified' | 'rejected' | 'pending') => {
  const res = await request(t.app).patch(api(`/school/staff-documents/${docId}/verify`)).set(auth(adminA)).send(status === 'rejected' ? { status, note: 'Does not match the original' } : { status });
  if (res.status !== 200) throw new Error(`verify failed ${res.status} ${JSON.stringify(res.body)}`);
};
const replaceDoc = async (docId: string, body: Record<string, unknown>): Promise<string> => {
  const res = await request(t.app).put(api(`/school/staff-documents/${docId}`)).set(auth(adminA)).send(body);
  if (res.status !== 201) throw new Error(`replace failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.id as string;
};
const setDocVisibility = async (docId: string, body: Record<string, boolean>) => {
  const res = await request(t.app).patch(api(`/school/staff-documents/${docId}/visibility`)).set(auth(adminA)).send(body);
  if (res.status !== 200) throw new Error(`visibility failed ${res.status} ${JSON.stringify(res.body)}`);
};
const docsOf = (p: ParentStaffPreview) => Object.fromEntries(p.card.documents.map((d) => [d.docType, d]));
/** A pending/rejected document on the parent card: its status only — no validity, no file. */
const notVerified = (docType: string, verificationStatus: string) => ({ docType, title: null, verificationStatus, expiryDate: null, expiryStatus: 'none', fileId: null });
const asParent = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(f.contexts.parent(fx.a.parent.id, fx.a.school.id), fn, { readOnly: true });

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  fx = await f.twoSchoolFixture();
  await ownerQuery('update users set password_hash = $1 where id = any ($2)', [await passwordHash(), [fx.a.admin.id, fx.b.admin.id, fx.a.driverUser.id]]);
  adminA = (await loginSchoolAdmin(t.app, String(fx.a.admin.email))).accessToken;
  driverA = (await loginStaff(t.app, String(fx.a.school.code), String(fx.a.driverUser.phone))).accessToken;
  parentA = (await loginParent(t, String(fx.a.parent.phone))).accessToken;
  const d = fx.a.driver.id;
  licenceExpiry = f.isoDay(400);
  await request(t.app).patch(api(`/school/staff/${d}`)).set(auth(adminA)).send({
    email: 'ramesh@example.test', address: '7 Hidden Lane', experienceYears: 11, experienceSummary: 'Ex-KSRTC', joiningDate: '2020-06-01',
    idProofType: 'aadhaar', idProofLast4: '4321', licenceExpiryDate: licenceExpiry, emergencyContactName: 'Secret Contact',
  });
  photoId = await upload(d, 'staff_photo');
  await request(t.app).patch(api(`/school/staff/${d}`)).set(auth(adminA)).send({ photoFileId: photoId });
  otherPhotoId = await upload(fx.a.otherDriver.id, 'staff_photo');
  await request(t.app).patch(api(`/school/staff/${fx.a.otherDriver.id}`)).set(auth(adminA)).send({ photoFileId: otherPhotoId });
  licenceFileId = await upload(d, 'staff_document');
  const licence = await request(t.app).post(api(`/school/staff/${d}/documents`)).set(auth(adminA)).send({ docType: 'licence_front', fileId: licenceFileId, expiryDate: licenceExpiry, visibleToParentsFile: true });
  licenceDocId = licence.body.data.id as string;
  identityFileId = await upload(d, 'staff_document');
  await ownerQuery('update staff_documents set file_id = $1 where id = $2', [identityFileId, fx.a.identityDocument.id]);
  policeFileId = await upload(d, 'staff_document');
  policeDocId = fx.a.driverDocument.id;
  await ownerQuery('update staff_documents set file_id = $1, visible_to_parents_file = true where id = $2', [policeFileId, policeDocId]);
  policeExpiry = (await ownerQuery<{ d: string }>('select expiry_date::text as d from staff_documents where id = $1', [policeDocId])).rows[0]!.d;
  await request(t.app).post(api(`/school/staff/${d}/documents`)).set(auth(adminA)).send({ docType: 'other', title: 'Internal note', visibleToParentsStatus: false });
});
afterAll(closeDb);

describe('GET /school/staff/:id/parent-preview', () => {
  it('shows unverified documents as not verified (no validity, no file) and never internal fields', async () => {
    const p = await preview(fx.a.driver.id);
    expect(p).toMatchObject({ staffId: fx.a.driver.id, staffType: 'driver', visibleToParents: true, hiddenReasons: [], buses: [{ busCode: 'R1', role: 'primary_driver' }] });
    expect(p.hiddenFields.sort()).toEqual(['email', 'licenceFile', 'phone']);
    expect(p.card).toMatchObject({
      fullName: 'Ramesh Kumar', phone: null, email: null,
      experience: { years: 11, summary: 'Ex-KSRTC', joiningDate: '2020-06-01' },
      licence: { expiryDate: null, expiryStatus: 'none', verificationStatus: 'pending' }, // never "valid" before verification
      verification: { identity: 'pending', policeVerification: 'pending' },
    });
    expect(p.card.photo!.fileId).toBe(photoId);
    const docs = docsOf(p);
    // Both documents are still pending: listed as not verified, without validity or file (the police file switch is on).
    expect(docs.licence_front).toEqual(notVerified('licence_front', 'pending'));
    expect(docs.police_verification).toEqual(notVerified('police_verification', 'pending'));
    expect(docs.identity).toBeUndefined();
    expect(docs.other).toBeUndefined();
    const reasons = Object.fromEntries(p.hiddenDocuments.map((d) => [d.docType, d.reason]));
    expect(reasons).toEqual({ identity: 'IDENTITY', other: 'DOCUMENT_FLAGS' });
    const json = JSON.stringify(p);
    for (const secret of ['7 Hidden Lane', 'Secret Contact', '4321', String(fx.a.driver.licence_no), String(fx.a.driverUser.phone)]) expect(json).not.toContain(secret);
  });

  it('shows validity (and the files the school allows) once the documents are verified', async () => {
    await verifyDoc(licenceDocId, 'verified'); // also sets the profile's licence verification
    await verifyDoc(policeDocId, 'verified');
    const p = await preview(fx.a.driver.id);
    expect(p.card.licence).toEqual({ expiryDate: licenceExpiry, expiryStatus: 'valid', verificationStatus: 'verified' });
    expect(p.card.verification).toEqual({ identity: 'pending', policeVerification: 'verified' });
    const docs = docsOf(p);
    expect(docs.licence_front).toEqual({ docType: 'licence_front', title: null, verificationStatus: 'verified', expiryDate: licenceExpiry, expiryStatus: 'valid', fileId: null }); // licenceFile off
    expect(docs.police_verification).toEqual({ docType: 'police_verification', title: null, verificationStatus: 'verified', expiryDate: policeExpiry, expiryStatus: 'valid', fileId: policeFileId });
  });

  it('never presents a rejected document as valid (documents and licence summary)', async () => {
    await verifyDoc(licenceDocId, 'rejected');
    await verifyDoc(policeDocId, 'rejected');
    const p = await preview(fx.a.driver.id);
    expect(p.card.licence).toEqual({ expiryDate: null, expiryStatus: 'none', verificationStatus: 'rejected' });
    expect(p.card.verification).toEqual({ identity: 'pending', policeVerification: 'rejected' });
    expect(docsOf(p).licence_front).toEqual(notVerified('licence_front', 'rejected'));
    expect(docsOf(p).police_verification).toEqual(notVerified('police_verification', 'rejected'));
    expect(p.hiddenDocuments.map((d) => d.docType).sort()).toEqual(['identity', 'other']);
    await verifyDoc(licenceDocId, 'verified');
    await verifyDoc(policeDocId, 'verified');
  });

  it('a renewal waiting for verification never inherits the verdict on the replaced version', async () => {
    const renewedExpiry = f.isoDay(1500);
    licenceDocId = await replaceDoc(licenceDocId, { expiryDate: renewedExpiry }); // keeps scan and switches; verification starts again
    const profile = await ownerQuery<{ s: string }>('select licence_verification_status as s from staff_profiles where id = $1', [fx.a.driver.id]);
    expect(profile.rows[0]!.s).toBe('pending'); // the verdict was on the replaced version → reset
    const pending = await preview(fx.a.driver.id);
    expect(pending.card.licence).toEqual({ expiryDate: null, expiryStatus: 'none', verificationStatus: 'pending' });
    expect(pending.card.documents.filter((d) => d.docType === 'licence_front')).toEqual([notVerified('licence_front', 'pending')]); // the old version is gone
    await verifyDoc(licenceDocId, 'verified');
    const verified = await preview(fx.a.driver.id);
    expect(verified.card.licence).toEqual({ expiryDate: licenceExpiry, expiryStatus: 'valid', verificationStatus: 'verified' });
    expect(docsOf(verified).licence_front).toMatchObject({ verificationStatus: 'verified', expiryDate: renewedExpiry, expiryStatus: 'valid' });
  });

  it('a document offered only for its file is hidden while unverified and shows just the file once verified', async () => {
    await setDocVisibility(policeDocId, { visibleToParentsStatus: false }); // file switch stays on
    await verifyDoc(policeDocId, 'pending');
    const pending = await preview(fx.a.driver.id);
    expect(docsOf(pending).police_verification).toBeUndefined();
    // The switches and the matrix offer the file: hidden only because the document is not verified.
    expect(pending.hiddenDocuments.find((d) => d.docType === 'police_verification')!.reason).toBe('NOT_VERIFIED');
    expect(pending.card.verification!.policeVerification).toBeNull(); // the status switch is off
    await setMatrix({ driver: { verification: false } });
    const matrixOff = await preview(fx.a.driver.id);
    expect(matrixOff.hiddenDocuments.find((d) => d.docType === 'police_verification')!.reason).toBe('SCHOOL_SETTING');
    await setMatrix({ driver: { verification: true } });
    await verifyDoc(policeDocId, 'verified');
    const verified = await preview(fx.a.driver.id);
    expect(docsOf(verified).police_verification).toEqual({ docType: 'police_verification', title: null, verificationStatus: null, expiryDate: null, expiryStatus: 'none', fileId: policeFileId });
    await setDocVisibility(policeDocId, { visibleToParentsStatus: true });
  });

  it('follows matrix changes (phone, licence file, photo, verification)', async () => {
    await verifyDoc(licenceDocId, 'verified');
    await setMatrix({ driver: { phone: true, licenceFile: true, photo: false, verification: false, training: false } });
    const p = await preview(fx.a.driver.id);
    expect(p.card).toMatchObject({ phone: fx.a.driver.phone, photo: null, verification: null });
    expect(p.card.documents.find((d) => d.docType === 'licence_front')!.fileId).toBe(licenceFileId);
    expect(p.card.documents.find((d) => d.docType === 'police_verification')).toBeUndefined();
    expect(p.hiddenDocuments.find((d) => d.docType === 'police_verification')!.reason).toBe('SCHOOL_SETTING');
    await setMatrix({ driver: { phone: false, licenceFile: false, photo: true, verification: true, training: true } });
  });

  it('explains why a card is not shown (inactive, not assigned)', async () => {
    const fresh = (await request(t.app).post(api('/school/staff')).set(auth(adminA)).send({ staffType: 'conductor', fullName: 'Asha N' })).body.data.id;
    expect(await preview(fresh)).toMatchObject({ visibleToParents: false, hiddenReasons: ['NOT_ASSIGNED'], buses: [] });
    await request(t.app).post(api(`/school/staff/${fresh}/deactivate`)).set(auth(adminA)).send({});
    expect((await preview(fresh)).hiddenReasons).toEqual(['INACTIVE', 'NOT_ASSIGNED']);
  });
});

describe('parent cards (exported for the parent module)', () => {
  it('returns the crew of the child’s bus, identical to the preview cards', async () => {
    const cards = await asParent((tx) => parentStaffForBus(fakeReq, tx, fx.a.bus.id));
    expect(cards.map((c) => [c.role, c.fullName])).toEqual([['primary_driver', 'Ramesh Kumar'], ['conductor', 'Suresh Babu']]);
    const p = await preview(fx.a.driver.id);
    const { photo: _a, ...card } = cards[0]!;
    const { photo: _b, ...expected } = p.card;
    expect({ ...card, role: undefined }).toEqual({ ...expected, role: undefined });
  });

  it('parents get the same "not verified" entries as the preview', async () => {
    await verifyDoc(policeDocId, 'rejected');
    const [driverCard] = await asParent((tx) => parentStaffForBus(fakeReq, tx, fx.a.bus.id));
    const p = await preview(fx.a.driver.id);
    const { photo: _a, ...card } = driverCard!;
    const { photo: _b, ...expected } = p.card;
    expect({ ...card, role: undefined }).toEqual({ ...expected, role: undefined });
    expect(card.documents.find((d) => d.docType === 'police_verification')).toEqual(notVerified('police_verification', 'rejected'));
    await verifyDoc(policeDocId, 'verified');
  });

  it('returns nothing for staff the parent may not see (RLS) or inactive staff', async () => {
    expect(await asParent((tx) => parentStaffForBus(fakeReq, tx, fx.a.otherBus.id))).toEqual([]);
    expect(await asParent((tx) => parentStaffCard(fakeReq, tx, fx.a.otherDriver.id))).toBeNull();
    expect(await asParent((tx) => parentStaffCard(fakeReq, tx, fx.b.driver.id))).toBeNull();
  });
});

describe('file access', () => {
  // Parents only ever get files of verified documents.
  beforeAll(async () => {
    await verifyDoc(licenceDocId, 'verified');
    await verifyDoc(policeDocId, 'verified');
  });

  it('parents: photo with the photo flag, documents with document flag AND matrix flag, never identity', async () => {
    const A = fx.a.school.id;
    expect(await fileStatus(photoId, parentA, A)).toBe(200);
    expect(await fileStatus(policeFileId, parentA, A)).toBe(200);
    expect(await fileStatus(licenceFileId, parentA, A)).toBe(404); // licenceFile off by default
    expect(await fileStatus(identityFileId, parentA, A)).toBe(404);
    expect(await fileStatus(otherPhotoId, parentA, A)).toBe(404); // driver of a bus unrelated to the child
    await setMatrix({ driver: { licenceFile: true, photo: false } });
    expect(await fileStatus(licenceFileId, parentA, A)).toBe(200);
    expect(await fileStatus(photoId, parentA, A)).toBe(404);
    await setMatrix({ driver: { verification: false } });
    expect(await fileStatus(policeFileId, parentA, A)).toBe(404);
    await setMatrix({ driver: { licenceFile: false, photo: true, verification: true } });
    expect(await fileStatus(photoId, parentA, fx.b.school.id)).toBe(403); // the parent has no child in school B
  });

  it('parents never get the file of a pending or rejected document, even with every flag on', async () => {
    const A = fx.a.school.id;
    const both = async () => [await fileStatus(licenceFileId, parentA, A), await fileStatus(policeFileId, parentA, A)];
    await setMatrix({ driver: { licenceFile: true } });
    expect(await both()).toEqual([200, 200]);
    for (const status of ['pending', 'rejected'] as const) {
      await verifyDoc(licenceDocId, status);
      await verifyDoc(policeDocId, status);
      expect(await both()).toEqual([404, 404]);
    }
    expect(await fileStatus(licenceFileId, driverA)).toBe(200); // the driver still opens their own documents
    await verifyDoc(licenceDocId, 'verified');
    await verifyDoc(policeDocId, 'verified');
    expect(await both()).toEqual([200, 200]);
    await setMatrix({ driver: { licenceFile: false } });
  });

  it('parents lose access when the staff member is deactivated', async () => {
    await ownerQuery('update staff_profiles set is_active = false where id = $1', [fx.a.driver.id]);
    expect(await fileStatus(photoId, parentA, fx.a.school.id)).toBe(404);
    await ownerQuery('update staff_profiles set is_active = true where id = $1', [fx.a.driver.id]);
    expect(await fileStatus(photoId, parentA, fx.a.school.id)).toBe(200);
  });

  it('drivers: their own photo and documents only; admins: everything of their school (not other schools)', async () => {
    expect(await fileStatus(photoId, driverA)).toBe(200);
    expect(await fileStatus(identityFileId, driverA)).toBe(200);
    expect(await fileStatus(otherPhotoId, driverA)).toBe(404);
    expect(await fileStatus(otherPhotoId, adminA)).toBe(200);
    const adminB = (await loginSchoolAdmin(t.app, String(fx.b.admin.email))).accessToken;
    expect(await fileStatus(photoId, adminB)).toBe(404);
  });

  it('replaced versions: the old scan is no longer served and the renewal needs its own verification', async () => {
    const A = fx.a.school.id;
    await setMatrix({ driver: { licenceFile: true } });
    expect(await fileStatus(licenceFileId, parentA, A)).toBe(200);
    const renewalFile = await upload(fx.a.driver.id, 'staff_document');
    licenceDocId = await replaceDoc(licenceDocId, { fileId: renewalFile, expiryDate: f.isoDay(1800) });
    expect(await fileStatus(licenceFileId, parentA, A)).toBe(404); // verified, but its version was replaced
    expect(await fileStatus(renewalFile, parentA, A)).toBe(404); // current, but pending
    await verifyDoc(licenceDocId, 'verified');
    expect(await fileStatus(renewalFile, parentA, A)).toBe(200);
    expect(await fileStatus(licenceFileId, parentA, A)).toBe(404);
    await setMatrix({ driver: { licenceFile: false } });
  });

  it('refuses staff uploads for deleted or unknown staff profiles', async () => {
    const gone = (await request(t.app).post(api('/school/staff')).set(auth(adminA)).send({ staffType: 'conductor', fullName: 'Gone' })).body.data.id;
    await request(t.app).delete(api(`/school/staff/${gone}`)).set(auth(adminA));
    const res = await request(t.app).post(api('/files/upload')).set(auth(adminA)).field('category', 'staff_document').field('entityId', gone).attach('file', PDF, 'd.pdf');
    expect(res.status).toBe(404);
    const wrongType = await request(t.app).post(api('/files/upload')).set(auth(adminA)).field('category', 'staff_photo').field('entityType', 'bus').field('entityId', fx.a.bus.id).attach('file', PDF, 'd.pdf');
    expect(wrongType.status).toBe(400);
  });
});
