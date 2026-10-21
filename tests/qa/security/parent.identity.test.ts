// A school acting on the GLOBAL parent identity of a parent who belongs to ANOTHER school
// (contract §4: parent_accounts is global, schools may only read it; BP §4.9 tenant isolation).
// Any school can register any number, so a school may end the parent's (global) sessions or clear
// its (global) sign-in lock only while the parent uses no other school, and only ever learns about
// the parent's activity in its own school (migration 854: school_parents.first_signed_in_at).
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, ownerQuery } from '../../helpers/db.js';
import { loginParent, passwordHash, PASSWORD } from '../../helpers/authApp.js';
import { api, buildWorld, call, type World } from './world.js';

let w: World;
beforeAll(async () => {
  w = await buildWorld();
});
afterAll(closeDb);

const openSessions = async (accountId: string) =>
  (await ownerQuery<{ n: number }>("select count(*)::int as n from sessions where owner_type = 'parent_account' and owner_id = $1 and revoked_at is null", [accountId])).rows[0]!.n;
const aRowOf = async (accountId: string) =>
  (await ownerQuery<{ id: string }>('select id from school_parents where school_id = $1 and parent_account_id = $2', [w.fx.a.school.id, accountId])).rows[0]!.id;
const tryPw = (phone: string, pw: string) => request(w.t.app).post(api('/auth/parent/password-login')).send({ phone, password: pw });

describe("school A claims school B's parent by phone number", () => {
  it('A cannot sign a B-only parent out of every school (reset-access / deactivate / delete)', async () => {
    const bParent = w.fx.b.parent; // linked ONLY in school B
    const phone = String(bParent.phone);
    const s = await loginParent(w.t, phone);
    // The parent uses school B (its children list) → B's row records the first use.
    expect((await call(w.t, 'get', '/parent/children', s.accessToken)).status).toBe(200);

    // School A registers the number (no consent, no relation to A) …
    const created = await call(w.t, 'post', '/school/parents', w.adminA.accessToken, { body: { phone, fullName: 'Claimed By A' } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const aParentId = created.body.data.id as string;
    // … and resets "its" access: nothing global happens, and the response reads like an unused number.
    const reset = await call(w.t, 'post', `/school/parents/${aParentId}/reset-access`, w.adminA.accessToken, { body: { reason: 'x' } });
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
    expect(reset.body.data).toMatchObject({ revokedSessions: 0, unlocked: false, sharedAccount: false, blockers: ['NO_ACTIVE_CHILD'] });
    expect((await call(w.t, 'get', '/parent/children', s.accessToken)).status).toBe(200);
    // Deactivating and deleting A's row do not end the B session either.
    expect((await call(w.t, 'patch', `/school/parents/${aParentId}`, w.adminA.accessToken, { body: { isActive: false } })).status).toBe(200);
    expect((await call(w.t, 'delete', `/school/parents/${aParentId}`, w.adminA.accessToken)).status).toBe(200);
    expect((await call(w.t, 'get', '/parent/children', s.accessToken)).status).toBe(200);
    expect(await openSessions(String(bParent.id))).toBeGreaterThan(0);
    // Registered again for the following tests.
    expect((await call(w.t, 'post', '/school/parents', w.adminA.accessToken, { body: { phone, fullName: 'Claimed By A' } })).status).toBe(201);
  });

  it("A's reset-access cannot clear the global sign-in lock that B's parent earned", async () => {
    const bParent = w.fx.b.parent;
    const phone = String(bParent.phone);
    await ownerQuery('update parent_accounts set password_hash = $1 where id = $2', [await passwordHash(), bParent.id]);
    for (let i = 0; i < 5; i++) await tryPw(phone, `wrong-${i}`);
    expect((await tryPw(phone, PASSWORD)).status).toBe(429); // locked
    const reset = await call(w.t, 'post', `/school/parents/${await aRowOf(String(bParent.id))}/reset-access`, w.adminA.accessToken, { body: {} });
    expect(reset.status).toBe(200);
    expect(reset.body.data.unlocked).toBe(false);
    expect((await tryPw(phone, 'wrong-again')).status).toBe(429); // still locked: no unlimited guessing
    const row = await ownerQuery<{ locked: boolean }>('select locked_until > now() as locked from parent_accounts where id = $1', [bParent.id]);
    expect(row.rows[0]!.locked).toBe(true);
  });

  it("B (the parent's real school) can still reset its parent although A registered the number", async () => {
    const bParent = w.fx.b.parent;
    expect(await openSessions(String(bParent.id))).toBeGreaterThan(0); // the session of the first test
    const reset = await call(w.t, 'post', `/school/parents/${w.fx.b.schoolParent.id}/reset-access`, w.adminB.accessToken, { body: { reason: 'Lost phone' } });
    expect(reset.status).toBe(200);
    expect(reset.body.data).toMatchObject({ unlocked: true, sharedAccount: false, otpReady: true });
    expect(reset.body.data.revokedSessions).toBeGreaterThan(0);
    expect(await openSessions(String(bParent.id))).toBe(0);
  });

  it('a parent who uses both schools is reset by neither (sharedAccount), but each school can block it locally', async () => {
    const shared = w.fx.sharedParent;
    const s = w.parent; // signed in by buildWorld
    const kids = await call(w.t, 'get', '/parent/children', s.accessToken);
    expect(kids.body.data.schools).toHaveLength(2); // uses A and B
    const aId = await aRowOf(String(shared.id));
    const reset = await call(w.t, 'post', `/school/parents/${aId}/reset-access`, w.adminA.accessToken, { body: {} });
    expect(reset.body.data).toMatchObject({ revokedSessions: 0, unlocked: false, sharedAccount: true });
    // Deactivation in A blocks the parent in A only; its B access keeps working.
    expect((await call(w.t, 'patch', `/school/parents/${aId}`, w.adminA.accessToken, { body: { isActive: false } })).status).toBe(200);
    expect((await call(w.t, 'get', `/parent/children/${w.fx.a.student.id}/tracking`, s.accessToken, { headers: { 'X-School-Id': String(w.fx.a.school.id) } })).status).toBe(403);
    expect((await call(w.t, 'get', `/parent/children/${w.fx.b.student.id}/tracking`, s.accessToken, { headers: { 'X-School-Id': String(w.fx.b.school.id) } })).status).toBe(200);
    expect((await call(w.t, 'patch', `/school/parents/${aId}`, w.adminA.accessToken, { body: { isActive: true } })).status).toBe(200);
  });

  it('school_clear_parent_lockout refuses a parent used by another school even when called directly', async () => {
    const { withTenant } = await import('../../../src/db/tenant.js');
    await expect(
      withTenant({ schoolId: String(w.fx.a.school.id), actorId: String(w.fx.a.admin.id), role: 'school_admin' }, (tx) => tx.query('select school_clear_parent_lockout($1)', [w.fx.b.parent.id])),
    ).rejects.toMatchObject({ code: 'P0001' });
  });
});

describe('what school A learns about a number it registers', () => {
  it("hasSignedIn reflects only the parent's use of school A (registering a number is no enumeration oracle)", async () => {
    const otherId = await aRowOf(String(w.fx.b.parent.id));
    const fresh = await call(w.t, 'post', '/school/parents', w.adminA.accessToken, { body: { phone: '+919811122233', fullName: 'Probe 2' } });
    const detail = async (id: string) => (await call(w.t, 'get', `/school/parents/${id}`, w.adminA.accessToken)).body.data as Record<string, unknown>;
    const pick = (d: Record<string, unknown>) => Object.fromEntries(Object.entries(d).filter(([k]) => /signed|lock|login|account/i.test(k)));
    expect(pick(await detail(otherId))).toEqual(pick(await detail(fresh.body.data.id as string)));
    expect((await detail(otherId)).hasSignedIn).toBe(false);
    // The shared parent has used school A (previous test) → true for A.
    expect((await detail(await aRowOf(String(w.fx.sharedParent.id)))).hasSignedIn).toBe(true);
  });
});
