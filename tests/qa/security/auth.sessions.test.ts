// Token / session / sign-in attacks (BP §5.2, §5.4, §16; contract §6):
//   refresh rotation + reuse detection, web cookie flags, logout-all, deactivation and school
//   suspension mid-session, forged JWTs, TOTP replay, lockout, OTP abuse, device binding.
import jwt from 'jsonwebtoken';
import { generate } from 'otplib';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import config from '../../../src/config/index.js';
import { invalidateSchoolState } from '../../../src/middleware/resolveTenant.js';
import { closeDb, ownerQuery } from '../../helpers/db.js';
import * as f from '../../helpers/factories.js';
import { loginSchoolAdmin, loginStaff, PASSWORD, schoolAdmin } from '../../helpers/authApp.js';
import { api, buildWorld, call, DRIVER_DEVICE, superAdminLogin, type World } from './world.js';

let w: World;

beforeAll(async () => {
  w = await buildWorld();
});
afterAll(closeDb);

const refresh = (token: string) => request(w.t.app).post(api('/auth/refresh')).send({ refreshToken: token });

describe('refresh rotation and reuse detection', () => {
  it('replaying a rotated refresh token revokes the whole family (new access + refresh tokens die too)', async () => {
    const s0 = await loginSchoolAdmin(w.t.app, String(w.fx.a.admin.email));
    const r1 = await refresh(s0.refreshToken);
    expect(r1.status).toBe(200);
    const s1 = r1.body.data as { accessToken: string; refreshToken: string };
    expect((await call(w.t, 'get', '/auth/me', s1.accessToken)).status).toBe(200);

    const replay = await refresh(s0.refreshToken);
    expect([replay.status, replay.body.error?.details?.reason]).toEqual([401, 'REFRESH_TOKEN_REUSED']);
    expect((await call(w.t, 'get', '/auth/me', s1.accessToken)).status).toBe(401);
    expect((await refresh(s1.refreshToken)).status).toBe(401);
  });

  it('five parallel refreshes of one token yield at most one new session and the family ends revoked or single', async () => {
    const s0 = await loginSchoolAdmin(w.t.app, String(w.fx.a.admin.email));
    const results = await Promise.all(Array.from({ length: 5 }, () => refresh(s0.refreshToken)));
    const okCount = results.filter((r) => r.status === 200).length;
    expect(okCount).toBeLessThanOrEqual(1);
    for (const r of results) expect(r.status === 200 || r.status === 401, `status ${r.status}`).toBe(true);
    const fam = await ownerQuery<{ n: number }>("select count(*)::int as n from sessions where family_id = (select family_id from sessions where id = $1) and revoked_at is null and rotated_at is null", [s0.sessionId]);
    expect(fam.rows[0]!.n).toBeLessThanOrEqual(1);
  });

  it('a web refresh cookie is httpOnly, SameSite=Strict, scoped to /api/v1/auth and never in the body', async () => {
    const res = await request(w.t.app).post(api('/auth/school/login')).set('X-WIMB-Client', 'web').send({ email: w.fx.a.admin.email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.refreshToken).toBeUndefined();
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('wimb_rt='));
    expect(cookie, 'refresh cookie').toBeDefined();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth(;|$)/i);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    // The cookie token presented as a mobile body token is refused (client binding).
    const raw = /wimb_rt=([^;]+)/.exec(cookie!)![1]!;
    const asMobile = await refresh(decodeURIComponent(raw));
    expect(asMobile.status).toBe(401);
  });
});

describe('logout, logout-all, password change, deactivation, suspension', () => {
  it('logout-all kills every other session (access + refresh) of the principal', async () => {
    const other = await loginSchoolAdmin(w.t.app, String(w.fx.a.admin.email));
    const current = await loginSchoolAdmin(w.t.app, String(w.fx.a.admin.email));
    expect((await call(w.t, 'post', '/auth/logout-all', current.accessToken)).status).toBe(200);
    expect((await call(w.t, 'get', '/auth/me', other.accessToken)).status).toBe(401);
    expect((await call(w.t, 'get', '/auth/me', current.accessToken)).status).toBe(401);
    expect((await refresh(other.refreshToken)).status).toBe(401);
    w.adminA = await loginSchoolAdmin(w.t.app, String(w.fx.a.admin.email));
  });

  it('logout with only a refresh token works; the matching access token is dead right after', async () => {
    const s = await loginSchoolAdmin(w.t.app, String(w.fx.a.admin.email));
    const out = await request(w.t.app).post(api('/auth/logout')).send({ refreshToken: s.refreshToken });
    expect(out.status).toBe(200);
    expect((await call(w.t, 'get', '/auth/me', s.accessToken)).status).toBe(401);
  });

  it('a staff member deactivated by the admin is rejected on the very next request and cannot refresh', async () => {
    const extra = await f.user(w.fx.a.school.id, { role: 'driver', password_hash: (await ownerQuery<{ h: string }>('select password_hash as h from users where id = $1', [w.fx.a.driverUser.id])).rows[0]!.h });
    const profile = await f.staffProfile(w.fx.a.school.id, { staff_type: 'driver', user_id: extra.id, full_name: 'Temp Driver' });
    const s = await loginStaff(w.t.app, String(w.fx.a.school.code), String(extra.phone), { ...DRIVER_DEVICE, deviceId: 'device-temp-0009' });
    const hdr = { 'X-Device-Id': 'device-temp-0009' };
    expect((await call(w.t, 'get', '/driver/me', s.accessToken, { headers: hdr })).status).toBe(200);
    const deact = await call(w.t, 'post', `/school/staff/${profile.id}/deactivate`, w.adminA.accessToken, { body: { reason: 'left' } });
    expect(deact.status, JSON.stringify(deact.body)).toBe(200);
    expect((await call(w.t, 'get', '/driver/me', s.accessToken, { headers: hdr })).status).toBe(401);
    expect((await refresh(s.refreshToken)).status).toBe(401);
  });

  it('a school suspended by the super admin locks its admin and staff out immediately (no 15-s cache window)', async () => {
    const s = await f.school({ name: 'Suspend Me' });
    await f.schoolSubscription(s.id);
    const adm = await schoolAdmin(s.id);
    const tok = await loginSchoolAdmin(w.t.app, String(adm.email));
    expect((await call(w.t, 'get', '/school/buses', tok.accessToken)).status).toBe(200); // warms the school cache
    const sus = await call(w.t, 'post', `/platform/schools/${s.id}/deactivate`, w.superAdmin.accessToken, { body: { status: 'suspended', reason: 'unpaid' } });
    expect(sus.status, JSON.stringify(sus.body)).toBe(200);
    const after = await call(w.t, 'get', '/school/buses', tok.accessToken);
    expect(after.status).not.toBe(200);
    expect((await refresh(tok.refreshToken)).status).not.toBe(200);
    invalidateSchoolState();
  });

  it('change-password keeps the current session and revokes the others', async () => {
    const adm = await schoolAdmin(w.fx.a.school.id);
    const a1 = await loginSchoolAdmin(w.t.app, String(adm.email));
    const a2 = await loginSchoolAdmin(w.t.app, String(adm.email));
    const res = await call(w.t, 'post', '/auth/change-password', a2.accessToken, { body: { currentPassword: PASSWORD, newPassword: 'NewSecret#456' } });
    expect(res.status).toBe(200);
    expect((await call(w.t, 'get', '/auth/me', a1.accessToken)).status).toBe(401);
    expect((await refresh(a1.refreshToken)).status).toBe(401);
    expect((await call(w.t, 'get', '/auth/me', a2.accessToken)).status).toBe(200);
  });
});

describe('forged access tokens', () => {
  const secret = () => config.jwt.accessSecret;
  const sign = (claims: Record<string, unknown>, opts: jwt.SignOptions = {}) =>
    jwt.sign({ typ: 'access', ...claims }, secret(), { algorithm: 'HS256', issuer: 'whereismybus', audience: 'whereismybus-api', expiresIn: 600, ...opts });
  const claimsOf = (token: string) => jwt.decode(token) as Record<string, unknown>;

  it("'none' algorithm, wrong issuer/audience and another key are refused", async () => {
    const c = claimsOf(w.adminA.accessToken);
    const base = { sub: c.sub, role: c.role, school_id: c.school_id, sid: c.sid };
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ ...base, typ: 'access', iss: 'whereismybus', aud: 'whereismybus-api', exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url')}.`;
    for (const tok of [none, sign(base, { issuer: 'evil' }), sign(base, { audience: 'other' }), jwt.sign({ ...base, typ: 'access' }, 'another-secret-another-secret-0123456789', { algorithm: 'HS256', issuer: 'whereismybus', audience: 'whereismybus-api', expiresIn: 600 })]) {
      expect((await call(w.t, 'get', '/school/buses', tok)).status).toBe(401);
    }
  });

  it('a validly signed token whose role or school disagrees with its session is refused', async () => {
    const d = claimsOf(w.driverA.accessToken);
    const a = claimsOf(w.adminA.accessToken);
    const p = claimsOf(w.parent.accessToken);
    const forged = [
      sign({ sub: d.sub, role: 'school_admin', school_id: d.school_id, sid: d.sid }), // driver → admin
      sign({ sub: a.sub, role: 'school_admin', school_id: w.fx.b.school.id, sid: a.sid }), // admin A → school B
      sign({ sub: p.sub, role: 'school_admin', school_id: w.fx.a.school.id, sid: p.sid }), // parent → admin
      sign({ sub: a.sub, role: 'super_admin', school_id: null, sid: a.sid }), // admin → super admin
      sign({ sub: w.fx.b.admin.id, role: 'school_admin', school_id: w.fx.b.school.id, sid: a.sid }), // another actor, my session
    ];
    for (const tok of forged) {
      const res = await call(w.t, 'get', '/school/buses', tok);
      expect(res.status, JSON.stringify(claimsOf(tok))).toBe(401);
    }
    expect((await call(w.t, 'get', '/platform/schools', forged[3]!)).status).toBe(401);
  });
});

describe('Super Admin TOTP', () => {
  it('the same TOTP code cannot sign in twice (replay within its 30-s step)', async () => {
    const { secret } = await superAdminLogin(w.t, w.fx.superAdmin, w.totpSecret);
    // superAdminLogin consumed one code; a second sign-in with that same code must fail.
    const code = await generate({ secret });
    const res = await request(w.t.app).post(api('/auth/platform/login')).send({ email: w.fx.superAdmin.email, password: PASSWORD, totpCode: code });
    expect(res.status, JSON.stringify(res.body)).toBe(401);
    expect(res.body.error.code).toBe('TOTP_REQUIRED');
    const fresh = await superAdminLogin(w.t, w.fx.superAdmin, w.totpSecret);
    w.superAdmin = fresh.tokens;
  });

  it('two parallel sign-ins with one code produce at most one session', async () => {
    await ownerQuery('update platform_users set totp_last_used_step = null where id = $1', [w.fx.superAdmin.id]);
    const code = await generate({ secret: w.totpSecret });
    const body = { email: w.fx.superAdmin.email, password: PASSWORD, totpCode: code };
    const rs = await Promise.all([1, 2, 3].map(() => request(w.t.app).post(api('/auth/platform/login')).send(body)));
    expect(rs.filter((r) => r.status === 200).length).toBeLessThanOrEqual(1);
  });

  it('an enrolment challenge is single-use and dies after enrolment', async () => {
    const pu = await f.platformUser({ password_hash: (await ownerQuery<{ h: string }>('select password_hash as h from platform_users where id = $1', [w.fx.superAdmin.id])).rows[0]!.h });
    const login = await request(w.t.app).post(api('/auth/platform/login')).send({ email: pu.email, password: PASSWORD });
    expect(login.body.data?.status).toBe('totp_enrollment_required');
    const challengeToken = login.body.data.challengeToken as string;
    const setup = await request(w.t.app).post(api('/auth/platform/totp/setup')).send({ challengeToken });
    expect(setup.status).toBe(200);
    const code = await generate({ secret: setup.body.data.secret as string });
    expect((await request(w.t.app).post(api('/auth/platform/totp/verify')).send({ challengeToken, code })).status).toBe(200);
    expect((await request(w.t.app).post(api('/auth/platform/totp/setup')).send({ challengeToken })).status).toBe(401);
    expect((await request(w.t.app).post(api('/auth/platform/totp/verify')).send({ challengeToken, code })).status).toBe(401);
  });
});

describe('lockout and OTP abuse', () => {
  it('after 5 wrong passwords the correct password is refused (ACCOUNT_LOCKED)', async () => {
    const adm = await schoolAdmin(w.fx.a.school.id);
    for (let i = 0; i < 5; i += 1) {
      const r = await request(w.t.app).post(api('/auth/school/login')).send({ email: adm.email, password: `Wrong#${i}x1` });
      expect(r.status).toBe(401);
    }
    const r = await request(w.t.app).post(api('/auth/school/login')).send({ email: adm.email, password: PASSWORD });
    expect([r.status, r.body.error?.details?.reason]).toEqual([429, 'ACCOUNT_LOCKED']);
    // Changing the e-mail case does not reset the counter.
    const r2 = await request(w.t.app).post(api('/auth/school/login')).send({ email: String(adm.email).toUpperCase(), password: PASSWORD });
    expect(r2.status).toBe(429);
  });

  it("an OTP issued for one number cannot sign in another; 5 wrong codes burn the right one; resend is throttled", async () => {
    const pa = await f.parentAccount();
    await f.schoolParent(w.fx.a.school.id, pa.id);
    await f.studentParent(w.fx.a.school.id, w.fx.a.otherStudent.id, pa.id);
    const pb = await f.parentAccount();
    await f.schoolParent(w.fx.a.school.id, pb.id);
    await f.studentParent(w.fx.a.school.id, w.fx.a.otherStudent.id, pb.id, { is_primary: false });
    expect((await request(w.t.app).post(api('/auth/parent/otp/request')).send({ phone: pa.phone })).status).toBe(202);
    const code = w.t.sms.lastOtp(String(pa.phone))!;
    expect(code).toMatch(/^\d{6}$/);
    // cross-number reuse
    expect((await request(w.t.app).post(api('/auth/parent/otp/verify')).send({ phone: pb.phone, otp: code })).status).toBe(401);
    // resend inside the cooldown
    const again = await request(w.t.app).post(api('/auth/parent/otp/request')).send({ phone: pa.phone });
    expect([again.status, again.body.error?.details?.reason]).toEqual([429, 'OTP_COOLDOWN']);
    // attempt cap
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) expect((await request(w.t.app).post(api('/auth/parent/otp/verify')).send({ phone: pa.phone, otp: wrong })).status).toBe(401);
    expect((await request(w.t.app).post(api('/auth/parent/otp/verify')).send({ phone: pa.phone, otp: code })).status).toBe(401);
  });

  it('an OTP is single-use', async () => {
    const pa = await f.parentAccount();
    await f.schoolParent(w.fx.b.school.id, pa.id);
    await f.studentParent(w.fx.b.school.id, w.fx.b.otherStudent.id, pa.id);
    await request(w.t.app).post(api('/auth/parent/otp/request')).send({ phone: pa.phone });
    const code = w.t.sms.lastOtp(String(pa.phone))!;
    expect((await request(w.t.app).post(api('/auth/parent/otp/verify')).send({ phone: pa.phone, otp: code })).status).toBe(200);
    expect((await request(w.t.app).post(api('/auth/parent/otp/verify')).send({ phone: pa.phone, otp: code })).status).toBe(401);
  });
});

describe('driver device binding', () => {
  it('the driver token is refused without, or with another, X-Device-Id on bound endpoints', async () => {
    const tok = w.driverA.accessToken;
    expect((await call(w.t, 'get', '/auth/device', tok, { headers: { 'X-Device-Id': DRIVER_DEVICE.deviceId } })).status).toBe(200);
    expect((await call(w.t, 'get', '/auth/device', tok)).status).toBe(403);
    expect((await call(w.t, 'get', '/auth/device', tok, { headers: { 'X-Device-Id': 'device-cond-0001' } })).status).toBe(403);
    const loc = await call(w.t, 'post', `/driver/trips/${w.fx.a.trip.id}/locations`, tok, {
      headers: { 'X-Device-Id': 'attacker-phone-01' },
      body: { points: [{ recordedAt: new Date().toISOString(), latitude: 12.97, longitude: 77.59 }] },
    });
    expect(loc.status).toBe(403);
  });

  it('a device blocked by the school stops the bound session', async () => {
    const dev = await ownerQuery<{ id: string }>("select id from devices where device_uid = $1 and owner_id = $2", [DRIVER_DEVICE.deviceId, w.fx.a.driverUser.id]);
    await ownerQuery('update devices set is_trusted = false where id = $1', [dev.rows[0]!.id]);
    try {
      expect((await call(w.t, 'get', '/auth/device', w.driverA.accessToken, { headers: { 'X-Device-Id': DRIVER_DEVICE.deviceId } })).status).toBe(403);
      const relog = await request(w.t.app).post(api('/auth/staff/login')).send({ schoolCode: w.fx.a.school.code, phone: w.fx.a.driverUser.phone, password: PASSWORD, device: DRIVER_DEVICE });
      expect(relog.status).toBe(403);
    } finally {
      await ownerQuery('update devices set is_trusted = true where id = $1', [dev.rows[0]!.id]);
    }
  });
});
