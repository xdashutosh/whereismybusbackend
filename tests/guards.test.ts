// Area guards + route guards (contract §4): routes under /platform, /school, /driver and /parent are
// unreachable without the area's role (and an active school context for school/driver), even when a
// module forgets its own guard; authentication runs once per request; super admins never get a
// school context; mass-assigned school ids never change req.tenant.
import express, { Router } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generate, generateSecret } from 'otplib';
import { createApp } from '../src/app.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { createGuards, guards } from '../src/middleware/guards.js';
import { createRateLimits } from '../src/middleware/rateLimits.js';
import { createAuthRouter } from '../src/modules/auth/router.js';
import { encryptSecret } from '../src/shared/crypto.js';
import { ok } from '../src/shared/envelope.js';
import { createMemoryKv } from '../src/shared/kv.js';
import { createSessionStore } from './helpers/auth.js';
import { closeDb, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { capturingSms, PASSWORD, passwordHash, schoolAdmin, staffUser } from './helpers/authApp.js';

const kv = createMemoryKv();
const sms = capturingSms();
const rateLimits = createRateLimits({ enabled: false, store: kv });
const probe = Router();
// Deliberately unguarded module routes: only the area guards protect them.
probe.get('/school/probe', (req, res) => ok(res, { tenant: req.tenant, role: req.auth?.role }));
probe.post('/school/probe', (req, res) => ok(res, { tenant: req.tenant?.schoolId }));
probe.get('/driver/probe', (req, res) => ok(res, { tenant: req.tenant?.schoolId }));
probe.get('/parent/probe', (req, res) => ok(res, { role: req.auth?.role, tenant: req.tenant ?? null }));
probe.get('/parent/scoped', ...guards.parent(), (req, res) => ok(res, { tenant: req.tenant?.schoolId }));
probe.get('/platform/probe', (req, res) => ok(res, { role: req.auth?.role, tenant: req.tenant ?? null }));
const app = createApp({
  modules: [
    { name: 'auth', router: createAuthRouter({ kv, sms, rateLimits }) },
    { name: 'probe', router: probe },
  ],
  rateLimits,
  loadMinVersions: async () => ({}),
});

let school: f.Row;
const tokens: Record<string, string> = {};
const get = (path: string, role?: string) => {
  const r = request(app).get(`/api/v1${path}`);
  return role ? r.set('Authorization', `Bearer ${tokens[role]}`) : r;
};

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  school = await f.school({ code: 'GUARD-1' });
  const admin = await schoolAdmin(school.id);
  tokens.admin = (await request(app).post('/api/v1/auth/school/login').send({ email: admin.email, password: PASSWORD })).body.data.accessToken as string;
  const driver = await staffUser(school.id);
  tokens.driver = (
    await request(app).post('/api/v1/auth/staff/login').send({ schoolCode: 'GUARD-1', phone: driver.phone, password: PASSWORD, device: { deviceId: 'guard-device-01', platform: 'android' } })
  ).body.data.accessToken as string;
  const parent = await f.parentAccount();
  await f.schoolParent(school.id, parent.id);
  const child = await f.student(school.id);
  await f.studentParent(school.id, child.id, parent.id);
  await request(app).post('/api/v1/auth/parent/otp/request').send({ phone: parent.phone });
  tokens.parent = (await request(app).post('/api/v1/auth/parent/otp/verify').send({ phone: parent.phone, otp: sms.lastOtp(String(parent.phone)) })).body.data.accessToken as string;
  const secret = generateSecret();
  const sa = await f.platformUser({ password_hash: await passwordHash(), totp_enabled: true, totp_secret_enc: encryptSecret(secret, { purpose: 'totp' }) });
  tokens.super = (await request(app).post('/api/v1/auth/platform/login').send({ email: sa.email, password: PASSWORD, totpCode: await generate({ secret }) })).body.data.accessToken as string;
});
afterAll(closeDb);

describe('area guards', () => {
  it('/school/*: school admins only, with the tenant from the token', async () => {
    expect((await get('/school/probe')).status).toBe(401);
    for (const role of ['driver', 'parent', 'super']) expect((await get('/school/probe', role)).status).toBe(403);
    const res = await get('/school/probe', 'admin').set('X-School-Id', crypto.randomUUID());
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ role: 'school_admin', tenant: { schoolId: school.id, timezone: 'Asia/Kolkata' } });
    const body = await request(app).post('/api/v1/school/probe').set('Authorization', `Bearer ${tokens.admin}`).send({ school_id: crypto.randomUUID(), schoolId: crypto.randomUUID() });
    expect(body.body.data.tenant).toBe(school.id);
    expect((await get('/school/does-not-exist')).status).toBe(401);
  });

  it('/driver/*: drivers and conductors only', async () => {
    expect((await get('/driver/probe', 'driver')).body.data.tenant).toBe(school.id);
    for (const role of ['admin', 'parent', 'super']) expect((await get('/driver/probe', role)).status).toBe(403);
  });

  it('/parent/*: parents only; X-School-Id resolved per route', async () => {
    const res = await get('/parent/probe', 'parent');
    expect(res.body.data).toEqual({ role: 'parent', tenant: null });
    for (const role of ['admin', 'driver', 'super']) expect((await get('/parent/probe', role)).status).toBe(403);
    expect((await get('/parent/scoped', 'parent')).status).toBe(400);
    expect((await get('/parent/scoped', 'parent').set('X-School-Id', school.id)).body.data.tenant).toBe(school.id);
  });

  it('/platform/*: super admins only and never with a school context', async () => {
    const res = await get('/platform/probe', 'super').set('X-School-Id', school.id);
    expect(res.body.data).toEqual({ role: 'super_admin', tenant: null });
    for (const role of ['admin', 'driver', 'parent']) expect((await get('/platform/probe', role)).status).toBe(403);
  });

  it('loads the session and resolves the tenant once per request even with area + route guards', async () => {
    const store = createSessionStore();
    let schoolLoads = 0;
    const g = createGuards({
      authenticate: { loadSession: store.loader },
      tenant: { loadSchool: async (id) => ((schoolLoads += 1), { id, status: 'active', deleted: false, timezone: 'Asia/Kolkata', tenantMode: 'shared', dbConnectionRef: null }), cache: false },
    });
    const r = Router();
    r.use('/school', ...g.schoolAdmin());
    r.get('/school/x', ...g.schoolAdmin(), (req, res) => ok(res, { tenant: req.tenant?.schoolId }));
    const local = express();
    local.use(r);
    local.use(errorHandler());
    const issued = store.issue({ role: 'school_admin', schoolId: school.id });
    const res = await request(local).get('/school/x').set('Authorization', `Bearer ${issued.token}`);
    expect(res.body.data.tenant).toBe(school.id);
    expect(store.loads).toHaveLength(1);
    expect(schoolLoads).toBe(1);
  });
});
