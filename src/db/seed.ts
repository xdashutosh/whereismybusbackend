// Seed runner (contract §14): runs src/db/seeds/NN_<module>.ts in lexical order as the OWNER,
// one transaction per file. Refuses NODE_ENV=production unless --force, and outside production
// refuses any database that is not on localhost unless --force or ALLOW_REMOTE_DEV_DB=true
// (backend/.env holds the production credentials: without backend/.env.local a plain `npm run seed`
// would otherwise write demo tenants and a known super-admin password into production).
//
// Seed module contract — every seed must be idempotent (re-running never duplicates data):
//   export async function seed(ctx: SeedContext): Promise<void>
//   ctx.tx            owner transaction handle (query/many/maybeOne/one) for this file
//   ctx.setContext()  sets app.school_id/actor_id/actor_role transaction-locally, so inserts
//                     satisfy FORCE RLS policies when the owner is not a BYPASSRLS role
//   ctx.defaultPassword / ctx.passwordHash  demo password and its argon2id hash (computed once)
//   ctx.remoteTarget  true when the database is not on localhost (seeded logins must then be
//                     forced to change their password on first sign-in)
//   Batch writes (multi-row VALUES / unnest / INSERT … SELECT) — contract §3 round trips.
// Demo password: SEED_DEFAULT_PASSWORD, else DEMO_PASSWORD outside production; in production
// (only with --force) a random password is generated for this run.
// CLI: tsx src/db/seed.ts [--force] [--only=NN_name]
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import config, { type Config, type DbConnection } from '../config/index.js';
import { isLocalDatabase } from '../config/hosts.js';
import { hashPassword } from '../shared/crypto.js';
import { logger as rootLogger, type Logger } from '../shared/logger.js';
import { isMainModule } from './cli.js';
import { migrate } from './migrate.js';
import { closePools, createPool } from './pool.js';
import { createTx, SET_CONTEXT_SQL, type TenantContext, type Tx } from './tenant.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SEEDS_DIR = path.join(HERE, 'seeds');
const OWN_EXT = path.extname(fileURLToPath(import.meta.url)); // '.ts' under tsx, '.js' in dist
export const DEMO_PASSWORD = 'Wimb@12345';

export interface SeedContext {
  tx: Tx;
  setContext(ctx: TenantContext): Promise<void>;
  config: Config;
  logger: Logger;
  defaultPassword: string;
  passwordHash: string;
  remoteTarget: boolean;
}

export type SeedFn = (ctx: SeedContext) => Promise<void>;

export function generateSeedPassword(): string {
  return `Wimb${crypto.randomBytes(9).toString('base64url').replace(/[-_]/g, 'x')}7`;
}

export async function listSeedFiles(dir = SEEDS_DIR, ext = OWN_EXT): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const pattern = new RegExp(`^\\d{2}_[a-z0-9_]+\\${ext}$`);
  return entries.filter((f) => pattern.test(f) && !f.endsWith('.d.ts')).sort();
}

export function resolveSeedPassword(cfg: Config = config): { defaultPassword: string; generatedPassword: boolean } {
  if (cfg.seedDefaultPassword) return { defaultPassword: cfg.seedDefaultPassword, generatedPassword: false };
  if (cfg.isProduction) return { defaultPassword: generateSeedPassword(), generatedPassword: true };
  return { defaultPassword: DEMO_PASSWORD, generatedPassword: false };
}

/**
 * Throws (before any connection is opened) unless seeding `conn` is allowed: production needs
 * `force`; outside production a non-local host needs `force` or ALLOW_REMOTE_DEV_DB=true.
 */
export function assertSeedable(
  conn: DbConnection | null,
  { isProduction = config.isProduction, force = false, allowRemote = config.allowRemoteDevDb }: { isProduction?: boolean; force?: boolean; allowRemote?: boolean } = {},
): asserts conn is DbConnection {
  if (!conn) throw new Error('Refusing to seed: the database is not configured.');
  if (isProduction) {
    if (!force) throw new Error('Refusing to seed demo data with NODE_ENV=production (pass --force to override).');
    return;
  }
  if (!isLocalDatabase(conn) && !force && !allowRemote) {
    throw new Error(
      `Refusing to seed "${conn.database}": NODE_ENV=${config.env} with a database that is not on localhost ` +
        '(backend/.env holds production credentials — check backend/.env.local). Pass --force or set ALLOW_REMOTE_DEV_DB=true to seed it deliberately.',
    );
  }
}

export async function runSeeds({
  dir = SEEDS_DIR,
  only,
  force = false,
  logger = rootLogger.child({ module: 'seed' }),
}: { dir?: string; only?: string; force?: boolean; logger?: Logger } = {}) {
  const owner = config.db.owner;
  assertSeedable(owner, { force });
  const remoteTarget = !isLocalDatabase(owner);
  const pool = createPool(owner, { max: 1, applicationName: 'whereismybus-seed' });
  try {
    await migrate({ pool, logger });
    const files = (await listSeedFiles(dir)).filter((f) => !only || f.startsWith(only));
    const { defaultPassword, generatedPassword } = resolveSeedPassword();
    const passwordHash = files.length ? await hashPassword(defaultPassword) : '';
    const ran: string[] = [];
    for (const file of files) {
      const mod = (await import(pathToFileURL(path.join(dir, file)).href)) as { seed?: SeedFn; default?: SeedFn };
      const seed = mod.seed ?? mod.default;
      if (typeof seed !== 'function') throw new Error(`Seed ${file} must export a seed(ctx) function`);
      const started = Date.now();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const systemCtx: TenantContext = { schoolId: null, actorId: null, role: 'system' };
        const setContext = async (c: TenantContext) => {
          await client.query(SET_CONTEXT_SQL, [c.schoolId ?? '', c.actorId ?? '', c.role]);
        };
        await setContext(systemCtx);
        const tx = createTx(client, systemCtx, false);
        await seed({ tx, setContext, config, logger, defaultPassword, passwordHash, remoteTarget });
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
      ran.push(file);
      logger.info({ seed: file, ms: Date.now() - started }, 'Seed applied');
    }
    return { ran, defaultPassword, generatedPassword };
  } finally {
    await pool.end();
  }
}

/** Prints the demo-account password of this run (CLI only, never logged). */
export function printPasswordNotice({ defaultPassword, generatedPassword }: { defaultPassword: string; generatedPassword: boolean }): void {
  const source = config.seedDefaultPassword ? 'SEED_DEFAULT_PASSWORD' : generatedPassword ? 'generated for this run' : 'built-in demo default';
  console.log(`Demo accounts created in this run use the password: ${defaultPassword}  (${source})`);
  console.log('Existing accounts keep their current password. Demo sign-ins are listed in docs/SEED_DATA.md.');
}

async function cli(argv: string[]): Promise<number> {
  const only = argv.find((a) => a.startsWith('--only='))?.slice('--only='.length);
  const force = argv.includes('--force');
  try {
    assertSeedable(config.db.owner, { force });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  console.log(`Seeding ${config.db.owner?.database ?? '(unconfigured)'} …`);
  // Seeds that run module jobs (80_alerts) use the app pool: end it so the process can exit.
  const result = await runSeeds({ only, force }).finally(closePools);
  if (!result.ran.length) {
    console.log('No seed files found in src/db/seeds.');
    return 0;
  }
  console.log(`Applied ${result.ran.length} seed file(s): ${result.ran.join(', ')}`);
  printPasswordNotice(result);
  return 0;
}

if (isMainModule(import.meta.url)) {
  cli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error('Seeding failed:', err);
      process.exitCode = 1;
    },
  );
}
