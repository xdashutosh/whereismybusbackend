// Fresh database, Neon-like roles: the migrations run as a NON-superuser, NOBYPASSRLS owner (like
// neondb_owner) and the API as a separate app role. Proves on a database the main suite did not
// touch that: migrations apply from scratch and are idempotent; FORCE RLS binds the owner too
// (maintenance mode only with actor_role 'system'); SECURITY DEFINER functions work through the
// definer_access policies; new partitions created by the worker are owned by the owner and secured.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import config, { type DbConnection } from '../src/config/index.js';
import { migrate, loadMigrations } from '../src/db/migrate.js';
import { createPool, type Pool } from '../src/db/pool.js';
import { setupAppRole } from '../src/db/setupRoles.js';
import { withTenant, type TenantContext } from '../src/db/tenant.js';
import { maintenanceConnection } from './helpers/db.js';

const base = config.db.owner!;
const DB = `${base.database}_owner`;
const OWNER = 'wimb_test_schema_owner';
const APP = 'wimb_test_schema_app';
const PASSWORD = 'wimb-test-schema-local-only';

function connAs(user: string): DbConnection {
  const url = new URL(base.connectionString ?? `postgresql://${base.host}:${base.port}/${base.database}`);
  url.username = user;
  url.password = PASSWORD;
  url.pathname = `/${DB}`;
  return { ...base, connectionString: url.toString(), user, password: PASSWORD, database: DB };
}

async function superuser<T>(database: string | null, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const target = maintenanceConnection(base) as { connectionString?: string } & Record<string, unknown>;
  let opts: Record<string, unknown> = target;
  if (database && target.connectionString) {
    const url = new URL(target.connectionString);
    url.pathname = `/${database}`;
    opts = { connectionString: url.toString() };
  } else if (database) {
    opts = { ...target, database };
  }
  const c = new pg.Client(opts);
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

let ownerPool: Pool;
let appPool: Pool;
const ownerTx = <T>(ctx: TenantContext, fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctx, fn, { pool: ownerPool });
const appTx = <T>(ctx: TenantContext, fn: Parameters<typeof withTenant<T>>[1]) => withTenant(ctx, fn, { pool: appPool });
const system: TenantContext = { schoolId: null, actorId: null, role: 'system' };
const ids: Record<string, string> = {};

beforeAll(async () => {
  await superuser(null, async (c) => {
    await c.query(`drop database if exists ${c.escapeIdentifier(DB)} with (force)`);
    for (const role of [OWNER, APP]) {
      await c.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${role}') then create role ${role} login; end if; end $$`);
      await c.query(`alter role ${role} login nosuperuser nobypassrls nocreatedb nocreaterole password '${PASSWORD}'`);
    }
    await c.query(`create database ${c.escapeIdentifier(DB)} owner ${OWNER}`);
  });
  // Extensions need a superuser locally (Neon lets its owner create them); the migrations'
  // CREATE EXTENSION IF NOT EXISTS then finds them installed.
  await superuser(DB, (c) => c.query('create extension if not exists pgcrypto; create extension if not exists citext; create extension if not exists btree_gist; create extension if not exists postgis;'));
  ownerPool = createPool(connAs(OWNER), { max: 2, applicationName: 'wimb-test-owner' });
  appPool = createPool(connAs(APP), { max: 2, applicationName: 'wimb-test-owner-app' });
});

afterAll(async () => {
  await ownerPool?.end();
  await appPool?.end();
  await superuser(null, async (c) => {
    await c.query(`drop database if exists ${c.escapeIdentifier(DB)} with (force)`);
    await c.query(`drop role if exists ${APP}`);
    await c.query(`drop role if exists ${OWNER}`);
  });
});

describe('fresh database with a non-superuser owner', () => {
  it('applies every migration once and is idempotent', async () => {
    const all = await loadMigrations();
    const first = await migrate({ pool: ownerPool });
    expect(first.applied).toEqual(all.map((m) => m.id));
    expect(await migrate({ pool: ownerPool })).toEqual({ applied: [], alreadyApplied: all.length });
    // The role already exists with the right attributes (no CREATEROLE needed for the grants).
    const r = await setupAppRole({ pool: ownerPool, appUser: APP });
    expect(r.created).toBe(false);
    const owners = await ownerPool.query<{ n: number }>("select count(*)::int as n from pg_tables where schemaname = 'public' and tableowner <> $1 and tablename <> 'spatial_ref_sys'", [OWNER]);
    expect(owners.rows[0]!.n).toBe(0);
  });

  it('FORCE RLS binds the owner: no context → zero rows and no writes; system → maintenance mode', async () => {
    await expect(ownerPool.query("insert into schools (code, name) values ('OWNER-NOCTX', 'x')")).rejects.toMatchObject({ code: '42501' });
    const school = await ownerTx(system, (tx) => tx.one<{ id: string }>("insert into schools (code, name, timezone) values ('OWNER-A', 'Owner School', 'Asia/Kolkata') returning id"));
    ids.school = school.id;
    expect((await ownerPool.query('select id from schools')).rowCount).toBe(0);
    // The settings trigger worked under RLS and the owner wrote tenant rows in maintenance mode.
    await ownerTx(system, async (tx) => {
      expect((await tx.one<{ n: number }>('select count(*)::int as n from school_settings where school_id = $1', [school.id])).n).toBe(1);
      ids.admin = (await tx.one<{ id: string }>("insert into users (school_id, role, full_name, email, password_hash) values ($1, 'school_admin', 'Owner Admin', 'owner-admin@school.test', 'h') returning id", [school.id])).id;
      ids.driver = (await tx.one<{ id: string }>("insert into users (school_id, role, full_name, phone, password_hash) values ($1, 'driver', 'Owner Driver', '+919900000001', 'h') returning id", [school.id])).id;
      ids.parent = (await tx.one<{ id: string }>("insert into parent_accounts (phone) values ('+919900000002') returning id")).id;
      await tx.query("insert into school_parents (school_id, parent_account_id, full_name) values ($1, $2, 'Owner Parent')", [school.id, ids.parent]);
      ids.student = (await tx.one<{ id: string }>("insert into students (school_id, full_name) values ($1, 'Owner Child') returning id", [school.id])).id;
      await tx.query('insert into student_parents (school_id, student_id, parent_account_id) values ($1, $2, $3)', [school.id, ids.student, ids.parent]);
      ids.session = (await tx.one<{ id: string }>("insert into sessions (owner_type, owner_id, school_id, family_id, refresh_hash, expires_at) values ('user', $1, $2, gen_random_uuid(), 'owner-refresh', now() + interval '1 day') returning id", [ids.driver, school.id])).id;
      await tx.query("insert into platform_users (email, name, password_hash) values ('owner-sa@platform.test', 'Owner SA', 'h')");
    });
    // In a school context (not system) the owner is an ordinary tenant: other schools stay invisible.
    expect((await ownerTx({ schoolId: school.id, actorId: null, role: 'school_admin' }, (tx) => tx.many('select id from parent_accounts'))).length).toBe(1);
  });

  it('the app role reaches rows only through tenant context and the SECURITY DEFINER functions', async () => {
    expect((await appPool.query('select id from users')).rowCount).toBe(0);
    const login = await appPool.query('select * from auth_school_admin_login($1)', ['OWNER-ADMIN@school.test']);
    expect(login.rows[0]).toMatchObject({ id: ids.admin, school_id: ids.school, school_status: 'active' });
    expect((await appPool.query("select id from auth_staff_login('owner-a', '+919900000001')")).rows).toEqual([{ id: ids.driver }]);
    expect((await appPool.query("select has_active_link from auth_parent_login('+919900000002')")).rows).toEqual([{ has_active_link: true }]);
    expect((await appPool.query('select id from auth_platform_login($1)', ['owner-sa@platform.test'])).rowCount).toBe(1);
    expect((await appPool.query('select actor_role, actor_name from auth_session_actor($1)', [ids.session])).rows).toEqual([{ actor_role: 'driver', actor_name: 'Owner Driver' }]);
    expect((await appPool.query("select session_id from auth_session_by_refresh('owner-refresh')")).rows).toEqual([{ session_id: ids.session }]);
    expect((await appPool.query('select student_id from parent_children_index($1)', [ids.parent])).rows).toEqual([{ student_id: ids.student }]);
    expect((await appPool.query('select school_id from school_timezones()')).rows).toEqual([{ school_id: ids.school }]);
    expect((await appPool.query('select * from active_school_ids()')).rowCount).toBe(1);
  });

  it('platform, parent, OTP, cleanup and partition functions work under FORCE RLS', async () => {
    const sa: TenantContext = { schoolId: null, actorId: null, role: 'super_admin' };
    const counts = await appTx(sa, (tx) => tx.one<{ schools_total: number }>('select * from platform_health_counts()'));
    expect(counts.schools_total).toBe(1);
    const second = await appTx(sa, (tx) => tx.one<{ id: string }>("select platform_create_school_admin($1, 'Second', 'second-owner@school.test', 'h') as id", [ids.school]));
    expect(await appTx(sa, (tx) => tx.one("select platform_reset_school_admin_password($1, $2, 'h2') as ok", [ids.school, second.id]))).toEqual({ ok: true });
    expect((await appTx(sa, (tx) => tx.many('select id from platform_school_admins($1)', [ids.school]))).length).toBe(2);
    expect(await appTx(sa, (tx) => tx.one('select platform_revoke_school_sessions($1) as n', [ids.school]))).toEqual({ n: 1 });

    const adminCtx: TenantContext = { schoolId: ids.school!, actorId: ids.admin!, role: 'school_admin' };
    const pid = await appTx(adminCtx, (tx) => tx.one<{ id: string }>("select ensure_parent_account('+919900000003') as id"));
    expect(pid.id).toMatch(/^[0-9a-f-]{36}$/);

    expect(await appTx(system, (tx) => tx.one("select status from otp_request('+919900000002', 'parent_login', repeat('a', 64), 300, 30, 5)"))).toEqual({ status: 'issued' });
    expect(await appTx(system, (tx) => tx.one("select status from otp_verify('+919900000002', 'parent_login', repeat('a', 64))"))).toEqual({ status: 'ok' });
    expect(await appTx(system, (tx) => tx.one('select sessions_deleted from session_cleanup()'))).toEqual({ sessions_deleted: 0 });

    const parentCtx: TenantContext = { schoolId: null, actorId: ids.parent!, role: 'parent' };
    expect(await appTx(parentCtx, (tx) => tx.one('select parent_notifications_mark_read() as n'))).toEqual({ n: 0 });

    const made = await appTx(system, (tx) => tx.many<{ name: string }>("select create_location_partitions('2033-05-01', 1) as name"));
    expect(made).toEqual([{ name: 'location_points_2033_05' }]);
    const part = await ownerPool.query<{ owner: string; force: boolean }>("select pg_get_userbyid(relowner) as owner, relforcerowsecurity as force from pg_class where relname = 'location_points_2033_05'");
    expect(part.rows[0]).toEqual({ owner: OWNER, force: true });
    expect(await appTx(system, (tx) => tx.many("select drop_location_partitions('2020-01-01') as name"))).toEqual([]);
  });
});
