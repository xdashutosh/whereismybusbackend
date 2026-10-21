// School lifecycle (BP §8.2, App. C; contract §4, §6): deactivation revokes every session of the
// school's users and of parents whose only active school it was, disconnects sockets, blocks
// logins / refresh / tenant API calls / file URLs; activation restores access; soft delete; admin
// password reset revokes the admin's sessions.
import { generate, generateSecret } from 'otplib';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encryptSecret } from '../src/shared/crypto.js';
import { pubsub } from '../src/shared/pubsub.js';
import { RT_CONTROL_CHANNEL, type ControlMessage } from '../src/shared/realtime.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { buildApp, DEVICE, loginParent, loginSchoolAdmin, loginStaff, PASSWORD, passwordHash, type TestApp, type Tokens } from './helpers/authApp.js';

let t: TestApp;
let fx: f.TwoSchoolFixture;
let superToken: string;
const control: ControlMessage[] = [];
let unsubscribe: () => Promise<void>;

async function superAdminToken(app: TestApp['app'], superAdmin: f.Row): Promise<string> {
  const secret = generateSecret();
  await ownerQuery('update platform_users set password_hash = $1, totp_enabled = true, totp_secret_enc = $2 where id = $3', [await passwordHash(), encryptSecret(secret, { purpose: 'totp' }), superAdmin.id]);
  const res = await request(app).post('/api/v1/auth/platform/login').send({ email: superAdmin.email, password: PASSWORD, totpCode: await generate({ secret }) });
  if (res.status !== 200) throw new Error(`platform login failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.accessToken as string;
}
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const sa = () => auth(superToken);
const settle = () => new Promise((r) => setTimeout(r, 30));

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  fx = await f.twoSchoolFixture();
  await ownerQuery('update users set password_hash = $1 where school_id = any ($2)', [await passwordHash(), [fx.a.school.id, fx.b.school.id]]);
  superToken = await superAdminToken(t.app, fx.superAdmin);
  unsubscribe = await pubsub.subscribe<ControlMessage>(RT_CONTROL_CHANNEL, (m) => {
    control.push(m);
  });
});
afterAll(async () => {
  await unsubscribe();
  await closeDb();
});

describe('deactivate → activate', () => {
  let admin: Tokens;
  let driver: Tokens;
  let exclusiveParent: Tokens;
  let sharedParent: Tokens;
  let otherAdmin: Tokens;

  it('revokes sessions, disconnects sockets and closes the school', async () => {
    admin = await loginSchoolAdmin(t.app, String(fx.a.admin.email));
    driver = await loginStaff(t.app, String(fx.a.school.code), String(fx.a.driverUser.phone));
    exclusiveParent = await loginParent(t, String(fx.a.parent.phone));
    sharedParent = await loginParent(t, String(fx.sharedParent.phone));
    otherAdmin = await loginSchoolAdmin(t.app, String(fx.b.admin.email));
    control.length = 0;

    const res = await request(t.app).post(`/api/v1/platform/schools/${fx.a.school.id}/deactivate`).set(sa()).send({ reason: 'Contract ended' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.school).toMatchObject({ id: fx.a.school.id, status: 'inactive', statusReason: 'Contract ended' });
    expect(res.body.data.sessions).toMatchObject({ parentsSignedOut: 1, parentSessionsRevoked: 1, complete: true });
    expect(res.body.data.sessions.userSessionsRevoked).toBeGreaterThanOrEqual(3); // admin, driver, fixture driver session

    const live = await ownerQuery('select count(*)::int as n from sessions where school_id = $1 and revoked_at is null', [fx.a.school.id]);
    expect(live.rows[0]!.n).toBe(0);
    await settle();
    expect(control).toContainEqual({ type: 'disconnect-school', schoolId: fx.a.school.id });
    const disconnected = control.flatMap((m) => (m.type === 'disconnect-sessions' ? m.sessionIds : []));
    expect(disconnected).toEqual(expect.arrayContaining([admin.sessionId, driver.sessionId, exclusiveParent.sessionId]));
    expect(disconnected).not.toContain(sharedParent.sessionId);

    const audit = await ownerQuery("select school_id, actor_id, new_values from audit_logs where action = 'school.deactivate' and entity_id = $1", [fx.a.school.id]);
    expect(audit.rows).toEqual([expect.objectContaining({ school_id: null, actor_id: fx.superAdmin.id })]);
  });

  it('blocks logins, refresh, API calls and file URLs of the school; other schools are untouched', async () => {
    expect((await request(t.app).get('/api/v1/school/audit-logs').set(auth(admin.accessToken))).status).toBe(401);
    expect((await request(t.app).get('/api/v1/auth/me').set(auth(driver.accessToken))).status).toBe(401);
    // Revoked by the closure: refresh names the closed school (school-inactive message, not "session ended").
    const refreshed = await request(t.app).post('/api/v1/auth/refresh').send({ refreshToken: admin.refreshToken });
    expect([refreshed.status, refreshed.body.error.code]).toEqual([403, 'SCHOOL_INACTIVE']);
    const parentRefresh = await request(t.app).post('/api/v1/auth/refresh').send({ refreshToken: exclusiveParent.refreshToken });
    expect([parentRefresh.status, parentRefresh.body.error.code]).toEqual([403, 'SCHOOL_INACTIVE']);
    const login = await request(t.app).post('/api/v1/auth/school/login').send({ email: fx.a.admin.email, password: PASSWORD });
    expect(login.status).toBe(403);
    expect(login.body.error.code).toBe('SCHOOL_INACTIVE');
    const staff = await request(t.app).post('/api/v1/auth/staff/login').send({ schoolCode: fx.a.school.code, phone: fx.a.driverUser.phone, password: PASSWORD, device: DEVICE });
    expect(staff.status).toBe(403);
    // Parent linked only here: signed out and can no longer sign in by OTP.
    expect((await request(t.app).get('/api/v1/auth/me').set(auth(exclusiveParent.accessToken))).status).toBe(401);
    // Parent with a child in school B: still signed in, but school A is closed to them.
    const me = await request(t.app).get('/api/v1/auth/me').set(auth(sharedParent.accessToken));
    expect(me.status).toBe(200);
    const schools = me.body.data.schools as { school: { id: string; status: string }; children: unknown[] }[];
    expect(schools.find((s) => s.school.id === fx.a.school.id)).toMatchObject({ school: { status: 'inactive' }, children: [] });
    expect(schools.find((s) => s.school.id === fx.b.school.id)!.children).toHaveLength(1);
    const fileA = await request(t.app).get(`/api/v1/files/${fx.a.busImage.id}/url`).set({ ...auth(sharedParent.accessToken), 'X-School-Id': fx.a.school.id });
    expect(fileA.status).toBe(403);
    expect(fileA.body.error.code).toBe('SCHOOL_INACTIVE');
    // School B keeps working.
    expect((await request(t.app).get('/api/v1/school/audit-logs').set(auth(otherAdmin.accessToken))).status).toBe(200);
  });

  it('suspending an inactive school is idempotent and re-runs the revocation', async () => {
    const res = await request(t.app).post(`/api/v1/platform/schools/${fx.a.school.id}/deactivate`).set(sa()).send({ status: 'suspended' });
    expect(res.status).toBe(200);
    expect(res.body.data.school.status).toBe('suspended');
    expect(res.body.data.sessions).toMatchObject({ userSessionsRevoked: 0, parentSessionsRevoked: 0 });
    expect((await ownerQuery("select 1 from audit_logs where action = 'school.suspend' and entity_id = $1", [fx.a.school.id])).rowCount).toBe(1);
  });

  it('activation restores sign-in', async () => {
    const res = await request(t.app).post(`/api/v1/platform/schools/${fx.a.school.id}/activate`).set(sa());
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ school: { status: 'active', statusReason: null }, warnings: [] });
    const relogin = await loginSchoolAdmin(t.app, String(fx.a.admin.email));
    expect((await request(t.app).get('/api/v1/school/audit-logs').set(auth(relogin.accessToken))).status).toBe(200);
    expect((await request(t.app).post(`/api/v1/platform/schools/${fx.a.school.id}/activate`).set(sa())).status).toBe(200);
    expect((await ownerQuery("select count(*)::int as n from audit_logs where action = 'school.activate' and entity_id = $1", [fx.a.school.id])).rows[0]!.n).toBe(1);
  });

  it('activation warns when the subscription has lapsed', async () => {
    await ownerQuery("update school_subscriptions set valid_from = '2020-01-01', valid_until = '2020-12-31' where school_id = $1", [fx.b.school.id]);
    await request(t.app).post(`/api/v1/platform/schools/${fx.b.school.id}/deactivate`).set(sa());
    const res = await request(t.app).post(`/api/v1/platform/schools/${fx.b.school.id}/activate`).set(sa());
    expect(res.body.data.warnings).toEqual(['SUBSCRIPTION_EXPIRED']);
    await ownerQuery('update school_subscriptions set valid_until = null where school_id = $1', [fx.b.school.id]);
  });
});

describe('DELETE /platform/schools/:id (soft delete)', () => {
  let id: string;
  it('refuses an active school, then soft-deletes a deactivated one', async () => {
    const created = await request(t.app)
      .post('/api/v1/platform/schools')
      .set(sa())
      .send({ name: 'Temporary School', code: `tmp-${f.nextSeq()}`, admin: { name: 'Temp Admin', email: `tmp-${f.nextSeq()}@x.example` } });
    id = created.body.data.school.id as string;
    const active = await request(t.app).delete(`/api/v1/platform/schools/${id}`).set(sa());
    expect(active.status).toBe(409);
    expect(active.body.error).toMatchObject({ code: 'INVALID_STATE', details: { reason: 'SCHOOL_ACTIVE' } });
    await request(t.app).post(`/api/v1/platform/schools/${id}/deactivate`).set(sa());
    const del = await request(t.app).delete(`/api/v1/platform/schools/${id}`).set(sa()).send({ reason: 'Duplicate onboarding' });
    expect(del.status).toBe(200);
    expect(del.body.data.school).toMatchObject({ id, deleted: true, statusReason: 'Duplicate onboarding' });
    expect((await ownerQuery("select school_id from audit_logs where action = 'school.delete' and entity_id = $1", [id])).rows).toEqual([{ school_id: null }]);
  });

  it('hides it from lists (unless includeDeleted), keeps it readable and refuses further changes', async () => {
    const list = await request(t.app).get('/api/v1/platform/schools?q=Temporary').set(sa());
    expect(list.body.data).toEqual([]);
    const withDeleted = await request(t.app).get('/api/v1/platform/schools?q=Temporary&includeDeleted=true').set(sa());
    expect(withDeleted.body.data.map((s: { id: string }) => s.id)).toEqual([id]);
    expect((await request(t.app).get(`/api/v1/platform/schools/${id}`).set(sa())).body.data.deleted).toBe(true);
    for (const call of [
      request(t.app).patch(`/api/v1/platform/schools/${id}`).set(sa()).send({ name: 'Back' }),
      request(t.app).post(`/api/v1/platform/schools/${id}/activate`).set(sa()),
      request(t.app).delete(`/api/v1/platform/schools/${id}`).set(sa()),
      request(t.app).put(`/api/v1/platform/schools/${id}/subscription`).set(sa()).send({ plan: 'standard' }),
    ]) {
      const res = await call;
      expect(res.status).toBe(409);
      expect(res.body.error.details).toMatchObject({ reason: 'SCHOOL_DELETED' });
    }
    const usage = await request(t.app).get('/api/v1/platform/usage?q=Temporary').set(sa());
    expect(usage.body.data).toEqual([]);
  });
});

describe('POST /platform/schools/:id/admin/reset-password', () => {
  it("issues a temporary password, forces a change and signs the admin out everywhere", async () => {
    const before = await loginSchoolAdmin(t.app, String(fx.b.admin.email));
    control.length = 0;
    const res = await request(t.app).post(`/api/v1/platform/schools/${fx.b.school.id}/admin/reset-password`).set(sa());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data).toMatchObject({ admin: { id: fx.b.admin.id, mustChangePassword: true }, credentials: { delivery: 'show', passwordGenerated: true } });
    expect(res.body.data.sessionsRevoked).toBeGreaterThanOrEqual(1);
    const temp = res.body.data.credentials.temporaryPassword as string;
    await settle();
    expect(control.flatMap((m) => (m.type === 'disconnect-sessions' ? m.sessionIds : []))).toContain(before.sessionId);
    expect((await request(t.app).get('/api/v1/school/audit-logs').set(auth(before.accessToken))).status).toBe(401);
    expect((await request(t.app).post('/api/v1/auth/school/login').send({ email: fx.b.admin.email, password: PASSWORD })).status).toBe(401);
    const login = await request(t.app).post('/api/v1/auth/school/login').send({ email: fx.b.admin.email, password: temp });
    expect(login.status).toBe(200);
    expect(login.body.data.mustChangePassword).toBe(true);
    const audit = await ownerQuery<{ school_id: string | null; new_values: unknown }>("select school_id, new_values from audit_logs where action = 'school.admin_password_reset' and entity_id = $1", [fx.b.admin.id]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.school_id).toBeNull();
    expect(JSON.stringify(audit.rows[0]!.new_values)).not.toContain(temp);
  });

  it('only resets admins of that school; validates chosen passwords', async () => {
    const other = await request(t.app).post(`/api/v1/platform/schools/${fx.b.school.id}/admin/reset-password`).set(sa()).send({ userId: fx.a.admin.id });
    expect(other.status).toBe(404);
    const driver = await request(t.app).post(`/api/v1/platform/schools/${fx.b.school.id}/admin/reset-password`).set(sa()).send({ userId: fx.b.driverUser.id });
    expect(driver.status).toBe(404);
    const weak = await request(t.app).post(`/api/v1/platform/schools/${fx.b.school.id}/admin/reset-password`).set(sa()).send({ password: '12345678' });
    expect(weak.status).toBe(400);
    const chosen = await request(t.app).post(`/api/v1/platform/schools/${fx.b.school.id}/admin/reset-password`).set(sa()).send({ userId: fx.b.admin.id, password: 'Reset#2026x', delivery: 'email' });
    expect(chosen.status).toBe(200);
    expect(chosen.body.data.credentials).toMatchObject({ delivery: 'email', passwordGenerated: false, emailDelivered: false, temporaryPassword: 'Reset#2026x' });
    expect((await request(t.app).post('/api/v1/auth/school/login').send({ email: fx.b.admin.email, password: 'Reset#2026x' })).status).toBe(200);
  });
});
