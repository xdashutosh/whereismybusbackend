// Files (BP §12, contract §2): web multipart proxy with EXIF stripping + thumbnails, presigned
// upload → complete (magic bytes, size, sha256, evidence kept untouched), presigned downloads,
// role/entity/staff-ownership checks, parent access only through category hooks, cross-school
// isolation (A's file from B → 404), mass-assigned school_id ignored, idempotent upload URLs.
import crypto from 'node:crypto';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerFileHooks } from '../src/modules/files/hooks.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { buildApp, loginParent, loginSchoolAdmin, loginStaff, passwordHash, type TestApp } from './helpers/authApp.js';

let t: TestApp;
let fx: f.TwoSchoolFixture;
let adminA: string;
let adminB: string;
let driverA: string;
let jpegWithExif: Buffer;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const pathOf = (url: string) => {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
};

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  fx = await f.twoSchoolFixture();
  await ownerQuery('update users set password_hash = $1 where id = any ($2)', [await passwordHash(), [fx.a.admin.id, fx.b.admin.id, fx.a.driverUser.id]]);
  adminA = (await loginSchoolAdmin(t.app, String(fx.a.admin.email))).accessToken;
  adminB = (await loginSchoolAdmin(t.app, String(fx.b.admin.email))).accessToken;
  driverA = (await loginStaff(t.app, String(fx.a.school.code), String(fx.a.driverUser.phone))).accessToken;
  jpegWithExif = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#0070f2' } })
    .jpeg()
    .withExif({ IFD0: { Copyright: 'Where Is My Bus test', Artist: 'Camera Owner' } })
    .toBuffer();
});
afterAll(closeDb);

async function download(url: string) {
  return request(t.app).get(pathOf(url)).buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
}

function webUpload(token: string, fields: Record<string, string>, file: Buffer, name: string) {
  const req = request(t.app).post('/api/v1/files/upload').set(auth(token));
  for (const [k, v] of Object.entries(fields)) void req.field(k, v);
  return req.attach('file', file, name);
}

describe('web upload (proxied)', () => {
  it('stores parent-visible images without EXIF, with a thumbnail, under the school key', async () => {
    expect((await sharp(jpegWithExif).metadata()).exif).toBeDefined();
    const res = await webUpload(adminA, { category: 'bus_image', entityId: fx.a.bus.id, school_id: fx.b.school.id }, jpegWithExif, 'bus.jpg');
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ category: 'bus_image', entityType: 'bus', entityId: fx.a.bus.id, contentType: 'image/jpeg', status: 'uploaded', hasThumbnail: true });
    expect(res.body.data.metadata).toMatchObject({ exifStripped: true, width: 64, height: 48 });
    const row = (await ownerQuery('select school_id, key, thumb_key from files where id = $1', [res.body.data.id])).rows[0]!;
    expect(row.school_id).toBe(fx.a.school.id);
    expect(row.key).toMatch(new RegExp(`^whereismybus-test/schools/${fx.a.school.id}/bus_image/${fx.a.bus.id}/[0-9a-f-]{36}\\.jpg$`));
    expect(JSON.stringify(res.body)).not.toContain('whereismybus-test/');

    const url = await request(t.app).get(`/api/v1/files/${res.body.data.id}/url`).set(auth(adminA));
    expect(url.status).toBe(200);
    expect(Date.parse(url.body.data.expiresAt) - Date.now()).toBeLessThanOrEqual(300_000);
    const got = await download(url.body.data.url);
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toBe('image/jpeg');
    expect((await sharp(got.body as Buffer).metadata()).exif).toBeUndefined();
    const thumb = await request(t.app).get(`/api/v1/files/${res.body.data.id}/url?variant=thumbnail&ttl=60`).set(auth(adminA));
    expect(thumb.body.data.contentType).toBe('image/webp');
    expect((await download(thumb.body.data.url)).headers['content-type']).toBe('image/webp');

    const audit = await ownerQuery("select school_id from audit_logs where action = 'file.upload' and entity_id = $1", [res.body.data.id]);
    expect(audit.rows).toEqual([{ school_id: fx.a.school.id }]);
  });

  it('accepts PDFs for documents and rejects content that does not match its magic bytes', async () => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
    const doc = await webUpload(adminA, { category: 'bus_document', entityId: fx.a.bus.id }, pdf, 'insurance.pdf');
    expect(doc.status).toBe(201);
    expect(doc.body.data).toMatchObject({ contentType: 'application/pdf', hasThumbnail: false, fileName: 'insurance.pdf' });
    const fake = await webUpload(adminA, { category: 'bus_image', entityId: fx.a.bus.id }, Buffer.from('this is not an image at all'), 'evil.jpg');
    expect([fake.status, fake.body.error.code]).toEqual([415, 'UNSUPPORTED_FILE']);
    const missing = await request(t.app).post('/api/v1/files/upload').set(auth(adminA)).field('category', 'bus_image').field('entityId', fx.a.bus.id);
    expect(missing.status).toBe(400);
  });

  it('refuses entities of another school and categories outside the role', async () => {
    const cross = await webUpload(adminB, { category: 'bus_image', entityId: fx.a.bus.id }, jpegWithExif, 'x.jpg');
    expect([cross.status, cross.body.error.code]).toEqual([404, 'NOT_FOUND']);
    const role = await webUpload(driverA, { category: 'bus_image', entityId: fx.a.bus.id }, jpegWithExif, 'x.jpg');
    expect(role.status).toBe(403);
  });
});

describe('presigned upload (mobile)', () => {
  const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
  const uploadUrl = (token: string, body: object, key?: string) => {
    const r = request(t.app).post('/api/v1/files/upload-url').set(auth(token));
    if (key) void r.set('Idempotency-Key', key);
    return r.send(body);
  };

  it('driver uploads odometer evidence: original kept byte-for-byte, thumbnail made, sha256 verified', async () => {
    const body = { category: 'odometer', entityType: 'trip', entityId: fx.a.trip.id, contentType: 'image/jpeg', sizeBytes: jpegWithExif.length, sha256: sha(jpegWithExif), metadata: { capturedAt: new Date().toISOString(), latitude: 12.97, longitude: 77.59, source: 'camera' } };
    const res = await uploadUrl(driverA, body, 'odo-key-0001');
    expect(res.status).toBe(201);
    expect(res.body.data.file).toMatchObject({ status: 'pending', category: 'odometer' });
    expect(res.body.data.upload).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'image/jpeg' } });
    const replay = await uploadUrl(driverA, body, 'odo-key-0001');
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.data.file.id).toBe(res.body.data.file.id);

    const id = res.body.data.file.id as string;
    expect((await request(t.app).post(`/api/v1/files/${id}/complete`).set(auth(driverA)).send({})).body.error.code).toBe('INVALID_STATE');
    const put = await request(t.app).put(pathOf(res.body.data.upload.url)).set('Content-Type', 'image/jpeg').send(jpegWithExif);
    expect(put.status).toBe(200);
    const done = await request(t.app).post(`/api/v1/files/${id}/complete`).set(auth(driverA)).send({});
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ status: 'uploaded', sha256: sha(jpegWithExif), sizeBytes: jpegWithExif.length, hasThumbnail: true, metadata: { capture: { source: 'camera' } } });
    expect((await request(t.app).post(`/api/v1/files/${id}/complete`).set(auth(driverA)).send({})).status).toBe(200); // idempotent
    const url = await request(t.app).get(`/api/v1/files/${id}/url`).set(auth(driverA));
    const got = await download(url.body.data.url);
    expect(sha(got.body as Buffer)).toBe(sha(jpegWithExif));
  });

  it('rejects disguised content and checksum mismatches at completion and deletes the object', async () => {
    const junk = Buffer.from('definitely not a jpeg image payload');
    const res = await uploadUrl(driverA, { category: 'odometer', entityId: fx.a.trip.id, contentType: 'image/jpeg', sizeBytes: junk.length });
    await request(t.app).put(pathOf(res.body.data.upload.url)).set('Content-Type', 'image/jpeg').send(junk);
    const done = await request(t.app).post(`/api/v1/files/${res.body.data.file.id}/complete`).set(auth(driverA)).send({});
    expect([done.status, done.body.error.code]).toEqual([415, 'UNSUPPORTED_FILE']);
    const row = (await ownerQuery('select status, key from files where id = $1', [res.body.data.file.id])).rows[0]!;
    expect(row.status).toBe('rejected');

    const mismatch = await uploadUrl(driverA, { category: 'odometer', entityId: fx.a.trip.id, contentType: 'image/jpeg', sizeBytes: jpegWithExif.length, sha256: 'a'.repeat(64) });
    await request(t.app).put(pathOf(mismatch.body.data.upload.url)).set('Content-Type', 'image/jpeg').send(jpegWithExif);
    const bad = await request(t.app).post(`/api/v1/files/${mismatch.body.data.file.id}/complete`).set(auth(driverA)).send({});
    expect([bad.status, bad.body.error.details[0].path]).toEqual([400, 'sha256']);
  });

  it('checks role, type, size, entity school and staff assignment', async () => {
    const base = { contentType: 'image/jpeg', sizeBytes: 1000 };
    expect((await uploadUrl(driverA, { ...base, category: 'bus_image', entityId: fx.a.bus.id })).status).toBe(403);
    expect((await uploadUrl(driverA, { ...base, category: 'odometer', entityId: fx.b.trip.id })).status).toBe(404);
    expect((await uploadUrl(driverA, { ...base, category: 'odometer', entityType: 'bus', entityId: fx.a.otherBus.id })).status).toBe(403);
    expect((await uploadUrl(driverA, { ...base, category: 'odometer', entityType: 'bus', entityId: fx.a.bus.id })).status).toBe(201);
    expect((await uploadUrl(driverA, { ...base, category: 'odometer', entityId: fx.a.trip.id, contentType: 'application/pdf' })).status).toBe(415);
    expect((await uploadUrl(driverA, { ...base, category: 'odometer', entityId: fx.a.trip.id, sizeBytes: 50 * 1024 * 1024 })).status).toBe(413);
    expect((await uploadUrl(adminA, { ...base, category: 'report' })).status).toBe(403);
    expect((await uploadUrl(adminA, { ...base, category: 'bus_image', entityType: 'staff', entityId: fx.a.bus.id })).status).toBe(400);
    expect((await request(t.app).put('/api/v1/files/local/upload?token=forged.token').set('Content-Type', 'image/jpeg').send(jpegWithExif)).status).toBe(401);
  });
});

describe('download authorization', () => {
  let busImageId: string;
  let logoId: string;
  let parentToken: string;

  beforeAll(async () => {
    busImageId = (await webUpload(adminA, { category: 'bus_image', entityId: fx.a.bus.id }, jpegWithExif, 'r1.jpg')).body.data.id as string;
    logoId = (await webUpload(adminA, { category: 'school_logo' }, jpegWithExif, 'logo.jpg')).body.data.id as string;
    await ownerQuery('update schools set logo_file_id = $1 where id = $2', [logoId, fx.a.school.id]);
    parentToken = (await loginParent(t, String(fx.a.parent.phone))).accessToken;
  });

  it('school A’s file URL is denied to school B (404) and to staff who did not upload it', async () => {
    const fromB = await request(t.app).get(`/api/v1/files/${busImageId}/url`).set(auth(adminB));
    expect([fromB.status, fromB.body.error.code]).toEqual([404, 'NOT_FOUND']);
    expect((await request(t.app).get(`/api/v1/files/${busImageId}/url`).set(auth(driverA))).status).toBe(404);
    expect((await request(t.app).get(`/api/v1/files/${logoId}/url`).set(auth(driverA))).status).toBe(200);
  });

  it('parents read only what a category hook grants (school logo built in; bus images via the buses hook)', async () => {
    const asParent = (id: string) => request(t.app).get(`/api/v1/files/${id}/url`).set(auth(parentToken)).set('X-School-Id', fx.a.school.id);
    expect((await asParent(logoId)).status).toBe(200);
    expect((await asParent(busImageId)).status).toBe(404);
    const unregister = registerFileHooks('bus_image', { parentRead: async ({ tx, file }) => (await tx.maybeOne('select 1 from bus_images where file_id = $1', [file.id])) !== null });
    try {
      expect((await asParent(busImageId)).status).toBe(404); // not attached as a bus image yet → hidden
      await ownerQuery('insert into bus_images (school_id, bus_id, file_id) values ($1, $2, $3)', [fx.a.school.id, fx.a.bus.id, busImageId]);
      expect((await asParent(busImageId)).status).toBe(200);
      const otherSchool = await request(t.app).get(`/api/v1/files/${busImageId}/url`).set(auth(parentToken)).set('X-School-Id', fx.b.school.id);
      expect(otherSchool.status).toBe(403); // parent A has no child in school B
    } finally {
      unregister();
    }
    const profile = await request(t.app).get('/api/v1/auth/me').set(auth(parentToken));
    expect(profile.body.data.schools[0].school.logoUrl).toEqual(expect.stringContaining('/api/v1/files/local/download?token='));
  });

  it('rejects tampered download tokens', async () => {
    const url = await request(t.app).get(`/api/v1/files/${busImageId}/url`).set(auth(adminA));
    const tampered = pathOf(url.body.data.url).replace(/token=([^&]{5})/, 'token=AAAAA');
    expect((await request(t.app).get(tampered)).status).toBe(401);
  });
});
