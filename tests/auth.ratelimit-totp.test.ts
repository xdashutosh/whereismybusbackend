// Route rate limiter × two-step Super Admin sign-in (regression). The `login` limiter (failuresOnly,
// 10 per 15 min per IP + identifier) counted every answer ≥ 400 — including the expected first step
// of the Super Admin sign-in (right password, no code yet → 401 TOTP_REQUIRED, TOTP_CODE_MISSING) —
// so about ten normal sign-ins from one IP ended in 429 RATE_LIMITED. Like the account lockout, the
// limiter now ignores the next steps the auth flows tag (lockout.ts nextStep → rateLimits.ts
// markNotFailure) and the enrolment challenge, while wrong passwords and wrong TOTP codes still count.
// Real DB under RLS, rate limits enabled.
import express from 'express';
import { generate, generateSecret } from 'otplib';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { createLimiter, limiterSpecs, markNotFailure } from '../src/middleware/rateLimits.js';
import { requestId } from '../src/middleware/requestId.js';
import { encryptSecret } from '../src/shared/crypto.js';
import { createMemoryKv } from '../src/shared/kv.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { buildApp, PASSWORD, passwordHash, type TestApp } from './helpers/authApp.js';

const LIMIT = limiterSpecs().login.limit; // 10 per 15 min per IP + identifier

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
});
afterAll(closeDb);

interface SuperAdmin {
  id: string;
  email: string;
  secret: string;
}

const platformLogin = (t: TestApp, body: Record<string, unknown>) => request(t.app).post('/api/v1/auth/platform/login').send(body);

/** `remaining` of the login limiter's RateLimit header (the request's own slot is already reserved). */
function remaining(res: request.Response): number {
  const m = new RegExp(`^limit=${LIMIT}, remaining=(\\d+),`).exec(String(res.headers.ratelimit));
  return m ? Number(m[1]) : Number.NaN;
}

async function enrolledSuperAdmin(): Promise<SuperAdmin> {
  const secret = generateSecret();
  const row = await f.platformUser({ password_hash: await passwordHash(), totp_enabled: true, totp_secret_enc: encryptSecret(secret, { purpose: 'totp' }) });
  return { id: String(row.id), email: String(row.email), secret };
}

/** A 6-digit code valid for none of the time steps around now (±2 × 30 s): always a wrong code. */
async function wrongCode(secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const valid = new Set(await Promise.all([-60, -30, 0, 30, 60].map((d) => generate({ secret, epoch: now + d }))));
  return ['000000', '111111', '222222', '333333', '444444', '555555'].find((c) => !valid.has(c))!;
}

/** The real two-step sign-in: password → 401 TOTP_REQUIRED (TOTP_CODE_MISSING), then password + code → session. */
async function twoStepSignIn(t: TestApp, admin: SuperAdmin) {
  const first = await platformLogin(t, { email: admin.email, password: PASSWORD });
  expect([first.status, first.body.error?.code, first.body.error?.details?.reason]).toEqual([401, 'TOTP_REQUIRED', 'TOTP_CODE_MISSING']);
  // Replay protection accepts each 30-s step once: reopen it so every sign-in can use the current code.
  await ownerQuery('update platform_users set totp_last_used_step = null where id = $1', [admin.id]);
  const second = await platformLogin(t, { email: admin.email, password: PASSWORD, totpCode: await generate({ secret: admin.secret }) });
  expect([second.status, second.body.data?.status]).toEqual([200, 'authenticated']);
  return { first, second };
}

describe('login limiter vs the two-step Super Admin sign-in', () => {
  it('never limits a sequence of more than 10 successful two-step sign-ins from one IP within the window', async () => {
    const t = buildApp({ rateLimitsEnabled: true });
    const admin = await enrolledSuperAdmin();
    for (let i = 0; i < LIMIT + 2; i += 1) {
      const { first, second } = await twoStepSignIn(t, admin);
      // Both steps were refunded: every request finds the whole budget (minus its own slot).
      expect([remaining(first), remaining(second)]).toEqual([LIMIT - 1, LIMIT - 1]);
    }
  });

  it('never counts the TOTP enrolment challenge of a Super Admin who has not enrolled yet', async () => {
    const t = buildApp({ rateLimitsEnabled: true });
    const admin = await f.platformUser({ password_hash: await passwordHash() });
    for (let i = 0; i < LIMIT + 2; i += 1) {
      const res = await platformLogin(t, { email: admin.email, password: PASSWORD });
      expect([res.status, res.body.data?.status, remaining(res)]).toEqual([200, 'totp_enrollment_required', LIMIT - 1]);
    }
  });

  it('still counts wrong passwords and wrong TOTP codes: the 11th failure is refused with 429 RATE_LIMITED', async () => {
    const t = buildApp({ rateLimitsEnabled: true });
    const admin = await enrolledSuperAdmin();
    const badCode = await wrongCode(admin.secret);
    const wrongPassword = async (i: number) => {
      const res = await platformLogin(t, { email: admin.email, password: `Wrong#${i}pass` });
      expect([res.status, res.body.error?.code]).toEqual([401, 'UNAUTHENTICATED']);
    };
    const wrongTotp = async () => {
      const res = await platformLogin(t, { email: admin.email, password: PASSWORD, totpCode: badCode });
      expect([res.status, res.body.error?.code, res.body.error?.details?.reason]).toEqual([401, 'TOTP_REQUIRED', 'TOTP_CODE_INVALID']);
    };
    // A successful sign-in clears the account lockout window (5 failures) but refunds only its own
    // limiter slots, so interleaved successes let 10 failures pile up without locking the account.
    for (let i = 0; i < 4; i += 1) await wrongPassword(i);
    await twoStepSignIn(t, admin);
    for (let i = 0; i < 4; i += 1) await wrongTotp();
    const { first } = await twoStepSignIn(t, admin);
    expect(remaining(first)).toBe(LIMIT - 9); // 8 failures so far + this request's own slot
    for (let i = 4; i < 6; i += 1) await wrongPassword(i);

    const limited = await platformLogin(t, { email: admin.email, password: 'Wrong#6pass' });
    expect(limited.status).toBe(429);
    expect(limited.body.error).toMatchObject({ code: 'RATE_LIMITED', details: { limiter: 'login' } });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    // From now on the limiter refuses this IP + identifier, the correct password included — and it is
    // the limiter, not the account lockout (the account is not locked).
    const blocked = await platformLogin(t, { email: admin.email, password: PASSWORD });
    expect([blocked.status, blocked.body.error?.details?.limiter]).toEqual([429, 'login']);
    expect((await ownerQuery('select locked_until from platform_users where id = $1', [admin.id])).rows[0]!.locked_until).toBeNull();
  });
});

describe('failuresOnly limiters and markNotFailure', () => {
  it('refund a ≥ 400 answer only when its handler marked it as an expected next step', async () => {
    const limiter = createLimiter({ name: 'steps', limit: 2, windowSec: 60, failuresOnly: true }, { enabled: true, store: createMemoryKv() });
    const app = express();
    app.use(requestId());
    app.post('/next-step', limiter, (_req, res) => {
      markNotFailure(res);
      res.status(401).json({ success: false });
    });
    app.post('/failure', limiter, (_req, res) => {
      res.status(401).json({ success: false });
    });
    app.use(errorHandler());
    for (let i = 0; i < 5; i += 1) expect((await request(app).post('/next-step')).status).toBe(401);
    expect((await request(app).post('/failure')).status).toBe(401);
    expect((await request(app).post('/failure')).status).toBe(401);
    expect((await request(app).post('/failure')).status).toBe(429);
    expect((await request(app).post('/next-step')).status).toBe(429); // the spent budget applies to every request
  });
});
