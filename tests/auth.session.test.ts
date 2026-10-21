// Sessions (BP §5.2, contract §6): refresh rotation, family reuse detection, web cookie mode,
// logout / logout-all, change-password (must_change_password guard), deactivated users and
// schools blocked on API + refresh, parent X-School-Id validation.
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidateSchoolState } from '../src/middleware/resolveTenant.js';
import { isDefinitiveRefreshFailure } from '../src/modules/auth/router.js';
import { forbidden, internalError, schoolInactive, serviceUnavailable, unauthenticated } from '../src/shared/errors.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { buildApp, loginParent, loginSchoolAdmin, loginStaff, PASSWORD, schoolAdmin, staffUser, type TestApp } from './helpers/authApp.js';

let t: TestApp;
let school: f.Row;

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  school = await f.school({ code: 'GAMMA-HYD', name: 'Gamma School' });
});
afterAll(closeDb);

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const me = (token: string) => request(t.app).get('/api/v1/auth/me').set(bearer(token));
const refresh = (refreshToken: string) => request(t.app).post('/api/v1/auth/refresh').send({ refreshToken });

describe('refresh rotation', () => {
  it('rotates the refresh token into a new session row of the same family', async () => {
    const admin = await schoolAdmin(school.id);
    const login = await loginSchoolAdmin(t.app, String(admin.email));
    const res = await refresh(login.refreshToken);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.refreshToken).not.toBe(login.refreshToken);
    expect(d.sessionId).not.toBe(login.sessionId);
    expect((await me(d.accessToken)).status).toBe(200);
    const { rows } = await ownerQuery('select id, family_id, rotated_at is not null as rotated, revoked_at from sessions where owner_id = $1 order by created_at', [admin.id]);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.family_id).toBe(rows[1]!.family_id);
    expect(rows.map((r) => Boolean(r.rotated))).toEqual([true, false]);
  });

  it('detects reuse of a rotated token and revokes the whole family', async () => {
    const admin = await schoolAdmin(school.id);
    const login = await loginSchoolAdmin(t.app, String(admin.email));
    const rotated = (await refresh(login.refreshToken)).body.data;
    const reuse = await refresh(login.refreshToken);
    expect([reuse.status, reuse.body.error.details.reason]).toEqual([401, 'REFRESH_TOKEN_REUSED']);
    expect((await refresh(rotated.refreshToken)).status).toBe(401);
    expect((await me(rotated.accessToken)).status).toBe(401);
    expect((await me(login.accessToken)).status).toBe(401);
    const audit = await ownerQuery("select count(*)::int as n from audit_logs where action = 'auth.refresh_reuse' and actor_id = $1", [admin.id]);
    expect(audit.rows[0]!.n).toBe(1);
  });

  it('rejects unknown, missing and expired tokens', async () => {
    expect((await refresh('x'.repeat(43))).status).toBe(401);
    expect((await request(t.app).post('/api/v1/auth/refresh').send({})).body.error.details.reason).toBe('MISSING_TOKEN');
    const admin = await schoolAdmin(school.id);
    const login = await loginSchoolAdmin(t.app, String(admin.email));
    await ownerQuery("update sessions set expires_at = now() - interval '1 minute' where id = $1", [login.sessionId]);
    expect((await refresh(login.refreshToken)).body.error.details.reason).toBe('EXPIRED');
  });
});

describe('web cookie mode', () => {
  it('keeps the refresh token in an httpOnly cookie and requires the X-WIMB-Client header', async () => {
    const admin = await schoolAdmin(school.id);
    const login = await request(t.app).post('/api/v1/auth/school/login').set('X-WIMB-Client', 'web').send({ email: admin.email, password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.data.refreshToken).toBeUndefined();
    const cookie = ([] as string[]).concat(login.headers['set-cookie'] ?? []).find((c) => c.startsWith('wimb_rt='))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
    expect(cookie).toMatch(/SameSite=Strict/i);
    const pair = cookie.split(';')[0]!;

    const noHeader = await request(t.app).post('/api/v1/auth/refresh').set('Cookie', pair).send({});
    expect(noHeader.status).toBe(401);
    const asMobile = await refresh(pair.slice('wimb_rt='.length));
    expect(asMobile.body.error.details.reason).toBe('CLIENT_MISMATCH');

    const ok = await request(t.app).post('/api/v1/auth/refresh').set('Cookie', pair).set('X-WIMB-Client', 'web').send({});
    expect(ok.status).toBe(200);
    expect(ok.body.data.refreshToken).toBeUndefined();
    const next = ([] as string[]).concat(ok.headers['set-cookie'] ?? []).find((c) => c.startsWith('wimb_rt='))!;
    expect(next.split(';')[0]).not.toBe(pair);

    const out = await request(t.app).post('/api/v1/auth/logout').set('Cookie', next.split(';')[0]!).set('X-WIMB-Client', 'web').send({});
    expect(out.status).toBe(200);
    expect(([] as string[]).concat(out.headers['set-cookie'] ?? []).some((c) => /^wimb_rt=;/.test(c))).toBe(true);
    expect((await me(ok.body.data.accessToken)).status).toBe(401);
  });

  it('keeps the refresh cookie on a temporary failure and clears it only on a definitive one', async () => {
    const admin = await schoolAdmin(school.id);
    const login = await request(t.app).post('/api/v1/auth/school/login').set('X-WIMB-Client', 'web').send({ email: admin.email, password: PASSWORD });
    const pair = ([] as string[]).concat(login.headers['set-cookie'] ?? []).find((c) => c.startsWith('wimb_rt='))!.split(';')[0]!;
    const webRefresh = (cookie: string) => request(t.app).post('/api/v1/auth/refresh').set('Cookie', cookie).set('X-WIMB-Client', 'web').send({});
    const clears = (res: request.Response) => ([] as string[]).concat(res.headers['set-cookie'] ?? []).some((c) => /^wimb_rt=;/.test(c));

    // A server-side failure (the refresh lookup is unavailable → 503) keeps the cookie: the session survives.
    await ownerQuery('alter function auth_session_by_refresh(text) rename to auth_session_by_refresh_off');
    let down: request.Response;
    try {
      down = await webRefresh(pair);
    } finally {
      await ownerQuery('alter function auth_session_by_refresh_off(text) rename to auth_session_by_refresh');
    }
    expect(down.status).toBeGreaterThanOrEqual(500);
    expect(clears(down)).toBe(false);
    const back = await webRefresh(pair);
    expect(back.status).toBe(200);
    const next = ([] as string[]).concat(back.headers['set-cookie'] ?? []).find((c) => c.startsWith('wimb_rt='))!.split(';')[0]!;

    // Definitive failures clear it: a reused (rotated) token, an unknown token, a revoked session.
    const reused = await webRefresh(pair);
    expect([reused.status, reused.body.error.details.reason, clears(reused)]).toEqual([401, 'REFRESH_TOKEN_REUSED', true]);
    const unknown = await webRefresh('wimb_rt=' + 'x'.repeat(43));
    expect([unknown.status, clears(unknown)]).toEqual([401, true]);
    const revoked = await webRefresh(next);
    expect([revoked.status, revoked.body.error.details.reason, clears(revoked)]).toEqual([401, 'REVOKED', true]);
  });

  it('classifies refresh failures: 401/403 and session codes are definitive, 5xx and unexpected errors are not', () => {
    expect(isDefinitiveRefreshFailure(unauthenticated())).toBe(true);
    expect(isDefinitiveRefreshFailure(schoolInactive())).toBe(true);
    expect(isDefinitiveRefreshFailure(forbidden())).toBe(true);
    expect(isDefinitiveRefreshFailure(internalError())).toBe(false);
    expect(isDefinitiveRefreshFailure(serviceUnavailable())).toBe(false);
    expect(isDefinitiveRefreshFailure(new Error('connection terminated'))).toBe(false);
  });
});

describe('logout and logout-all', () => {
  it('logout revokes the current family only; logout-all revokes every session', async () => {
    const driver = await staffUser(school.id);
    const phone = String(driver.phone);
    const s1 = await loginStaff(t.app, 'GAMMA-HYD', phone);
    const s2 = await loginStaff(t.app, 'GAMMA-HYD', phone, { deviceId: 'device-second-002', platform: 'ios', model: 'iPhone', appVersion: '1.0.0' });
    const s3 = await loginStaff(t.app, 'GAMMA-HYD', phone);
    expect((await request(t.app).post('/api/v1/auth/logout').set(bearer(s1.accessToken)).send({})).status).toBe(200);
    expect((await me(s1.accessToken)).status).toBe(401);
    expect((await refresh(s1.refreshToken)).status).toBe(401);
    expect((await me(s2.accessToken)).status).toBe(200);

    const all = await request(t.app).post('/api/v1/auth/logout-all').set(bearer(s2.accessToken)).send({});
    expect(all.status).toBe(200);
    expect(all.body.data.revokedSessions).toBe(2);
    expect((await me(s2.accessToken)).status).toBe(401);
    expect((await me(s3.accessToken)).status).toBe(401);
    expect((await refresh(s3.refreshToken)).status).toBe(401);
  });

  it('logout works with only a refresh token and needs some credential', async () => {
    const admin = await schoolAdmin(school.id);
    const login = await loginSchoolAdmin(t.app, String(admin.email));
    expect((await request(t.app).post('/api/v1/auth/logout').send({ refreshToken: login.refreshToken })).status).toBe(200);
    expect((await me(login.accessToken)).status).toBe(401);
    expect((await request(t.app).post('/api/v1/auth/logout').send({})).status).toBe(401);
  });
});

describe('change password', () => {
  it('forces the change before anything else, then clears must_change_password and signs out other sessions', async () => {
    const admin = await schoolAdmin(school.id, { must_change_password: true });
    const first = await loginSchoolAdmin(t.app, String(admin.email));
    const other = await loginSchoolAdmin(t.app, String(admin.email));
    expect(first.body.mustChangePassword).toBe(true);
    const blocked = await request(t.app).get('/api/v1/school/audit-logs').set(bearer(first.accessToken));
    expect([blocked.status, blocked.body.error.code]).toEqual([403, 'PASSWORD_CHANGE_REQUIRED']);
    expect((await me(first.accessToken)).body.data.mustChangePassword).toBe(true);

    const change = (body: object) => request(t.app).post('/api/v1/auth/change-password').set(bearer(first.accessToken)).send(body);
    expect((await change({ currentPassword: 'Wrong#123', newPassword: 'NewSecret#456' })).body.error.details[0].path).toBe('currentPassword');
    expect((await change({ currentPassword: PASSWORD, newPassword: 'short' })).status).toBe(400);
    expect((await change({ currentPassword: PASSWORD, newPassword: 'onlyletters' })).status).toBe(400);
    const ok = await change({ currentPassword: PASSWORD, newPassword: 'NewSecret#456' });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual({ changed: true, otherSessionsRevoked: 1 });

    expect((await request(t.app).get('/api/v1/school/audit-logs').set(bearer(first.accessToken))).status).toBe(200);
    expect((await me(other.accessToken)).status).toBe(401);
    expect((await request(t.app).post('/api/v1/auth/school/login').send({ email: admin.email, password: PASSWORD })).status).toBe(401);
    expect((await request(t.app).post('/api/v1/auth/school/login').send({ email: admin.email, password: 'NewSecret#456' })).body.data.mustChangePassword).toBe(false);
    const audit = await ownerQuery("select new_values from audit_logs where action = 'auth.password_change' and actor_id = $1", [admin.id]);
    expect(audit.rows[0]!.new_values).toEqual({ initial: false, otherSessionsRevoked: 1 });
    expect(JSON.stringify(audit.rows)).not.toContain('NewSecret');
  });

  it('lets an OTP parent set a first password without the current one', async () => {
    const parent = await f.parentAccount();
    await f.schoolParent(school.id, parent.id);
    const login = await loginParent(t, String(parent.phone));
    const res = await request(t.app).post('/api/v1/auth/change-password').set(bearer(login.accessToken)).send({ newPassword: 'Parent#2026' });
    expect(res.status).toBe(200);
    const pw = await request(t.app).post('/api/v1/auth/parent/password-login').send({ phone: parent.phone, password: 'Parent#2026' });
    expect(pw.status).toBe(200);
    // Now the current password is required.
    expect((await request(t.app).post('/api/v1/auth/change-password').set(bearer(login.accessToken)).send({ newPassword: 'Parent#2027' })).status).toBe(400);
  });
});

describe('deactivation', () => {
  it('a deactivated user is refused on the API and on refresh', async () => {
    const admin = await schoolAdmin(school.id);
    const login = await loginSchoolAdmin(t.app, String(admin.email));
    await ownerQuery('update users set is_active = false where id = $1', [admin.id]);
    expect((await me(login.accessToken)).status).toBe(401);
    expect((await refresh(login.refreshToken)).body.error.details.reason).toBe('ACCOUNT_INACTIVE');
    const s = await ownerQuery('select revoked_reason from sessions where id = $1', [login.sessionId]);
    expect(s.rows[0]!.revoked_reason).toBe('actor_inactive');
  });

  it('a suspended or deleted school blocks the API, /auth/me and refresh for its users', async () => {
    const s2 = await f.school({ code: 'DELTA-COK' });
    const admin = await schoolAdmin(s2.id);
    const login = await loginSchoolAdmin(t.app, String(admin.email));
    expect((await request(t.app).get('/api/v1/school/audit-logs').set(bearer(login.accessToken))).status).toBe(200);
    await ownerQuery("update schools set status = 'suspended' where id = $1", [s2.id]);
    invalidateSchoolState(s2.id);
    const api = await request(t.app).get('/api/v1/school/audit-logs').set(bearer(login.accessToken));
    expect([api.status, api.body.error.code]).toEqual([403, 'SCHOOL_INACTIVE']);
    expect((await me(login.accessToken)).body.error.code).toBe('SCHOOL_INACTIVE');
    expect((await refresh(login.refreshToken)).body.error.code).toBe('SCHOOL_INACTIVE');
    // That refresh revoked the session; presenting the token again still names the closed school.
    expect((await refresh(login.refreshToken)).body.error.code).toBe('SCHOOL_INACTIVE');
    await ownerQuery("update schools set status = 'active', deleted_at = now() where id = $1", [s2.id]);
    invalidateSchoolState(s2.id);
    expect((await request(t.app).post('/api/v1/auth/school/login').send({ email: admin.email, password: PASSWORD })).body.error.code).toBe('SCHOOL_INACTIVE');
  });
});

describe('profiles and parent school context', () => {
  it('returns the staff profile with the bound device', async () => {
    const driver = await staffUser(school.id);
    const sp = await f.staffProfile(school.id, { user_id: driver.id, staff_type: 'driver' });
    const login = await loginStaff(t.app, 'GAMMA-HYD', String(driver.phone));
    const res = await me(login.accessToken);
    expect(res.body.data).toMatchObject({ role: 'driver', staffProfile: { id: sp.id, staffType: 'driver' }, device: { platform: 'android' }, school: { code: 'GAMMA-HYD' } });
  });

  it('validates X-School-Id for parents: missing → 400, no active link → 403, linked → passes', async () => {
    const other = await f.school({ code: 'EPS-1' });
    const parent = await f.parentAccount();
    await f.schoolParent(school.id, parent.id);
    const child = await f.student(school.id);
    await f.studentParent(school.id, child.id, parent.id);
    await f.schoolParent(other.id, parent.id); // registered there, but no child link
    const login = await loginParent(t, String(parent.phone));
    const url = `/api/v1/files/${crypto.randomUUID()}/url`;
    expect((await request(t.app).get(url).set(bearer(login.accessToken))).status).toBe(400);
    const foreign = await request(t.app).get(url).set(bearer(login.accessToken)).set('X-School-Id', other.id);
    expect([foreign.status, foreign.body.error.code]).toEqual([403, 'FORBIDDEN']);
    expect((await request(t.app).get(url).set(bearer(login.accessToken)).set('X-School-Id', crypto.randomUUID())).status).toBe(403);
    expect((await request(t.app).get(url).set(bearer(login.accessToken)).set('X-School-Id', school.id)).status).toBe(404);
    const profile = await me(login.accessToken);
    expect(profile.body.data.schools.map((s: { school: { id: string } }) => s.school.id)).toEqual([school.id]);
  });
});
