// Migration runner (contract §3). Runs as the OWNER role.
// - Applies migrations/NNN_name.sql in lexical order, each in its own transaction.
// - Runners are serialised with pg_advisory_xact_lock (transaction-scoped → PgBouncer-safe);
//   schema_migrations is re-checked after the lock, so concurrent runners never apply twice.
// - An applied file whose checksum changed is a hard error (write a new migration instead).
// - Files must not contain transaction control or CONCURRENTLY (one transaction per file).
// CLI: tsx src/db/migrate.ts up|status [--test]
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import config, { ROOT_DIR, type DbConnection } from '../config/index.js';
import { logger as rootLogger, type Logger } from '../shared/logger.js';
import { isMainModule } from './cli.js';
import { createPool, type Pool, type PoolClient } from './pool.js';

export const MIGRATIONS_DIR = path.join(ROOT_DIR, 'migrations');
/** Advisory lock key shared by every migration runner of this application. */
export const MIGRATION_LOCK_KEY = 727274001;
const FILE_PATTERN = /^(\d{3})_[a-z0-9_]+\.sql$/;

export class MigrationError extends Error {
  readonly migrationId: string | undefined;
  constructor(message: string, { id, cause }: { id?: string; cause?: unknown } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'MigrationError';
    this.migrationId = id;
  }
}

export interface Migration {
  id: string;
  file: string;
  sql: string;
  checksum: string;
}

export type MigrationState = 'applied' | 'pending' | 'checksum_mismatch' | 'missing_file';

const CREATE_TABLE_SQL = `
  create table if not exists schema_migrations (
    id         text primary key,
    checksum   text not null,
    applied_at timestamptz not null default now()
  )`;

export function checksumOf(sql: string): string {
  return crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

function assertTransactionSafe(id: string, sql: string): void {
  const stripped = sql.replace(/--[^\n]*/g, '');
  if (/^\s*(begin|commit|rollback|start\s+transaction)\s*;/im.test(stripped)) {
    throw new MigrationError(`${id}: must not contain transaction control statements (the runner wraps each file in a transaction)`, { id });
  }
  if (/\bconcurrently\b/i.test(stripped)) throw new MigrationError(`${id}: CONCURRENTLY cannot run inside a transaction`, { id });
}

/** Lists migration files in lexical order (missing directory = no migrations). */
export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<Migration[]> {
  let entries: string[];
  try {
    entries = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const seen = new Map<string, string>();
  const out: Migration[] = [];
  for (const file of entries) {
    const m = FILE_PATTERN.exec(file);
    if (!m) throw new MigrationError(`Invalid migration file name "${file}" (expected NNN_snake_case.sql)`);
    const num = m[1]!;
    const prior = seen.get(num);
    if (prior) throw new MigrationError(`Duplicate migration number ${num}: ${prior} and ${file}`);
    seen.set(num, file);
    const sql = await fs.readFile(path.join(dir, file), 'utf8');
    const id = file.replace(/\.sql$/, '');
    assertTransactionSafe(id, sql);
    out.push({ id, file, sql, checksum: checksumOf(sql) });
  }
  return out;
}

function lineOf(sql: string, position: string | undefined): number | null {
  if (!position) return null;
  return sql.slice(0, Number(position)).split('\n').length;
}

async function lockAndEnsureTable(client: PoolClient): Promise<void> {
  await client.query('select pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
  await client.query(CREATE_TABLE_SQL);
}

function verifyChecksums(migrations: Migration[], applied: { id: string; checksum: string }[]): void {
  const byId = new Map(migrations.map((m) => [m.id, m]));
  for (const row of applied) {
    const m = byId.get(row.id);
    if (m && m.checksum !== row.checksum) {
      throw new MigrationError(
        `Checksum mismatch for applied migration ${row.id}: the file was modified after it was applied ` +
          `(applied ${row.checksum.slice(0, 12)}…, file ${m.checksum.slice(0, 12)}…). ` +
          'Applied migrations are immutable — restore the original file and add a new migration instead.',
        { id: row.id },
      );
    }
  }
}

export interface MigrateOptions {
  pool?: Pool;
  conn?: DbConnection | null;
  dir?: string;
  logger?: Logger;
}

/** Applies every pending migration → { applied, alreadyApplied }. */
export async function migrate({ pool, conn, dir = MIGRATIONS_DIR, logger = rootLogger.child({ module: 'migrate' }) }: MigrateOptions = {}) {
  const migrations = await loadMigrations(dir);
  const p = pool ?? createPool(conn ?? config.db.owner, { max: 1, applicationName: 'whereismybus-migrate' });
  const applied: string[] = [];
  const client = await p.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    await lockAndEnsureTable(client);
    const { rows } = await client.query<{ id: string; checksum: string }>('select id, checksum from schema_migrations order by id');
    await client.query('COMMIT');
    verifyChecksums(migrations, rows);
    const done = new Set(rows.map((r) => r.id));

    for (const m of migrations) {
      if (done.has(m.id)) continue;
      await client.query('BEGIN');
      await lockAndEnsureTable(client);
      const existing = await client.query<{ checksum: string }>('select checksum from schema_migrations where id = $1', [m.id]);
      if (existing.rows[0]) {
        await client.query('COMMIT');
        verifyChecksums([m], [{ id: m.id, checksum: existing.rows[0].checksum }]);
        continue;
      }
      const started = Date.now();
      try {
        await client.query(m.sql);
      } catch (err) {
        const e = err as { message?: string; position?: string };
        const line = lineOf(m.sql, e.position);
        throw new MigrationError(`${m.file}${line ? ` (line ${line})` : ''}: ${e.message ?? String(err)}`, { id: m.id, cause: err });
      }
      await client.query('insert into schema_migrations (id, checksum) values ($1, $2)', [m.id, m.checksum]);
      await client.query('COMMIT');
      applied.push(m.id);
      logger.info({ migration: m.id, ms: Date.now() - started }, 'Migration applied');
    }
    return { applied, alreadyApplied: migrations.length - applied.length };
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

export interface MigrationStatusRow {
  id: string;
  status: MigrationState;
  appliedAt: string | null;
}

/** Reports migration state without changing anything (works for the app role: SELECT only). */
export async function migrationStatus({ pool, conn, dir = MIGRATIONS_DIR }: MigrateOptions = {}): Promise<MigrationStatusRow[]> {
  const migrations = await loadMigrations(dir);
  const p = pool ?? createPool(conn ?? config.db.owner, { max: 1, applicationName: 'whereismybus-migrate' });
  try {
    const exists = await p.query<{ present: boolean }>("select to_regclass('schema_migrations') is not null as present");
    const rows = exists.rows[0]?.present
      ? (await p.query<{ id: string; checksum: string; applied_at: string }>('select id, checksum, applied_at from schema_migrations order by id')).rows
      : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const result: MigrationStatusRow[] = migrations.map((m) => {
      const row = byId.get(m.id);
      if (!row) return { id: m.id, status: 'pending', appliedAt: null };
      return { id: m.id, status: row.checksum === m.checksum ? 'applied' : 'checksum_mismatch', appliedAt: row.applied_at };
    });
    const fileIds = new Set(migrations.map((m) => m.id));
    for (const row of rows) if (!fileIds.has(row.id)) result.push({ id: row.id, status: 'missing_file', appliedAt: row.applied_at });
    return result.sort((a, b) => a.id.localeCompare(b.id));
  } finally {
    if (!pool) await p.end();
  }
}

/** Throws unless every migration file is applied with a matching checksum (boot / readiness). */
export async function assertMigrationsApplied(options: MigrateOptions = {}): Promise<MigrationStatusRow[]> {
  const status = await migrationStatus(options);
  const problems = status.filter((s) => s.status === 'pending' || s.status === 'checksum_mismatch');
  if (problems.length) {
    throw new MigrationError(`Database schema is not up to date: ${problems.map((s) => `${s.id} (${s.status})`).join(', ')}. Run "npm run migrate".`);
  }
  return status;
}

async function cli(argv: string[]): Promise<number> {
  const command = argv[0] ?? 'up';
  const conn = argv.includes('--test') ? config.testDb.owner : config.db.owner;
  if (!conn) throw new Error('Database is not configured');
  const target = `${conn.database} (${conn.source})`;
  if (command === 'up') {
    console.log(`Migrating ${target} …`);
    const { applied, alreadyApplied } = await migrate({ conn });
    console.log(applied.length ? `Applied ${applied.length} migration(s): ${applied.join(', ')}` : `Already up to date (${alreadyApplied} migrations applied).`);
    return 0;
  }
  if (command === 'status') {
    const status = await migrationStatus({ conn });
    console.log(`Migration status for ${target}:`);
    if (!status.length) console.log('  (no migrations)');
    for (const s of status) console.log(`  ${s.status.padEnd(17)} ${s.id.padEnd(48)} ${s.appliedAt ?? ''}`);
    return status.some((s) => s.status === 'checksum_mismatch') ? 1 : 0;
  }
  console.error(`Unknown command "${command}". Usage: tsx src/db/migrate.ts up|status [--test]`);
  return 2;
}

if (isMainModule(import.meta.url)) {
  cli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(err instanceof MigrationError ? `Migration failed: ${err.message}` : err);
      process.exitCode = 1;
    },
  );
}
