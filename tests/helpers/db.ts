// Test database helpers.
//   ownerQuery(sql, params)   runs a statement as the OWNER (fixtures, schema probes)
//   appPool()                 the runtime pool (RLS-restricted test app role)
//   truncateAll({ keep })     empties every application table (one statement) — never
//                             schema_migrations, extension tables (PostGIS spatial_ref_sys) or `keep`
//   closeDb()                 closes every pool (afterAll)
//   maintenanceConnection()   `postgres` database of the server behind a connection descriptor
import type { DbConnection } from '../../src/config/index.js';
import config from '../../src/config/index.js';
import { closePools, getAppPool, getOwnerPool, type QueryResultRow } from '../../src/db/pool.js';

export function maintenanceConnection(conn: DbConnection): Record<string, unknown> {
  if (conn.connectionString) {
    const url = new URL(conn.connectionString);
    url.pathname = '/postgres';
    return { connectionString: url.toString() };
  }
  return { host: conn.host, port: conn.port, user: conn.user ?? undefined, password: conn.password, ssl: conn.ssl ?? false, database: 'postgres' };
}

function assertTestDb(): void {
  const name = config.db.owner?.database ?? '';
  if (!config.isTest || !name.toLowerCase().includes('test')) throw new Error(`Refused: not a test database (${name || 'unconfigured'})`);
}

export async function ownerQuery<R extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) {
  assertTestDb();
  return getOwnerPool().query<R>(sql, params);
}

export function appPool() {
  assertTestDb();
  return getAppPool();
}

export async function truncateAll({ keep = [] }: { keep?: readonly string[] } = {}): Promise<void> {
  assertTestDb();
  const { rows } = await ownerQuery<{ t: string }>(
    `select quote_ident(c.relname) as t
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
        and c.relname <> 'schema_migrations' and c.relname <> all ($1::text[])
        and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')`,
    [keep],
  );
  if (rows.length) await ownerQuery(`truncate table ${rows.map((r) => r.t).join(', ')} restart identity cascade`);
}

export async function closeDb(): Promise<void> {
  await closePools();
}
