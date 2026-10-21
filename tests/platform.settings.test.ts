// Platform settings, health, usage and the platform logo upload (BP §4.4, §13.2, §20 #3/#7):
// validated global settings with merge semantics, audit and cache events; counts-only health and
// usage; logo stored in the school's own scope and readable by that school.
import { generate, generateSecret } from 'otplib';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordHeartbeat, HEARTBEAT_STALE_S } from '../src/modules/platform/jobs.js';
import { jobsStatus } from '../src/modules/platform/jobs.js';
import { encryptSecret } from '../src/shared/crypto.js';
import { events } from '../src/shared/events.js';
import { createMemoryKv, kv } from '../src/shared/kv.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { buildApp, loginSchoolAdmin, PASSWORD, passwordHash, type TestApp } from './helpers/authApp.js';

let t: TestApp;
let fx: f.TwoSchoolFixture;
let superToken: string;

async function superAdminToken(app: TestApp['app'], superAdmin: f.Row): Promise<string> {
  const secret = generateSecret();
  await ownerQuery('update platform_users set password_hash = $1, totp_enabled = true, totp_secret_enc = $2 where id = $3', [await passwordHash(), encryptSecret(secret, { purpose: 'totp' }), superAdmin.id]);
  const res = await request(app).post('/api/v1/auth/platform/login').send({ email: superAdmin.email, password: PASSWORD, totpCode: await generate({ secret }) });
  if (res.status !== 200) throw new Error(`platform login failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.accessToken as string;
}
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const sa = () => auth(superToken);

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  fx = await f.twoSchoolFixture();
  await ownerQuery('update users set password_hash = $1 where id = $2', [await passwordHash(), fx.a.admin.id]);
  superToken = await superAdminToken(t.app, fx.superAdmin);
});
afterAll(async () => {
  await ownerQuery(`update platform_settings set value = '10' where key = 'location.moving_interval_s'`);
  await ownerQuery(`update platform_settings set value = '90' where key = 'location.stopped_interval_s'`);
  await ownerQuery(`update platform_settings set value = '[60, 30, 15, 7, 1]' where key = 'docs.expiry_reminder_days'`);
  await ownerQuery(`update platform_settings set value = '{"driver_app": "1.0.0", "parent_app": "1.0.0"}' where key = 'min_supported_version'`);
  await ownerQuery(`update platform_settings set value = '{"push": true, "sms": false, "whatsapp": false, "email": true}' where key = 'modules'`);
  await closeDb();
});

describe('GET/PUT /platform/settings', () => {
  it('lists every setting with its description and visibility', async () => {
    const res = await request(t.app).get('/api/v1/platform/settings').set(sa());
    expect(res.status).toBe(200);
    const byKey = Object.fromEntries((res.body.data as { key: string }[]).map((s) => [s.key, s]));
    expect(byKey['location.moving_interval_s']).toMatchObject({ value: 10, isPublic: true });
    expect(byKey['docs.expiry_reminder_days']).toMatchObject({ value: [60, 30, 15, 7, 1] });
    expect(byKey['min_supported_version']).toMatchObject({ value: { driver_app: '1.0.0', parent_app: '1.0.0' } });
    expect(Object.keys(byKey)).toEqual(expect.arrayContaining(['location.stopped_interval_s', 'location.moving_speed_kmh', 'location.stopped_after_s', 'modules', 'features']));
  });

  it('updates validated keys, merges objects, audits and announces the change', async () => {
    const changed: string[] = [];
    const off = events.on('platform_settings.changed', ({ key }) => {
      changed.push(key);
    });
    const res = await request(t.app)
      .put('/api/v1/platform/settings')
      .set(sa())
      .send({ 'location.moving_interval_s': 15, 'location.stopped_interval_s': 120, 'docs.expiry_reminder_days': [7, 30, 1], min_supported_version: { driver_app: '1.2.0' }, modules: { sms: true }, 'location.moving_speed_kmh': 4 });
    off();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const byKey = Object.fromEntries((res.body.data as { key: string; value: unknown; updatedBy: string | null }[]).map((s) => [s.key, s]));
    expect(byKey['location.moving_interval_s']).toMatchObject({ value: 15, updatedBy: fx.superAdmin.id });
    expect(byKey['docs.expiry_reminder_days']!.value).toEqual([30, 7, 1]);
    expect(byKey['min_supported_version']!.value).toEqual({ driver_app: '1.2.0', parent_app: '1.0.0' });
    expect(byKey['modules']!.value).toEqual({ push: true, sms: true, whatsapp: false, email: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(changed.sort()).toEqual(['docs.expiry_reminder_days', 'location.moving_interval_s', 'location.stopped_interval_s', 'min_supported_version', 'modules']);
    const audit = await ownerQuery<{ school_id: string | null; old_values: Record<string, unknown>; new_values: Record<string, unknown> }>("select school_id, old_values, new_values from audit_logs where action = 'platform_settings.update'");
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ school_id: null, old_values: { 'location.moving_interval_s': 10 }, new_values: { 'location.moving_interval_s': 15 } });
    expect(audit.rows[0]!.new_values).not.toHaveProperty('location.moving_speed_kmh');
  });

  it('rejects unknown keys, out-of-range values and inconsistent intervals', async () => {
    const put = (body: unknown) => request(t.app).put('/api/v1/platform/settings').set(sa()).send(body as object);
    for (const body of [
      {},
      { 'location.moving_interval_s': 5 },
      { 'location.moving_interval_s': 12.5 },
      { 'location.retention_months': 0 },
      { 'docs.expiry_reminder_days': [7, 7] },
      { min_supported_version: { driver_app: 'latest' } },
      { features: { teleport: true } },
      { 'location.unknown_key': 1 },
      { 'location.moving_interval_s': 200 },
    ]) {
      const res = await put(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const inconsistent = await put({ 'location.moving_interval_s': 120, 'location.stopped_interval_s': 90 });
    expect(inconsistent.body.error.details).toEqual([{ path: 'location.stopped_interval_s', message: 'Must be at least the moving interval' }]);
  });
});

describe('GET /platform/health', () => {
  it('returns counts only plus API, database, queue and status checks', async () => {
    await recordHeartbeat();
    const res = await request(t.app).get('/api/v1/platform/health').set(sa());
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.counts).toEqual({ schools: { total: 2, active: 2, suspended: 0, inactive: 0 }, buses: 4, activeTrips: 4, tripsLast24h: expect.any(Number), students: 4, parents: 3, staff: 6 });
    expect(d.api).toMatchObject({ status: 'ok', environment: 'test' });
    expect(d.database).toMatchObject({ ok: true });
    expect(d.redis).toMatchObject({ ok: true, skipped: true });
    expect(d.queue).toMatchObject({ backend: 'in-process', worker: { level: 'ok' } });
    expect(d.queue.jobs.map((j: { name: string }) => j.name)).toEqual(expect.arrayContaining(['partition-maintenance', 'platform-heartbeat']));
    expect(d.checks.sms).toMatchObject({ level: 'ok' });
    expect(JSON.stringify(res.body)).not.toContain(String(fx.a.school.id));
  });

  it('job worker status goes stale without heartbeats', async () => {
    const store = createMemoryKv();
    expect((await jobsStatus(store)).level).toBe('warn');
    await recordHeartbeat(store, new Date(Date.now() - (HEARTBEAT_STALE_S + 60) * 1000));
    expect(await jobsStatus(store)).toMatchObject({ level: 'warn', details: { ageSeconds: expect.any(Number) } });
    await recordHeartbeat(store);
    expect((await jobsStatus(store)).level).toBe('ok');
    expect(kv).toBeDefined();
  });
});

describe('GET /platform/usage', () => {
  it('counts per school next to the plan limits (no school rows), CSV export', async () => {
    const res = await request(t.app).get('/api/v1/platform/usage?sort=-createdAt').set(sa());
    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ total: 2, page: 1 });
    const a = (res.body.data as { school: { id: string } }[]).find((r) => r.school.id === fx.a.school.id) as Record<string, unknown>;
    expect(a).toMatchObject({
      subscription: { plan: 'standard', maxBuses: 50 },
      usage: { buses: 2, students: 2, staff: 3, parents: 2, routes: 2, activeTrips: 2 },
      limits: { buses: { used: 2, limit: 50, remaining: 48, reached: false } },
    });
    expect(JSON.stringify(res.body)).not.toContain('KA01AB1234');
    const page2 = await request(t.app).get('/api/v1/platform/usage?limit=1&page=3').set(sa());
    expect(page2.body).toMatchObject({ data: [], meta: { total: 2 } });
    const csv = await request(t.app).get('/api/v1/platform/usage?format=csv').set(sa());
    expect(csv.status).toBe(200);
    expect(csv.text.replace(/^\uFEFF/, '').split(/\r\n/)[0]).toMatch(/^Code,Name,Status,Plan/);
  });
});

describe('POST/DELETE /platform/schools/:id/logo', () => {
  const png = () => sharp({ create: { width: 64, height: 48, channels: 3, background: '#1B7F3B' } }).png().toBuffer();

  it('stores the logo in the school scope, links it and lets the school read it', async () => {
    const res = await request(t.app).post(`/api/v1/platform/schools/${fx.a.school.id}/logo`).set(sa()).attach('file', await png(), { filename: 'logo.png', contentType: 'image/png' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.logoUrl).toMatch(/^http/);
    expect(res.body.data.logoThumbnailUrl).toMatch(/^http/);
    const fileId = res.body.data.logoFileId as string;
    const row = await ownerQuery('select school_id, category, entity_id, uploader_type, uploaded_by, status, key from files where id = $1', [fileId]);
    expect(row.rows[0]).toMatchObject({ school_id: fx.a.school.id, category: 'school_logo', entity_id: fx.a.school.id, uploader_type: 'platform_user', uploaded_by: fx.superAdmin.id, status: 'uploaded' });
    expect(String(row.rows[0]!.key)).toContain(`/schools/${fx.a.school.id}/school_logo/`);
    expect((await ownerQuery('select logo_file_id from schools where id = $1', [fx.a.school.id])).rows[0]!.logo_file_id).toBe(fileId);
    const detail = await request(t.app).get(`/api/v1/platform/schools/${fx.a.school.id}`).set(sa());
    expect(detail.body.data).toMatchObject({ logoFileId: fileId, logoUrl: expect.stringMatching(/^http/) });
    const admin = await loginSchoolAdmin(t.app, String(fx.a.admin.email));
    expect((await request(t.app).get(`/api/v1/files/${fileId}/url`).set(auth(admin.accessToken))).status).toBe(200);
    expect((await ownerQuery("select 1 from audit_logs where action = 'school.logo_update' and school_id is null and entity_id = $1", [fx.a.school.id])).rowCount).toBe(1);

    // Replacing retires the previous logo.
    const again = await request(t.app).post(`/api/v1/platform/schools/${fx.a.school.id}/logo`).set(sa()).attach('file', await png(), { filename: 'logo2.png', contentType: 'image/png' });
    expect(again.status).toBe(200);
    expect((await ownerQuery('select status from files where id = $1', [fileId])).rows[0]!.status).toBe('deleted');
  });

  it('rejects non-images and missing files; removal unlinks the logo', async () => {
    const txt = await request(t.app).post(`/api/v1/platform/schools/${fx.a.school.id}/logo`).set(sa()).attach('file', Buffer.from('hello world'), { filename: 'logo.png', contentType: 'image/png' });
    expect(txt.status).toBe(415);
    expect((await request(t.app).post(`/api/v1/platform/schools/${fx.a.school.id}/logo`).set(sa())).status).toBe(400);
    const del = await request(t.app).delete(`/api/v1/platform/schools/${fx.a.school.id}/logo`).set(sa());
    expect(del.status).toBe(200);
    expect(del.body.data).toEqual({ logoFileId: null, logoUrl: null, logoThumbnailUrl: null });
    expect((await ownerQuery('select logo_file_id from schools where id = $1', [fx.a.school.id])).rows[0]!.logo_file_id).toBeNull();
    expect((await request(t.app).delete(`/api/v1/platform/schools/${fx.a.school.id}/logo`).set(sa())).status).toBe(200);
  });
});
