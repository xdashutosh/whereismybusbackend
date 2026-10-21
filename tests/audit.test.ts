// Audit (contract §5, BP §8.2/§8.3/§13.3): rows written by auth flows in the actor's scope,
// GET /school/audit-logs (filters, pagination, sort, CSV, tenant isolation, role gate),
// GET /platform/audit-logs (platform-level rows only), insert-only for the app role.
import { generate, generateSecret } from 'otplib';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/tenant.js';
import { encryptSecret } from '../src/shared/crypto.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { buildApp, loginSchoolAdmin, loginStaff, PASSWORD, passwordHash, type TestApp } from './helpers/authApp.js';

let t: TestApp;
let fx: f.TwoSchoolFixture;
let adminToken: string;
let superToken: string;

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  fx = await f.twoSchoolFixture();
  await ownerQuery('update users set password_hash = $1 where id = any ($2)', [await passwordHash(), [fx.a.admin.id, fx.b.admin.id, fx.a.driverUser.id]]);
  adminToken = (await loginSchoolAdmin(t.app, String(fx.a.admin.email))).accessToken;
  await loginSchoolAdmin(t.app, String(fx.b.admin.email));
  const secret = generateSecret();
  await ownerQuery('update platform_users set password_hash = $1, totp_enabled = true, totp_secret_enc = $2 where id = $3', [
    await passwordHash(),
    encryptSecret(secret, { purpose: 'totp' }),
    fx.superAdmin.id,
  ]);
  const login = await request(t.app).post('/api/v1/auth/platform/login').send({ email: fx.superAdmin.email, password: PASSWORD, totpCode: await generate({ secret }) });
  superToken = login.body.data.accessToken as string;
});
afterAll(closeDb);

const schoolLogs = (query = '', token = adminToken) => request(t.app).get(`/api/v1/school/audit-logs${query}`).set({ Authorization: `Bearer ${token}` });

describe('GET /school/audit-logs', () => {
  it('lists only the school’s own rows, newest first, with actor details', async () => {
    const res = await schoolLogs();
    expect(res.status).toBe(200);
    const rows = res.body.data as { action: string; entityId: string; actorId: string; createdAt: string; ip: string | null }[];
    expect(rows.map((r) => r.action)).toEqual(['auth.login', 'bus.create']);
    expect(rows[0]).toMatchObject({ actorId: fx.a.admin.id, actorType: 'user', entityType: 'session' });
    expect(rows[0]!.ip).toEqual(expect.any(String));
    expect(rows[1]!.entityId).toBe(fx.a.bus.id);
    expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 2, totalPages: 1 });
  });

  it('filters by action (exact / prefix), actor, entity and dates; ignores school_id in the query', async () => {
    expect((await schoolLogs('?action=bus.create')).body.data).toHaveLength(1);
    expect((await schoolLogs('?action=auth.*')).body.data.map((r: { action: string }) => r.action)).toEqual(['auth.login']);
    expect((await schoolLogs(`?actorId=${fx.a.admin.id}`)).body.data).toHaveLength(1);
    expect((await schoolLogs(`?entityId=${fx.a.bus.id}&entityType=bus`)).body.data).toHaveLength(1);
    expect((await schoolLogs(`?entityId=${fx.b.bus.id}`)).body.data).toHaveLength(0);
    expect((await schoolLogs('?to=2020-01-01')).body.data).toHaveLength(0);
    expect((await schoolLogs(`?from=${f.isoDay(-1)}&to=${f.isoDay(1)}`)).body.data).toHaveLength(2);
    expect((await schoolLogs(`?school_id=${fx.b.school.id}&schoolId=${fx.b.school.id}`)).body.data.map((r: { action: string }) => r.action)).toEqual(['auth.login', 'bus.create']);
    expect((await schoolLogs('?limit=1&page=2&sort=action')).body).toMatchObject({ data: [{ action: 'bus.create' }], meta: { total: 2, totalPages: 2 } });
  });

  it('rejects invalid filters', async () => {
    expect((await schoolLogs('?from=yesterday')).status).toBe(400);
    expect((await schoolLogs('?format=pdf')).status).toBe(400);
    expect((await schoolLogs('?sort=password')).status).toBe(400);
    expect((await schoolLogs(`?from=${f.isoDay(1)}&to=${f.isoDay(-1)}`)).status).toBe(400);
  });

  it('exports CSV with the formula guard', async () => {
    const res = await schoolLogs('?format=csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/audit-log\.csv/);
    const lines = res.text.replace(/^\uFEFF/, '').trim().split('\r\n');
    expect(lines[0]).toBe('Time (UTC),Actor type,Actor,Actor ID,Action,Entity type,Entity ID,IP,Request ID,Old values,New values');
    expect(lines).toHaveLength(3);
    expect(res.text).toContain('auth.login');
  });

  it('is limited to school admins', async () => {
    const driver = await loginStaff(t.app, String(fx.a.school.code), String(fx.a.driverUser.phone));
    expect((await schoolLogs('', driver.accessToken)).status).toBe(403);
    expect((await schoolLogs('', superToken)).status).toBe(403);
    expect((await request(t.app).get('/api/v1/school/audit-logs')).status).toBe(401);
  });
});

describe('GET /platform/audit-logs', () => {
  it('shows platform-level actions only', async () => {
    const res = await request(t.app).get('/api/v1/platform/audit-logs').set({ Authorization: `Bearer ${superToken}` });
    expect(res.status).toBe(200);
    const actions = (res.body.data as { action: string }[]).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['school.create', 'auth.login']));
    expect(actions).not.toContain('bus.create');
    const ids = (await ownerQuery<{ id: number }>('select id from audit_logs where school_id is not null')).rows.map((r) => r.id);
    expect((res.body.data as { id: number }[]).some((r) => ids.includes(r.id))).toBe(false);
    expect((await request(t.app).get('/api/v1/platform/audit-logs').set({ Authorization: `Bearer ${adminToken}` })).status).toBe(403);
  });
});

describe('immutability', () => {
  it('audit rows written by the API cannot be updated or deleted by the app role', async () => {
    const ctx = { schoolId: fx.a.school.id, actorId: fx.a.admin.id, role: 'school_admin' as const };
    const before = (await ownerQuery("select count(*)::int as n from audit_logs where action = 'auth.login'")).rows[0]!.n as number;
    await expect(withTenant(ctx, (tx) => tx.query("update audit_logs set action = 'auth.tampered' where action = 'auth.login'"))).rejects.toMatchObject({ code: '42501' });
    await expect(withTenant(ctx, (tx) => tx.query("delete from audit_logs where action = 'auth.login'"))).rejects.toMatchObject({ code: '42501' });
    await expect(withTenant({ schoolId: null, actorId: fx.superAdmin.id, role: 'super_admin' }, (tx) => tx.query('delete from audit_logs'))).rejects.toMatchObject({ code: '42501' });
    expect((await ownerQuery("select count(*)::int as n from audit_logs where action = 'auth.login'")).rows[0]!.n).toBe(before);
  });
});
