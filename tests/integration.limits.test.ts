// Integrator regressions — the refresh rate limit is keyed per session (refresh token) with a
// generous per-IP ceiling, so a school office or a carrier NAT (many devices, one address) is not
// throttled as one client (was: 60 per 15 minutes per IP).
import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { createRateLimits, limiterSpecs, refreshBucket, type LimiterSpec } from '../src/middleware/rateLimits.js';
import { requestId } from '../src/middleware/requestId.js';
import { createMemoryKv } from '../src/shared/kv.js';
import { buildApp, loginSchoolAdmin, schoolAdmin } from './helpers/authApp.js';
import { closeDb, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';

const token = (i: number) => `refresh-token-${String(i).padStart(4, '0')}-abcdefghijklmnop`;

function refreshApp(overrides: Partial<Record<string, Partial<LimiterSpec>>> = {}) {
  const rl = createRateLimits({ enabled: true, store: createMemoryKv(), overrides });
  const app = express();
  app.use(requestId());
  app.use(cookieParser());
  app.use(express.json());
  app.post('/refresh', rl.refreshIp, rl.refresh, (_req, res) => {
    res.status(401).json({ success: false });
  });
  app.use(errorHandler());
  return app;
}

beforeAll(() => truncateAll({ keep: ['platform_settings'] }));
afterAll(closeDb);

describe('refresh limiter keys', () => {
  it('buckets by refresh token (cookie for web, body for mobile), by IP without one', () => {
    const web = { get: (h: string) => (h.toLowerCase() === 'x-wimb-client' ? 'web' : undefined), cookies: { wimb_rt: token(1) }, body: {}, ip: '10.0.0.1', socket: {} };
    const mobile = { get: () => undefined, cookies: {}, body: { refreshToken: token(1) }, ip: '10.0.0.2', socket: {} };
    const none = { get: () => undefined, cookies: {}, body: {}, ip: '10.0.0.3', socket: {} };
    const k1 = refreshBucket(web as never);
    expect(k1).toMatch(/^rt:[0-9a-f]{40}$/);
    expect(refreshBucket(mobile as never)).toBe(k1); // same token → same bucket, whatever the address
    expect(k1).not.toContain(token(1)); // never the raw token
    expect(refreshBucket(none as never)).toBe('ip:10.0.0.3');
    // A web request does not fall back to a body token (cookie only), and vice versa.
    expect(refreshBucket({ ...web, cookies: {}, body: { refreshToken: token(2) } } as never)).toBe('ip:10.0.0.1');
  });

  it('per-session budget plus a high per-IP ceiling', () => {
    const specs = limiterSpecs();
    expect(specs.refresh).toMatchObject({ limit: 30, windowSec: 900 });
    expect(specs.refreshIp.limit).toBeGreaterThanOrEqual(3000);
  });
});

describe('refresh limiter behaviour', () => {
  it('one address can refresh many sessions (far beyond the old 60 per IP)', async () => {
    const app = refreshApp();
    for (let i = 0; i < 150; i += 1) {
      const res = await request(app).post('/refresh').send({ refreshToken: token(i) });
      expect(res.status, `request ${i}`).toBe(401);
    }
  });

  it('a single session hammering refresh is limited without affecting other sessions on the same IP', async () => {
    const app = refreshApp();
    for (let i = 0; i < 30; i += 1) expect((await request(app).post('/refresh').send({ refreshToken: token(1) })).status).toBe(401);
    const limited = await request(app).post('/refresh').send({ refreshToken: token(1) });
    expect(limited.status).toBe(429);
    expect(limited.body.error).toMatchObject({ code: 'RATE_LIMITED', details: { limiter: 'refresh' } });
    expect((await request(app).post('/refresh').send({ refreshToken: token(2) })).status).toBe(401);
    // Web cookie of the same token shares the bucket.
    const web = await request(app).post('/refresh').set('X-WIMB-Client', 'web').set('Cookie', `wimb_rt=${token(1)}`).send({});
    expect(web.status).toBe(429);
  });

  it('the per-IP ceiling still stops a flood of distinct tokens', async () => {
    const app = refreshApp({ refreshIp: { limit: 5 } });
    for (let i = 0; i < 5; i += 1) expect((await request(app).post('/refresh').send({ refreshToken: token(100 + i) })).status).toBe(401);
    const res = await request(app).post('/refresh').send({ refreshToken: token(200) });
    expect(res.status).toBe(429);
    expect(res.body.error.details.limiter).toBe('refreshIp');
  });

  it('real refresh rotation through the auth module keeps working with limits on', async () => {
    const t = buildApp({ rateLimitsEnabled: true });
    const school = await f.school({ code: 'LIM-REF' });
    const admin = await schoolAdmin(school.id);
    let tokens = await loginSchoolAdmin(t.app, String(admin.email));
    for (let i = 0; i < 40; i += 1) {
      const res = await request(t.app).post('/api/v1/auth/refresh').send({ refreshToken: tokens.refreshToken });
      expect(res.status, `rotation ${i}`).toBe(200);
      const data = res.body.data as { accessToken: string; refreshToken: string };
      tokens = { ...tokens, accessToken: data.accessToken, refreshToken: data.refreshToken };
    }
  });
});
