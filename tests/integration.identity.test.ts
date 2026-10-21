// Integrator regressions — the global parent identity (contract §4, migration 015):
//   1. The app role reads only the non-sensitive columns of parent_accounts, in EVERY context
//      (column privileges, not RLS): password hash, lockout counters and the global last sign-in
//      are reachable only through scoped SECURITY DEFINER functions.
//   2. ensure_parent_account() and school_update_parent_phone() serialise on one advisory lock per
//      phone, so two schools linking / correcting the same parent cannot interleave.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type TenantContext, type Tx } from '../src/db/tenant.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { TEST_APP_ROLE } from './helpers/testEnv.js';

const SENSITIVE = ['password_hash', 'failed_login_count', 'locked_until', 'last_login_at'];

let schoolA: f.Row;
let schoolB: f.Row;
let parent: f.Row;
let otherParent: f.Row;

const query = (ctx: TenantContext, sql: string, params: unknown[] = []) => withTenant(ctx, (tx) => tx.many<Record<string, unknown>>(sql, params));

/** Latch that a test resolves to let a held transaction continue. */
function latch() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { open, opened };
}
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  schoolA = await f.school({ code: 'ID-A' });
  schoolB = await f.school({ code: 'ID-B' });
  parent = await f.parentAccount({ display_name: 'Shared', password_hash: '$argon2id$fake', last_login_at: new Date().toISOString(), failed_login_count: 2 });
  otherParent = await f.parentAccount({ locked_until: new Date(Date.now() + 600_000).toISOString(), failed_login_count: 0 });
  // The parent has used school A (migration 854: per-school sign-in flag), not school B.
  await f.schoolParent(schoolA.id, parent.id, { first_signed_in_at: new Date().toISOString() });
  await f.schoolParent(schoolB.id, parent.id);
  await f.schoolParent(schoolB.id, otherParent.id);
});
afterAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  await closeDb();
});

describe('parent_accounts column privileges', () => {
  it('db:setup-roles grants SELECT on the safe columns only and no INSERT/DELETE', async () => {
    const { rows } = await ownerQuery<{ column_name: string; privilege_type: string }>(
      `select column_name, privilege_type from information_schema.column_privileges
        where grantee = $1 and table_name = 'parent_accounts' order by 2, 1`,
      [TEST_APP_ROLE],
    );
    const select = rows.filter((r) => r.privilege_type === 'SELECT').map((r) => r.column_name);
    expect(select.sort()).toEqual(['created_at', 'display_name', 'id', 'is_active', 'phone', 'preferred_language', 'updated_at']);
    for (const c of SENSITIVE) expect(select).not.toContain(c);
    const table = await ownerQuery<{ p: string }>(
      `select privilege_type as p from information_schema.role_table_grants where grantee = $1 and table_name = 'parent_accounts'`,
      [TEST_APP_ROLE],
    );
    expect(table.rows).toEqual([]);
  });

  it.each(SENSITIVE)('a school admin cannot select %s of a linked parent', async (column) => {
    await expect(query(f.contexts.schoolAdmin(schoolA.id), `select ${column} from parent_accounts where id = $1`, [parent.id])).rejects.toMatchObject({ code: '42501' });
  });

  it('select * is refused in school, system and parent contexts alike', async () => {
    for (const ctx of [f.contexts.schoolAdmin(schoolA.id), f.contexts.system(schoolA.id), f.contexts.parent(parent.id, null)]) {
      await expect(query(ctx, 'select * from parent_accounts')).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('sensitive columns cannot leak through WHERE clauses or RETURNING either', async () => {
    const ctx = f.contexts.schoolAdmin(schoolA.id);
    await expect(query(ctx, 'select id from parent_accounts where password_hash is not null')).rejects.toMatchObject({ code: '42501' });
    await expect(query(ctx, 'select id from parent_accounts order by last_login_at')).rejects.toMatchObject({ code: '42501' });
    const own = f.contexts.parent(parent.id, null);
    await expect(query(own, "update parent_accounts set display_name = 'x' where id = $1 returning password_hash", [parent.id])).rejects.toMatchObject({ code: '42501' });
  });

  it('schools still read the safe columns of their own parents only', async () => {
    expect(await query(f.contexts.schoolAdmin(schoolA.id), 'select id, phone, is_active from parent_accounts')).toEqual([{ id: parent.id, phone: parent.phone, is_active: true }]);
  });
});

describe('scoped definer functions', () => {
  it('school_parent_sign_in_state returns flags for the caller school parents only', async () => {
    const a = await query(f.contexts.schoolAdmin(schoolA.id), 'select * from school_parent_sign_in_state()');
    expect(a).toEqual([{ parent_account_id: parent.id, has_signed_in: true, is_locked: false }]);
    const b = await query(f.contexts.schoolAdmin(schoolB.id), 'select * from school_parent_sign_in_state() order by parent_account_id');
    expect(b).toHaveLength(2);
    expect(b.find((r) => r.parent_account_id === otherParent.id)).toEqual({ parent_account_id: otherParent.id, has_signed_in: false, is_locked: true });
    // Other roles get nothing.
    expect(await query(f.contexts.parent(parent.id, schoolA.id), 'select * from school_parent_sign_in_state()')).toEqual([]);
    expect(await query(f.contexts.superAdmin(), 'select * from school_parent_sign_in_state()')).toEqual([]);
  });

  it('parent_self_password_hash answers only for the calling parent', async () => {
    expect(await query(f.contexts.parent(parent.id, null), 'select parent_self_password_hash() as h')).toEqual([{ h: '$argon2id$fake' }]);
    expect(await query(f.contexts.parent(otherParent.id, null), 'select parent_self_password_hash() as h')).toEqual([{ h: null }]);
    expect(await query(f.contexts.schoolAdmin(schoolA.id), 'select parent_self_password_hash() as h')).toEqual([{ h: null }]);
  });

  it('parent_record_login_failure works in the own context only', async () => {
    await expect(query(f.contexts.schoolAdmin(schoolA.id), 'select parent_record_login_failure($1, null, false, 5, 15)', [parent.id])).rejects.toMatchObject({ code: '42501' });
    await expect(query(f.contexts.parent(otherParent.id, null), 'select parent_record_login_failure($1, null, false, 5, 15)', [parent.id])).rejects.toMatchObject({ code: '42501' });
    const [r] = await query(f.contexts.parent(parent.id, null), 'select parent_record_login_failure($1, null, false, 5, 15) as until', [parent.id]);
    expect(r).toEqual({ until: null });
    expect((await ownerQuery('select failed_login_count from parent_accounts where id = $1', [parent.id])).rows[0]).toEqual({ failed_login_count: 3 });
    const [locked] = await query(f.contexts.parent(parent.id, null), 'select parent_record_login_failure($1, 5, true, 5, 15) as until', [parent.id]);
    expect(Date.parse(String(locked!.until))).toBeGreaterThan(Date.now());
    await ownerQuery('update parent_accounts set failed_login_count = 2, locked_until = null where id = $1', [parent.id]);
  });

  it('school_clear_parent_lockout clears only parents linked to the caller school', async () => {
    await expect(query(f.contexts.schoolAdmin(schoolA.id), 'select school_clear_parent_lockout($1)', [otherParent.id])).rejects.toMatchObject({ code: 'P0002' });
    await expect(query(f.contexts.driver(schoolB.id, otherParent.id), 'select school_clear_parent_lockout($1)', [otherParent.id])).rejects.toMatchObject({ code: '42501' });
    expect(await query(f.contexts.schoolAdmin(schoolB.id), 'select school_clear_parent_lockout($1) as c', [otherParent.id])).toEqual([{ c: true }]);
    expect(await query(f.contexts.schoolAdmin(schoolB.id), 'select school_clear_parent_lockout($1) as c', [otherParent.id])).toEqual([{ c: false }]);
    expect((await ownerQuery('select locked_until from parent_accounts where id = $1', [otherParent.id])).rows[0]).toEqual({ locked_until: null });
  });
});

describe('advisory lock between ensure_parent_account and school_update_parent_phone', () => {
  it('a phone correction in flight makes another school wait, then register the old number as a new account', async () => {
    const solo = await f.parentAccount();
    await f.schoolParent(schoolB.id, solo.id);
    const newPhone = f.uniquePhone();
    const hold = latch();
    let bDone = false;
    const correction = withTenant(f.contexts.schoolAdmin(schoolB.id), async (tx) => {
      await tx.query('select school_update_parent_phone($1, $2)', [solo.id, newPhone]);
      await hold.opened; // keeps the transaction (and the advisory lock) open
    }).then(() => (bDone = true));
    await settle(150);
    let aId: string | null = null;
    const registration = withTenant(f.contexts.schoolAdmin(schoolA.id), (tx) => tx.one<{ id: string }>('select ensure_parent_account($1) as id', [solo.phone])).then((r) => (aId = r.id));
    await settle(300);
    expect(aId).toBeNull(); // blocked behind school B's correction
    hold.open();
    await Promise.all([correction, registration]);
    expect(bDone).toBe(true);
    expect(aId).not.toBe(solo.id); // the old number now belongs to a fresh identity
    const rows = (await ownerQuery<{ id: string; phone: string }>('select id, phone from parent_accounts where id = any($1::uuid[]) order by phone', [[solo.id, aId]])).rows;
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === solo.id)?.phone).toBe(newPhone);
  });

  it('a link in flight makes the correction wait and then refuse the now-shared identity', async () => {
    const solo = await f.parentAccount();
    await f.schoolParent(schoolB.id, solo.id);
    const hold = latch();
    const linking = withTenant(f.contexts.schoolAdmin(schoolA.id), async (tx: Tx) => {
      const { id } = await tx.one<{ id: string }>('select ensure_parent_account($1) as id', [solo.phone]);
      await hold.opened;
      await tx.query(
        `insert into school_parents (school_id, parent_account_id, full_name) values (nullif(current_setting('app.school_id', true), '')::uuid, $1, 'Linked by A')`,
        [id],
      );
      return id;
    });
    await settle(150);
    let outcome: string | null = null;
    const correction = withTenant(f.contexts.schoolAdmin(schoolB.id), (tx) => tx.query('select school_update_parent_phone($1, $2)', [solo.id, f.uniquePhone()])).then(
      () => (outcome = 'updated'),
      (err: { code?: string }) => (outcome = err.code ?? 'error'),
    );
    await settle(300);
    expect(outcome).toBeNull(); // waiting for school A's transaction
    hold.open();
    expect(await linking).toBe(solo.id);
    await correction;
    expect(outcome).toBe('P0001');
    expect((await ownerQuery('select phone from parent_accounts where id = $1', [solo.id])).rows[0]).toEqual({ phone: solo.phone });
  });
});
