// Go-live readiness: vitest globalSetup for running a SUBSET of the backend suite against the
// hosted Neon test database (PostgreSQL 18 behind PgBouncer transaction pooling).
// Same steps as tests/helpers/globalSetup.ts EXCEPT the localhost-only reset guard, which is
// replaced by a stricter, explicit opt-in:
//   - the database name must be exactly the one in NEON_TEST_RESET_CONFIRM, and contain "test"
//   - the host must be a Neon host (*.neon.tech)
// It never creates databases (whereismybus_test must already exist), never touches any other
// database, and drops/recreates schema public of that one database, migrates as the owner and
// provisions the NOBYPASSRLS test app role (wimb_test_app). Run it through run-neon.mjs, which
// builds TEST_DATABASE_URL from backend/.env without printing secrets. Teardown drops wimb_test_app.
import type { TestProject } from 'vitest/node';
import { applyTestEnv, TEST_APP_PASSWORD } from '../../helpers/testEnv.js';
import { assertTestDatabaseName, provideTestStorage } from '../../helpers/globalSetup.js';

export default async function neonGlobalSetup(project: TestProject): Promise<() => Promise<void>> {
  applyTestEnv();
  const { default: config } = await import('../../../src/config/index.js');
  const { dbHost } = await import('../../../src/config/hosts.js');
  const { createPool } = await import('../../../src/db/pool.js');
  const { migrate } = await import('../../../src/db/migrate.js');
  const { setupAppRole, appCredentials } = await import('../../../src/db/setupRoles.js');
  const owner = config.testDb.owner;
  if (!owner) throw new Error('Test database not configured (TEST_DATABASE_URL).');
  const name = assertTestDatabaseName(owner.database);
  if (!process.env.NEON_TEST_RESET_CONFIRM || process.env.NEON_TEST_RESET_CONFIRM !== name) {
    throw new Error(`Refusing to reset "${name}": set NEON_TEST_RESET_CONFIRM=${name} to confirm.`);
  }
  if (!/\.neon\.tech$/i.test(dbHost(owner))) throw new Error('Refusing: this setup is only for a Neon test database.');

  const started = Date.now();
  const pool = createPool(owner, { max: 1, applicationName: 'whereismybus-neon-test-setup' });
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ db: string }>('select current_database() as db');
      if (rows[0]?.db !== name) throw new Error('Connected to an unexpected database');
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
    const { applied } = await migrate({ pool });
    console.log(`[neon-setup] schema recreated, ${applied.length} migration(s) applied in ${Date.now() - started} ms`);
  } finally {
    await pool.end();
  }
  const { user } = appCredentials(config.testDb.app);
  if (!user) throw new Error('Test app role is not configured');
  const t1 = Date.now();
  const r = await setupAppRole({ conn: owner, appUser: user, appPassword: TEST_APP_PASSWORD });
  console.log(`[neon-setup] app role ${r.role} provisioned (created=${r.created}, tables=${r.tables}) in ${Date.now() - t1} ms`);
  const storage = await provideTestStorage(project); // private temp storage root, removed after the run
  return async () => {
    await storage.teardown();
    // The test role's password is public (tests/helpers/testEnv.ts): never leave it on the Neon branch.
    // PG16+ CREATEROLE rules: the owner must be granted the role before DROP OWNED / DROP ROLE.
    const drop = createPool(owner, { max: 1, applicationName: 'whereismybus-neon-test-teardown' });
    try {
      const { rowCount } = await drop.query('select 1 from pg_roles where rolname = $1', [user]);
      if (rowCount) {
        const ident = '"' + user.replace(/"/g, '""') + '"';
        await drop.query(`grant ${ident} to current_user`).catch(() => undefined);
        await drop.query(`drop owned by ${ident}`);
        await drop.query(`drop role ${ident}`);
        console.log(`[neon-setup] test app role ${user} dropped`);
      }
    } finally {
      await drop.end();
    }
  };
}
