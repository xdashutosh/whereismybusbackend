// BP §5.2 force logout by an admin (coverage finding): a school admin can sign a driver/conductor,
// another school admin or a parent out on every device WITHOUT changing their credentials —
// POST /school/staff/:id/sessions/revoke · /school/admins/:id/sessions/revoke ·
// /school/parents/:id/sessions/revoke. Sessions are revoked, sockets disconnected, the action is
// audited, the same password / PIN / OTP still signs in, and other schools' ids answer 404.
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { realtime } from '../../src/shared/realtime.js';
import { closeDb, ownerQuery, truncateAll } from '../helpers/db.js';
import * as f from '../helpers/factories.js';
import { buildApp, loginParent, loginSchoolAdmin, loginStaff, PASSWORD, passwordHash, schoolAdmin, type TestApp } from '../helpers/authApp.js';

let t: TestApp;
let fx: f.TwoSchoolFixture;
let adminA: string;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const me = (token: string) => request(t.app).get('/api/v1/auth/me').set(auth(token));
const revoke = (path: string, token = adminA) => request(t.app).post(`/api/v1/school/${path}/sessions/revoke`).set(auth(token)).send({});
const liveSessions = async (ownerType: string, ownerId: string) =>
  Number((await ownerQuery<{ n: string }>('select count(*) as n from sessions where owner_type = $1 and owner_id = $2 and revoked_at is null', [ownerType, ownerId])).rows[0]!.n);
const auditOf = async (action: string, entityId: string) =>
  (await ownerQuery<{ school_id: string; new_values: Record<string, unknown> }>('select school_id, new_values from audit_logs where action = $1 and entity_id = $2', [action, entityId])).rows;

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  fx = await f.twoSchoolFixture();
  await ownerQuery('update users set password_hash = $1 where id = any ($2)', [await passwordHash(), [fx.a.admin.id, fx.b.admin.id, fx.a.driverUser.id]]);
  adminA = (await loginSchoolAdmin(t.app, String(fx.a.admin.email))).accessToken;
});
afterEach(() => vi.restoreAllMocks());
afterAll(closeDb);

describe('POST /school/staff/:id/sessions/revoke', () => {
  it('signs the driver out everywhere and keeps the password', async () => {
    const disconnect = vi.spyOn(realtime, 'disconnectSessions');
    const driver = (await loginStaff(t.app, String(fx.a.school.code), String(fx.a.driverUser.phone))).accessToken;
    expect((await me(driver)).status).toBe(200);
    const res = await revoke(`staff/${fx.a.driver.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: fx.a.driver.id });
    expect(res.body.data.revokedSessions).toBeGreaterThanOrEqual(1);
    expect(disconnect).toHaveBeenCalled();
    expect((await me(driver)).status).toBe(401);
    expect(await liveSessions('user', fx.a.driverUser.id)).toBe(0);
    // Same credentials still work: nothing but the sessions changed.
    const again = await loginStaff(t.app, String(fx.a.school.code), String(fx.a.driverUser.phone));
    expect((await me(again.accessToken)).status).toBe(200);
    const rows = await auditOf('staff.sessions_revoke', String(fx.a.driver.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ school_id: fx.a.school.id, new_values: { revokedSessions: res.body.data.revokedSessions } });
  });

  it('answers 0 for a staff member without a login and 404 for another school', async () => {
    const none = await revoke(`staff/${fx.a.otherDriver.id}`);
    expect(none.status).toBe(200);
    expect(none.body.data.revokedSessions).toBe(0);
    expect((await revoke(`staff/${fx.b.driver.id}`)).status).toBe(404);
    expect(await liveSessions('user', fx.b.driverUser.id)).toBeGreaterThan(0);
  });
});

describe('POST /school/admins/:id/sessions/revoke', () => {
  it('signs another admin out everywhere, keeps the password, refuses self and other schools', async () => {
    const other = await schoolAdmin(fx.a.school.id, { email: 'second.admin@greenfield.test' });
    const token = (await loginSchoolAdmin(t.app, 'second.admin@greenfield.test')).accessToken;
    const res = await revoke(`admins/${other.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: other.id, revokedSessions: 1 });
    expect((await me(token)).status).toBe(401);
    expect((await request(t.app).post('/api/v1/auth/school/login').send({ email: 'second.admin@greenfield.test', password: PASSWORD })).status).toBe(200);
    expect(await auditOf('school_admin.sessions_revoke', String(other.id))).toHaveLength(1);

    const self = await revoke(`admins/${fx.a.admin.id}`);
    expect(self.status).toBe(403);
    expect(self.body.error.details ?? self.body.error).toMatchObject({ reason: 'SELF' });
    expect((await me(adminA)).status).toBe(200);
    expect((await revoke(`admins/${fx.b.admin.id}`)).status).toBe(404);
  });
});

describe('POST /school/parents/:id/sessions/revoke', () => {
  it('signs the parent out everywhere and leaves the account and its link active', async () => {
    const parent = (await loginParent(t, String(fx.a.parent.phone))).accessToken;
    expect((await me(parent)).status).toBe(200);
    const res = await revoke(`parents/${fx.a.schoolParent.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ parentId: fx.a.schoolParent.id, sharedAccount: false });
    expect(res.body.data.revokedSessions).toBeGreaterThanOrEqual(1);
    expect((await me(parent)).status).toBe(401);
    expect(await liveSessions('parent_account', String(fx.a.parent.id))).toBe(0);
    // Nothing else changed: the account and its link stay active (the next OTP sign-in works).
    const state = await ownerQuery<{ account: boolean; link: boolean }>(
      'select pa.is_active as account, sp.is_active as link from school_parents sp join parent_accounts pa on pa.id = sp.parent_account_id where sp.id = $1',
      [fx.a.schoolParent.id],
    );
    expect(state.rows[0]).toEqual({ account: true, link: true });
    const rows = await auditOf('parent.sessions_revoke', String(fx.a.schoolParent.id));
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]!.new_values)).not.toContain(String(fx.a.parent.phone).slice(-6));
  });

  it('answers 404 for a parent of another school and needs a school admin', async () => {
    expect((await revoke(`parents/${fx.b.schoolParent.id}`)).status).toBe(404);
    const driver = (await loginStaff(t.app, String(fx.a.school.code), String(fx.a.driverUser.phone))).accessToken;
    expect((await revoke(`parents/${fx.a.schoolParent.id}`, driver)).status).toBe(403);
  });
});
