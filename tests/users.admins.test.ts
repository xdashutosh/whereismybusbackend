// Additional school admins (BP §8.3 CRUD /school/admins + reset-access/activate/deactivate, §5.4):
// temporary passwords (returned once, never audited), forced change at sign-in, global e-mail
// uniqueness, self-protection, never losing the last active admin (concurrent deactivations),
// session revocation + socket disconnect, lockout cleared by a reset, soft delete, roles and
// cross-school isolation (A's token with B's ids → 404 everywhere).
import type { Request } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { channels } from '../src/shared/notifications/index.js';
import * as service from '../src/modules/users/service.js';
import { realtime } from '../src/shared/realtime.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { buildApp, loginParent, loginSchoolAdmin, loginStaff, PASSWORD, passwordHash, schoolAdmin, type TestApp } from './helpers/authApp.js';

let t: TestApp;
let fx: f.TwoSchoolFixture;
let adminA: string;
let driverA: string;
let parentA: string;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const api = (p = '') => `/api/v1/school/admins${p}`;
const TEMP_RE = /^[A-Za-z]{4}-[A-Za-z]{4}-[2-9]{4}$/;
const login = (email: string, password = PASSWORD) => request(t.app).post('/api/v1/auth/school/login').send({ email, password });
const me = (token: string) => request(t.app).get('/api/v1/auth/me').set(auth(token));

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  fx = await f.twoSchoolFixture();
  await ownerQuery('update users set password_hash = $1 where id = any ($2)', [await passwordHash(), [fx.a.admin.id, fx.b.admin.id, fx.a.driverUser.id]]);
  adminA = (await loginSchoolAdmin(t.app, String(fx.a.admin.email))).accessToken;
  driverA = (await loginStaff(t.app, String(fx.a.school.code), String(fx.a.driverUser.phone))).accessToken;
  parentA = (await loginParent(t, String(fx.a.parent.phone))).accessToken;
});
afterEach(() => vi.restoreAllMocks());
afterAll(closeDb);

describe('create', () => {
  it('creates an admin with a generated temporary password that must be changed at sign-in', async () => {
    const res = await request(t.app)
      .post(api())
      .set(auth(adminA))
      .send({ fullName: 'Kavya Menon', email: 'Kavya.Menon@Greenfield.TEST', phone: '98450 22222', school_id: fx.b.school.id, role: 'driver' });
    expect(res.status).toBe(201);
    const { admin, temporaryPassword } = res.body.data as { admin: Record<string, unknown>; temporaryPassword: string };
    expect(temporaryPassword).toMatch(TEMP_RE);
    expect(admin).toMatchObject({ fullName: 'Kavya Menon', email: 'kavya.menon@greenfield.test', phone: '+919845022222', isActive: true, mustChangePassword: true, isSelf: false, createdBy: fx.a.admin.id });
    const row = await ownerQuery<{ school_id: string; role: string }>('select school_id, role from users where id = $1', [admin.id]);
    expect(row.rows[0]).toEqual({ school_id: fx.a.school.id, role: 'school_admin' });

    const signIn = await login('kavya.menon@greenfield.test', temporaryPassword);
    expect(signIn.status).toBe(200);
    expect(signIn.body.data.mustChangePassword).toBe(true);
    const mail = channels.email.sentMessages().at(-1)!;
    expect(mail.to).toBe('kavya.menon@greenfield.test');
    expect(mail.text).toContain(temporaryPassword);
    const log = await ownerQuery<{ new_values: Record<string, unknown> }>("select new_values from audit_logs where action = 'school_admin.create' and entity_id = $1", [admin.id]);
    expect(log.rows[0]!.new_values).toMatchObject({ email: 'kavya.menon@greenfield.test', generatedByServer: true });
    expect(JSON.stringify(log.rows[0]!.new_values)).not.toContain(temporaryPassword);
  });

  it('accepts an admin-chosen password (never echoed) and validates input', async () => {
    const res = await request(t.app).post(api()).set(auth(adminA)).send({ fullName: 'Rohit Shetty', email: 'rohit@greenfield.test', password: 'Initial#2026' });
    expect(res.status).toBe(201);
    expect(res.body.data.temporaryPassword).toBeNull();
    expect((await login('rohit@greenfield.test', 'Initial#2026')).status).toBe(200);
    const bad = await request(t.app).post(api()).set(auth(adminA)).send({ fullName: '', email: 'nope', phone: '12', password: 'short' });
    expect(bad.status).toBe(400);
    expect((bad.body.error.details as { path: string }[]).map((d) => d.path)).toEqual(expect.arrayContaining(['fullName', 'email', 'phone', 'password']));
  });

  it("refuses an e-mail already used by any school's admin (global sign-in identifier)", async () => {
    const own = await request(t.app).post(api()).set(auth(adminA)).send({ fullName: 'Dup', email: 'ROHIT@greenfield.test' });
    expect(own.status).toBe(409);
    expect(own.body.error.code).toBe('DUPLICATE');
    const other = await request(t.app).post(api()).set(auth(adminA)).send({ fullName: 'Dup', email: String(fx.b.admin.email) });
    expect(other.status).toBe(409);
    expect(other.body.error.message).not.toContain(String(fx.b.school.name));
  });
});

describe('read and update', () => {
  it("lists only this school's admins with filters and CSV", async () => {
    const res = await request(t.app).get(api('?sort=fullName')).set(auth(adminA));
    expect(res.status).toBe(200);
    const names = res.body.data.map((a: { fullName: string }) => a.fullName);
    expect(names).toEqual(['Anita Rao', 'Kavya Menon', 'Rohit Shetty']);
    expect(res.body.data.find((a: { isSelf: boolean }) => a.isSelf).id).toBe(fx.a.admin.id);
    expect(res.body.data.every((a: { email: string }) => a.email !== fx.b.admin.email)).toBe(true);
    const q = await request(t.app).get(api('?q=kavya')).set(auth(adminA));
    expect(q.body.meta.total).toBe(1);
    const csv = await request(t.app).get(api('?format=csv')).set(auth(adminA));
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text).toContain('kavya.menon@greenfield.test');
    expect(csv.text).not.toContain('$argon2');
  });

  it('updates name/e-mail/phone with an audit diff', async () => {
    const id = await idOf('rohit@greenfield.test');
    const res = await request(t.app).patch(api(`/${id}`)).set(auth(adminA)).send({ fullName: 'Rohit S.', phone: '+919845033333', email: 'rohit.s@greenfield.test' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ fullName: 'Rohit S.', phone: '+919845033333', email: 'rohit.s@greenfield.test' });
    const cleared = await request(t.app).patch(api(`/${id}`)).set(auth(adminA)).send({ phone: '' });
    expect(cleared.body.data.phone).toBeNull();
    const dup = await request(t.app).patch(api(`/${id}`)).set(auth(adminA)).send({ email: 'kavya.menon@greenfield.test' });
    expect(dup.status).toBe(409);
    const log = await ownerQuery<{ old_values: unknown; new_values: unknown }>(
      "select old_values, new_values from audit_logs where action = 'school_admin.update' and entity_id = $1 order by id limit 1",
      [id],
    );
    expect(log.rows[0]).toEqual({
      old_values: { fullName: 'Rohit Shetty', email: 'rohit@greenfield.test', phone: null },
      new_values: { fullName: 'Rohit S.', email: 'rohit.s@greenfield.test', phone: '+919845033333' },
    });
  });
});

async function idOf(email: string): Promise<string> {
  return (await ownerQuery<{ id: string }>("select id from users where email = $1 and role = 'school_admin' and deleted_at is null", [email])).rows[0]!.id;
}

describe('deactivate / activate', () => {
  it('refuses to deactivate yourself', async () => {
    const res = await request(t.app).post(api(`/${fx.a.admin.id}/deactivate`)).set(auth(adminA)).send({});
    expect(res.status).toBe(403);
    expect(res.body.error.details).toMatchObject({ reason: 'SELF' });
  });

  it('deactivates another admin: sessions revoked, sockets disconnected, sign-in blocked, audited', async () => {
    const email = 'kavya.menon@greenfield.test';
    const id = await idOf(email);
    await ownerQuery('update users set password_hash = $1, must_change_password = false where id = $2', [await passwordHash(), id]);
    const session = await loginSchoolAdmin(t.app, email);
    expect((await me(session.accessToken)).status).toBe(200);
    const disconnect = vi.spyOn(realtime, 'disconnectSessions');

    const res = await request(t.app).post(api(`/${id}/deactivate`)).set(auth(adminA)).send({ reason: 'Left the school' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id, isActive: false });
    expect(res.body.data.revokedSessions).toBeGreaterThanOrEqual(1);
    expect(disconnect).toHaveBeenCalledWith(expect.arrayContaining([session.sessionId]));
    expect((await me(session.accessToken)).status).toBe(401);
    expect((await request(t.app).post('/api/v1/auth/refresh').send({ refreshToken: session.refreshToken })).status).toBe(401);
    const blocked = await login(email);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.message).toMatch(/deactivated/);
    const log = await ownerQuery<{ new_values: Record<string, unknown> }>("select new_values from audit_logs where action = 'school_admin.deactivate' and entity_id = $1", [id]);
    expect(log.rows[0]!.new_values).toMatchObject({ isActive: false, reason: 'Left the school' });
    // idempotent: deactivating again changes nothing
    const again = await request(t.app).post(api(`/${id}/deactivate`)).set(auth(adminA)).send({});
    expect(again.body.data).toMatchObject({ isActive: false, revokedSessions: 0 });
    expect((await request(t.app).get(api('?status=inactive')).set(auth(adminA))).body.data.map((a: { id: string }) => a.id)).toEqual([id]);
  });

  it('activates it again (sign-in works)', async () => {
    const id = await idOf('kavya.menon@greenfield.test');
    const res = await request(t.app).post(api(`/${id}/activate`)).set(auth(adminA));
    expect(res.status).toBe(200);
    expect(res.body.data.isActive).toBe(true);
    expect((await login('kavya.menon@greenfield.test')).status).toBe(200);
    const log = await ownerQuery("select 1 from audit_logs where action = 'school_admin.activate' and entity_id = $1", [id]);
    expect(log.rowCount).toBe(1);
  });

  it('never loses the last active admin when two admins deactivate each other concurrently', async () => {
    const s = await f.school({ name: 'Two Admin School' });
    const x = await schoolAdmin(s.id, { full_name: 'Admin X' });
    const y = await schoolAdmin(s.id, { full_name: 'Admin Y' });
    const tx = (await loginSchoolAdmin(t.app, String(x.email))).accessToken;
    const ty = (await loginSchoolAdmin(t.app, String(y.email))).accessToken;
    const [rx, ry] = await Promise.all([
      request(t.app).post(api(`/${y.id}/deactivate`)).set(auth(tx)).send({}),
      request(t.app).post(api(`/${x.id}/deactivate`)).set(auth(ty)).send({}),
    ]);
    const statuses = [rx.status, ry.status].sort();
    expect(statuses[0]).toBe(200);
    expect([401, 409]).toContain(statuses[1]);
    const loser = rx.status === 200 ? ry : rx;
    if (loser.status === 409) expect(loser.body.error).toMatchObject({ code: 'INVALID_STATE', details: { reason: 'LAST_ACTIVE_ADMIN' } });
    const active = await ownerQuery<{ n: number }>("select count(*)::int as n from users where school_id = $1 and role = 'school_admin' and is_active", [s.id]);
    expect(active.rows[0]!.n).toBe(1);
  });
  it('refuses to deactivate or delete the only remaining active admin (service rule)', async () => {
    // A request from an admin account that is itself no longer active (e.g. deactivated by a
    // concurrent request after authentication) must not take away the last active admin.
    const s = await f.school({ name: 'Single Admin School' });
    const only = await schoolAdmin(s.id, { full_name: 'Only Admin' });
    const gone = await schoolAdmin(s.id, { full_name: 'Gone Admin', is_active: false });
    const req = {
      method: 'POST',
      auth: { actorId: gone.id, role: 'school_admin', ownerType: 'user', schoolId: s.id, sessionId: gone.id },
      tenant: { schoolId: s.id, timezone: 'Asia/Kolkata', tenantMode: 'shared', dbConnectionRef: null },
    } as unknown as Request;
    await expect(service.deactivate(req, only.id, {})).rejects.toMatchObject({ code: 'INVALID_STATE', details: { reason: 'LAST_ACTIVE_ADMIN' } });
    await expect(service.remove(req, only.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const row = await ownerQuery<{ is_active: boolean; deleted_at: string | null }>('select is_active, deleted_at from users where id = $1', [only.id]);
    expect(row.rows[0]).toEqual({ is_active: true, deleted_at: null });
  });
});

describe('reset access', () => {
  it('refuses to reset yourself', async () => {
    expect((await request(t.app).post(api(`/${fx.a.admin.id}/reset-access`)).set(auth(adminA)).send({})).status).toBe(403);
  });

  it('issues a temporary password, clears the lockout and signs the admin out everywhere', async () => {
    const email = 'kavya.menon@greenfield.test';
    const id = await idOf(email);
    const session = await loginSchoolAdmin(t.app, email);
    await ownerQuery("update users set locked_until = now() + interval '10 minutes', failed_login_count = 5 where id = $1", [id]);
    const disconnect = vi.spyOn(realtime, 'disconnectSessions');

    const res = await request(t.app).post(api(`/${id}/reset-access`)).set(auth(adminA));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const { temporaryPassword, admin, revokedSessions } = res.body.data as { temporaryPassword: string; admin: Record<string, unknown>; revokedSessions: number };
    expect(temporaryPassword).toMatch(TEMP_RE);
    expect(admin).toMatchObject({ mustChangePassword: true, locked: false });
    expect(revokedSessions).toBeGreaterThanOrEqual(1);
    expect(disconnect).toHaveBeenCalledWith(expect.arrayContaining([session.sessionId]));
    expect((await me(session.accessToken)).status).toBe(401);
    expect((await login(email)).status).toBe(401);
    const fresh = await login(email, temporaryPassword);
    expect(fresh.status).toBe(200);
    expect(fresh.body.data.mustChangePassword).toBe(true);
    expect(channels.email.sentMessages().at(-1)!.subject).toMatch(/reset/i);
    const log = await ownerQuery<{ new_values: Record<string, unknown> }>("select new_values from audit_logs where action = 'school_admin.reset_access' and entity_id = $1", [id]);
    expect(log.rows[0]!.new_values).toMatchObject({ forcedChangeAtSignIn: true, generatedByServer: true });
    expect(JSON.stringify(log.rows[0]!.new_values)).not.toContain(temporaryPassword);
  });

  it('accepts an admin-chosen temporary password', async () => {
    const id = await idOf('kavya.menon@greenfield.test');
    const res = await request(t.app).post(api(`/${id}/reset-access`)).set(auth(adminA)).send({ password: 'Temp#2026x' });
    expect(res.status).toBe(200);
    expect(res.body.data.temporaryPassword).toBeNull();
    expect((await login('kavya.menon@greenfield.test', 'Temp#2026x')).status).toBe(200);
    expect((await request(t.app).post(api(`/${id}/reset-access`)).set(auth(adminA)).send({ password: 'weak' })).status).toBe(400);
  });
});

describe('delete', () => {
  it('refuses to delete yourself; soft-deletes another admin and frees its e-mail', async () => {
    expect((await request(t.app).delete(api(`/${fx.a.admin.id}`)).set(auth(adminA))).status).toBe(403);
    const id = await idOf('rohit.s@greenfield.test');
    await ownerQuery('update users set password_hash = $1, must_change_password = false where id = $2', [await passwordHash(), id]);
    const session = await loginSchoolAdmin(t.app, 'rohit.s@greenfield.test');
    const disconnect = vi.spyOn(realtime, 'disconnectSessions');
    const del = await request(t.app).delete(api(`/${id}`)).set(auth(adminA));
    expect([del.status, del.body.data]).toEqual([200, { id, deleted: true }]);
    expect((await request(t.app).get(api(`/${id}`)).set(auth(adminA))).status).toBe(404);
    const row = await ownerQuery<{ deleted_at: string | null; is_active: boolean }>('select deleted_at, is_active from users where id = $1', [id]);
    expect(row.rows[0]!.deleted_at).not.toBeNull();
    expect(row.rows[0]!.is_active).toBe(false);
    expect(disconnect).toHaveBeenCalledWith(expect.arrayContaining([session.sessionId]));
    expect((await me(session.accessToken)).status).toBe(401);
    expect((await login('rohit.s@greenfield.test')).status).toBe(401);
    const again = await request(t.app).post(api()).set(auth(adminA)).send({ fullName: 'Rohit Returns', email: 'rohit.s@greenfield.test' });
    expect(again.status).toBe(201);
  });
});

describe('isolation and roles', () => {
  it("returns 404 for school B's admin on every endpoint and changes nothing", async () => {
    const b = String(fx.b.admin.id);
    expect((await request(t.app).get(api(`/${b}`)).set(auth(adminA))).status).toBe(404);
    expect((await request(t.app).patch(api(`/${b}`)).set(auth(adminA)).send({ fullName: 'Hacked' })).status).toBe(404);
    expect((await request(t.app).post(api(`/${b}/deactivate`)).set(auth(adminA)).send({})).status).toBe(404);
    expect((await request(t.app).post(api(`/${b}/activate`)).set(auth(adminA))).status).toBe(404);
    expect((await request(t.app).post(api(`/${b}/reset-access`)).set(auth(adminA)).send({})).status).toBe(404);
    expect((await request(t.app).delete(api(`/${b}`)).set(auth(adminA))).status).toBe(404);
    const row = await ownerQuery<{ full_name: string; is_active: boolean; deleted_at: string | null }>('select full_name, is_active, deleted_at from users where id = $1', [b]);
    expect(row.rows[0]).toEqual({ full_name: 'Anita Rao', is_active: true, deleted_at: null });
    expect((await login(String(fx.b.admin.email))).status).toBe(200);
  });

  it('does not treat drivers as school admins', async () => {
    const d = String(fx.a.driverUser.id);
    expect((await request(t.app).get(api(`/${d}`)).set(auth(adminA))).status).toBe(404);
    expect((await request(t.app).post(api(`/${d}/deactivate`)).set(auth(adminA)).send({})).status).toBe(404);
  });

  it('is refused to drivers, parents and anonymous callers', async () => {
    expect((await request(t.app).get(api())).status).toBe(401);
    expect((await request(t.app).get(api()).set(auth(driverA))).status).toBe(403);
    expect((await request(t.app).post(api()).set(auth(driverA)).send({ fullName: 'X', email: 'x@y.test' })).status).toBe(403);
    expect((await request(t.app).get(api()).set(auth(parentA)).set('X-School-Id', fx.a.school.id)).status).toBe(403);
  });
});
