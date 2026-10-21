// School profile (BP §8.3 GET/PATCH /school/profile): own school only, immutable code and platform
// fields, phone/e-mail normalisation, school_logo linking (→ /auth/me logoUrl), audit, roles and
// cross-school isolation (school A's admin never reads or changes school B).
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { events } from '../src/shared/events.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { buildApp, loginParent, loginSchoolAdmin, loginStaff, passwordHash, type TestApp } from './helpers/authApp.js';

let t: TestApp;
let fx: f.TwoSchoolFixture;
let adminA: string;
let adminB: string;
let driverA: string;
let parentA: string;
let png: Buffer;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  fx = await f.twoSchoolFixture();
  await ownerQuery('update users set password_hash = $1 where id = any ($2)', [await passwordHash(), [fx.a.admin.id, fx.b.admin.id, fx.a.driverUser.id]]);
  adminA = (await loginSchoolAdmin(t.app, String(fx.a.admin.email))).accessToken;
  adminB = (await loginSchoolAdmin(t.app, String(fx.b.admin.email))).accessToken;
  driverA = (await loginStaff(t.app, String(fx.a.school.code), String(fx.a.driverUser.phone))).accessToken;
  parentA = (await loginParent(t, String(fx.a.parent.phone))).accessToken;
  png = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#1b7f3b' } }).png().toBuffer();
});
afterAll(closeDb);

async function uploadLogo(token: string): Promise<string> {
  const res = await request(t.app).post('/api/v1/files/upload').set(auth(token)).field('category', 'school_logo').attach('file', png, 'logo.png');
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

describe('GET /school/profile', () => {
  it("returns the caller's own school with location and subscription", async () => {
    const res = await request(t.app).get('/api/v1/school/profile').set(auth(adminA));
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d).toMatchObject({ id: fx.a.school.id, code: fx.a.school.code, name: 'Greenfield Public School', institutionType: 'school', timezone: 'Asia/Kolkata', status: 'active', logoUrl: null });
    expect(d.location).toEqual({ lat: 12.9716, lng: 77.5946 });
    expect(d.subscription).toMatchObject({ plan: 'standard', status: 'active', maxBuses: 50 });
    const resB = await request(t.app).get('/api/v1/school/profile').set(auth(adminB));
    expect(resB.body.data.id).toBe(fx.b.school.id);
  });

  it('is limited to school admins', async () => {
    expect((await request(t.app).get('/api/v1/school/profile')).status).toBe(401);
    expect((await request(t.app).get('/api/v1/school/profile').set(auth(driverA))).status).toBe(403);
    const parent = await request(t.app).get('/api/v1/school/profile').set(auth(parentA)).set('X-School-Id', fx.a.school.id);
    expect(parent.status).toBe(403);
  });
});

describe('PATCH /school/profile', () => {
  it('updates profile fields, normalises contacts, audits and ignores school_id / platform fields', async () => {
    const seen: unknown[] = [];
    const off = events.on('school.profile_changed', (p) => void seen.push(p));
    const res = await request(t.app)
      .patch('/api/v1/school/profile')
      .set(auth(adminA))
      .send({
        name: 'Greenfield Public School, Whitefield',
        address: '12 ITPL Main Road',
        contactName: 'Anita Rao',
        contactPhone: '98450 12345',
        contactEmail: 'Office@Greenfield.TEST',
        location: { lat: 12.9698, lng: 77.75 },
        geofenceRadiusM: 250,
        brandColor: '#0070F2',
        pincode: '560066',
        school_id: fx.b.school.id,
        schoolId: fx.b.school.id,
        status: 'suspended',
        institutionType: 'college',
      });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: fx.a.school.id,
      name: 'Greenfield Public School, Whitefield',
      contactPhone: '+919845012345',
      contactEmail: 'office@greenfield.test',
      location: { lat: 12.9698, lng: 77.75 },
      geofenceRadiusM: 250,
      status: 'active',
      institutionType: 'school',
    });
    const b = await ownerQuery<{ name: string; status: string }>('select name, status from schools where id = $1', [fx.b.school.id]);
    expect(b.rows[0]).toEqual({ name: 'Greenfield Public School', status: 'active' });
    const a = await ownerQuery<{ status: string; institution_type: string }>('select status, institution_type from schools where id = $1', [fx.a.school.id]);
    expect(a.rows[0]).toEqual({ status: 'active', institution_type: 'school' });
    const log = await ownerQuery<{ old_values: Record<string, unknown>; new_values: Record<string, unknown> }>(
      "select old_values, new_values from audit_logs where school_id = $1 and action = 'school.update' order by id desc limit 1",
      [fx.a.school.id],
    );
    expect(log.rows[0]!.old_values.name).toBe('Greenfield Public School');
    expect(log.rows[0]!.new_values.contactPhone).toBe('+919845012345');
    await new Promise((r) => setTimeout(r, 5));
    off();
    expect(seen).toEqual([expect.objectContaining({ schoolId: fx.a.school.id, changedFields: expect.arrayContaining(['name', 'location']) })]);
  });

  it('refuses to change the school code', async () => {
    const res = await request(t.app).patch('/api/v1/school/profile').set(auth(adminA)).send({ code: 'HACKED', name: 'X' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'code' })]));
    const row = await ownerQuery<{ code: string }>('select code from schools where id = $1', [fx.a.school.id]);
    expect(row.rows[0]!.code).toBe(fx.a.school.code);
  });

  it('validates fields', async () => {
    const res = await request(t.app)
      .patch('/api/v1/school/profile')
      .set(auth(adminA))
      .send({ name: '  ', timezone: 'Mars/Olympus', brandColor: 'blue', geofenceRadiusM: 5, contactPhone: '12', contactEmail: 'nope', location: { lat: 91, lng: 0 } });
    expect(res.status).toBe(400);
    const paths = (res.body.error.details as { path: string }[]).map((d) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['name', 'timezone', 'brandColor', 'geofenceRadiusM', 'contactPhone', 'contactEmail', 'location.lat']));
  });

  it('changes the timezone (resolveTenant picks it up) and clears optional fields with null', async () => {
    const res = await request(t.app).patch('/api/v1/school/profile').set(auth(adminA)).send({ timezone: 'Asia/Dubai', address: '', location: null });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ timezone: 'Asia/Dubai', address: null, location: null });
    const back = await request(t.app).patch('/api/v1/school/profile').set(auth(adminA)).send({ timezone: 'Asia/Kolkata', location: { lat: 12.9716, lng: 77.5946 } });
    expect(back.body.data.timezone).toBe('Asia/Kolkata');
  });

  it('links an uploaded school logo → profile and /auth/me return a signed logoUrl', async () => {
    const fileId = await uploadLogo(adminA);
    const res = await request(t.app).patch('/api/v1/school/profile').set(auth(adminA)).send({ logoFileId: fileId });
    expect(res.status).toBe(200);
    expect(res.body.data.logoFileId).toBe(fileId);
    expect(res.body.data.logoUrl).toMatch(/^http/);
    const me = await request(t.app).get('/api/v1/auth/me').set(auth(adminA));
    expect(me.body.data.school.logoUrl).toMatch(/^http/);
    const removed = await request(t.app).patch('/api/v1/school/profile').set(auth(adminA)).send({ logoFileId: null });
    expect(removed.body.data).toMatchObject({ logoFileId: null, logoUrl: null });
  });

  it("rejects another school's logo file and files of other categories", async () => {
    const logoB = await uploadLogo(adminB);
    const cross = await request(t.app).patch('/api/v1/school/profile').set(auth(adminA)).send({ logoFileId: logoB });
    expect(cross.status).toBe(400);
    expect(cross.body.error.details[0].path).toBe('logoFileId');
    const busImage = await f.file(fx.a.school.id, { category: 'bus_image', entity_type: 'bus', entity_id: fx.a.bus.id });
    const wrong = await request(t.app).patch('/api/v1/school/profile').set(auth(adminA)).send({ logoFileId: busImage.id });
    expect(wrong.status).toBe(400);
    const pending = await f.file(fx.a.school.id, { category: 'school_logo', entity_type: 'school', entity_id: fx.a.school.id, status: 'pending' });
    expect((await request(t.app).patch('/api/v1/school/profile').set(auth(adminA)).send({ logoFileId: pending.id })).status).toBe(400);
    const b = await ownerQuery<{ logo_file_id: string | null }>('select logo_file_id from schools where id = $1', [fx.a.school.id]);
    expect(b.rows[0]!.logo_file_id).toBeNull();
  });

  it('refuses drivers and parents', async () => {
    expect((await request(t.app).patch('/api/v1/school/profile').set(auth(driverA)).send({ name: 'X' })).status).toBe(403);
    expect((await request(t.app).patch('/api/v1/school/profile').set(auth(parentA)).set('X-School-Id', fx.a.school.id).send({ name: 'X' })).status).toBe(403);
  });
});
