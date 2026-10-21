// Legal links and public school branding (BP §16 "Privacy policy URL per app", §13.1 school sign-in
// branding; migration 901, privacy module): platform settings legal.* (https only, super admin),
// per-school override in /school/settings (school admin), effective values for the apps
// (/auth/legal, /auth/school/branding, /auth/me), active schools only, caching and rate limiting.
import { generate, generateSecret } from 'otplib';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createRateLimits } from '../src/middleware/rateLimits.js';
import { invalidateSchoolState } from '../src/middleware/resolveTenant.js';
import { modules as defaultModules } from '../src/modules/index.js';
import { clearLegalCaches } from '../src/modules/privacy/index.js';
import { createPrivacyRouter } from '../src/modules/privacy/router.js';
import { encryptSecret } from '../src/shared/crypto.js';
import { createMemoryKv } from '../src/shared/kv.js';
import { storage } from '../src/shared/storage.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { buildApp, loginSchoolAdmin, loginStaff, PASSWORD, passwordHash, schoolAdmin, staffUser, type TestApp } from './helpers/authApp.js';

let t: TestApp;
let fx: f.TwoSchoolFixture;
let superToken: string;
let adminA: string;
let adminB: string;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const api = (p: string) => `/api/v1${p}`;

async function superAdminToken(superAdmin: f.Row): Promise<string> {
  const secret = generateSecret();
  await ownerQuery('update platform_users set password_hash = $1, totp_enabled = true, totp_secret_enc = $2 where id = $3', [await passwordHash(), encryptSecret(secret, { purpose: 'totp' }), superAdmin.id]);
  const res = await request(t.app).post(api('/auth/platform/login')).send({ email: superAdmin.email, password: PASSWORD, totpCode: await generate({ secret }) });
  if (res.status !== 200) throw new Error(`platform login failed ${res.status}`);
  return res.body.data.accessToken as string;
}

async function resetLegal() {
  await ownerQuery(`update platform_settings set value = 'null' where key in ('legal.privacy_url', 'legal.terms_url')`);
  await ownerQuery(`update platform_settings set value = '"1"' where key = 'legal.consent_version'`);
  await ownerQuery('update school_settings set privacy_policy_url = null, terms_url = null, consent_version = null');
  clearLegalCaches();
}

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  fx = await f.twoSchoolFixture();
  await ownerQuery('update schools set code = $1 where id = $2', ['LEGAL-A', fx.a.school.id]);
  await ownerQuery('update schools set code = $1, name = $2 where id = $3', ['LEGAL-B', 'Second School', fx.b.school.id]);
  for (const s of [fx.a.school.id, fx.b.school.id]) await ownerQuery('insert into school_settings (school_id) values ($1) on conflict do nothing', [s]);
  superToken = await superAdminToken(fx.superAdmin);
  adminA = (await loginSchoolAdmin(t.app, String((await schoolAdmin(fx.a.school.id)).email))).accessToken;
  adminB = (await loginSchoolAdmin(t.app, String((await schoolAdmin(fx.b.school.id)).email))).accessToken;
});
beforeEach(resetLegal);
afterAll(async () => {
  await resetLegal();
  await closeDb();
});

describe('platform legal settings (super admin)', () => {
  it('lists the legal keys as public settings with defaults', async () => {
    const res = await request(t.app).get(api('/platform/settings')).set(auth(superToken));
    const byKey = new Map((res.body.data as { key: string; value: unknown; isPublic: boolean }[]).map((s) => [s.key, s]));
    expect(byKey.get('legal.privacy_url')).toMatchObject({ value: null, isPublic: true });
    expect(byKey.get('legal.terms_url')).toMatchObject({ value: null, isPublic: true });
    expect(byKey.get('legal.consent_version')).toMatchObject({ value: '1', isPublic: true });
  });

  it('accepts https URLs and a version, rejects http / malformed values, null clears', async () => {
    const put = (body: Record<string, unknown>) => request(t.app).put(api('/platform/settings')).set(auth(superToken)).send(body);
    for (const bad of [{ 'legal.privacy_url': 'http://insecure.example.com/p' }, { 'legal.terms_url': 'not a url' }, { 'legal.consent_version': 'two words' }, { 'legal.consent_version': '' }, { 'legal.privacy_url': `https://x.example/${'a'.repeat(600)}` }]) {
      const res = await put(bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    const ok = await put({ 'legal.privacy_url': 'https://wimb.example.com/privacy', 'legal.terms_url': 'https://wimb.example.com/terms', 'legal.consent_version': '2026-10' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const audit = await ownerQuery<{ n: number }>("select count(*)::int as n from audit_logs where action = 'platform_settings.update' and new_values ? 'legal.privacy_url'");
    expect(audit.rows[0]!.n).toBeGreaterThanOrEqual(1);
    expect((await request(t.app).get(api('/auth/legal'))).body.data).toEqual({ privacyUrl: 'https://wimb.example.com/privacy', termsUrl: 'https://wimb.example.com/terms', consentVersion: '2026-10' });
    expect((await put({ 'legal.privacy_url': null })).status).toBe(200);
    expect((await request(t.app).get(api('/auth/legal'))).body.data.privacyUrl).toBeNull();
  });

  it('school admins cannot change platform legal settings', async () => {
    expect((await request(t.app).put(api('/platform/settings')).set(auth(adminA)).send({ 'legal.consent_version': '9' })).status).toBe(403);
  });
});

describe('per-school override (PUT /school/settings)', () => {
  it('overrides the links / version for that school only and reports effective + platform values', async () => {
    await ownerQuery(`update platform_settings set value = '"https://platform.example.com/privacy"' where key = 'legal.privacy_url'`);
    clearLegalCaches();
    const res = await request(t.app).put(api('/school/settings')).set(auth(adminA)).send({ privacyPolicyUrl: 'https://school-a.example.com/privacy', consentVersion: 'a-2' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ privacyPolicyUrl: 'https://school-a.example.com/privacy', termsUrl: null, consentVersion: 'a-2' });
    expect(res.body.data.legal).toEqual({
      effective: { privacyUrl: 'https://school-a.example.com/privacy', termsUrl: null, consentVersion: 'a-2' },
      platform: { privacyUrl: 'https://platform.example.com/privacy', termsUrl: null, consentVersion: '1' },
    });
    // School B still sees the platform values.
    const b = await request(t.app).get(api('/school/settings')).set(auth(adminB));
    expect(b.body.data.legal.effective).toEqual({ privacyUrl: 'https://platform.example.com/privacy', termsUrl: null, consentVersion: '1' });
    const audit = await ownerQuery<{ n: number }>("select count(*)::int as n from audit_logs where school_id = $1 and action = 'school_settings.update' and new_values ? 'consentVersion'", [fx.a.school.id]);
    expect(audit.rows[0]!.n).toBe(1);
    // null resets to the platform value
    const reset = await request(t.app).put(api('/school/settings')).set(auth(adminA)).send({ privacyPolicyUrl: null, consentVersion: null });
    expect(reset.body.data.legal.effective.privacyUrl).toBe('https://platform.example.com/privacy');
  });

  it('rejects non-https and malformed override values (and the database refuses them too)', async () => {
    for (const body of [{ privacyPolicyUrl: 'http://school.example.com' }, { termsUrl: 'javascript:alert(1)' }, { consentVersion: 'with space' }]) {
      expect((await request(t.app).put(api('/school/settings')).set(auth(adminA)).send(body)).status, JSON.stringify(body)).toBe(400);
    }
    await expect(ownerQuery("update school_settings set terms_url = 'http://x.example.com' where school_id = $1", [fx.a.school.id])).rejects.toThrow(/school_settings_terms_url_ck/);
  });
});

describe('GET /auth/school/branding (public)', () => {
  it('returns the branding and effective legal links of an active school — and nothing else', async () => {
    const logo = await f.file(fx.a.school.id, { category: 'school_logo', entity_type: 'school', entity_id: fx.a.school.id, mime: 'image/png' });
    await storage.putObject({ key: String(logo.key), body: Buffer.from('png'), contentType: 'image/png' });
    await ownerQuery("update schools set logo_file_id = $1, brand_color = '#0A6ED1', institution_type = 'college' where id = $2", [logo.id, fx.a.school.id]);
    await ownerQuery("update school_settings set terms_url = 'https://school-a.example.com/terms' where school_id = $1", [fx.a.school.id]);
    await ownerQuery(`update platform_settings set value = '"https://platform.example.com/privacy"' where key = 'legal.privacy_url'`);
    clearLegalCaches();
    const res = await request(t.app).get(api('/auth/school/branding')).query({ code: 'legal-a' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Object.keys(res.body.data).sort()).toEqual(['brandColor', 'code', 'institutionType', 'logoUrl', 'name', 'privacyUrl', 'termsUrl']);
    expect(res.body.data).toMatchObject({
      name: 'Greenfield Public School',
      code: 'LEGAL-A',
      brandColor: '#0A6ED1',
      institutionType: 'college',
      privacyUrl: 'https://platform.example.com/privacy',
      termsUrl: 'https://school-a.example.com/terms',
    });
    expect(res.body.data.logoUrl).toMatch(/^http:\/\/[^/]+\/api\/v1\/files\/local\/download\?token=/);
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    // The signed logo URL works without a token.
    const logoRes = await request(t.app).get(new URL(res.body.data.logoUrl).pathname + new URL(res.body.data.logoUrl).search);
    expect(logoRes.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(fx.a.school.id);
  });

  it('answers 404 for unknown, suspended, inactive and deleted schools; 400 for malformed codes', async () => {
    expect((await request(t.app).get(api('/auth/school/branding')).query({ code: 'NOPE-XYZ' })).status).toBe(404);
    for (const state of ["status = 'suspended'", "status = 'inactive'", 'deleted_at = now()']) {
      await ownerQuery(`update schools set ${state} where id = $1`, [fx.b.school.id]);
      clearLegalCaches();
      const res = await request(t.app).get(api('/auth/school/branding')).query({ code: 'LEGAL-B' });
      expect(res.status, state).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      await ownerQuery("update schools set status = 'active', deleted_at = null where id = $1", [fx.b.school.id]);
    }
    invalidateSchoolState();
    expect((await request(t.app).get(api('/auth/school/branding'))).status).toBe(400);
    expect((await request(t.app).get(api('/auth/school/branding')).query({ code: 'x' })).status).toBe(400);
    expect((await request(t.app).get(api('/auth/school/branding')).query({ code: "A' or 1=1 --" })).status).toBe(400);
  });

  it('caches the lookup and drops the cache when the school changes', async () => {
    clearLegalCaches();
    expect((await request(t.app).get(api('/auth/school/branding')).query({ code: 'LEGAL-B' })).body.data.name).toBe('Second School');
    await ownerQuery("update schools set name = 'Renamed Directly' where id = $1", [fx.b.school.id]);
    // Cached (no event for a direct DB change) …
    expect((await request(t.app).get(api('/auth/school/branding')).query({ code: 'LEGAL-B' })).body.data.name).toBe('Second School');
    // … an API settings change drops it.
    expect((await request(t.app).put(api('/school/settings')).set(auth(adminB)).send({ termsUrl: 'https://b.example.com/terms' })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    const fresh = await request(t.app).get(api('/auth/school/branding')).query({ code: 'LEGAL-B' });
    expect(fresh.body.data).toMatchObject({ name: 'Renamed Directly', termsUrl: 'https://b.example.com/terms' });
    await ownerQuery("update schools set name = 'Second School' where id = $1", [fx.b.school.id]);
  });

  it('is rate limited per IP (publicLookup) together with /auth/legal', async () => {
    const kv = createMemoryKv();
    const rateLimits = createRateLimits({ enabled: true, store: kv, overrides: { publicLookup: { limit: 3 } } });
    const modules = defaultModules.map((m) => (m.name === 'privacy' ? { name: 'privacy', router: createPrivacyRouter({ rateLimits }) } : m));
    const app = createApp({ modules, rateLimits: createRateLimits({ enabled: false }), loadMinVersions: async () => ({}) });
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) statuses.push((await request(app).get(api('/auth/school/branding')).query({ code: 'LEGAL-A' })).status);
    const limited = await request(app).get(api('/auth/legal'));
    expect(statuses).toEqual([200, 200, 200]);
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after']).toBeDefined();
  });
});

describe('legal links reach the apps', () => {
  it('GET /auth/legal is public and returns the platform values', async () => {
    const res = await request(t.app).get(api('/auth/legal'));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ privacyUrl: null, termsUrl: null, consentVersion: '1' });
  });

  it('/auth/me of staff and admins carries the effective links of their school', async () => {
    await ownerQuery("update school_settings set privacy_policy_url = 'https://school-a.example.com/privacy' where school_id = $1", [fx.a.school.id]);
    const driver = await staffUser(fx.a.school.id, 'driver');
    const code = (await ownerQuery<{ code: string }>('select code from schools where id = $1', [fx.a.school.id])).rows[0]!.code;
    const login = await loginStaff(t.app, code, String(driver.phone));
    expect(login.body.user).toMatchObject({ school: { privacyUrl: 'https://school-a.example.com/privacy', termsUrl: null } });
    const me = await request(t.app).get(api('/auth/me')).set(auth(adminB));
    expect(me.body.data.school).toMatchObject({ privacyUrl: null, termsUrl: null });
  });
});
