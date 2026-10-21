// Subscriptions (BP §20 #1, contract §9): GET/PUT /platform/schools/:id/subscription, the
// resolveTenant hook (expired / cancelled plans block the school) and the create-endpoint limits
// (assertSubscriptionCapacity, subscriptionAllows) including concurrent creates.
import { generate, generateSecret } from 'otplib';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/tenant.js';
import { assertSubscriptionCapacity, subscriptionAllows } from '../src/modules/platform/index.js';
import { encryptSecret } from '../src/shared/crypto.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { buildApp, loginSchoolAdmin, PASSWORD, passwordHash, type TestApp } from './helpers/authApp.js';

let t: TestApp;
let fx: f.TwoSchoolFixture;
let superToken: string;
let adminToken: string;

async function superAdminToken(app: TestApp['app'], superAdmin: f.Row): Promise<string> {
  const secret = generateSecret();
  await ownerQuery('update platform_users set password_hash = $1, totp_enabled = true, totp_secret_enc = $2 where id = $3', [await passwordHash(), encryptSecret(secret, { purpose: 'totp' }), superAdmin.id]);
  const res = await request(app).post('/api/v1/auth/platform/login').send({ email: superAdmin.email, password: PASSWORD, totpCode: await generate({ secret }) });
  if (res.status !== 200) throw new Error(`platform login failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.accessToken as string;
}
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const sa = () => auth(superToken);
const subUrl = (id: string) => `/api/v1/platform/schools/${id}/subscription`;
const schoolCall = () => request(t.app).get('/api/v1/school/audit-logs').set(auth(adminToken));

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  fx = await f.twoSchoolFixture();
  await ownerQuery('update users set password_hash = $1 where id = $2', [await passwordHash(), fx.a.admin.id]);
  superToken = await superAdminToken(t.app, fx.superAdmin);
  adminToken = (await loginSchoolAdmin(t.app, String(fx.a.admin.email))).accessToken;
});
afterAll(closeDb);

describe('GET/PUT /platform/schools/:id/subscription', () => {
  it('shows the current plan, limits against usage counts and the history', async () => {
    const res = await request(t.app).get(subUrl(fx.a.school.id)).set(sa());
    expect(res.status).toBe(200);
    expect(res.body.data.current).toMatchObject({ plan: 'standard', status: 'active', maxBuses: 50, maxStudents: 2000, validUntil: null });
    expect(res.body.data.usage).toEqual({ buses: { used: 2, limit: 50, remaining: 48, reached: false }, students: { used: 2, limit: 2000, remaining: 1998, reached: false } });
    expect(res.body.data.history).toHaveLength(1);
    expect((await request(t.app).get(subUrl('00000000-0000-4000-8000-000000000000')).set(sa())).status).toBe(404);
  });

  it('updates the active plan in place, validates, audits', async () => {
    const res = await request(t.app).put(subUrl(fx.a.school.id)).set(sa()).send({ plan: 'premium', maxBuses: 2, maxStudents: 3, validUntil: '2099-12-31', modules: { sms: true, whatsapp: false }, notes: 'Annual contract' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.current).toMatchObject({ plan: 'premium', maxBuses: 2, maxStudents: 3, validUntil: '2099-12-31', modules: { sms: true, whatsapp: false }, notes: 'Annual contract' });
    expect(res.body.data.usage.buses).toEqual({ used: 2, limit: 2, remaining: 0, reached: true });
    expect(res.body.data.history).toHaveLength(1);
    const audit = await ownerQuery<{ school_id: string | null; new_values: Record<string, unknown> }>("select school_id, new_values from audit_logs where action = 'school.subscription_update' and entity_id = $1", [fx.a.school.id]);
    expect(audit.rows).toEqual([expect.objectContaining({ school_id: null, new_values: expect.objectContaining({ plan: 'premium', maxBuses: 2 }) })]);
    for (const bad of [{}, { plan: 'x', maxBuses: -1 }, { plan: 'x', validFrom: '2026-05-01', validUntil: '2026-04-01' }, { plan: 'x', modules: { teleport: true } }, { plan: 'x', status: 'paused' }]) {
      expect((await request(t.app).put(subUrl(fx.a.school.id)).set(sa()).send(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await schoolCall()).status).toBe(200);
  });
});

describe('resolveTenant subscription hook', () => {
  it('an expired plan blocks every tenant request with SCHOOL_INACTIVE / SUBSCRIPTION_EXPIRED', async () => {
    const put = await request(t.app).put(subUrl(fx.a.school.id)).set(sa()).send({ plan: 'premium', maxBuses: 2, maxStudents: 3, validFrom: '2020-01-01', validUntil: '2020-12-31' });
    expect(put.status).toBe(200);
    const res = await schoolCall();
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'SCHOOL_INACTIVE', details: { reason: 'SUBSCRIPTION_EXPIRED', validUntil: '2020-12-31' } });
    // School B is not affected.
    expect((await request(t.app).get(subUrl(fx.b.school.id)).set(sa())).body.data.current.status).toBe('active');
  });

  it('a cancelled plan blocks; re-activating starts a new plan row and restores access', async () => {
    const cancel = await request(t.app).put(subUrl(fx.a.school.id)).set(sa()).send({ plan: 'premium', status: 'cancelled', validUntil: null });
    expect(cancel.body.data.current.status).toBe('cancelled');
    expect((await schoolCall()).body.error.details.reason).toBe('SUBSCRIPTION_CANCELLED');
    const again = await request(t.app).put(subUrl(fx.a.school.id)).set(sa()).send({ plan: 'standard', maxBuses: 3, maxStudents: 3 });
    expect(again.body.data.current).toMatchObject({ plan: 'standard', status: 'active', maxBuses: 3 });
    expect(again.body.data.history.map((h: { status: string }) => h.status)).toEqual(['active', 'cancelled']);
    expect((await ownerQuery("select 1 from audit_logs where action = 'school.subscription_create' and entity_id = $1", [fx.a.school.id])).rowCount).toBe(1);
    expect((await schoolCall()).status).toBe(200);
  });
});

describe('create-endpoint limits', () => {
  const admin = () => f.contexts.schoolAdmin(fx.a.school.id, fx.a.admin.id);

  it('assertSubscriptionCapacity refuses creates beyond the plan and allows within it', async () => {
    // Plan: 3 buses (2 used), 3 students (2 active).
    await expect(withTenant(admin(), (tx) => assertSubscriptionCapacity(tx, 'buses'))).resolves.toEqual({ used: 2, limit: 3 });
    await expect(withTenant(admin(), (tx) => assertSubscriptionCapacity(tx, 'students', 2))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
      details: { reason: 'SUBSCRIPTION_LIMIT', resource: 'students', limit: 3, used: 2, adding: 2 },
    });
    // Unlimited plan for school B's buses.
    await ownerQuery('update school_subscriptions set max_buses = null where school_id = $1', [fx.b.school.id]);
    await expect(withTenant(f.contexts.schoolAdmin(fx.b.school.id, fx.b.admin.id), (tx) => assertSubscriptionCapacity(tx, 'buses', 1000))).resolves.toEqual({ used: -1, limit: null });
    await expect(withTenant(f.contexts.superAdmin(fx.superAdmin.id), (tx) => assertSubscriptionCapacity(tx, 'buses'))).rejects.toThrow(/school context/);
  });

  it('serialises concurrent creates so the limit is never exceeded', async () => {
    const create = (code: string) =>
      withTenant(admin(), async (tx) => {
        await assertSubscriptionCapacity(tx, 'buses');
        await tx.query("insert into buses (school_id, code, registration_no) values (current_setting('app.school_id')::uuid, $1, $2)", [code, `KA01ZZ${code.slice(-4)}`]);
      });
    const results = await Promise.allSettled([create('C-1001'), create('C-1002'), create('C-1003')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => (r.reason as { details: { reason: string } }).details.reason)).toEqual(['SUBSCRIPTION_LIMIT', 'SUBSCRIPTION_LIMIT']);
    expect((await ownerQuery('select count(*)::int as n from buses where school_id = $1 and deleted_at is null', [fx.a.school.id])).rows[0]!.n).toBe(3);
  });

  it('subscriptionAllows reflects module switches of the plan', async () => {
    await request(t.app).put(subUrl(fx.a.school.id)).set(sa()).send({ plan: 'standard', maxBuses: 3, maxStudents: 3, modules: { sms: false, reports: true } });
    await expect(withTenant(admin(), (tx) => subscriptionAllows(tx, 'sms'))).resolves.toBe(false);
    await expect(withTenant(admin(), (tx) => subscriptionAllows(tx, 'reports'))).resolves.toBe(true);
    await expect(withTenant(admin(), (tx) => subscriptionAllows(tx, 'whatsapp'))).resolves.toBe(true);
  });
});
