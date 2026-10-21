// HTTP pipeline through createApp(): probes, request ids, CORS, 404, authentication with session
// reload, password-change guard, tenant resolution (staff token / parent X-School-Id), role gate,
// validation, pagination envelope, idempotency replay.
import { Router } from 'express';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApp } from '../src/app.js';
import { authenticate } from '../src/middleware/authenticate.js';
import { authorize } from '../src/middleware/authorize.js';
import { idempotency } from '../src/middleware/idempotency.js';
import { createRateLimits } from '../src/middleware/rateLimits.js';
import { resolveTenant, type SchoolState } from '../src/middleware/resolveTenant.js';
import { list, ok } from '../src/shared/envelope.js';
import { createIdempotencyStore } from '../src/shared/idempotency.js';
import { createMemoryKv } from '../src/shared/kv.js';
import { listMeta, parsePagination } from '../src/shared/pagination.js';
import { validate, validated } from '../src/shared/validate.js';
import { closeDb } from './helpers/db.js';
import { createSessionStore } from './helpers/auth.js';

const SCHOOL_A = '0a000000-0000-4000-8000-00000000000a';
const SCHOOL_B = '0b000000-0000-4000-8000-00000000000b';
const SUSPENDED = '0c000000-0000-4000-8000-00000000000c';

const schools: Record<string, SchoolState> = {
  [SCHOOL_A]: { id: SCHOOL_A, status: 'active', deleted: false, timezone: 'Asia/Kolkata', tenantMode: 'shared', dbConnectionRef: null },
  [SCHOOL_B]: { id: SCHOOL_B, status: 'active', deleted: false, timezone: 'Asia/Kolkata', tenantMode: 'shared', dbConnectionRef: null },
  [SUSPENDED]: { id: SUSPENDED, status: 'suspended', deleted: false, timezone: 'Asia/Kolkata', tenantMode: 'shared', dbConnectionRef: null },
};
const store = createSessionStore();
const parentLinks = new Set<string>();
const auth = authenticate({ loadSession: store.loader });
const tenant = resolveTenant({ loadSchool: async (id) => schools[id] ?? null, parentLink: async (p, s) => parentLinks.has(`${p}|${s}`), cache: false });

const probe = Router();
probe.get('/probe/me', auth, (req, res) => ok(res, req.auth));
probe.get('/probe/school', auth, tenant, authorize('school_admin', 'parent'), (req, res) => ok(res, { tenant: req.tenant, role: req.auth?.role }));
probe.get('/probe/admin-only', auth, tenant, authorize('school_admin'), (_req, res) => ok(res, { ok: true }));
probe.get(
  '/probe/list',
  validate({ query: z.object({ page: z.string().optional(), limit: z.string().optional(), status: z.enum(['active', 'retired']).optional() }) }),
  (req, res) => {
    const q = validated<{ page?: string; limit?: string; status?: string }>(req, 'query');
    const { page, limit } = parsePagination(q);
    return list(res, [{ status: q.status ?? 'any' }], listMeta({ page, limit, total: 45 }));
  },
);
probe.post('/probe/items', validate({ body: z.object({ name: z.string().min(1), qty: z.number().int().positive() }) }), (req, res) => ok(res, validated(req, 'body'), { status: 201 }));
let creates = 0;
const idemStore = createIdempotencyStore(createMemoryKv());
probe.post('/probe/create', auth, tenant, idempotency({ store: idemStore }), (req, res) => {
  creates += 1;
  res.status(201).json({ success: true, data: { n: creates, body: req.body as unknown } });
});

const app = createApp({
  modules: [{ name: 'probe', router: probe }],
  rateLimits: createRateLimits({ enabled: false }),
  loadMinVersions: async () => ({}),
  readinessChecks: { database: async () => ({ ok: true, latencyMs: 1 }), redis: async () => ({ ok: true, skipped: true }) },
});

afterAll(closeDb);

describe('probes and basics', () => {
  it('serves /healthz and /readyz', async () => {
    const h = await request(app).get('/healthz');
    expect(h.status).toBe(200);
    expect(h.body.data.status).toBe('ok');
    const r = await request(app).get('/readyz');
    expect(r.status).toBe(200);
    expect(r.body.data.checks.redis).toEqual({ ok: true, skipped: true });
  });

  it('reports not-ready with 503 and the failing check', async () => {
    const down = createApp({ modules: [], readinessChecks: { database: async () => ({ ok: false, error: 'ECONNREFUSED' }) }, loadMinVersions: async () => ({}) });
    const r = await request(down).get('/readyz');
    expect(r.status).toBe(503);
    expect(r.body.error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', details: { checks: { database: { ok: false } } } });
  });

  it('runs real readiness checks against the test database (app role)', async () => {
    const real = createApp({ modules: [], loadMinVersions: async () => ({}) });
    const r = await request(real).get('/readyz');
    expect(r.status).toBe(200);
    expect(r.body.data.checks.database.ok).toBe(true);
    expect(r.body.data.checks.migrations).toMatchObject({ ok: true, pending: [] });
  });

  it('echoes valid request ids, generates others, and returns the 404 envelope', async () => {
    const res = await request(app).get('/api/v1/nope').set('X-Request-Id', 'client-req-12345');
    expect(res.status).toBe(404);
    expect(res.headers['x-request-id']).toBe('client-req-12345');
    expect(res.body).toEqual({ success: false, error: { code: 'NOT_FOUND', message: 'Route GET /api/v1/nope not found.', requestId: 'client-req-12345' } });
    const gen = await request(app).get('/api/v1/nope').set('X-Request-Id', 'bad id!');
    expect(gen.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sets security headers and CORS for allowed origins', async () => {
    const res = await request(app).options('/api/v1/probe/me').set('Origin', 'http://localhost:5173').set('Access-Control-Request-Method', 'GET').set('Access-Control-Request-Headers', 'X-School-Id,Authorization');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-headers']).toContain('X-School-Id');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    const h = await request(app).get('/healthz');
    expect(h.headers['x-powered-by']).toBeUndefined();
    expect(h.headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('maps malformed JSON to VALIDATION_ERROR', async () => {
    const res = await request(app).post('/api/v1/probe/items').set('Content-Type', 'application/json').send('{"name":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('authenticate', () => {
  it('accepts a valid token and reloads the session on every request', async () => {
    const { token, actorId, sessionId } = store.issue({ role: 'school_admin', schoolId: SCHOOL_A, actorName: 'Asha' });
    const before = store.loads.length;
    const res = await request(app).get('/api/v1/probe/me').set('Authorization', `Bearer ${token}`);
    await request(app).get('/api/v1/probe/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ actorId, sessionId, role: 'school_admin', schoolId: SCHOOL_A, ownerType: 'user', actorName: 'Asha' });
    expect(store.loads.length - before).toBe(2);
  });

  it('rejects missing, revoked, deactivated and mismatched sessions', async () => {
    expect((await request(app).get('/api/v1/probe/me')).body.error.code).toBe('UNAUTHENTICATED');
    const revoked = store.issue({ role: 'driver', schoolId: SCHOOL_A });
    store.update(revoked.sessionId, { revokedAt: new Date().toISOString() });
    expect((await request(app).get('/api/v1/probe/me').set('Authorization', `Bearer ${revoked.token}`)).status).toBe(401);
    const inactive = store.issue({ role: 'driver', schoolId: SCHOOL_A });
    store.update(inactive.sessionId, { actorActive: false });
    expect((await request(app).get('/api/v1/probe/me').set('Authorization', `Bearer ${inactive.token}`)).status).toBe(401);
    const moved = store.issue({ role: 'school_admin', schoolId: SCHOOL_A });
    store.update(moved.sessionId, { schoolId: SCHOOL_B });
    expect((await request(app).get('/api/v1/probe/me').set('Authorization', `Bearer ${moved.token}`)).status).toBe(401);
    const demoted = store.issue({ role: 'school_admin', schoolId: SCHOOL_A });
    store.update(demoted.sessionId, { actorRole: 'driver' });
    expect((await request(app).get('/api/v1/probe/me').set('Authorization', `Bearer ${demoted.token}`)).status).toBe(401);
  });

  it('blocks everything but the password-change endpoints while a change is required', async () => {
    const { token } = store.issue({ role: 'school_admin', schoolId: SCHOOL_A, mustChangePassword: true });
    const res = await request(app).get('/api/v1/probe/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });
});

describe('resolveTenant + authorize', () => {
  it('takes the school from the token for staff and ignores X-School-Id', async () => {
    const { token } = store.issue({ role: 'school_admin', schoolId: SCHOOL_A });
    const res = await request(app).get('/api/v1/probe/school').set('Authorization', `Bearer ${token}`).set('X-School-Id', SCHOOL_B);
    expect(res.status).toBe(200);
    expect(res.body.data.tenant).toEqual({ schoolId: SCHOOL_A, timezone: 'Asia/Kolkata', tenantMode: 'shared', dbConnectionRef: null });
  });

  it('requires a linked X-School-Id for parents', async () => {
    const { token, actorId } = store.issue({ role: 'parent' });
    parentLinks.add(`${actorId}|${SCHOOL_B}`);
    const missing = await request(app).get('/api/v1/probe/school').set('Authorization', `Bearer ${token}`);
    expect(missing.status).toBe(400);
    const invalid = await request(app).get('/api/v1/probe/school').set('Authorization', `Bearer ${token}`).set('X-School-Id', 'nope');
    expect(invalid.status).toBe(400);
    const unlinked = await request(app).get('/api/v1/probe/school').set('Authorization', `Bearer ${token}`).set('X-School-Id', SCHOOL_A);
    expect(unlinked.status).toBe(403);
    const linked = await request(app).get('/api/v1/probe/school').set('Authorization', `Bearer ${token}`).set('X-School-Id', SCHOOL_B.toUpperCase());
    expect(linked.status).toBe(200);
    expect(linked.body.data).toMatchObject({ role: 'parent', tenant: { schoolId: SCHOOL_B } });
  });

  it('blocks inactive schools, super admins and other roles', async () => {
    const suspended = store.issue({ role: 'school_admin', schoolId: SUSPENDED });
    const s = await request(app).get('/api/v1/probe/school').set('Authorization', `Bearer ${suspended.token}`);
    expect(s.status).toBe(403);
    expect(s.body.error.code).toBe('SCHOOL_INACTIVE');
    const admin = store.issue({ role: 'super_admin' });
    expect((await request(app).get('/api/v1/probe/school').set('Authorization', `Bearer ${admin.token}`)).body.error.code).toBe('FORBIDDEN');
    const driver = store.issue({ role: 'driver', schoolId: SCHOOL_A });
    const d = await request(app).get('/api/v1/probe/admin-only').set('Authorization', `Bearer ${driver.token}`);
    expect(d.status).toBe(403);
    expect(d.body.error.code).toBe('FORBIDDEN');
  });
});

describe('validation, envelopes and idempotency', () => {
  it('validates query/body into req.valid and strips unknown keys', async () => {
    const res = await request(app).post('/api/v1/probe/items').send({ name: 'Bus', qty: 2, school_id: SCHOOL_B });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, data: { name: 'Bus', qty: 2 } });
    const bad = await request(app).post('/api/v1/probe/items').send({ name: '', qty: -1 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(['name', 'qty']);
    const badQuery = await request(app).get('/api/v1/probe/list?status=flying');
    expect(badQuery.body.error.details[0].path).toBe('query.status');
  });

  it('returns list envelopes with page/limit meta', async () => {
    const res = await request(app).get('/api/v1/probe/list?page=2&limit=20&status=active');
    expect(res.body).toEqual({ success: true, data: [{ status: 'active' }], meta: { page: 2, limit: 20, total: 45, totalPages: 3 } });
    expect((await request(app).get('/api/v1/probe/list?limit=500')).status).toBe(400);
  });

  it('replays the stored response for a repeated Idempotency-Key and rejects reuse with another body', async () => {
    const { token } = store.issue({ role: 'school_admin', schoolId: SCHOOL_A });
    const send = (body: unknown, key = 'create-key-0001') => request(app).post('/api/v1/probe/create').set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key).send(body as object);
    const first = await send({ a: 1, b: 2 });
    const replay = await send({ b: 2, a: 1 });
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(first.body);
    const reuse = await send({ a: 9 });
    expect(reuse.status).toBe(409);
    expect(reuse.body.error.details.reason).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await send({ a: 1 }, 'bad key')).status).toBe(400);
    // Another principal may use the same key independently.
    const other = store.issue({ role: 'school_admin', schoolId: SCHOOL_A });
    const otherRes = await request(app).post('/api/v1/probe/create').set('Authorization', `Bearer ${other.token}`).set('Idempotency-Key', 'create-key-0001').send({ a: 1, b: 2 });
    expect(otherRes.headers['idempotent-replayed']).toBeUndefined();
    expect(creates).toBe(2);
  });
});
