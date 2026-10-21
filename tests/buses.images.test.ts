// Bus images (BP §8.3 POST /school/buses/:id/images, §12 thumbnails) and the parent view of a bus
// (BP §13.3 visibility matrix: images, plate, capacity, insurance/fitness status vs files): linking
// uploaded bus_image files, sort order, reorder, captions, delete (file retired), file checks,
// staff/parent file access through the buses hooks, parentBusView filtering (only current,
// verified documents reach parents), isolation.
import type { Request } from 'express';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/tenant.js';
import { parentBusView } from '../src/modules/buses/index.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { buildApp, loginParent, loginSchoolAdmin, loginStaff, passwordHash, type TestApp } from './helpers/authApp.js';

let t: TestApp;
let fx: f.TwoSchoolFixture;
let adminA: string;
let adminB: string;
let driverA: string;
let parentA: string;
let jpeg: Buffer;
let busId: string;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const api = (path: string) => `/api/v1${path}`;
const fakeReq = { protocol: 'http', get: () => 'localhost' } as unknown as Request;

async function uploadImage(entityId: string, token = adminA): Promise<string> {
  const res = await request(t.app).post(api('/files/upload')).set(auth(token)).field('category', 'bus_image').field('entityId', entityId).attach('file', jpeg, 'bus.jpg');
  if (res.status !== 201) throw new Error(`upload failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.id as string;
}
const addImage = (bus: string, body: Record<string, unknown>, token = adminA) => request(t.app).post(api(`/school/buses/${bus}/images`)).set(auth(token)).send(body);
const fileUrl = (id: string, token: string, schoolId?: string) => {
  const r = request(t.app).get(api(`/files/${id}/url`)).set(auth(token));
  return schoolId ? r.set('X-School-Id', schoolId) : r;
};
const setBusVisibility = (patch: Record<string, boolean>) =>
  ownerQuery("update school_settings set parent_visibility = jsonb_set(parent_visibility, '{bus}', (parent_visibility->'bus') || $2::jsonb) where school_id = $1", [fx.a.school.id, JSON.stringify(patch)]);

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  fx = await f.twoSchoolFixture();
  await ownerQuery('update users set password_hash = $1 where id = any ($2)', [await passwordHash(), [fx.a.admin.id, fx.b.admin.id, fx.a.driverUser.id]]);
  adminA = (await loginSchoolAdmin(t.app, String(fx.a.admin.email))).accessToken;
  adminB = (await loginSchoolAdmin(t.app, String(fx.b.admin.email))).accessToken;
  driverA = (await loginStaff(t.app, String(fx.a.school.code), String(fx.a.driverUser.phone))).accessToken;
  parentA = (await loginParent(t, String(fx.a.parent.phone))).accessToken;
  jpeg = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#1b7f3b' } }).jpeg().withExif({ IFD0: { Artist: 'Phone Owner' } }).toBuffer();
  busId = fx.a.bus.id; // R1: the parent's child's bus, driver A's assigned bus
});
afterAll(closeDb);

describe('gallery', () => {
  let first: string;
  let second: string;

  it('links an uploaded bus_image file with signed URL + thumbnail and appends in sort order', async () => {
    const fileId = await uploadImage(busId);
    const res = await addImage(busId, { fileId, caption: 'Front view', school_id: fx.b.school.id });
    expect(res.status).toBe(201);
    first = res.body.data.id;
    expect(res.body.data).toMatchObject({ busId, fileId, caption: 'Front view', sortOrder: 1, contentType: 'image/jpeg' });
    expect(res.body.data.url).toEqual(expect.stringContaining('token='));
    expect(res.body.data.thumbnailUrl).toEqual(expect.stringContaining('token='));
    second = (await addImage(busId, { fileId: await uploadImage(busId) })).body.data.id;
    const list = await request(t.app).get(api(`/school/buses/${busId}/images`)).set(auth(adminA));
    expect(list.body.data.map((i: { id: string; sortOrder: number }) => [i.id, i.sortOrder])).toEqual([[fx.a.busImage.id, 0], [first, 1], [second, 2]]);
    expect((await ownerQuery('select school_id, created_by from bus_images where id = $1', [first])).rows[0]).toEqual({ school_id: fx.a.school.id, created_by: fx.a.admin.id });
  });

  it('reorders the whole gallery and edits captions', async () => {
    const res = await request(t.app).put(api(`/school/buses/${busId}/images/order`)).set(auth(adminA)).send({ imageIds: [second, first, fx.a.busImage.id] });
    expect(res.body.data.map((i: { id: string }) => i.id)).toEqual([second, first, fx.a.busImage.id]);
    const partial = await request(t.app).put(api(`/school/buses/${busId}/images/order`)).set(auth(adminA)).send({ imageIds: [second] });
    expect(partial.status).toBe(400);
    const cap = await request(t.app).patch(api(`/school/buses/${busId}/images/${second}`)).set(auth(adminA)).send({ caption: 'Side view' });
    expect([cap.status, cap.body.data.caption, cap.body.data.sortOrder]).toEqual([200, 'Side view', 0]);
    const detail = await request(t.app).get(api(`/school/buses/${busId}`)).set(auth(adminA));
    expect(detail.body.data.images[0].id).toBe(second);
    expect(detail.body.data.coverThumbnailUrl).toBe(detail.body.data.images[0].thumbnailUrl);
  });

  it('rejects files that are not uploaded bus images of this bus, or already attached', async () => {
    const otherBus = await uploadImage(fx.a.otherBus.id);
    expect((await addImage(busId, { fileId: otherBus })).status).toBe(400);
    const pdfDoc = await request(t.app).post(api('/files/upload')).set(auth(adminA)).field('category', 'bus_document').field('entityId', busId).attach('file', jpeg, 'x.jpg');
    expect((await addImage(busId, { fileId: pdfDoc.body.data.id })).status).toBe(400);
    const fromB = await uploadImage(fx.b.bus.id, adminB);
    expect((await addImage(busId, { fileId: fromB })).status).toBe(404);
    const pending = await f.file(fx.a.school.id, { category: 'bus_image', entity_type: 'bus', entity_id: busId, status: 'pending' });
    expect((await addImage(busId, { fileId: pending.id })).status).toBe(409);
    expect((await addImage(busId, { fileId: fx.a.busImage.file_id })).status).toBe(409);
    expect((await addImage(fx.b.bus.id, { fileId: await uploadImage(busId) })).status).toBe(404);
  });

  it('caps the gallery size', async () => {
    const bus = await f.bus(fx.a.school.id, { code: 'G1' });
    for (let i = 0; i < 12; i += 1) await f.busImage(fx.a.school.id, bus.id);
    const res = await addImage(bus.id, { fileId: await uploadImage(bus.id) });
    expect([res.status, res.body.error.details]).toEqual([409, { maxImages: 12 }]);
  });

  it('deletes an image and retires its file', async () => {
    const fileId = (await ownerQuery<{ file_id: string }>('select file_id from bus_images where id = $1', [first])).rows[0]!.file_id;
    const res = await request(t.app).delete(api(`/school/buses/${busId}/images/${first}`)).set(auth(adminA));
    expect([res.status, res.body.data]).toEqual([200, { id: first, deleted: true }]);
    expect((await ownerQuery('select status from files where id = $1', [fileId])).rows[0]!.status).toBe('deleted');
    expect((await fileUrl(fileId, adminA)).status).toBe(404);
    expect((await request(t.app).delete(api(`/school/buses/${busId}/images/${first}`)).set(auth(adminA))).status).toBe(404);
    expect((await ownerQuery("select 1 from audit_logs where action = 'bus_image.delete' and entity_id = $1", [busId])).rowCount).toBe(1);
  });
});

describe('image access for staff and parents', () => {
  it('the assigned driver reads images of their bus only', async () => {
    expect((await fileUrl(fx.a.busImage.file_id as string, driverA)).status).toBe(200);
    const r2 = await f.busImage(fx.a.school.id, fx.a.otherBus.id);
    expect((await fileUrl(r2.file_id as string, driverA)).status).toBe(404);
  });

  it("parents see their child's bus images while parent_visibility.bus.images is on", async () => {
    const own = fx.a.busImage.file_id as string;
    expect((await fileUrl(own, parentA, fx.a.school.id)).status).toBe(200);
    const r2 = await f.busImage(fx.a.school.id, fx.a.otherBus.id);
    expect((await fileUrl(r2.file_id as string, parentA, fx.a.school.id)).status).toBe(404);
    await setBusVisibility({ images: false });
    expect((await fileUrl(own, parentA, fx.a.school.id)).status).toBe(404);
    await setBusVisibility({ images: true });
    expect((await fileUrl(own, parentA, fx.a.school.id)).status).toBe(200);
  });
});

describe('parentBusView', () => {
  const asParent = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant({ schoolId: fx.a.school.id, actorId: fx.a.parent.id, role: 'parent' }, fn, { readOnly: true });
  const view = () => asParent((tx) => parentBusView(fakeReq, tx, busId));
  const verify = async (docId: string, status: 'verified' | 'rejected' | 'pending') => {
    const res = await request(t.app).patch(api(`/school/bus-documents/${docId}/verify`)).set(auth(adminA)).send(status === 'rejected' ? { status, note: 'Policy number does not match' } : { status });
    if (res.status !== 200) throw new Error(`verify failed ${res.status} ${JSON.stringify(res.body)}`);
  };
  const expiryOf = async (docId: string) => (await ownerQuery<{ d: string }>('select expiry_date::text as d from bus_documents where id = $1', [docId])).rows[0]!.d;

  // Parents only ever see verified documents; the fixture's documents start as 'pending'.
  beforeAll(async () => {
    await verify(fx.a.busDocument.id, 'verified');
    await verify(fx.a.hiddenBusDocument.id, 'verified');
  });

  it('applies the school visibility matrix and the document flags', async () => {
    const view = await asParent((tx) => parentBusView(fakeReq, tx, busId));
    expect(view).toMatchObject({ id: busId, code: 'R1', registrationNo: 'KA01AB1234', capacity: null });
    expect(view!.images.length).toBeGreaterThan(0);
    expect(view!.images[0]!.thumbnailUrl).toEqual(expect.stringContaining('token='));
    expect(view!.documents.map((d) => d.docType)).toEqual(['insurance']); // permit has both flags off
    expect(view!.documents[0]).toMatchObject({ expiryStatus: 'valid', fileId: null });
    expect(view!.documents[0]!.expiryDate).toEqual(expect.any(String));

    await setBusVisibility({ plate: false, capacity: true, images: false, insurance_status: false });
    const hidden = await asParent((tx) => parentBusView(fakeReq, tx, busId));
    expect(hidden).toMatchObject({ registrationNo: null, capacity: 40, images: [], documents: [] });
    await setBusVisibility({ plate: true, capacity: false, images: true, insurance_status: true });
  });

  it('never presents a pending or rejected document as valid: it is left out until verified', async () => {
    const insurance = fx.a.busDocument.id;
    for (const status of ['pending', 'rejected'] as const) {
      await verify(insurance, status);
      expect((await view())!.documents).toEqual([]); // every visibility flag is on — only the verification is missing
    }
    await verify(insurance, 'verified');
    expect((await view())!.documents).toEqual([{ docType: 'insurance', title: null, expiryDate: await expiryOf(insurance), expiryStatus: 'valid', fileId: null }]);
  });

  it('hides a replaced version: a renewal is shown only once it is verified itself', async () => {
    const expiryDate = f.isoDay(565);
    const res = await request(t.app).put(api(`/school/bus-documents/${fx.a.busDocument.id}`)).set(auth(adminA)).send({ title: 'Renewed policy', expiryDate });
    expect([res.status, res.body.data.verificationStatus]).toEqual([201, 'pending']);
    expect((await view())!.documents).toEqual([]); // the verified version is history now, the renewal is pending
    await verify(res.body.data.id as string, 'verified');
    expect((await view())!.documents).toEqual([{ docType: 'insurance', title: 'Renewed policy', expiryDate, expiryStatus: 'valid', fileId: null }]);
  });

  it("returns null for a bus that is not the parent's child's bus or belongs to another school", async () => {
    expect(await asParent((tx) => parentBusView(fakeReq, tx, fx.a.otherBus.id))).toBeNull();
    expect(await asParent((tx) => parentBusView(fakeReq, tx, fx.b.bus.id))).toBeNull();
  });
});
