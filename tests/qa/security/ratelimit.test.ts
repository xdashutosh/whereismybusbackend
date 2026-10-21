// Rate-limit bypass attempts (BP §5.4 "rate-limited login (per IP and per identifier)", §16;
// contract §6). Every test asserts the SECURE behaviour.
import crypto from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildConfig } from '../../../src/config/index.js';
import { globalBucket, limiterSpecs } from '../../../src/middleware/rateLimits.js';
import { signAccessToken } from '../../../src/shared/tokens.js';
import { closeDb, ownerQuery, truncateAll } from '../../helpers/db.js';
import * as f from '../../helpers/factories.js';
import { buildApp, passwordHash, PASSWORD, schoolAdmin, type TestApp } from '../../helpers/authApp.js';
import { api } from './world.js';

let schoolId: string;
beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  const s = await f.school({ name: 'RL School' });
  await f.schoolSubscription(s.id);
  schoolId = String(s.id);
});
afterAll(closeDb);

function appWith(trustProxy: boolean | number): TestApp {
  const t = buildApp({ rateLimitsEnabled: true });
  t.app.set('trust proxy', trustProxy);
  return t;
}
const otp = (t: TestApp, phone: string, xff?: string) => {
  let r = request(t.app).post(api('/auth/parent/otp/request'));
  if (xff) r = r.set('X-Forwarded-For', xff);
  return r.send({ phone });
};

const PROD = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://wimbowner:ownerpw@db.example.com:5432/wimb?sslmode=require',
  DB_APP_USER: 'wimb_app', DB_APP_PASSWORD: 'app-secret-pw', JWT_ACCESS_SECRET: 'x'.repeat(48),
  CORS_ORIGINS: 'https://admin.example.com', RATE_LIMIT_ENABLED: 'true', REDIS_URL: 'redis://cache.example.com:6379',
  STORAGE_DRIVER: 's3', AWS_BUCKET_NAME: 'bucket', AWS_REGION: 'in-maa-1', AWS_ACCESS_KEY_ID: 'AKIA', AWS_SECRET_ACCESS_KEY: 'shh',
  SMS_PROVIDER: 'webpayservices', SMS_API_URL: 'https://sms.example.com/api.php', SMS_API_USERNAME: 'u', SMS_API_KEY: 'sms-api-key-123456',
  SMS_SENDER_ID: 'WIMBUS', SMS_ROUTE: 'OTP', SMS_DLT_TEMPLATE_ID: '1707170000000000001', SMS_OTP_MESSAGE: 'Your Where Is My Bus login code is {otp}. It is valid for 10 minutes.',
};
const issuesOf = (env: Record<string, string>): string => {
  try {
    buildConfig(env);
    return '';
  } catch (err) {
    return (err as Error).message;
  }
};

describe('X-Forwarded-For and TRUST_PROXY', () => {
  it('TRUST_PROXY=1 (one hop) limits a client rotating X-Forwarded-For by the right-most address', async () => {
    const t = appWith(1);
    let limited = 0;
    for (let i = 0; i < 25; i++) if ((await otp(t, `+9197${String(70000000 + i)}`, `203.0.113.${i + 1}, 198.51.100.7`)).status === 429) limited++;
    expect(limited).toBeGreaterThan(0);
  });

  it('production config refuses TRUST_PROXY unset/false/true/0 (only an explicit hop count or proxy list is safe)', () => {
    for (const v of [undefined, 'false', 'true', 'yes', '0', '']) {
      const env: Record<string, string> = { ...PROD };
      if (v !== undefined) env.TRUST_PROXY = v;
      expect(issuesOf(env), `TRUST_PROXY=${v}`).toMatch(/TRUST_PROXY/);
    }
    for (const v of ['1', '2', '10.0.0.0/8, 192.168.1.1']) expect(issuesOf({ ...PROD, TRUST_PROXY: v }), `TRUST_PROXY=${v}`).toBe('');
    expect(buildConfig({ ...PROD, TRUST_PROXY: '2' }).trustProxy).toBe(2);
    // Outside production the developer default (false) stays allowed.
    expect(issuesOf({ NODE_ENV: 'development', DATABASE_URL: 'postgresql://o:p@localhost:5432/wimb', STORAGE_DRIVER: 'local', TRUST_PROXY: 'false' })).toBe('');
  });
});

describe('password spraying from one IP (BP §5.4: per IP AND per identifier)', () => {
  it('one IP trying one password against 40 admin e-mails is refused with 429 by the per-IP limiter', async () => {
    const t = appWith(false);
    const admins: string[] = [];
    for (let i = 0; i < 40; i++) admins.push(String((await schoolAdmin(schoolId, { email: `spray${i}@example.test` })).email));
    const limit = limiterSpecs().loginIp.limit;
    const statuses: number[] = [];
    let limiter = '';
    for (const email of admins) {
      const res = await request(t.app).post(api('/auth/school/login')).send({ email, password: 'Winter2026!' });
      statuses.push(res.status);
      if (res.status === 429) limiter = res.body.error.details.limiter;
    }
    expect(statuses.slice(0, limit).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(limit).every((s) => s === 429)).toBe(true);
    expect(limiter).toBe('loginIp');
    // The other sign-in routes share the per-IP budget.
    expect((await request(t.app).post(api('/auth/staff/login')).send({ schoolCode: 'X', phone: '+919800000001', password: 'nope' })).status).toBe(429);
    expect((await request(t.app).post(api('/auth/parent/password-login')).send({ phone: '+919800000001', password: 'nope' })).status).toBe(429);
  });

  it('successful sign-ins never use up the per-IP budget', async () => {
    const t = appWith(false);
    const admin = await schoolAdmin(schoolId, { email: 'busy-office@example.test' });
    await ownerQuery('update users set password_hash = $1 where id = $2', [await passwordHash(), admin.id]);
    const limit = limiterSpecs().loginIp.limit;
    for (let i = 0; i < limit + 5; i++) {
      const res = await request(t.app).post(api('/auth/school/login')).send({ email: String(admin.email), password: PASSWORD });
      expect(res.status, `sign-in ${i}`).toBe(200);
    }
  });
});

describe('global limiter and the location-ingest URL', () => {
  const INGEST = '/api/v1/driver/trips/00000000-0000-4000-8000-000000000000/locations';
  const fakeReq = (headers: Record<string, string>, method = 'POST', url = INGEST) =>
    ({ method, originalUrl: url, ip: '198.51.100.9', socket: {}, get: (h: string) => headers[h.toLowerCase()] }) as never;
  const token = (role: 'driver' | 'parent', sid = crypto.randomUUID()) =>
    signAccessToken({ actorId: crypto.randomUUID(), role, schoolId: role === 'driver' ? crypto.randomUUID() : null, sessionId: sid }).accessToken;

  it('only a valid access token moves a request out of the per-IP bucket (ingest: per session, else per account)', () => {
    const sid = crypto.randomUUID();
    expect(globalBucket(fakeReq({}))).toBe('198.51.100.9');
    expect(globalBucket(fakeReq({ authorization: 'Bearer not-a-real-token-but-long-enough' }))).toBe('198.51.100.9');
    expect(globalBucket(fakeReq({ authorization: 'Bearer not-a-real-token-but-long-enough' }, 'GET', '/api/v1/school/buses'))).toBe('198.51.100.9');
    expect(globalBucket(fakeReq({ authorization: `Bearer ${token('driver', sid)}` }))).toBe(`sid:${sid}`);
    const parent = token('parent');
    const parentSub = JSON.parse(Buffer.from(parent.split('.')[1]!, 'base64url').toString()).sub as string;
    expect(globalBucket(fakeReq({ authorization: `Bearer ${parent}` }))).toBe(`actor:parent:${parentSub}`);
    const driver = token('driver', sid);
    const driverSub = JSON.parse(Buffer.from(driver.split('.')[1]!, 'base64url').toString()).sub as string;
    expect(globalBucket(fakeReq({ authorization: `Bearer ${driver}` }, 'POST', '/api/v1/driver/trips/start'))).toBe(`actor:driver:${driverSub}`);
    expect(globalBucket(fakeReq({ authorization: `Bearer ${driver}` }, 'GET'))).toBe(`actor:driver:${driverSub}`);
  });

  it('unauthenticated (1 MB) requests to /driver/trips/<any>/locations are rate limited like any other path', async () => {
    const t = appWith(false);
    const big = { points: 'x'.repeat(900_000) };
    const limit = limiterSpecs().global.limit;
    let limited = 0;
    for (let i = 0; i < limit + 20; i++) {
      const r = request(t.app).post(INGEST);
      if (i % 2 === 0) r.set('Authorization', 'Bearer forged.token.value-with-some-length');
      if ((await r.send(i % 50 === 0 ? big : {})).status === 429) limited++;
    }
    expect(limited).toBeGreaterThanOrEqual(20);
  });
});
