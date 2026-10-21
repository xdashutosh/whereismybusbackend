// Shared world for the security regression suite (formerly the pre-release attack suite): the real app (every module, real DB under RLS),
// the two-school fixture (BP §4.9: identical codes/names, one parent linked in both schools) and
// signed-in principals of every role.
import request from 'supertest';
import { generate, generateSecret } from 'otplib';
import { encryptSecret } from '../../../src/shared/crypto.js';
import { ownerQuery, truncateAll } from '../../helpers/db.js';
import * as f from '../../helpers/factories.js';
import { buildApp, loginParent, loginSchoolAdmin, loginStaff, passwordHash, PASSWORD, pinHash, type TestApp, type Tokens } from '../../helpers/authApp.js';

export const api = (p: string) => `/api/v1${p}`;
export type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface World {
  t: TestApp;
  fx: f.TwoSchoolFixture;
  adminA: Tokens;
  adminB: Tokens;
  driverA: Tokens;
  conductorA: Tokens;
  parent: Tokens;
  superAdmin: Tokens;
  totpSecret: string;
}

export const DRIVER_DEVICE = { deviceId: 'device-aaaa-0001', platform: 'android' as const, model: 'Pixel 8', appVersion: '1.0.0' };
export const CONDUCTOR_DEVICE = { deviceId: 'device-cond-0001', platform: 'android' as const, model: 'Pixel 7', appVersion: '1.0.0' };

/** Enrols TOTP for a platform user and signs in with password + code. */
export async function superAdminLogin(t: TestApp, superAdmin: f.Row, secret = generateSecret()): Promise<{ tokens: Tokens; secret: string }> {
  await ownerQuery('update platform_users set password_hash = $1, totp_enabled = true, totp_secret_enc = $2, totp_last_used_step = null where id = $3', [
    await passwordHash(),
    encryptSecret(secret, { purpose: 'totp' }),
    superAdmin.id,
  ]);
  const res = await request(t.app).post(api('/auth/platform/login')).send({ email: superAdmin.email, password: PASSWORD, totpCode: await generate({ secret }) });
  if (res.status !== 200) throw new Error(`platform login failed ${res.status} ${JSON.stringify(res.body)}`);
  const d = res.body.data as Record<string, unknown>;
  return { tokens: { accessToken: d.accessToken as string, refreshToken: d.refreshToken as string, sessionId: d.sessionId as string, body: d }, secret };
}

export async function buildWorld(opts: Parameters<typeof buildApp>[0] = {}): Promise<World> {
  await truncateAll({ keep: ['platform_settings'] });
  const t = buildApp(opts);
  const fx = await f.twoSchoolFixture();
  const { a, b } = fx;
  await ownerQuery('update users set password_hash = $1 where id = any ($2)', [await passwordHash(), [a.admin.id, b.admin.id, a.driverUser.id, a.conductorUser.id, b.driverUser.id]]);
  await ownerQuery('update users set pin_hash = $1 where id = any ($2)', [await pinHash(), [a.driverUser.id]]);
  const adminA = await loginSchoolAdmin(t.app, String(a.admin.email));
  const adminB = await loginSchoolAdmin(t.app, String(b.admin.email));
  const driverA = await loginStaff(t.app, String(a.school.code), String(a.driverUser.phone), DRIVER_DEVICE);
  const conductorA = await loginStaff(t.app, String(a.school.code), String(a.conductorUser.phone), CONDUCTOR_DEVICE);
  const parent = await loginParent(t, String(fx.sharedParent.phone));
  const { tokens: superAdmin, secret } = await superAdminLogin(t, fx.superAdmin);
  return { t, fx, adminA, adminB, driverA, conductorA, parent, superAdmin, totpSecret: secret };
}

/** supertest call with an optional bearer token and headers. */
export function call(t: TestApp, method: Method, path: string, token: string | null, { body, headers = {} }: { body?: unknown; headers?: Record<string, string> } = {}) {
  let r = request(t.app)[method](api(path));
  if (token) r = r.set('Authorization', `Bearer ${token}`);
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  return body !== undefined && method !== 'get' ? r.send(body as object) : r;
}

/** md5 fingerprint of the rows of a table that belong to a school (owner connection, RLS bypassed). */
export async function fingerprint(schoolId: string, tables: readonly string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of tables) {
    const col = table === 'schools' ? 'id' : 'school_id';
    const { rows } = await ownerQuery<{ h: string | null }>(`select md5(string_agg(t::text, '|' order by t::text)) as h from ${table} t where ${col} = $1`, [schoolId]);
    out[table] = rows[0]?.h ?? 'empty';
  }
  return out;
}
