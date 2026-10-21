// Sign-in flows (contract §6, BP §5): school admin (lockout, inactive user/school), staff
// (school code + phone|username + password|PIN, device binding), Super Admin TOTP enrolment and
// enforcement (with replay protection), parent password fallback. Real DB under RLS.
import { generate } from 'otplib';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { buildApp, DEVICE, loginSchoolAdmin, loginStaff, PASSWORD, passwordHash, PIN, schoolAdmin, staffUser, type TestApp } from './helpers/authApp.js';

let t: TestApp;
let schoolA: f.Row;
let schoolB: f.Row;

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  schoolA = await f.school({ code: 'ALPHA-BLR', name: 'Alpha School' });
  schoolB = await f.school({ code: 'BETA-JPR', name: 'Beta School' });
});
afterAll(closeDb);

const post = (path: string, body: unknown) => request(t.app).post(`/api/v1${path}`).send(body as object);

describe('school admin login', () => {
  it('signs in with e-mail + password and returns tokens + profile with school branding', async () => {
    const admin = await schoolAdmin(schoolA.id, { full_name: 'Anita Rao' });
    const res = await post('/auth/school/login', { email: String(admin.email).toUpperCase(), password: PASSWORD });
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d).toMatchObject({ status: 'authenticated', tokenType: 'Bearer', mustChangePassword: false });
    expect(d.accessToken).toEqual(expect.any(String));
    expect(d.refreshToken).toEqual(expect.any(String));
    expect(d.user).toMatchObject({ id: admin.id, role: 'school_admin', name: 'Anita Rao', school: { id: schoolA.id, code: 'ALPHA-BLR', name: 'Alpha School' } });
    const { rows } = await ownerQuery("select school_id, actor_id, action, ip from audit_logs where action = 'auth.login' and actor_id = $1", [admin.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.school_id).toBe(schoolA.id);
    const s = await ownerQuery('select owner_type, school_id, client, revoked_at from sessions where owner_id = $1', [admin.id]);
    expect(s.rows).toEqual([{ owner_type: 'user', school_id: schoolA.id, client: 'mobile', revoked_at: null }]);
  });

  it('answers unknown e-mails and wrong passwords identically', async () => {
    const admin = await schoolAdmin(schoolA.id);
    const wrong = await post('/auth/school/login', { email: admin.email, password: 'Wrong#999' });
    const unknown = await post('/auth/school/login', { email: 'nobody@nowhere.test', password: 'Wrong#999' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.code).toBe('UNAUTHENTICATED');
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });

  it('locks the account after 5 failures (even the right password is refused) and unlocks after the cooldown', async () => {
    const admin = await schoolAdmin(schoolA.id);
    for (let i = 0; i < 5; i += 1) expect((await post('/auth/school/login', { email: admin.email, password: `Wrong#${i}x` })).status).toBe(401);
    const locked = await post('/auth/school/login', { email: admin.email, password: PASSWORD });
    expect(locked.status).toBe(429);
    expect(locked.body.error.details.reason).toBe('ACCOUNT_LOCKED');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(800);
    const audit = await ownerQuery('select action from audit_logs where actor_id = $1 order by id', [admin.id]);
    expect(audit.rows.map((r) => String(r.action))).toEqual(['auth.login_failed', 'auth.login_failed', 'auth.login_failed', 'auth.login_failed', 'auth.account_locked']);
    await ownerQuery("update users set locked_until = now() - interval '1 second' where id = $1", [admin.id]);
    expect((await post('/auth/school/login', { email: admin.email, password: PASSWORD })).status).toBe(200);
    const after = await ownerQuery('select failed_login_count, locked_until, last_login_at from users where id = $1', [admin.id]);
    expect(after.rows[0]).toMatchObject({ failed_login_count: 0, locked_until: null });
    expect(after.rows[0]!.last_login_at).not.toBeNull();
  });

  it('applies the same lockout to unknown e-mails (no enumeration)', async () => {
    for (let i = 0; i < 5; i += 1) expect((await post('/auth/school/login', { email: 'ghost@nowhere.test', password: `Wrong#${i}x` })).status).toBe(401);
    const res = await post('/auth/school/login', { email: 'ghost@nowhere.test', password: 'Wrong#9x' });
    expect(res.status).toBe(429);
    expect(res.body.error.details.reason).toBe('ACCOUNT_LOCKED');
  });

  it('refuses deactivated users and inactive or deleted schools', async () => {
    const inactive = await schoolAdmin(schoolA.id, { is_active: false });
    expect((await post('/auth/school/login', { email: inactive.email, password: PASSWORD })).body.error.code).toBe('FORBIDDEN');
    const suspended = await f.school({ status: 'suspended' });
    const a1 = await schoolAdmin(suspended.id);
    const r1 = await post('/auth/school/login', { email: a1.email, password: PASSWORD });
    expect([r1.status, r1.body.error.code]).toEqual([403, 'SCHOOL_INACTIVE']);
    const deleted = await f.school({ deleted_at: new Date().toISOString() });
    const a2 = await schoolAdmin(deleted.id);
    expect((await post('/auth/school/login', { email: a2.email, password: PASSWORD })).body.error.code).toBe('SCHOOL_INACTIVE');
  });

  it('validates the body and ignores unknown keys such as school_id', async () => {
    expect((await post('/auth/school/login', { email: 'not-an-email', password: 'x' })).status).toBe(400);
    const admin = await schoolAdmin(schoolA.id);
    const res = await post('/auth/school/login', { email: admin.email, password: PASSWORD, school_id: schoolB.id, schoolId: schoolB.id });
    expect(res.status).toBe(200);
    expect(res.body.data.user.school.id).toBe(schoolA.id);
  });
});

describe('staff login', () => {
  it('signs in with school code + phone + password and binds the session to the device row', async () => {
    const driver = await staffUser(schoolA.id, 'driver', { full_name: 'Ramesh Kumar' });
    const tokens = await loginStaff(t.app, 'alpha-blr', String(driver.phone));
    expect(tokens.body.user).toMatchObject({ id: driver.id, role: 'driver', school: { id: schoolA.id }, device: { platform: 'android', model: 'Pixel 8' } });
    const { rows } = await ownerQuery(
      'select d.device_uid, d.school_id, d.owner_id, s.device_id = d.id as bound, s.app_name from sessions s join devices d on d.id = s.device_id where s.id = $1',
      [tokens.sessionId],
    );
    expect(rows[0]).toMatchObject({ device_uid: DEVICE.deviceId, school_id: schoolA.id, owner_id: driver.id, bound: true, app_name: 'driver_app' });
  });

  it('accepts username + PIN, refuses another school code and bad combinations', async () => {
    const conductor = await staffUser(schoolA.id, 'conductor', { username: 'suresh.alpha' });
    const ok = await post('/auth/staff/login', { schoolCode: 'ALPHA-BLR', username: 'suresh.alpha', pin: PIN, device: { ...DEVICE, deviceId: 'device-cond-0001' } });
    expect(ok.status).toBe(200);
    expect(ok.body.data.user.role).toBe('conductor');
    const otherSchool = await post('/auth/staff/login', { schoolCode: 'BETA-JPR', username: 'suresh.alpha', pin: PIN, device: DEVICE });
    expect(otherSchool.status).toBe(401);
    const both = await post('/auth/staff/login', { schoolCode: 'ALPHA-BLR', username: 'suresh.alpha', phone: String(conductor.phone), pin: PIN, device: DEVICE });
    expect(both.status).toBe(400);
    const noDevice = await post('/auth/staff/login', { schoolCode: 'ALPHA-BLR', username: 'suresh.alpha', pin: PIN });
    expect(noDevice.status).toBe(400);
    const wrongPin = await post('/auth/staff/login', { schoolCode: 'ALPHA-BLR', username: 'suresh.alpha', pin: '0000', device: DEVICE });
    expect(wrongPin.status).toBe(401);
  });

  it('enforces the device binding: other device → DEVICE_NOT_BOUND', async () => {
    const driver = await staffUser(schoolA.id);
    const tokens = await loginStaff(t.app, 'ALPHA-BLR', String(driver.phone), { ...DEVICE, deviceId: 'device-bind-0001' });
    const auth = { Authorization: `Bearer ${tokens.accessToken}` };
    const same = await request(t.app).get('/api/v1/auth/device').set(auth).set('X-Device-Id', 'device-bind-0001');
    expect(same.status).toBe(200);
    expect(same.body.data.device.deviceUid).toBe('device-bind-0001');
    const other = await request(t.app).get('/api/v1/auth/device').set(auth).set('X-Device-Id', 'device-evil-0002');
    expect([other.status, other.body.error.code]).toEqual([403, 'DEVICE_NOT_BOUND']);
    const none = await request(t.app).get('/api/v1/auth/device').set(auth);
    expect(none.body.error.code).toBe('DEVICE_NOT_BOUND');
    // A blocked device can no longer sign in, and its live session is refused.
    await ownerQuery("update devices set revoked_at = now() where owner_id = $1 and device_uid = 'device-bind-0001'", [driver.id]);
    expect((await request(t.app).get('/api/v1/auth/device').set(auth).set('X-Device-Id', 'device-bind-0001')).body.error.code).toBe('DEVICE_NOT_BOUND');
    const relogin = await post('/auth/staff/login', { schoolCode: 'ALPHA-BLR', phone: String(driver.phone), password: PASSWORD, device: { ...DEVICE, deviceId: 'device-bind-0001' } });
    expect([relogin.status, relogin.body.error.code]).toEqual([403, 'DEVICE_NOT_BOUND']);
    const admin = await schoolAdmin(schoolA.id);
    const adminTokens = await loginSchoolAdmin(t.app, String(admin.email));
    expect((await request(t.app).get('/api/v1/auth/device').set({ Authorization: `Bearer ${adminTokens.accessToken}` })).status).toBe(403);
  });
});

describe('super admin login with TOTP', () => {
  let email: string;
  let secret: string;

  it('forces TOTP enrolment on the first login (no session before enrolment)', async () => {
    const admin = await f.platformUser({ password_hash: await passwordHash(), name: 'Platform Owner' });
    email = String(admin.email);
    const first = await post('/auth/platform/login', { email, password: PASSWORD });
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ status: 'totp_enrollment_required', challengeToken: expect.any(String) });
    expect(first.body.data.accessToken).toBeUndefined();
    expect((await ownerQuery('select count(*)::int as n from sessions where owner_id = $1', [admin.id])).rows[0]!.n).toBe(0);

    const setup = await post('/auth/platform/totp/setup', { challengeToken: first.body.data.challengeToken });
    expect(setup.status).toBe(200);
    expect(setup.body.data.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect(setup.body.data.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    secret = setup.body.data.secret as string;

    expect((await post('/auth/platform/totp/verify', { challengeToken: first.body.data.challengeToken, code: '000000' })).body.error.code).toBe('TOTP_REQUIRED');
    const verify = await post('/auth/platform/totp/verify', { challengeToken: first.body.data.challengeToken, code: await generate({ secret }) });
    expect(verify.status).toBe(200);
    expect(verify.body.data).toMatchObject({ status: 'authenticated', user: { role: 'super_admin', totpEnabled: true } });
    expect((await ownerQuery('select totp_enabled, totp_secret_enc is not null as has_secret from platform_users where id = $1', [admin.id])).rows[0]).toEqual({ totp_enabled: true, has_secret: true });
    // The challenge is single-use.
    expect((await post('/auth/platform/totp/setup', { challengeToken: first.body.data.challengeToken })).status).toBe(401);
  });

  it('requires a valid, unused TOTP code once enrolled', async () => {
    const missing = await post('/auth/platform/login', { email, password: PASSWORD });
    expect([missing.status, missing.body.error.code]).toEqual([401, 'TOTP_REQUIRED']);
    expect((await post('/auth/platform/login', { email, password: PASSWORD, totpCode: '123456' })).body.error.code).toBe('TOTP_REQUIRED');
    const code = await generate({ secret, epoch: Math.floor(Date.now() / 1000) + 30 });
    const ok = await post('/auth/platform/login', { email, password: PASSWORD, totpCode: code });
    expect(ok.status).toBe(200);
    expect(ok.body.data.user).toMatchObject({ role: 'super_admin', email });
    const replay = await post('/auth/platform/login', { email, password: PASSWORD, totpCode: code });
    expect([replay.status, replay.body.error.code]).toEqual([401, 'TOTP_REQUIRED']);
    const audit = await ownerQuery("select school_id, action from audit_logs where actor_type = 'platform_user' order by id");
    expect(audit.rows.map((r) => String(r.action))).toEqual(expect.arrayContaining(['auth.totp_enroll', 'auth.login', 'auth.login_failed']));
    expect(audit.rows.every((r) => r.school_id === null)).toBe(true);
  });

  it('never gives super admins a school context', async () => {
    // Codes of the already-used time steps are refused (replay protection); start a fresh window.
    await ownerQuery('update platform_users set totp_last_used_step = null where email = $1', [email]);
    const code = await generate({ secret });
    const ok = await post('/auth/platform/login', { email, password: PASSWORD, totpCode: code });
    const auth = { Authorization: `Bearer ${ok.body.data.accessToken}` };
    const res = await request(t.app).get('/api/v1/school/audit-logs').set(auth).set('X-School-Id', schoolA.id);
    expect(res.status).toBe(403);
    expect((await request(t.app).get(`/api/v1/files/${crypto.randomUUID()}/url`).set(auth)).status).toBe(403);
  });

  it('rejects unknown challenges', async () => {
    expect((await post('/auth/platform/totp/setup', { challengeToken: 'x'.repeat(43) })).status).toBe(401);
  });
});

describe('parent password fallback', () => {
  it('signs in parents who set a password and refuses unlinked or password-less numbers', async () => {
    const parent = await f.parentAccount({ password_hash: await passwordHash(), display_name: 'Priya' });
    await f.schoolParent(schoolA.id, parent.id);
    const ok = await post('/auth/parent/password-login', { phone: String(parent.phone).replace('+91', '0'), password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.body.data.user).toMatchObject({ role: 'parent', id: parent.id, hasPassword: true });
    const noPassword = await f.parentAccount();
    await f.schoolParent(schoolA.id, noPassword.id);
    expect((await post('/auth/parent/password-login', { phone: noPassword.phone, password: PASSWORD })).status).toBe(401);
    const unlinked = await f.parentAccount({ password_hash: await passwordHash() });
    expect((await post('/auth/parent/password-login', { phone: unlinked.phone, password: PASSWORD })).body.error.code).toBe('FORBIDDEN');
  });
});
