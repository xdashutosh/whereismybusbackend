// Rate limiters (shared KV counters) and app version gating.
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { createLimiter, createRateLimits } from '../src/middleware/rateLimits.js';
import { requestId } from '../src/middleware/requestId.js';
import { createMemoryKv, type KvStore } from '../src/shared/kv.js';
import { signAccessToken } from '../src/shared/tokens.js';
import { compareVersions, parseVersion } from '../src/shared/version.js';

function appWith(limiter: express.RequestHandler, status = 200) {
  const app = express();
  app.use(requestId());
  app.use(express.json());
  app.post('/x', limiter, (_req, res) => {
    res.status(status).json({ success: status < 400 });
  });
  app.use(errorHandler());
  return app;
}

describe('rate limits', () => {
  it('returns 429 with Retry-After once the window budget is spent', async () => {
    const app = appWith(createLimiter({ name: 't1', limit: 2, windowSec: 60 }, { enabled: true, store: createMemoryKv() }));
    expect((await request(app).post('/x')).status).toBe(200);
    const second = await request(app).post('/x');
    expect(second.headers.ratelimit).toMatch(/remaining=0/);
    const third = await request(app).post('/x');
    expect(third.status).toBe(429);
    expect(third.body.error).toMatchObject({ code: 'RATE_LIMITED', details: { limiter: 't1' } });
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('counts only failures for failuresOnly limiters, keyed per identifier', async () => {
    const store = createMemoryKv();
    const login = createRateLimits({ enabled: true, store, overrides: { login: { limit: 2 } } }).login;
    const okApp = appWith(login, 200);
    for (let i = 0; i < 4; i += 1) expect((await request(okApp).post('/x').send({ email: 'a@b.c' })).status).toBe(200);
    const failApp = appWith(login, 401);
    expect((await request(failApp).post('/x').send({ email: 'a@b.c' })).status).toBe(401);
    expect((await request(failApp).post('/x').send({ email: 'a@b.c' })).status).toBe(401);
    expect((await request(failApp).post('/x').send({ email: 'A@B.C' })).status).toBe(429);
    expect((await request(failApp).post('/x').send({ email: 'other@b.c' })).status).toBe(401);
  });

  it('is a pass-through when disabled and fails open when the store is down', async () => {
    const disabled = appWith(createLimiter({ name: 't2', limit: 0, windowSec: 60 }, { enabled: false }));
    expect((await request(disabled).post('/x')).status).toBe(200);
    const broken: KvStore = { ...createMemoryKv(), incr: () => Promise.reject(new Error('redis down')) };
    const open = appWith(createLimiter({ name: 't3', limit: 0, windowSec: 60 }, { enabled: true, store: broken }));
    expect((await request(open).post('/x')).status).toBe(200);
  });

  it('keys OTP requests by normalised phone; location ingestion by a signed-in crew member has its own global bucket', async () => {
    const store = createMemoryKv();
    const limits = createRateLimits({ enabled: true, store, overrides: { otpRequestPhone: { limit: 1 }, global: { limit: 1 } } });
    const otp = appWith(limits.otpRequestPhone);
    expect((await request(otp).post('/x').send({ phone: '98450 12345' })).status).toBe(200);
    expect((await request(otp).post('/x').send({ phone: '+91 98450-12345' })).status).toBe(429);
    const ingest = express();
    ingest.use(limits.global);
    ingest.post('/api/v1/driver/trips/:id/locations', (_req, res) => res.json({ ok: true }));
    ingest.post('/api/v1/other', (_req, res) => res.json({ ok: true }));
    ingest.use(errorHandler());
    expect((await request(ingest).post('/api/v1/other')).status).toBe(200);
    expect((await request(ingest).post('/api/v1/other')).status).toBe(429);
    // Anonymous (or forged-token) ingestion shares the per-IP bucket: no unlimited unauthenticated path.
    expect((await request(ingest).post('/api/v1/driver/trips/abc/locations')).status).toBe(429);
    expect((await request(ingest).post('/api/v1/driver/trips/abc/locations').set('Authorization', 'Bearer forged.token.value-with-some-length')).status).toBe(429);
    // A valid crew token is bucketed per session (many buses can share one carrier-NAT address).
    const crew = signAccessToken({ actorId: crypto.randomUUID(), role: 'driver', schoolId: crypto.randomUUID(), sessionId: crypto.randomUUID() }).accessToken;
    expect((await request(ingest).post('/api/v1/driver/trips/abc/locations').set('Authorization', `Bearer ${crew}`)).status).toBe(200);
  });
});

describe('version gate', () => {
  const app = createApp({ modules: [], loadMinVersions: async () => ({ driver_app: '1.4.0' }), readinessChecks: {} });

  it('rejects outdated or unversioned driver apps with 426', async () => {
    const old = await request(app).get('/api/v1/anything').set('X-App-Name', 'driver_app').set('X-App-Version', '1.3.9');
    expect(old.status).toBe(426);
    expect(old.body.error).toMatchObject({ code: 'APP_UPDATE_REQUIRED', details: { app: 'driver_app', minSupportedVersion: '1.4.0', currentVersion: '1.3.9' } });
    const missing = await request(app).get('/api/v1/anything').set('X-App-Name', 'driver_app');
    expect(missing.status).toBe(426);
    const pre = await request(app).get('/api/v1/anything').set('X-App-Name', 'driver_app').set('X-App-Version', '1.4.0-beta.1');
    expect(pre.status).toBe(426);
  });

  it('lets current apps, other apps and web clients through', async () => {
    for (const [name, version] of [
      ['driver_app', '1.4.0'],
      ['driver_app', '2.0.0'],
      ['parent_app', '0.1.0'],
      ['unknown_app', '0.0.1'],
    ]) {
      const res = await request(app).get('/api/v1/anything').set('X-App-Name', name!).set('X-App-Version', version!);
      expect(res.status).toBe(404); // passed the gate, then no such route
    }
    expect((await request(app).get('/api/v1/anything')).status).toBe(404);
  });

  it('compares semantic versions', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.3-rc.1', '1.2.3')).toBe(-1);
    expect(compareVersions('1.2.3+build.5', '1.2.3')).toBe(0);
    expect(parseVersion('v1.2')).toBeNull();
    expect(() => compareVersions('x', '1.0.0')).toThrow(TypeError);
  });
});
