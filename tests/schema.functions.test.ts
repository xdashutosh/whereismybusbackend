// SECURITY DEFINER functions (contract §4, BP §4.4/§4.5): exact (minimal) result columns, fixed
// search_path, EXECUTE only for the app role, role guards, and behaviour through the app role —
// session/actor loading, the four login lookups, OTP issue/verify, parent link index, worker and
// platform helpers, partition maintenance, notification push targets. Also: audit_logs is insert-only
// for the app role.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAppPool } from '../src/db/pool.js';
import { withTenant, type TenantContext } from '../src/db/tenant.js';
import { loadSchoolTimezones } from '../src/jobs/schoolCron.js';
import { parentLinkFromDb } from '../src/middleware/resolveTenant.js';
import { loadMinVersionsFromDb } from '../src/middleware/versionGate.js';
import { loadSessionFromDb } from '../src/shared/sessions.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as F from './helpers/factories.js';
import { TEST_APP_ROLE } from './helpers/testEnv.js';

let f: F.TwoSchoolFixture;
const one = <T extends Record<string, unknown>>(ctx: TenantContext, sql: string, params: unknown[] = []) => withTenant(ctx, (tx) => tx.maybeOne<T>(sql, params));
const many = <T extends Record<string, unknown>>(ctx: TenantContext, sql: string, params: unknown[] = []) => withTenant(ctx, (tx) => tx.many<T>(sql, params));
const sys = F.contexts.system();

const EXPECTED_DEFINERS: Record<string, string> = {
  active_school_ids: 'SETOF uuid',
  auth_parent_login: 'TABLE(id uuid, password_hash text, is_active boolean, failed_login_count integer, locked_until timestamp with time zone, has_active_link boolean)',
  auth_platform_login: 'TABLE(id uuid, name text, password_hash text, must_change_password boolean, totp_enabled boolean, totp_secret_enc text, totp_last_used_step bigint, is_active boolean, failed_login_count integer, locked_until timestamp with time zone)',
  auth_school_admin_login: 'TABLE(id uuid, school_id uuid, school_status text, school_deleted boolean, full_name text, password_hash text, must_change_password boolean, is_active boolean, failed_login_count integer, locked_until timestamp with time zone)',
  auth_session_actor: 'TABLE(session_id uuid, owner_type text, owner_id uuid, school_id uuid, device_id uuid, revoked_at timestamp with time zone, expires_at timestamp with time zone, actor_active boolean, actor_role text, actor_name text, must_change_password boolean)',
  auth_session_by_refresh: 'TABLE(session_id uuid, family_id uuid, owner_type text, owner_id uuid, school_id uuid, device_id uuid, client text, expires_at timestamp with time zone, rotated_at timestamp with time zone, revoked_at timestamp with time zone)',
  auth_staff_login: 'TABLE(id uuid, school_id uuid, school_status text, school_deleted boolean, role text, full_name text, password_hash text, pin_hash text, must_change_password boolean, is_active boolean, failed_login_count integer, locked_until timestamp with time zone)',
  create_location_partitions: 'SETOF text',
  drop_location_partitions: 'SETOF text',
  ensure_parent_account: 'uuid',
  location_partition_maintenance: 'TABLE(created text[], dropped text[], default_rows bigint, retention_months integer, school_rows_purged bigint, device_event_coords_purged bigint)',
  location_retention_cutoffs: 'TABLE(school_id uuid, retention_months integer, cutoff timestamp with time zone)',
  notification_clear_parent_tokens: 'integer',
  notification_parent_push_tokens: 'TABLE(parent_account_id uuid, fcm_token text)',
  otp_request: 'TABLE(status text, retry_after_s integer, expires_at timestamp with time zone)',
  otp_verify: 'TABLE(status text, attempts_left integer)',
  parent_children_index: 'TABLE(school_id uuid, student_id uuid)',
  parent_accept_consent: 'TABLE(id uuid, version text, accepted_at timestamp with time zone, privacy_url text, terms_url text)',
  parent_mark_school_used: 'boolean',
  parent_notifications_mark_read: 'integer',
  parent_record_login_failure: 'timestamp with time zone',
  parent_self_password_hash: 'text',
  platform_create_school_admin: 'uuid',
  platform_health_counts: 'TABLE(schools_total bigint, schools_active bigint, schools_suspended bigint, schools_inactive bigint, buses_total bigint, active_trips bigint, trips_last_24h bigint, students_total bigint, parents_total bigint, staff_total bigint)',
  platform_reset_school_admin_password: 'boolean',
  platform_revoke_school_sessions: 'integer',
  platform_school_admins: 'TABLE(id uuid, full_name text, email citext, phone text, is_active boolean, must_change_password boolean, last_login_at timestamp with time zone, created_at timestamp with time zone)',
  public_school_branding: 'TABLE(code text, name text, institution_type text, brand_color text, logo_key text, privacy_url text, terms_url text)',
  school_clear_parent_lockout: 'boolean',
  school_erase_parent_account: 'TABLE(anonymised boolean, revoked_session_ids uuid[])',
  school_legal_terms: 'TABLE(privacy_url text, terms_url text, consent_version text)',
  school_local_date: 'date',
  school_parent_sign_in_state: 'TABLE(parent_account_id uuid, has_signed_in boolean, is_locked boolean)',
  school_parent_used_elsewhere: 'boolean',
  school_redact_parent_consents: 'integer',
  school_timezones: 'TABLE(school_id uuid, timezone text)',
  school_update_parent_phone: 'uuid',
  school_usage_counts: 'TABLE(buses bigint, students bigint, staff bigint, parents bigint, routes bigint, active_trips bigint, trips_last_30_days bigint, last_activity_at timestamp with time zone)',
  session_cleanup: 'TABLE(sessions_deleted integer, otps_deleted integer, idempotency_deleted integer)',
};

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  f = await F.twoSchoolFixture();
});

afterAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  await closeDb();
});

describe('definer catalog', () => {
  it('exposes exactly the allowed result columns, with a fixed search_path', async () => {
    const { rows } = await ownerQuery<{ name: string; result: string; config: string[] | null }>(
      `select p.proname as name, pg_get_function_result(p.oid) as result, p.proconfig as config
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosecdef order by 1`,
    );
    expect(Object.fromEntries(rows.map((r) => [r.name, r.result]))).toEqual(EXPECTED_DEFINERS);
    for (const r of rows) expect(r.config ?? [], r.name).toContain('search_path=public, pg_temp');
  });

  it('only the app role (and the owner) may execute them; owner-only helpers are not executable', async () => {
    const { rows } = await ownerQuery<{ name: string; app: boolean; pub: boolean }>(
      `select p.proname as name, has_function_privilege($1, p.oid, 'EXECUTE') as app,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as pub
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and (p.prosecdef or p.proname like 'apply\\_%')`,
      [TEST_APP_ROLE],
    );
    for (const r of rows) {
      expect(r.pub, `${r.name} must not be executable by PUBLIC`).toBe(false);
      expect(r.app, r.name).toBe(!r.name.startsWith('apply_'));
    }
    await expect(withTenant(sys, (tx) => tx.query("select apply_tenant_rls('buses')"))).rejects.toMatchObject({ code: '42501' });
  });

  it('audit_logs is insert/select-only for the app role', async () => {
    const ctxA = F.contexts.schoolAdmin(f.a.school.id, f.a.admin.id);
    await withTenant(ctxA, (tx) => tx.query("insert into audit_logs (school_id, action) values ($1, 'bus.update')", [f.a.school.id]));
    await expect(withTenant(ctxA, (tx) => tx.query("update audit_logs set action = 'bus.tampered'"))).rejects.toMatchObject({ code: '42501' });
    await expect(withTenant(ctxA, (tx) => tx.query('delete from audit_logs'))).rejects.toMatchObject({ code: '42501' });
  });
});

describe('sessions and logins', () => {
  it('auth_session_actor resolves user, parent and platform sessions (used by authenticate())', async () => {
    const driver = await loadSessionFromDb(f.a.driverSession.id);
    expect(driver).toMatchObject({ ownerType: 'user', ownerId: f.a.driverUser.id, schoolId: f.a.school.id, deviceId: f.a.driverDevice.id, actorActive: true, actorRole: 'driver', actorName: 'Ramesh Kumar', mustChangePassword: false, revokedAt: null });
    expect(driver!.expiresAt).toMatch(/Z$/);
    const p = await F.session({ owner_type: 'parent_account', owner_id: f.sharedParent.id });
    expect(await loadSessionFromDb(p.id)).toMatchObject({ actorRole: 'parent', schoolId: null, actorName: 'Vikram Mehta' });
    const sa = await F.session({ owner_type: 'platform_user', owner_id: f.superAdmin.id });
    expect(await loadSessionFromDb(sa.id)).toMatchObject({ actorRole: 'super_admin', actorName: 'Super Admin' });
    await ownerQuery('update users set is_active = false where id = $1', [f.b.driverUser.id]);
    expect(await loadSessionFromDb(f.b.driverSession.id)).toMatchObject({ actorActive: false });
    expect(await loadSessionFromDb('00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('auth_session_by_refresh finds a session by refresh hash only', async () => {
    const row = await one(sys, 'select * from auth_session_by_refresh($1)', [f.a.driverSession.refresh_hash]);
    expect(row).toMatchObject({ session_id: f.a.driverSession.id, owner_id: f.a.driverUser.id, family_id: f.a.driverSession.family_id });
    expect(await one(sys, "select * from auth_session_by_refresh('nope')")).toBeNull();
  });

  it('login lookups return one minimal row per login type', async () => {
    const pu = await one(sys, 'select * from auth_platform_login($1)', [String(f.superAdmin.email).toUpperCase()]);
    expect(pu).toMatchObject({ id: f.superAdmin.id, totp_enabled: false, password_hash: 'test-hash' });
    const admin = await one(sys, 'select * from auth_school_admin_login($1)', [f.a.admin.email]);
    expect(admin).toMatchObject({ id: f.a.admin.id, school_id: f.a.school.id, school_status: 'active', school_deleted: false });
    const byPhone = await one(sys, 'select * from auth_staff_login($1, $2)', [String(f.a.school.code).toLowerCase(), f.a.driverUser.phone]);
    expect(byPhone).toMatchObject({ id: f.a.driverUser.id, role: 'driver', school_id: f.a.school.id });
    const byUsername = await one(sys, 'select * from auth_staff_login($1, $2)', [f.b.school.code, String(f.b.conductorUser.username).toUpperCase()]);
    expect(byUsername).toMatchObject({ id: f.b.conductorUser.id, role: 'conductor' });
    // School code scopes staff: A's phone with B's code finds nothing; admins never match staff login.
    expect(await one(sys, 'select * from auth_staff_login($1, $2)', [f.b.school.code, f.a.driverUser.phone])).toBeNull();
    expect(await one(sys, 'select * from auth_staff_login($1, $2)', [f.a.school.code, f.a.admin.email])).toBeNull();
    const parent = await one(sys, 'select * from auth_parent_login($1)', [f.sharedParent.phone]);
    expect(parent).toMatchObject({ id: f.sharedParent.id, is_active: true, has_active_link: true });
    expect(await one(sys, "select * from auth_parent_login('+910000000000')")).toBeNull();
  });
});

describe('OTP', () => {
  it('issues, enforces the resend cooldown, verifies once and locks after max attempts', async () => {
    const phone = F.uniquePhone();
    const hash = F.sha256Hex(`otp-${phone}`);
    const issued = await one<{ status: string; retry_after_s: number }>(sys, "select * from otp_request($1, 'parent_login', $2, 300, 30, 3)", [phone, hash]);
    expect(issued).toMatchObject({ status: 'issued', retry_after_s: 0 });
    const again = await one<{ status: string; retry_after_s: number }>(sys, "select * from otp_request($1, 'parent_login', $2, 300, 30, 3)", [phone, F.sha256Hex('other')]);
    expect(again!.status).toBe('cooldown');
    expect(again!.retry_after_s).toBeGreaterThan(0);
    expect(await one(sys, "select * from otp_verify($1, 'parent_login', $2)", [phone, F.sha256Hex('wrong')])).toEqual({ status: 'invalid', attempts_left: 2 });
    expect(await one(sys, "select * from otp_verify($1, 'parent_login', $2)", [phone, hash])).toEqual({ status: 'ok', attempts_left: 1 });
    expect(await one(sys, "select * from otp_verify($1, 'parent_login', $2)", [phone, hash])).toEqual({ status: 'not_found', attempts_left: 0 });

    const phone2 = F.uniquePhone();
    await one(sys, "select * from otp_request($1, 'parent_login', $2, 300, 0, 2)", [phone2, hash]);
    expect(await one(sys, "select * from otp_verify($1, 'parent_login', $2)", [phone2, F.sha256Hex('x')])).toEqual({ status: 'invalid', attempts_left: 1 });
    expect(await one(sys, "select * from otp_verify($1, 'parent_login', $2)", [phone2, F.sha256Hex('y')])).toEqual({ status: 'locked', attempts_left: 0 });
    expect(await one(sys, "select * from otp_verify($1, 'parent_login', $2)", [phone2, hash])).toEqual({ status: 'locked', attempts_left: 0 });
    // A fresh request (cooldown 0) replaces the locked code; expiry is enforced.
    await one(sys, "select * from otp_request($1, 'parent_login', $2, 300, 0, 2)", [phone2, hash]);
    await ownerQuery("update otp_codes set expires_at = now() - interval '1 second' where phone = $1", [phone2]);
    expect(await one(sys, "select * from otp_verify($1, 'parent_login', $2)", [phone2, hash])).toEqual({ status: 'expired', attempts_left: 0 });
    const stored = await ownerQuery<{ code_hash: string }>('select code_hash from otp_codes where phone = $1', [phone]);
    expect(stored.rows[0]!.code_hash).toBe(hash); // only the hash is stored
    await expect(one(sys, "select * from otp_request($1, 'parent_login', 'short', 300, 30, 3)", [phone])).rejects.toMatchObject({ code: '22023' });
  });
});

describe('parents', () => {
  it('parent_children_index lists active links across schools (used by resolveTenant)', async () => {
    const rows = await many<{ school_id: string; student_id: string }>(sys, 'select * from parent_children_index($1) order by school_id', [f.sharedParent.id]);
    expect(rows.map((r) => r.student_id).sort()).toEqual([f.a.student.id, f.b.student.id].sort());
    expect(await parentLinkFromDb(f.sharedParent.id, f.b.school.id)).toBe(true);
    expect(await parentLinkFromDb(f.a.parent.id, f.b.school.id)).toBe(false);
    await ownerQuery('update school_parents set is_active = false where school_id = $1 and parent_account_id = $2', [f.b.school.id, f.sharedParent.id]);
    expect(await parentLinkFromDb(f.sharedParent.id, f.b.school.id)).toBe(false);
    await ownerQuery('update school_parents set is_active = true where school_id = $1 and parent_account_id = $2', [f.b.school.id, f.sharedParent.id]);
  });

  it('ensure_parent_account returns the global identity (creating it once) for school admins only', async () => {
    const ctxB = F.contexts.schoolAdmin(f.b.school.id, f.b.admin.id);
    const existing = await one<{ id: string }>(ctxB, 'select ensure_parent_account($1) as id', [f.a.parent.phone]);
    expect(existing!.id).toBe(f.a.parent.id);
    const phone = F.uniquePhone();
    const created = await one<{ id: string }>(ctxB, "select ensure_parent_account($1, 'Kavya Iyer') as id", [phone]);
    expect((await one<{ id: string }>(ctxB, 'select ensure_parent_account($1) as id', [phone]))!.id).toBe(created!.id);
    // The admin still cannot read the account until the school links it (school_parents).
    expect(await many(ctxB, 'select id from parent_accounts where id = $1', [created!.id])).toEqual([]);
    await expect(one(F.contexts.parent(f.a.parent.id, f.a.school.id), 'select ensure_parent_account($1)', [phone])).rejects.toMatchObject({ code: '42501' });
    await expect(one(F.contexts.superAdmin(f.superAdmin.id), 'select ensure_parent_account($1)', [phone])).rejects.toMatchObject({ code: '42501' });
  });
});

describe('notification push targets (migration 600)', () => {
  it('return only live, trusted phones of parents linked to the caller school, in a school system context only', async () => {
    const phone = (owner: string, token: string, extra: Record<string, unknown> = {}) =>
      F.device({ owner_type: 'parent_account', owner_id: owner, school_id: null, app_name: 'parent_app', fcm_token: token, ...extra });
    const signIn = (owner: string, deviceId: string, extra: Record<string, unknown> = {}) =>
      F.session({ owner_type: 'parent_account', owner_id: owner, school_id: null, device_id: deviceId, ...extra });
    const live = await phone(f.a.parent.id, 'tok-fn-live');
    await signIn(f.a.parent.id, live.id);
    const signedOut = await phone(f.a.parent.id, 'tok-fn-signed-out');
    await signIn(f.a.parent.id, signedOut.id, { revoked_at: new Date().toISOString() });
    const expired = await phone(f.a.parent.id, 'tok-fn-expired');
    await signIn(f.a.parent.id, expired.id, { expires_at: new Date(Date.now() - 60_000).toISOString() });
    const untrusted = await phone(f.a.parent.id, 'tok-fn-untrusted', { is_trusted: false });
    await signIn(f.a.parent.id, untrusted.id);
    await phone(f.a.parent.id, 'tok-fn-never');
    const shared = await phone(f.sharedParent.id, 'tok-fn-shared');
    await signIn(f.sharedParent.id, shared.id);
    const ids = [f.a.parent.id, f.sharedParent.id];
    const tokens = async (schoolId: string) =>
      (await many<{ fcm_token: string }>(F.contexts.system(schoolId), 'select fcm_token from notification_parent_push_tokens($1) order by 1', [ids])).map((r) => r.fcm_token);
    expect(await tokens(f.a.school.id)).toEqual(['tok-fn-live', 'tok-fn-shared']);
    // School B: only the parent linked there.
    expect(await tokens(f.b.school.id)).toEqual(['tok-fn-shared']);
    for (const ctx of [F.contexts.schoolAdmin(f.a.school.id, f.a.admin.id), F.contexts.parent(f.a.parent.id, f.a.school.id), F.contexts.system(null), F.contexts.superAdmin(f.superAdmin.id)]) {
      await expect(many(ctx, 'select * from notification_parent_push_tokens($1)', [ids])).rejects.toMatchObject({ code: '42501' });
      await expect(one(ctx, 'select notification_clear_parent_tokens($1)', [['tok-fn-live']])).rejects.toMatchObject({ code: '42501' });
    }
    // Pruning from school B cannot touch a phone of a parent who is linked only in school A.
    expect((await one<{ n: number }>(F.contexts.system(f.b.school.id), 'select notification_clear_parent_tokens($1) as n', [['tok-fn-live']]))!.n).toBe(0);
    expect((await one<{ n: number }>(F.contexts.system(f.a.school.id), 'select notification_clear_parent_tokens($1) as n', [['tok-fn-live']]))!.n).toBe(1);
    expect((await ownerQuery('select fcm_token from devices where id = $1', [live.id])).rows[0]).toEqual({ fcm_token: null });
  });
});

describe('worker and platform helpers', () => {
  it('active_school_ids / school_timezones skip suspended and deleted schools', async () => {
    const suspended = await F.school({ status: 'suspended', timezone: 'Asia/Dubai' });
    const ids = (await many<{ id: string }>(sys, 'select id from active_school_ids() as id')).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([f.a.school.id, f.b.school.id]));
    expect(ids).not.toContain(suspended.id);
    const tz = await loadSchoolTimezones();
    expect(tz).toEqual(expect.arrayContaining([{ schoolId: f.a.school.id, timezone: 'Asia/Kolkata' }]));
    expect(tz.map((t) => t.schoolId)).not.toContain(suspended.id);
  });

  it('platform_health_counts / school_usage_counts return counts for super admins only', async () => {
    const sa = F.contexts.superAdmin(f.superAdmin.id);
    const counts = await one<Record<string, number>>(sa, 'select * from platform_health_counts()');
    expect(counts).toMatchObject({ active_trips: 4, buses_total: 4 });
    expect(counts!.schools_total).toBeGreaterThanOrEqual(2);
    const usage = await one<Record<string, unknown>>(sa, 'select * from school_usage_counts($1)', [f.a.school.id]);
    expect(usage).toMatchObject({ buses: 2, students: 2, staff: 3, parents: 2, routes: 2, active_trips: 2 });
    await expect(one(F.contexts.schoolAdmin(f.a.school.id, f.a.admin.id), 'select * from platform_health_counts()')).rejects.toMatchObject({ code: '42501' });
    await expect(one(F.contexts.parent(f.a.parent.id, null), 'select * from school_usage_counts($1)', [f.a.school.id])).rejects.toMatchObject({ code: '42501' });
  });

  it('super admins create and reset a school’s admins (sessions revoked) — nothing else', async () => {
    const sa = F.contexts.superAdmin(f.superAdmin.id);
    const id = (await one<{ id: string }>(sa, "select platform_create_school_admin($1, 'Second Admin', $2, 'hash-2') as id", [f.a.school.id, `second-${F.nextSeq()}@school.test`]))!.id;
    const admins = await many<{ id: string; must_change_password: boolean }>(sa, 'select * from platform_school_admins($1)', [f.a.school.id]);
    expect(admins.map((a) => a.id)).toEqual([f.a.admin.id, id]);
    expect(admins[1]!.must_change_password).toBe(true);
    const s = await F.session({ owner_type: 'user', owner_id: id, school_id: f.a.school.id });
    expect(await one(sa, "select platform_reset_school_admin_password($1, $2, 'hash-3') as ok", [f.a.school.id, id])).toEqual({ ok: true });
    const { rows } = await ownerQuery<{ revoked_reason: string }>('select revoked_reason from sessions where id = $1', [s.id]);
    expect(rows[0]!.revoked_reason).toBe('password_reset');
    // Drivers are not school admins: the reset refuses them.
    expect(await one(sa, "select platform_reset_school_admin_password($1, $2, 'x') as ok", [f.a.school.id, f.a.driverUser.id])).toEqual({ ok: false });
    await expect(one(F.contexts.schoolAdmin(f.a.school.id, f.a.admin.id), "select platform_create_school_admin($1, 'x', 'x@y.z', 'h')", [f.a.school.id])).rejects.toMatchObject({ code: '42501' });
  });

  it('platform_revoke_school_sessions and session_cleanup', async () => {
    const sa = F.contexts.superAdmin(f.superAdmin.id);
    const n = await one<{ n: number }>(sa, 'select platform_revoke_school_sessions($1) as n', [f.b.school.id]);
    expect(n!.n).toBeGreaterThanOrEqual(1);
    await F.session({ owner_type: 'parent_account', owner_id: f.a.parent.id, expires_at: new Date(Date.now() - 40 * 86_400_000).toISOString() });
    await F.otpCode({ expires_at: new Date(Date.now() - 3 * 86_400_000).toISOString() });
    await F.idempotencyKey({ actor_id: f.a.parent.id, expires_at: new Date(Date.now() - 1000).toISOString() });
    const cleaned = await one<Record<string, number>>(sys, 'select * from session_cleanup()');
    expect(cleaned!.sessions_deleted).toBeGreaterThanOrEqual(1);
    expect(cleaned!.otps_deleted).toBeGreaterThanOrEqual(1);
    expect(cleaned!.idempotency_deleted).toBeGreaterThanOrEqual(1);
    await expect(one(sa, 'select * from session_cleanup()')).rejects.toMatchObject({ code: '42501' });
  });

  it('min supported versions are readable by the version gate', async () => {
    expect(await loadMinVersionsFromDb()).toEqual({ driver_app: '1.0.0', parent_app: '1.0.0' });
  });
});

describe('location partitions', () => {
  it('create_location_partitions is idempotent and secures every new partition', async () => {
    const created = await many<{ name: string }>(sys, "select create_location_partitions('2031-01-15', 2) as name");
    expect(created.map((r) => r.name)).toEqual(['location_points_2031_01', 'location_points_2031_02']);
    expect(await many(sys, "select create_location_partitions('2031-01-01', 2) as name")).toEqual([]);
    const { rows } = await ownerQuery<{ rls: boolean; force: boolean; policies: string[]; bound: string }>(
      `select c.relrowsecurity as rls, c.relforcerowsecurity as force, pg_get_expr(c.relpartbound, c.oid) as bound,
              array(select polname::text from pg_policy where polrelid = c.oid order by 1) as policies
         from pg_class c where c.relname = 'location_points_2031_01'`,
    );
    expect(rows[0]).toMatchObject({ rls: true, force: true, policies: ['definer_access', 'parent_no_delete', 'parent_scope', 'tenant_isolation'] });
    const utc = await ownerQuery<{ lo: string }>("select ('2031-01-01 00:00:00+00'::timestamptz = (regexp_match($1, '''([^'']+)'''))[1]::timestamptz)::text as lo", [rows[0]!.bound]);
    expect(utc.rows[0]!.lo).toBe('true');
    // Points of that month land in the new partition and stay tenant-isolated.
    await ownerQuery("insert into location_points (school_id, trip_id, recorded_at, latitude, longitude) values ($1, $2, '2031-01-20T10:00:00Z', 12.9, 77.6)", [f.a.school.id, f.a.trip.id]);
    expect(await many(F.contexts.schoolAdmin(f.b.school.id, f.b.admin.id), 'select 1 from location_points_2031_01')).toEqual([]);
    expect(await many(F.contexts.schoolAdmin(f.a.school.id, f.a.admin.id), 'select 1 from location_points_2031_01')).toHaveLength(1);
    await expect(one(F.contexts.schoolAdmin(f.a.school.id, f.a.admin.id), "select create_location_partitions('2032-01-01', 1)")).rejects.toMatchObject({ code: '42501' });
  });

  it('drop_location_partitions drops expired months only and never the current month', async () => {
    await many(sys, "select create_location_partitions('2020-01-01', 2) as name");
    expect(await many(sys, "select drop_location_partitions('2020-02-01') as name")).toEqual([{ name: 'location_points_2020_01' }]);
    expect(await many(sys, "select drop_location_partitions('2020-03-01') as name")).toEqual([{ name: 'location_points_2020_02' }]);
    await expect(one(sys, "select drop_location_partitions((current_date + interval '1 month')::date)")).rejects.toMatchObject({ code: '22023' });
    await expect(many(sys, "select drop_location_partitions('2031-03-01')")).rejects.toMatchObject({ code: '22023' }); // future cut-offs refused
    const left = await ownerQuery<{ n: number }>("select count(*)::int as n from pg_class where relname in ('location_points_2031_01', 'location_points_2031_02')");
    expect(left.rows[0]!.n).toBe(2);
    await ownerQuery('drop table location_points_2031_01, location_points_2031_02');
  });

  it('runs through the app role (getAppPool) without a tenant context', async () => {
    const { rows } = await getAppPool().query<{ n: number }>('select count(*)::int as n from school_timezones()');
    expect(rows[0]!.n).toBeGreaterThanOrEqual(2);
  });
});
