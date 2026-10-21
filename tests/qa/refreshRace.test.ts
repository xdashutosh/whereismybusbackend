// Refresh grace window (migration 900, auth/sessions.ts, REFRESH_GRACE_SECONDS = 30). The driver app
// runs two ApiClients (UI isolate + flutter_foreground_task service isolate) over one secure store;
// when both refresh the same pair at the same moment the server sees the same refresh token twice,
// and a client that lost a refresh response retries with the old token. Within 30 s, from the same
// client and device, the server answers with the SAME successor instead of revoking the family.
// Reuse detection outside that window (or from another device, or after the successor moved on) is
// unchanged. (Formerly tests-pre/mobile/refreshRace.test.ts.)
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REFRESH_GRACE_SECONDS } from '../../src/modules/auth/policy.js';
import { clientFingerprint } from '../../src/modules/auth/sessions.js';
import { closeDb, ownerQuery, truncateAll } from '../helpers/db.js';
import * as f from '../helpers/factories.js';
import { buildApp, DEVICE, loginParent, loginSchoolAdmin, loginStaff, PASSWORD, schoolAdmin, staffUser, type TestApp } from '../helpers/authApp.js';

let t: TestApp;
let school: f.Row;

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  school = await f.school({ code: 'RACE-BLR', name: 'Race School' });
});
afterAll(closeDb);

const refresh = (refreshToken: string, deviceId: string | null = DEVICE.deviceId) => {
  const r = request(t.app).post('/api/v1/auth/refresh');
  if (deviceId) r.set('X-Device-Id', deviceId);
  return r.send({ refreshToken });
};
const me = (token: string) => request(t.app).get('/api/v1/auth/me').set({ Authorization: `Bearer ${token}` });
const reason = (res: request.Response) => res.body.error?.details?.reason as string | undefined;

async function driverLogin() {
  const driver = await staffUser(school.id, 'driver');
  return { driver, login: await loginStaff(t.app, 'RACE-BLR', String(driver.phone)) };
}

async function ageRotation(sessionId: string, seconds: number) {
  await ownerQuery(`update sessions set rotated_at = rotated_at - make_interval(secs => $2) where id = $1`, [sessionId, seconds]);
}

describe('concurrent refresh of one driver session (UI isolate + tracking service isolate)', () => {
  it('two simultaneous refreshes with the same token keep the driver signed in with ONE successor', async () => {
    const { login } = await driverLogin();
    const [a, b] = await Promise.all([refresh(login.refreshToken), refresh(login.refreshToken)]);
    expect([a.status, b.status], `reasons: ${JSON.stringify([reason(a), reason(b)])}`).toEqual([200, 200]);
    expect(a.body.data.refreshToken).toBe(b.body.data.refreshToken);
    expect(a.body.data.sessionId).toBe(b.body.data.sessionId);
    expect((await me(a.body.data.accessToken)).status).toBe(200);
    expect((await me(b.body.data.accessToken)).status).toBe(200);
    // Exactly one live successor; nothing revoked.
    const fam = await ownerQuery<{ live: number; revoked: number }>(
      `select count(*) filter (where rotated_at is null and revoked_at is null)::int as live, count(*) filter (where revoked_at is not null)::int as revoked
         from sessions where family_id = (select family_id from sessions where id = $1)`,
      [login.sessionId],
    );
    expect(fam.rows[0]).toEqual({ live: 1, revoked: 0 });
    // The successor rotates normally afterwards.
    const next = await refresh(a.body.data.refreshToken);
    expect(next.status).toBe(200);
    expect(next.body.data.refreshToken).not.toBe(a.body.data.refreshToken);
  });

  it('a retry after a lost response (sequential, within the window) returns the same successor', async () => {
    const { login } = await driverLogin();
    const first = await refresh(login.refreshToken);
    const retry = await refresh(login.refreshToken);
    expect([first.status, retry.status]).toEqual([200, 200]);
    expect(retry.body.data.refreshToken).toBe(first.body.data.refreshToken);
    expect(retry.body.data.sessionId).toBe(first.body.data.sessionId);
    expect(retry.body.data.refreshTokenExpiresAt).toBe(first.body.data.refreshTokenExpiresAt);
    expect((await me(retry.body.data.accessToken)).status).toBe(200);
    const audit = await ownerQuery("select count(*)::int as n from audit_logs where action = 'auth.refresh_reuse' and entity_id = $1", [login.sessionId]);
    expect(audit.rows[0]!.n).toBe(0);
  });

  it('stores the successor token only encrypted and wipes it when the family is revoked', async () => {
    const { login } = await driverLogin();
    const first = await refresh(login.refreshToken);
    const row = (await ownerQuery<{ enc: string | null; fp: string | null; successor_id: string | null }>('select successor_token_enc as enc, successor_client_fp as fp, successor_id from sessions where id = $1', [login.sessionId])).rows[0]!;
    expect(row.successor_id).toBe(first.body.data.sessionId);
    expect(row.enc).toMatch(/^v1\./);
    expect(row.enc).not.toContain(first.body.data.refreshToken);
    expect(row.fp).toMatch(/^[0-9a-f]{64}$/);
    expect(row.fp).not.toContain(DEVICE.deviceId);
    const out = await request(t.app).post('/api/v1/auth/logout').set({ Authorization: `Bearer ${first.body.data.accessToken}` }).send({});
    expect(out.status).toBe(200);
    const wiped = await ownerQuery<{ n: number }>('select count(*)::int as n from sessions where family_id = (select family_id from sessions where id = $1) and successor_token_enc is not null', [login.sessionId]);
    expect(wiped.rows[0]!.n).toBe(0);
    expect(reason(await refresh(login.refreshToken))).toBe('REVOKED');
  });
});

describe('reuse detection outside the grace window is unchanged', () => {
  it(`after ${REFRESH_GRACE_SECONDS} s the old token is a reuse: the family is revoked`, async () => {
    const { login } = await driverLogin();
    const first = await refresh(login.refreshToken);
    await ageRotation(login.sessionId, REFRESH_GRACE_SECONDS + 1);
    const late = await refresh(login.refreshToken);
    expect([late.status, reason(late)]).toEqual([401, 'REFRESH_TOKEN_REUSED']);
    expect((await refresh(first.body.data.refreshToken)).status).toBe(401);
    expect((await me(first.body.data.accessToken)).status).toBe(401);
    const audit = await ownerQuery("select count(*)::int as n from audit_logs where action = 'auth.refresh_reuse' and entity_id = $1", [login.sessionId]);
    expect(audit.rows[0]!.n).toBe(1);
  });

  it('just inside the window (29 s) the successor is still returned', async () => {
    const { login } = await driverLogin();
    const first = await refresh(login.refreshToken);
    await ageRotation(login.sessionId, REFRESH_GRACE_SECONDS - 1);
    const retry = await refresh(login.refreshToken);
    expect(retry.status).toBe(200);
    expect(retry.body.data.refreshToken).toBe(first.body.data.refreshToken);
  });

  it('another device (different X-Device-Id) presenting the old token triggers reuse detection', async () => {
    const { login } = await driverLogin();
    const first = await refresh(login.refreshToken);
    const thief = await refresh(login.refreshToken, 'attacker-phone-0001');
    expect([thief.status, reason(thief)]).toEqual([401, 'REFRESH_TOKEN_REUSED']);
    expect((await refresh(first.body.data.refreshToken)).status).toBe(401);
  });

  it('a mobile retry without X-Device-Id never gets the grace answer', async () => {
    const { login } = await driverLogin();
    const first = await refresh(login.refreshToken, null);
    expect(first.status).toBe(200);
    const retry = await refresh(login.refreshToken, null);
    expect([retry.status, reason(retry)]).toEqual([401, 'REFRESH_TOKEN_REUSED']);
    // And a first rotation without a device id stores no grace secret at all.
    const row = (await ownerQuery<{ enc: string | null }>('select successor_token_enc as enc from sessions where id = $1', [login.sessionId])).rows[0]!;
    expect(row.enc).toBeNull();
  });

  it('once the successor was rotated itself, the old token is a reuse even inside the window', async () => {
    const { login } = await driverLogin();
    const first = await refresh(login.refreshToken);
    const second = await refresh(first.body.data.refreshToken);
    expect(second.status).toBe(200);
    const old = await refresh(login.refreshToken);
    expect([old.status, reason(old)]).toEqual([401, 'REFRESH_TOKEN_REUSED']);
    expect((await refresh(second.body.data.refreshToken)).status).toBe(401);
  });

  it('a deactivated account gets no successor from the grace window', async () => {
    const { driver, login } = await driverLogin();
    await refresh(login.refreshToken);
    await ownerQuery('update users set is_active = false where id = $1', [driver.id]);
    const retry = await refresh(login.refreshToken);
    expect(retry.status).toBe(401);
    expect(retry.body.data).toBeUndefined();
  });

  it('wipes expired grace secrets of older rows on the next rotation of the family', async () => {
    const { login } = await driverLogin();
    const first = await refresh(login.refreshToken);
    await ageRotation(login.sessionId, REFRESH_GRACE_SECONDS + 5);
    await refresh(first.body.data.refreshToken);
    const rows = await ownerQuery<{ id: string; enc: string | null }>('select id, successor_token_enc as enc from sessions where id = any($1::uuid[])', [[login.sessionId, first.body.data.sessionId]]);
    const byId = new Map(rows.rows.map((r) => [r.id, r.enc]));
    expect(byId.get(login.sessionId)).toBeNull();
    expect(byId.get(first.body.data.sessionId)).toMatch(/^v1\./);
  });
});

describe('web clients (refresh cookie) and parents', () => {
  const cookieOf = (res: request.Response) => ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('wimb_rt='))!.split(';')[0]!;
  const webRefresh = (cookie: string, ua: string) => request(t.app).post('/api/v1/auth/refresh').set('Cookie', cookie).set('X-WIMB-Client', 'web').set('User-Agent', ua).send({});

  it('two tabs of the same browser refreshing at once both stay signed in; another browser is a reuse', async () => {
    const admin = await schoolAdmin(school.id);
    const login = await request(t.app).post('/api/v1/auth/school/login').set('X-WIMB-Client', 'web').set('User-Agent', 'Browser/1').send({ email: admin.email, password: PASSWORD });
    const cookie = cookieOf(login);
    const [a, b] = await Promise.all([webRefresh(cookie, 'Browser/1'), webRefresh(cookie, 'Browser/1')]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(cookieOf(a)).toBe(cookieOf(b));
    expect(a.body.data.refreshToken).toBeUndefined(); // still never in the body for web clients
    const other = await webRefresh(cookie, 'OtherBrowser/2');
    expect([other.status, reason(other)]).toEqual([401, 'REFRESH_TOKEN_REUSED']);
  });

  it('parents get the same grace answer (school-less session rows)', async () => {
    const parent = await f.parentAccount();
    const sp = await f.schoolParent(school.id, parent.id);
    const st = await f.student(school.id);
    await f.studentParent(school.id, st.id, parent.id);
    expect(sp.id).toBeTruthy();
    const login = await loginParent(t, String(parent.phone));
    const [a, b] = await Promise.all([refresh(login.refreshToken, 'parent-phone-01'), refresh(login.refreshToken, 'parent-phone-01')]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.data.refreshToken).toBe(b.body.data.refreshToken);
  });

  it('admin school login (mobile client without device id) keeps strict reuse detection', async () => {
    const admin = await schoolAdmin(school.id);
    const login = await loginSchoolAdmin(t.app, String(admin.email));
    await refresh(login.refreshToken, null);
    expect(reason(await refresh(login.refreshToken, null))).toBe('REFRESH_TOKEN_REUSED');
  });
});

describe('clientFingerprint', () => {
  const base = { ip: null, appName: null, appVersion: null };
  it('uses X-Device-Id for mobile and the user agent for web, and nothing else', () => {
    const m1 = clientFingerprint({ ...base, client: 'mobile', userAgent: 'A', deviceUid: 'dev-1' });
    expect(m1).toMatch(/^[0-9a-f]{64}$/);
    expect(clientFingerprint({ ...base, client: 'mobile', userAgent: 'B', deviceUid: 'dev-1' })).toBe(m1);
    expect(clientFingerprint({ ...base, client: 'mobile', userAgent: 'A', deviceUid: 'dev-2' })).not.toBe(m1);
    expect(clientFingerprint({ ...base, client: 'mobile', userAgent: 'A', deviceUid: null })).toBeNull();
    expect(clientFingerprint({ ...base, client: 'web', userAgent: 'UA', deviceUid: null })).toMatch(/^[0-9a-f]{64}$/);
    expect(clientFingerprint({ ...base, client: 'web', userAgent: null, deviceUid: 'dev-1' })).toBeNull();
    expect(clientFingerprint({ ...base, client: 'web', userAgent: 'dev-1', deviceUid: null })).not.toBe(clientFingerprint({ ...base, client: 'mobile', userAgent: null, deviceUid: 'dev-1' }));
  });
});
