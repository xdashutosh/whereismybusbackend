// App-role provisioning (contract §3). Run as the OWNER after every migration batch:
//   npm run db:setup-roles [-- --test]
// Creates (or aligns) the runtime role from DB_APP_USER/DB_APP_PASSWORD (or the user/password of
// DATABASE_APP_URL) as LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION, then
// grants — generically, for whatever tables the migrations created:
//   CONNECT on the database, USAGE on schema public
//   SELECT, INSERT, UPDATE, DELETE on every table (never TRUNCATE/REFERENCES/TRIGGER)
//   INSERT + SELECT only on audit_logs (insert-only audit trail, BP §6.2)
//   SELECT only on schema_migrations (readiness probe)
//   SELECT only on tables that belong to extensions (PostGIS spatial_ref_sys)
//   column-level SELECT/UPDATE only on parent_accounts (COLUMN_RESTRICTED_TABLES): the global parent
//   identity's password hash, lockout counters and global last sign-in are never readable by the
//   app role; flows that need them go through SECURITY DEFINER functions (migration 015)
//   USAGE, SELECT on every sequence; EXECUTE on every function/procedure except the owner-only
//   migration helpers (OWNER_ONLY_ROUTINES); SECURITY DEFINER functions are additionally revoked
//   from PUBLIC so only the app role (and the owner) can call them
//   default privileges for objects the owner creates later (tables, sequences, routines)
// REFUSES an app role that is a member of any other role (directly or transitively): membership
// would grant privileges these GRANTs cannot take away (e.g. pg_write_all_data → UPDATE/DELETE on
// audit_logs, the owner or a hosted-console superuser group → SET ROLE past FORCE RLS). Let
// db:setup-roles create the app role itself instead of creating it in the Neon console.
// Everything runs in one transaction; secrets are never logged.
import config, { type DbConnection } from '../config/index.js';
import { logger as rootLogger, type Logger } from '../shared/logger.js';
import { isMainModule } from './cli.js';
import { createPool, type Pool, type PoolClient } from './pool.js';

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
/** Tables with narrower grants than the default four privileges. */
export const RESTRICTED_TABLES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  audit_logs: ['SELECT', 'INSERT'],
  schema_migrations: ['SELECT'],
});
/**
 * Tables the app role may read/update only column by column (no INSERT/DELETE: rows are created by
 * SECURITY DEFINER functions). Columns not listed — and any column added later — stay unreadable.
 */
export const COLUMN_RESTRICTED_TABLES: Readonly<Record<string, { select: readonly string[]; update: readonly string[] }>> = Object.freeze({
  parent_accounts: {
    select: ['id', 'phone', 'display_name', 'preferred_language', 'is_active', 'created_at', 'updated_at'],
    // Mirrors parent_accounts_guard (migration 014); RLS lets only the parent's own context update.
    update: ['display_name', 'preferred_language', 'password_hash', 'failed_login_count', 'locked_until', 'last_login_at', 'updated_at'],
  },
});
/** Migration helpers (schema DDL) the app role must never execute. */
export const OWNER_ONLY_ROUTINES: readonly string[] = Object.freeze([
  'apply_updated_at',
  'apply_definer_access',
  'apply_tenant_rls',
  'apply_platform_rls',
  'apply_parent_scope',
]);

export interface SetupRolesOptions {
  /** Owner connection pool (or `conn` to create a temporary one). */
  pool?: Pool;
  conn?: DbConnection | null;
  appUser: string;
  /** Required when the role does not exist yet; optional otherwise (password unchanged). */
  appPassword?: string | null;
  logger?: Logger;
}

export interface SetupRolesResult {
  role: string;
  created: boolean;
  attributesChanged: string[];
  tables: number;
  sequences: number;
  routines: number;
}

interface RoleRow {
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcanlogin: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolreplication: boolean;
}

/** Credentials of an app connection descriptor (user + password, from fields or URL). */
export function appCredentials(conn: DbConnection | null): { user: string | null; password: string | null } {
  if (!conn) return { user: null, password: null };
  if (conn.connectionString) {
    try {
      const u = new URL(conn.connectionString);
      return { user: decodeURIComponent(u.username) || null, password: u.password ? decodeURIComponent(u.password) : null };
    } catch {
      return { user: conn.user, password: null };
    }
  }
  return { user: conn.user, password: conn.password ?? null };
}

async function ensureRole(client: PoolClient, appUser: string, appPassword: string | null | undefined): Promise<{ created: boolean; changed: string[] }> {
  const role = client.escapeIdentifier(appUser);
  const passwordClause = appPassword ? ` PASSWORD ${client.escapeLiteral(appPassword)}` : '';
  const existing = await client.query<RoleRow>(
    'select rolsuper, rolbypassrls, rolcanlogin, rolcreatedb, rolcreaterole, rolreplication from pg_roles where rolname = $1',
    [appUser],
  );
  const row = existing.rows[0];
  if (!row) {
    if (!appPassword) throw new Error(`Role "${appUser}" does not exist and no password was provided (DB_APP_PASSWORD)`);
    await client.query('SAVEPOINT wimb_create_role');
    try {
      await client.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION${passwordClause}`);
      await client.query('RELEASE SAVEPOINT wimb_create_role');
      return { created: true, changed: [] };
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT wimb_create_role');
      // 42710 duplicate_object: created concurrently (another runner on the same cluster).
      if ((err as { code?: string }).code !== '42710') throw err;
    }
    return ensureRole(client, appUser, appPassword);
  }
  // Only attributes that differ are altered (changing BYPASSRLS/SUPERUSER needs those privileges).
  const changes: string[] = [];
  if (row.rolsuper) changes.push('NOSUPERUSER');
  if (row.rolbypassrls) changes.push('NOBYPASSRLS');
  if (!row.rolcanlogin) changes.push('LOGIN');
  if (row.rolcreatedb) changes.push('NOCREATEDB');
  if (row.rolcreaterole) changes.push('NOCREATEROLE');
  if (row.rolreplication) changes.push('NOREPLICATION');
  if (changes.length || appPassword) await client.query(`ALTER ROLE ${role} ${changes.join(' ')}${passwordClause}`);
  return { created: false, changed: changes };
}

/** Every role the app role is a member of (directly or through other roles). */
export async function inheritedRoles(client: Pick<PoolClient, 'query'>, appUser: string): Promise<string[]> {
  const { rows } = await client.query<{ rolname: string }>(
    `select r.rolname from pg_roles r
      where r.rolname <> $1 and pg_has_role($1, r.oid, 'MEMBER')
      order by r.rolname`,
    [appUser],
  );
  return rows.map((r) => r.rolname);
}

async function countObjects(client: PoolClient) {
  const { rows } = await client.query<{ tables: number; sequences: number; routines: number }>(
    `select (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')) as tables,
            (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relkind = 'S') as sequences,
            (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public') as routines`,
  );
  return rows[0]!;
}

/** Creates/aligns the app role and (re)applies every grant. */
export async function setupAppRole({ pool, conn, appUser, appPassword, logger = rootLogger.child({ module: 'setup-roles' }) }: SetupRolesOptions): Promise<SetupRolesResult> {
  if (!IDENT_RE.test(appUser)) throw new Error('App role name must be a plain identifier (letters, digits, underscore)');
  const p = pool ?? createPool(conn ?? config.db.owner, { max: 1, applicationName: 'whereismybus-setup-roles' });
  const client = await p.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const me = await client.query<{ current_user: string; db: string }>('select current_user, current_database() as db');
    const owner = me.rows[0]!.current_user;
    if (owner === appUser) throw new Error('The app role must differ from the owner role that runs migrations');
    const { created, changed } = await ensureRole(client, appUser, appPassword);
    const memberOf = await inheritedRoles(client, appUser);
    if (memberOf.length) {
      throw new Error(
        `Refusing to provision "${appUser}": it is a member of ${memberOf.map((r) => `"${r}"`).join(', ')}, which grants privileges ` +
          'beyond the app-role contract (row level security / insert-only audit_logs). Revoke those memberships ' +
          '(REVOKE <role> FROM <app role>) or let db:setup-roles create a fresh app role.',
      );
    }
    const role = client.escapeIdentifier(appUser);
    const ownerIdent = client.escapeIdentifier(owner);
    const statements = [
      `GRANT CONNECT ON DATABASE ${client.escapeIdentifier(me.rows[0]!.db)} TO ${role}`,
      `GRANT USAGE ON SCHEMA public TO ${role}`,
      `REVOKE CREATE ON SCHEMA public FROM ${role}`,
      `REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM ${role}`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`,
      `REVOKE UPDATE ON ALL SEQUENCES IN SCHEMA public FROM ${role}`,
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`,
      `GRANT EXECUTE ON ALL ROUTINES IN SCHEMA public TO ${role}`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerIdent} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerIdent} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${role}`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerIdent} IN SCHEMA public GRANT EXECUTE ON ROUTINES TO ${role}`,
    ];
    for (const sql of statements) await client.query(sql);
    // Extension-owned tables (PostGIS spatial_ref_sys): read-only for the app role.
    const extTables = await client.query<{ t: string }>(
      `select format('%I.%I', n.nspname, c.relname) as t
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         join pg_depend d on d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e'
        where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')`,
    );
    for (const { t } of extTables.rows) await client.query(`REVOKE INSERT, UPDATE, DELETE ON ${t} FROM ${role}`);
    // Owner-only migration helpers; SECURITY DEFINER functions callable by the app role only.
    const routines = await client.query<{ sig: string; name: string; definer: boolean }>(
      `select p.oid::regprocedure::text as sig, p.proname as name, p.prosecdef as definer
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')`,
    );
    for (const r of routines.rows) {
      if (OWNER_ONLY_ROUTINES.includes(r.name)) {
        await client.query(`REVOKE ALL ON ROUTINE ${r.sig} FROM PUBLIC, ${role}`);
      } else if (r.definer) {
        await client.query(`REVOKE ALL ON ROUTINE ${r.sig} FROM PUBLIC`);
        await client.query(`GRANT EXECUTE ON ROUTINE ${r.sig} TO ${role}`);
      }
    }
    for (const [table, privileges] of Object.entries(RESTRICTED_TABLES)) {
      const exists = await client.query<{ present: boolean }>('select to_regclass($1) is not null as present', [`public.${table}`]);
      if (!exists.rows[0]?.present) continue;
      const t = `public.${client.escapeIdentifier(table)}`;
      await client.query(`REVOKE ALL ON ${t} FROM ${role}`);
      await client.query(`GRANT ${privileges.join(', ')} ON ${t} TO ${role}`);
    }
    for (const [table, cols] of Object.entries(COLUMN_RESTRICTED_TABLES)) {
      const exists = await client.query<{ present: boolean }>('select to_regclass($1) is not null as present', [`public.${table}`]);
      if (!exists.rows[0]?.present) continue;
      const t = `public.${client.escapeIdentifier(table)}`;
      const list = (names: readonly string[]) => names.map((c) => client.escapeIdentifier(c)).join(', ');
      // REVOKE on the table also removes earlier column grants, so re-runs converge.
      await client.query(`REVOKE ALL ON ${t} FROM ${role}`);
      await client.query(`GRANT SELECT (${list(cols.select)}) ON ${t} TO ${role}`);
      await client.query(`GRANT UPDATE (${list(cols.update)}) ON ${t} TO ${role}`);
    }
    const counts = await countObjects(client);
    await client.query('COMMIT');
    const result: SetupRolesResult = { role: appUser, created, attributesChanged: changed, ...counts };
    logger.info(result, 'App role provisioned');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true;
    }
    throw err;
  } finally {
    client.release(broken);
    if (!pool) await p.end();
  }
}

async function cli(argv: string[]): Promise<number> {
  const pair = argv.includes('--test') ? config.testDb : config.db;
  if (!pair.owner) throw new Error('Owner database connection is not configured');
  if (!pair.app || pair.appIsOwnerFallback) throw new Error('App role is not configured: set DB_APP_USER/DB_APP_PASSWORD or DATABASE_APP_URL');
  const { user, password } = appCredentials(pair.app);
  if (!user) throw new Error('App role name could not be determined');
  console.log(`Provisioning app role on ${pair.owner.database} (${pair.owner.source}) …`);
  const r = await setupAppRole({ conn: pair.owner, appUser: user, appPassword: password });
  console.log(
    `${r.created ? 'Created' : 'Updated'} role ${r.role}${r.attributesChanged.length ? ` (${r.attributesChanged.join(' ')})` : ''}; ` +
      `grants applied to ${r.tables} table(s), ${r.sequences} sequence(s), ${r.routines} routine(s).`,
  );
  return 0;
}

if (isMainModule(import.meta.url)) {
  cli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error('Role setup failed:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    },
  );
}
