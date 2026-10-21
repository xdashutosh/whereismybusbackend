// Platform-table policies (contract §4): schools (super admin: all; school: own, profile-only
// updates), platform_users / platform_settings (super admin; public settings readable), parent
// accounts (own row or linked school), subscriptions, audit visibility, staff session scoping,
// otp_codes (no app access) and the school_settings bootstrap trigger.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type TenantContext } from '../src/db/tenant.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import { contexts, otpCode, twoSchoolFixture, type TwoSchoolFixture } from './helpers/factories.js';

let f: TwoSchoolFixture;
let adminA: TenantContext;
let superAdmin: TenantContext;

const many = <T extends Record<string, unknown>>(ctx: TenantContext, sql: string, params: unknown[] = []) =>
  withTenant(ctx, (tx) => tx.many<T>(sql, params));

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  f = await twoSchoolFixture();
  adminA = contexts.schoolAdmin(f.a.school.id, f.a.admin.id);
  superAdmin = contexts.superAdmin(f.superAdmin.id);
});

afterAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  await closeDb();
});

describe('schools', () => {
  it('school contexts see only their own school; super admins see all', async () => {
    expect(await many(adminA, 'select id from schools')).toEqual([{ id: f.a.school.id }]);
    expect(await many(contexts.driver(f.b.school.id, f.b.driverUser.id), 'select id from schools')).toEqual([{ id: f.b.school.id }]);
    expect((await many(superAdmin, 'select id from schools')).length).toBe(2);
  });

  it('school admins edit their profile but never platform-controlled columns or other schools', async () => {
    const r = await withTenant(adminA, (tx) => tx.query("update schools set contact_phone = '+918000000001' where id = $1", [f.a.school.id]));
    expect(r.rowCount).toBe(1);
    await expect(withTenant(adminA, (tx) => tx.query("update schools set status = 'active', code = 'HACKED' where id = $1", [f.a.school.id]))).rejects.toMatchObject({ code: '42501' });
    await expect(withTenant(adminA, (tx) => tx.query('update schools set deleted_at = now() where id = $1', [f.a.school.id]))).rejects.toMatchObject({ code: '42501' });
    const other = await withTenant(adminA, (tx) => tx.query("update schools set name = 'x' where id = $1", [f.b.school.id]));
    expect(other.rowCount).toBe(0);
    await expect(withTenant(contexts.driver(f.a.school.id, f.a.driverUser.id), (tx) => tx.query("update schools set name = 'x' where id = $1", [f.a.school.id]))).resolves.toMatchObject({ rowCount: 0 });
  });

  it('super admins create schools (settings row created in the same transaction) and change status', async () => {
    const created = await withTenant(superAdmin, async (tx) => {
      const s = await tx.one<{ id: string }>("insert into schools (code, name) values ('NEWSCHOOL-01', 'New School') returning id");
      await tx.query("update schools set status = 'suspended', status_reason = 'unpaid' where id = $1", [s.id]);
      // The trigger restored the caller's (empty) school context after creating the settings row.
      const ctx = await tx.one<{ school: string }>("select current_setting('app.school_id', true) as school");
      return { id: s.id, school: ctx.school };
    });
    expect(created.school).toBe('');
    const settings = await ownerQuery<{ school_id: string; parent_visibility: Record<string, unknown> }>('select school_id, parent_visibility from school_settings where school_id = $1', [created.id]);
    expect(settings.rows[0]!.parent_visibility).toHaveProperty('driver.phone', false);
    // …but still sees none of that school's tenant rows.
    expect(await many(superAdmin, 'select school_id from school_settings')).toEqual([]);
  });
});

describe('platform_users and platform_settings', () => {
  it('platform users are visible to super admins only', async () => {
    expect((await many(superAdmin, 'select id from platform_users')).map((r) => r.id)).toContain(f.superAdmin.id);
    expect(await many(adminA, 'select id from platform_users')).toEqual([]);
    expect(await many(contexts.parent(f.a.parent.id, null), 'select id from platform_users')).toEqual([]);
  });

  it('public settings are readable by every context; private ones and writes are super-admin only', async () => {
    const pub = await many<{ key: string }>(adminA, 'select key from platform_settings order by key');
    expect(pub.map((r) => r.key)).toContain('min_supported_version');
    expect(pub.map((r) => r.key)).toContain('location.retention_months'); // public since migration 800 (schools read the maximum)
    expect(pub.map((r) => r.key)).not.toContain('trips.stale_close_hours');
    expect((await many(superAdmin, "select key from platform_settings where key = 'trips.stale_close_hours'")).length).toBe(1);
    const upd = await withTenant(adminA, (tx) => tx.query("update platform_settings set value = '99' where key = 'location.moving_interval_s'"));
    expect(upd.rowCount).toBe(0);
    await expect(withTenant(adminA, (tx) => tx.query("insert into platform_settings (key, value) values ('evil', '1')"))).rejects.toMatchObject({ code: '42501' });
  });
});

describe('parent_accounts', () => {
  it('school admins see the parents linked to their school only', async () => {
    const rows = await many<{ id: string }>(adminA, 'select id from parent_accounts');
    expect(rows.map((r) => r.id).sort()).toEqual([f.a.parent.id, f.sharedParent.id].sort());
    expect(await many(adminA, 'select id from parent_accounts where id = $1', [f.b.parent.id])).toEqual([]);
    expect(await many(contexts.driver(f.a.school.id, f.a.driverUser.id), 'select id from parent_accounts')).toEqual([]);
  });

  it('a parent sees and updates its own row only', async () => {
    const own = contexts.parent(f.a.parent.id, null);
    expect(await many(own, 'select id from parent_accounts')).toEqual([{ id: f.a.parent.id }]);
    const r = await withTenant(own, (tx) => tx.query("update parent_accounts set preferred_language = 'hi'"));
    expect(r.rowCount).toBe(1);
  });
});

describe('subscriptions, audit, sessions, otp', () => {
  it('school admins read their own subscription but cannot change it', async () => {
    expect((await many(adminA, 'select id from school_subscriptions')).length).toBe(1);
    expect((await withTenant(adminA, (tx) => tx.query('update school_subscriptions set max_buses = 999'))).rowCount).toBe(0);
    expect((await withTenant(superAdmin, (tx) => tx.query('update school_subscriptions set max_buses = 60 where school_id = $1', [f.a.school.id]))).rowCount).toBe(1);
  });

  it('audit rows: school admins read their school, drivers read nothing, platform rows need super admin', async () => {
    const rows = await many<{ action: string }>(adminA, 'select action from audit_logs');
    expect(rows.map((r) => r.action)).toEqual(['bus.create']);
    expect(await many(contexts.driver(f.a.school.id, f.a.driverUser.id), 'select id from audit_logs')).toEqual([]);
    await withTenant(contexts.superAdmin(f.superAdmin.id), (tx) => tx.query("insert into audit_logs (actor_type, actor_id, action) values ('platform_user', $1, 'school.update')", [f.superAdmin.id]));
    await expect(withTenant(adminA, (tx) => tx.query("insert into audit_logs (action) values ('school.update')"))).rejects.toMatchObject({ code: '42501' });
  });

  it('drivers see only their own sessions and devices; school admins see the school’s', async () => {
    const driver = contexts.driver(f.a.school.id, f.a.driverUser.id);
    expect(await many(driver, 'select id from sessions')).toEqual([{ id: f.a.driverSession.id }]);
    expect(await many(driver, 'select id from devices')).toEqual([{ id: f.a.driverDevice.id }]);
    expect(await many(contexts.conductor(f.a.school.id, f.a.conductorUser.id), 'select id from sessions')).toEqual([]);
    expect(await many(adminA, 'select id from sessions')).toEqual([{ id: f.a.driverSession.id }]);
  });

  it('super admins and parents keep their own school-less sessions', async () => {
    await withTenant(superAdmin, (tx) =>
      tx.query("insert into sessions (owner_type, owner_id, family_id, refresh_hash, client, expires_at) values ('platform_user', $1, gen_random_uuid(), 'sa-refresh-hash', 'web', now() + interval '1 day')", [f.superAdmin.id]),
    );
    expect((await many(superAdmin, 'select id from sessions')).length).toBe(1);
    expect(await many(contexts.superAdmin(), 'select id from sessions')).toEqual([]);
    await expect(
      withTenant(superAdmin, (tx) => tx.query("insert into sessions (owner_type, owner_id, school_id, family_id, refresh_hash, expires_at) values ('user', $1, $2, gen_random_uuid(), 'x-hash', now())", [f.a.admin.id, f.a.school.id])),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('otp_codes are invisible to the app role in every context', async () => {
    await otpCode();
    for (const ctx of [adminA, superAdmin, contexts.system(), contexts.parent(f.a.parent.id, null)]) {
      expect(await many(ctx, 'select id from otp_codes')).toEqual([]);
    }
  });
});
