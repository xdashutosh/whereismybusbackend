// Development database reset (contract §3): drops every object in schema public, re-applies all
// migrations as the owner, re-provisions the app role and optionally seeds.
// Guards: refuses with NODE_ENV=production and ALWAYS refuses non-local database hosts.
// CLI: tsx src/db/reset.ts [--seed] [--test]
import config, { type DbConnection } from '../config/index.js';
import { isLocalDatabase } from '../config/hosts.js';
import { logger as rootLogger, type Logger } from '../shared/logger.js';
import { isMainModule } from './cli.js';
import { migrate } from './migrate.js';
import { createPool } from './pool.js';
import { appCredentials, setupAppRole } from './setupRoles.js';

/** Throws unless resetting `conn` is allowed (local host, not production). */
export function assertResettable(conn: DbConnection | null, { isProduction = config.isProduction } = {}): asserts conn is DbConnection {
  if (isProduction) throw new Error('Refusing to reset a database with NODE_ENV=production.');
  if (!conn) throw new Error('Database is not configured.');
  if (!isLocalDatabase(conn)) {
    throw new Error(`Refusing to reset "${conn.database}": only databases on localhost can be reset (check backend/.env.local).`);
  }
}

/** Drops and recreates schema public, then migrates. Returns the migrate() result. */
export async function resetDatabase(conn: DbConnection, { logger = rootLogger.child({ module: 'reset' }) }: { logger?: Logger } = {}) {
  assertResettable(conn);
  const pool = createPool(conn, { max: 1, applicationName: 'whereismybus-reset' });
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('drop schema if exists public cascade');
      await client.query('create schema public');
      await client.query('grant usage on schema public to public');
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    return await migrate({ pool, logger });
  } finally {
    await pool.end();
  }
}

async function cli(argv: string[]): Promise<number> {
  const useTest = argv.includes('--test');
  const pair = useTest ? config.testDb : config.db;
  assertResettable(pair.owner);
  console.log(`Resetting ${pair.owner.database} (${pair.owner.source}) …`);
  const { applied } = await resetDatabase(pair.owner);
  console.log(`Schema recreated; applied ${applied.length} migration(s).`);
  if (pair.app && !pair.appIsOwnerFallback) {
    const { user, password } = appCredentials(pair.app);
    if (user) {
      const r = await setupAppRole({ conn: pair.owner, appUser: user, appPassword: password });
      console.log(`App role ${r.role} provisioned (${r.tables} tables).`);
    }
  }
  if (argv.includes('--seed') && !useTest) {
    const { runSeeds, printPasswordNotice } = await import('./seed.js');
    const result = await runSeeds();
    console.log(`Applied ${result.ran.length} seed file(s)${result.ran.length ? `: ${result.ran.join(', ')}` : ''}.`);
    if (result.ran.length) printPasswordNotice(result);
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  cli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error('Reset failed:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    },
  );
}
