// Regression (audit-web): the platform audit rows written during first sign-in (TOTP enrolment) carry
// the Super Admin name, like every later sign-in (modules/auth/totp.ts totpVerify).
import { generate } from 'otplib';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, ownerQuery, truncateAll } from '../helpers/db.js';
import * as f from '../helpers/factories.js';
import { buildApp, PASSWORD, passwordHash, type TestApp } from '../helpers/authApp.js';

let t: TestApp;
beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
});
afterAll(closeDb);
const post = (path: string, body: unknown) => request(t.app).post(`/api/v1${path}`).send(body as object);

describe('platform audit actor names', () => {
  it('records the Super Admin name on the TOTP enrolment and first-login audit rows', async () => {
    const admin = await f.platformUser({ password_hash: await passwordHash(), name: 'Platform Owner' });
    const first = await post('/auth/platform/login', { email: String(admin.email), password: PASSWORD });
    const challengeToken = first.body.data.challengeToken as string;
    const setup = await post('/auth/platform/totp/setup', { challengeToken });
    const verify = await post('/auth/platform/totp/verify', { challengeToken, code: await generate({ secret: setup.body.data.secret as string }) });
    expect(verify.status).toBe(200);
    const rows = (await ownerQuery<{ action: string; actor_name: string | null }>("select action, actor_name from audit_logs where actor_id = $1 and action in ('auth.totp_enroll','auth.login') order by action desc", [admin.id])).rows;
    expect(rows.map((r) => r.action)).toEqual(['auth.totp_enroll', 'auth.login']);
    expect(rows.map((r) => r.actor_name)).toEqual(['Platform Owner', 'Platform Owner']);
  });
});
