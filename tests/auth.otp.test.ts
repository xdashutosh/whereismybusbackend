// Parent OTP sign-in (contract §2/§6): only school-registered numbers receive codes, identical
// responses for unknown numbers (no enumeration), 6-digit hashed codes, env-driven policy
// (SMS_OTP_EXPIRY_MIN / MAX_ATTEMPTS / RESEND_SECONDS; tests/helpers/testEnv.ts pins 10 min, 5, 60 s),
// per-phone daily cap (Asia/Kolkata day), global daily circuit breaker, per-phone and per-IP limits,
// children index grouped by school.
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import config from '../src/config/index.js';
import { globalSendsKey, globalTrippedKey, otpDay } from '../src/modules/auth/otp.js';
import type { OtpPolicy } from '../src/modules/auth/policy.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { buildApp, type TestApp } from './helpers/authApp.js';

let t: TestApp;
let schoolA: f.Row;
let schoolB: f.Row;
let parent: f.Row;
let childA: f.Row;
let childB: f.Row;

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  schoolA = await f.school({ name: 'Alpha School' });
  schoolB = await f.school({ name: 'Beta School' });
  parent = await f.parentAccount({ display_name: 'Vikram Mehta' });
  childA = await f.student(schoolA.id, { full_name: 'Aarav Mehta', admission_no: 'A-1' });
  childB = await f.student(schoolB.id, { full_name: 'Isha Mehta', admission_no: 'B-1' });
  for (const [s, c] of [[schoolA, childA], [schoolB, childB]] as const) {
    await f.schoolParent(s.id, parent.id, { full_name: 'Vikram Mehta' });
    await f.studentParent(s.id, c.id, parent.id);
  }
});
beforeEach(async () => {
  t = buildApp();
  await ownerQuery('delete from otp_codes');
});
afterAll(closeDb);

const requestOtp = (phone: string, app = t.app) => request(app).post('/api/v1/auth/parent/otp/request').send({ phone });
const verifyOtp = (phone: string, otp: string, app = t.app) => request(app).post('/api/v1/auth/parent/otp/verify').send({ phone, otp });

describe('OTP request', () => {
  it('sends a 6-digit code to registered numbers and stores only its hash', async () => {
    const res = await requestOtp(String(parent.phone));
    expect(res.status).toBe(202);
    expect(res.body.data).toEqual({ status: 'sent', expiresInSeconds: 600, resendAfterSeconds: 60, codeLength: 6 });
    expect(res.body.data.expiresInSeconds).toBe(config.sms.otp.expirySeconds);
    expect(res.body.data.resendAfterSeconds).toBe(config.sms.otp.resendSeconds);
    const otp = t.sms.lastOtp(String(parent.phone))!;
    expect(otp).toMatch(/^\d{6}$/);
    const { rows } = await ownerQuery("select code_hash, attempts, max_attempts, extract(epoch from expires_at - now())::int as ttl from otp_codes where phone = $1", [parent.phone]);
    expect(rows[0]!.code_hash).not.toContain(otp);
    expect(rows[0]).toMatchObject({ attempts: 0, max_attempts: 5 });
    expect(rows[0]!.ttl).toBeGreaterThan(590);
    expect(rows[0]!.ttl).toBeLessThanOrEqual(600);
  });

  it('answers unknown and unlinked numbers identically without sending anything', async () => {
    const known = await requestOtp(String(parent.phone));
    const unknownPhone = f.uniquePhone();
    const unknown = await requestOtp(unknownPhone);
    const unlinked = await f.parentAccount();
    const inactiveLink = await f.parentAccount();
    await f.schoolParent(schoolA.id, inactiveLink.id, { is_active: false });
    const r1 = await requestOtp(String(unlinked.phone));
    const r2 = await requestOtp(String(inactiveLink.phone));
    for (const r of [unknown, r1, r2]) {
      expect(r.status).toBe(known.status);
      expect(r.body).toEqual(known.body);
    }
    expect(t.sms.sent.map((s) => s.to)).toEqual([parent.phone]);
    expect((await ownerQuery('select count(*)::int as n from otp_codes where phone = any ($1)', [[unknownPhone, unlinked.phone, inactiveLink.phone]])).rows[0]!.n).toBe(0);
  });

  it('enforces the resend cooldown for every number alike', async () => {
    expect((await requestOtp(String(parent.phone))).status).toBe(202);
    const again = await requestOtp(String(parent.phone));
    const ghost = f.uniquePhone();
    await requestOtp(ghost);
    const ghostAgain = await requestOtp(ghost);
    for (const r of [again, ghostAgain]) {
      expect(r.status).toBe(429);
      expect(r.body.error.details.reason).toBe('OTP_COOLDOWN');
      expect(Number(r.headers['retry-after'])).toBeLessThanOrEqual(60);
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(50);
    }
    expect(t.sms.sent).toHaveLength(1);
  });

  it('accepts local spellings and rejects malformed numbers', async () => {
    const local = String(parent.phone).replace('+91', '');
    expect((await requestOtp(`${local.slice(0, 5)} ${local.slice(5)}`)).status).toBe(202);
    expect(t.sms.sent[0]!.to).toBe(parent.phone);
    expect((await requestOtp('12345')).status).toBe(400);
  });
});

describe('OTP verify', () => {
  it('signs the parent in and returns children grouped by school', async () => {
    await requestOtp(String(parent.phone));
    const res = await verifyOtp(String(parent.phone), t.sms.lastOtp(String(parent.phone))!);
    expect(res.status).toBe(200);
    const user = res.body.data.user;
    expect(user).toMatchObject({ role: 'parent', id: parent.id, phone: parent.phone, name: 'Vikram Mehta' });
    expect(user.schools.map((s: { school: { name: string } }) => s.school.name)).toEqual(['Alpha School', 'Beta School']);
    expect(user.schools[0].children).toEqual([expect.objectContaining({ id: childA.id, fullName: 'Aarav Mehta' })]);
    expect(user.schools[1].children).toEqual([expect.objectContaining({ id: childB.id, fullName: 'Isha Mehta' })]);
    const s = await ownerQuery('select owner_type, school_id from sessions where id = $1', [res.body.data.sessionId]);
    expect(s.rows[0]).toEqual({ owner_type: 'parent_account', school_id: null });
    // single use
    expect((await verifyOtp(String(parent.phone), t.sms.lastOtp(String(parent.phone))!)).status).toBe(401);
  });

  it('rejects wrong, unknown-number, expired and exhausted codes with the same answer', async () => {
    await requestOtp(String(parent.phone));
    const otp = t.sms.lastOtp(String(parent.phone))!;
    const wrongCode = otp === '000000' ? '111111' : '000000';
    const wrong = await verifyOtp(String(parent.phone), wrongCode);
    const unknown = await verifyOtp(f.uniquePhone(), otp);
    expect(wrong.status).toBe(401);
    expect(unknown.body).toMatchObject({ error: { code: wrong.body.error.code, message: wrong.body.error.message } });
    // 4 more wrong attempts exhaust the code: the right one is refused afterwards.
    for (let i = 0; i < 4; i += 1) expect((await verifyOtp(String(parent.phone), wrongCode)).status).toBe(401);
    expect((await verifyOtp(String(parent.phone), otp)).status).toBe(401);

    t = buildApp();
    await ownerQuery('delete from otp_codes where phone = $1', [parent.phone]);
    await requestOtp(String(parent.phone));
    const fresh = t.sms.lastOtp(String(parent.phone))!;
    await ownerQuery("update otp_codes set expires_at = now() - interval '1 second' where phone = $1", [parent.phone]);
    const expired = await verifyOtp(String(parent.phone), fresh);
    expect([expired.status, expired.body.error.message]).toEqual([401, wrong.body.error.message]);
  });

  it('a new code replaces the previous one after the cooldown', async () => {
    await requestOtp(String(parent.phone));
    const first = t.sms.lastOtp(String(parent.phone))!;
    await t.kv.deleteByPrefix('auth:otp-cooldown');
    await ownerQuery("update otp_codes set last_sent_at = now() - interval '61 seconds' where phone = $1", [parent.phone]);
    expect((await requestOtp(String(parent.phone))).status).toBe(202);
    const second = t.sms.lastOtp(String(parent.phone))!;
    if (first !== second) expect((await verifyOtp(String(parent.phone), first)).status).toBe(401);
    expect((await verifyOtp(String(parent.phone), second)).status).toBe(200);
  });
});

describe('OTP rate limits', () => {
  it('limits requests per phone and per IP, and failed verifications', async () => {
    const limited = buildApp({ rateLimitsEnabled: true });
    const phone = f.uniquePhone();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await requestOtp(phone, limited.app)).status);
    expect(statuses[0]).toBe(202);
    const sixth = await requestOtp(phone, limited.app);
    expect(sixth.status).toBe(429);
    expect(sixth.body.error.details.limiter).toBe('otpRequestPhone');

    const ipApp = buildApp({ rateLimitsEnabled: true });
    let last: request.Response | undefined;
    for (let i = 0; i < 21; i += 1) last = await requestOtp(f.uniquePhone(), ipApp.app);
    expect(last!.status).toBe(429);
    expect(last!.body.error.details.limiter).toBe('otpRequestIp');

    const verifyApp = buildApp({ rateLimitsEnabled: true });
    let v: request.Response | undefined;
    for (let i = 0; i < 11; i += 1) v = await verifyOtp(String(parent.phone), '000001', verifyApp.app);
    expect(v!.status).toBe(429);
    expect(v!.body.error.details.limiter).toBe('otpVerify');
  });
});

// ── env-driven policy, daily caps and the global circuit breaker ──────────────
const POLICY: OtpPolicy = { expirySeconds: 120, maxAttempts: 2, resendSeconds: 20, dailyCapPerPhone: 10, globalDailyCap: 2000 };
/** 2026-10-18 23:30 in Asia/Kolkata → 30 minutes to local midnight. */
const LATE_EVENING = new Date('2026-10-18T18:00:00Z');

async function bypassCooldown(app: TestApp) {
  await app.kv.deleteByPrefix('auth:otp-cooldown');
  await ownerQuery("update otp_codes set last_sent_at = now() - interval '1 hour'");
}

async function registeredParent(): Promise<string> {
  const p = await f.parentAccount();
  await f.schoolParent(schoolA.id, p.id);
  return String(p.phone);
}

describe('OTP policy from env', () => {
  it('uses the injected policy for the response, expiry, attempts and cooldown', async () => {
    const app = buildApp({ otpPolicy: POLICY });
    const res = await requestOtp(String(parent.phone), app.app);
    expect(res.status).toBe(202);
    expect(res.body.data).toEqual({ status: 'sent', expiresInSeconds: 120, resendAfterSeconds: 20, codeLength: 6 });
    const { rows } = await ownerQuery('select max_attempts, extract(epoch from expires_at - now())::int as ttl from otp_codes where phone = $1', [parent.phone]);
    expect(rows[0]!.max_attempts).toBe(2);
    expect(rows[0]!.ttl).toBeGreaterThan(110);
    expect(rows[0]!.ttl).toBeLessThanOrEqual(120);

    const again = await requestOtp(String(parent.phone), app.app);
    expect(again.status).toBe(429);
    expect(Number(again.headers['retry-after'])).toBeLessThanOrEqual(20);

    const otp = app.sms.lastOtp(String(parent.phone))!;
    const wrong = otp === '000000' ? '111111' : '000000';
    for (let i = 0; i < 2; i += 1) expect((await verifyOtp(String(parent.phone), wrong, app.app)).status).toBe(401);
    expect((await verifyOtp(String(parent.phone), otp, app.app)).status).toBe(401); // exhausted after 2 attempts
  });

  it('defaults to config.sms.otp (SMS_OTP_*)', async () => {
    expect(config.sms.otp).toMatchObject({ expirySeconds: 600, maxAttempts: 5, resendSeconds: 60, dailyCapPerPhone: 10, globalDailyCap: 2000 });
    const res = await requestOtp(String(parent.phone));
    expect(res.body.data).toMatchObject({ expiresInSeconds: config.sms.otp.expirySeconds, resendAfterSeconds: config.sms.otp.resendSeconds });
  });
});

describe('OTP daily cap per phone (Asia/Kolkata day)', () => {
  it('computes the local day and the seconds to local midnight', () => {
    expect(otpDay(LATE_EVENING)).toEqual({ day: '2026-10-18', secondsToMidnight: 1800 });
    expect(otpDay(new Date('2026-10-18T18:30:00Z'))).toEqual({ day: '2026-10-19', secondsToMidnight: 86400 });
  });

  it('caps registered and unknown numbers identically, with Retry-After until local midnight', async () => {
    let now = LATE_EVENING;
    const app = buildApp({ otpPolicy: { ...POLICY, dailyCapPerPhone: 2 }, now: () => now });
    const known = await registeredParent();
    const unknown = f.uniquePhone();
    const run = async (phone: string) => {
      const out: { status: number; body: unknown; retryAfter: string | undefined }[] = [];
      for (let i = 0; i < 3; i += 1) {
        const r = await requestOtp(phone, app.app);
        out.push({ status: r.status, body: r.body.data ?? { code: r.body.error.code, message: r.body.error.message, details: r.body.error.details }, retryAfter: r.headers['retry-after'] });
        await bypassCooldown(app);
      }
      return out;
    };
    const a = await run(known);
    const b = await run(unknown);
    expect(a.map((x) => x.status)).toEqual([202, 202, 429]);
    expect(b).toEqual(a);
    expect(a[2]).toMatchObject({ retryAfter: '1800', body: { code: 'RATE_LIMITED', details: { reason: 'OTP_DAILY_CAP', retryAfterSeconds: 1800 } } });
    expect(app.sms.sent.filter((s) => s.to === known)).toHaveLength(2);
    expect(app.sms.sent.filter((s) => s.to === unknown)).toHaveLength(0);

    now = new Date('2026-10-18T18:31:00Z'); // next local day
    expect((await requestOtp(known, app.app)).status).toBe(202);
    expect((await requestOtp(unknown, app.app)).status).toBe(202);
  });

  it('a cooldown rejection does not use up the daily allowance', async () => {
    const app = buildApp({ otpPolicy: { ...POLICY, dailyCapPerPhone: 2 }, now: () => LATE_EVENING });
    const phone = await registeredParent();
    expect((await requestOtp(phone, app.app)).status).toBe(202);
    for (let i = 0; i < 3; i += 1) expect((await requestOtp(phone, app.app)).body.error.details.reason).toBe('OTP_COOLDOWN');
    await bypassCooldown(app);
    expect((await requestOtp(phone, app.app)).status).toBe(202);
  });
});

describe('OTP global daily circuit breaker', () => {
  it('counts real provider sends only; once tripped every number gets the same 503 and the provider is not called', async () => {
    const app = buildApp({ otpPolicy: { ...POLICY, globalDailyCap: 2 }, now: () => LATE_EVENING, realSends: true });
    const { day } = otpDay(LATE_EVENING);
    const [p1, p2, p3] = [await registeredParent(), await registeredParent(), await registeredParent()];
    expect((await requestOtp(p1, app.app)).status).toBe(202);
    expect((await requestOtp(f.uniquePhone(), app.app)).status).toBe(202); // unknown numbers send nothing and do not count
    expect((await requestOtp(p2, app.app)).status).toBe(202);
    expect(await app.kv.get(globalSendsKey(day))).toBe('2');
    expect(await app.kv.get(globalTrippedKey(day))).toBeNull();

    const tripped = [await requestOtp(p3, app.app), await requestOtp(f.uniquePhone(), app.app), await requestOtp(p1, app.app)];
    for (const r of tripped) {
      expect(r.status).toBe(503);
      const { requestId: _a, ...error } = r.body.error;
      const { requestId: _b, ...first } = tripped[0]!.body.error;
      expect(error).toEqual(first);
      expect(r.headers['retry-after']).toBe('1800');
    }
    expect(tripped[0]!.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(JSON.stringify(tripped[0]!.body)).not.toMatch(/cap|SMS_OTP|provider/i);
    expect(app.sms.sent.map((s) => s.to)).toEqual([p1, p2]);
    expect(await app.kv.get(globalTrippedKey(day))).toBe('1'); // the "logged once" marker
    expect(await app.kv.get(globalSendsKey(day))).toBe('2');
  });

  it('console (non-billable) sends never trip the breaker', async () => {
    const app = buildApp({ otpPolicy: { ...POLICY, globalDailyCap: 1 }, now: () => LATE_EVENING, realSends: false });
    for (let i = 0; i < 3; i += 1) expect((await requestOtp(await registeredParent(), app.app)).status).toBe(202);
    expect(await app.kv.get(globalSendsKey(otpDay(LATE_EVENING).day))).toBeNull();
  });
});

describe('OTP delivery failures', () => {
  it('never reach the client: same 202 as a successful send', async () => {
    const ok = await requestOtp(String(parent.phone));
    await ownerQuery('delete from otp_codes');
    const failing = buildApp({ smsOverride: { sendOtp: async () => ({ delivered: false, provider: 'webpayservices', error: 'LOW_BALANCE' }) } });
    const res = await requestOtp(String(parent.phone), failing.app);
    expect(res.status).toBe(202);
    expect(res.body).toEqual(ok.body);
    const throwing = buildApp({ smsOverride: { sendOtp: async () => Promise.reject(new Error('Low SMS Balance')) } });
    await ownerQuery('delete from otp_codes');
    const res2 = await requestOtp(String(parent.phone), throwing.app);
    expect([res2.status, JSON.stringify(res2.body).includes('Balance')]).toEqual([202, false]);
  });
});
