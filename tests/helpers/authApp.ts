// HTTP harness for the auth/audit/files suites: the real app (every module, real DB under RLS)
// with the auth router rebuilt on an isolated KV store, a capturing SMS channel and optional rate
// limits, plus helpers that create real accounts (argon2id hashes) and sign them in through the API.
import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { createRateLimits } from '../../src/middleware/rateLimits.js';
import { modules as defaultModules } from '../../src/modules/index.js';
import { createAuthRouter } from '../../src/modules/auth/router.js';
import { createFilesRouter } from '../../src/modules/files/router.js';
import { hashPassword } from '../../src/shared/crypto.js';
import { createMemoryKv, type KvStore } from '../../src/shared/kv.js';
import type { OtpPolicy } from '../../src/modules/auth/policy.js';
import type { SmsChannel } from '../../src/shared/notifications/sms.js';
import * as f from './factories.js';

export const PASSWORD = 'Secret#123';
export const PIN = '4321';

let hashCache: Promise<string> | null = null;
export function passwordHash(): Promise<string> {
  hashCache ??= hashPassword(PASSWORD);
  return hashCache;
}
let pinCache: Promise<string> | null = null;
export function pinHash(): Promise<string> {
  pinCache ??= hashPassword(PIN);
  return pinCache;
}

export interface SentSms {
  to: string;
  otp: string;
}

/** In-memory SMS channel; realSends = true makes every send count toward the global daily cap. */
export function capturingSms({ realSends = false }: { realSends?: boolean } = {}): SmsChannel & { sent: SentSms[]; lastOtp(to: string): string | undefined } {
  const sent: SentSms[] = [];
  return {
    provider: 'console',
    sent,
    lastOtp: (to) => [...sent].reverse().find((s) => s.to === to)?.otp,
    async sendOtp(to, otp) {
      sent.push({ to, otp });
      return { delivered: true, provider: 'console' };
    },
    async sendText() {
      return { delivered: true, provider: 'console' };
    },
    sendsRealSms: () => realSends,
    async checkBalance() {
      return { provider: 'console', balance: null, low: false, threshold: 0, checkedAt: new Date().toISOString(), cached: false };
    },
  };
}

export interface TestApp {
  app: Express;
  kv: KvStore;
  sms: ReturnType<typeof capturingSms>;
}

export function buildApp({
  rateLimitsEnabled = false,
  otpPolicy,
  now,
  realSends = false,
  smsOverride,
}: { rateLimitsEnabled?: boolean; otpPolicy?: OtpPolicy; now?: () => Date; realSends?: boolean; smsOverride?: Partial<SmsChannel> } = {}): TestApp {
  const kv = createMemoryKv();
  const sms = Object.assign(capturingSms({ realSends }), smsOverride ?? {});
  const rateLimits = createRateLimits({ enabled: rateLimitsEnabled, store: kv });
  const modules = defaultModules.map((m) => {
    if (m.name === 'auth') return { name: 'auth', router: createAuthRouter({ kv, sms, rateLimits, ...(otpPolicy ? { otpPolicy } : {}), ...(now ? { now } : {}) }) };
    if (m.name === 'files') return { name: 'files', router: createFilesRouter({ rateLimits }) };
    return m;
  });
  const app = createApp({ modules, rateLimits, loadMinVersions: async () => ({}) });
  return { app, kv, sms };
}

export const DEVICE: { deviceId: string; platform: 'android' | 'ios' | 'web'; model: string; appVersion: string } = { deviceId: 'device-aaaa-0001', platform: 'android', model: 'Pixel 8', appVersion: '1.0.0' };

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  body: Record<string, unknown>;
}

function tokensOf(res: request.Response): Tokens {
  const d = res.body.data as Record<string, unknown>;
  return { accessToken: d.accessToken as string, refreshToken: d.refreshToken as string, sessionId: d.sessionId as string, body: d };
}

/** Real school admin with a known password. */
export async function schoolAdmin(schoolId: string, o: f.Values = {}) {
  return f.user(schoolId, { role: 'school_admin', password_hash: await passwordHash(), ...o });
}

/** Real driver/conductor with password + PIN. */
export async function staffUser(schoolId: string, role: 'driver' | 'conductor' = 'driver', o: f.Values = {}) {
  return f.user(schoolId, { role, password_hash: await passwordHash(), pin_hash: await pinHash(), ...o });
}

export async function loginSchoolAdmin(app: Express, email: string): Promise<Tokens> {
  const res = await request(app).post('/api/v1/auth/school/login').send({ email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`school login failed ${res.status} ${JSON.stringify(res.body)}`);
  return tokensOf(res);
}

export async function loginStaff(app: Express, schoolCode: string, phone: string, device = DEVICE): Promise<Tokens> {
  const res = await request(app).post('/api/v1/auth/staff/login').send({ schoolCode, phone, password: PASSWORD, device });
  if (res.status !== 200) throw new Error(`staff login failed ${res.status} ${JSON.stringify(res.body)}`);
  return tokensOf(res);
}

export async function loginParent(t: TestApp, phone: string): Promise<Tokens> {
  const req = await request(t.app).post('/api/v1/auth/parent/otp/request').send({ phone });
  if (req.status !== 202) throw new Error(`otp request failed ${req.status} ${JSON.stringify(req.body)}`);
  const otp = t.sms.lastOtp(phone);
  if (!otp) throw new Error('no OTP captured');
  const res = await request(t.app).post('/api/v1/auth/parent/otp/verify').send({ phone, otp });
  if (res.status !== 200) throw new Error(`otp verify failed ${res.status} ${JSON.stringify(res.body)}`);
  return tokensOf(res);
}

export { tokensOf };
