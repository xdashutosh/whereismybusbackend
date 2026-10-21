// vitest globalSetup — once per `vitest run`, before any test file:
//   1. resolves the test database through src/config (TEST_DATABASE_URL in the real environment
//      wins over backend/.env.local, which wins over backend/.env; TEST_DB_NAME is the DB_* form)
//   2. REFUSES unless the database name contains "test" and the host is local — both checks run
//      BEFORE any connection is opened (no connection to a remote cluster, no CREATE DATABASE there)
//   3. creates the database when missing (via the server's `postgres` maintenance database), so
//      private per-agent databases work out of the box:
//        TEST_DATABASE_URL=postgresql://postgres@localhost:54329/whereismybus_test_<name> npm test
//   4. drops/recreates schema public and applies every migration as the OWNER
//   5. creates/aligns the dedicated test app role (LOGIN NOBYPASSRLS) and applies its grants
//   6. (after every guard) gives this run a private local-storage root in the OS temp folder (provided to every test
//      worker as `storageDir`) and deletes it in teardown — uploads never accumulate in backend/
//      and parallel runs never share or delete each other's files
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import type * as ResetModule from '../../src/db/reset.js';
import { applyTestEnv, TEST_APP_PASSWORD } from './testEnv.js';

export function assertTestDatabaseName(name: string | null | undefined): string {
  if (typeof name !== 'string' || !name.toLowerCase().includes('test')) {
    throw new Error(`Refusing to run tests against database "${name ?? '(none)'}": the name must contain "test" (set TEST_DATABASE_URL or TEST_DB_NAME).`);
  }
  return name;
}

declare module 'vitest' {
  export interface ProvidedContext {
    storageDir: string;
  }
}

/** Creates this run's private storage root, provides it to the workers; returns it and its teardown. */
export async function provideTestStorage(project: TestProject): Promise<{ storageDir: string; teardown: () => Promise<void> }> {
  const storageDir = await mkdtemp(path.join(os.tmpdir(), 'wimb-test-storage-'));
  project.provide('storageDir', storageDir);
  return { storageDir, teardown: () => rm(storageDir, { recursive: true, force: true }) };
}

export default async function globalSetup(project: TestProject): Promise<() => Promise<void>> {
  applyTestEnv();
  const { default: config } = await import('../../src/config/index.js');
  const reset: typeof ResetModule = await import('../../src/db/reset.js'); // annotated: assertResettable is an assertion
  const { setupAppRole, appCredentials } = await import('../../src/db/setupRoles.js');
  const { maintenanceConnection } = await import('./db.js');
  const owner = config.testDb.owner;
  if (!owner) throw new Error('Test database not configured: set TEST_DATABASE_URL or DB_HOST/DB_USER/TEST_DB_NAME.');
  const name = assertTestDatabaseName(owner.database);
  reset.assertResettable(owner); // localhost only — must run before the maintenance connection below

  const admin = new pg.Client({ ...maintenanceConnection(owner), application_name: 'whereismybus-test-setup' });
  await admin.connect();
  try {
    const exists = await admin.query('select 1 from pg_database where datname = $1', [name]);
    if (!exists.rowCount) {
      try {
        await admin.query(`create database ${admin.escapeIdentifier(name)}`);
      } catch (err) {
        if ((err as { code?: string }).code !== '42P04') throw err; // created concurrently
      }
    }
  } finally {
    await admin.end();
  }

  await reset.resetDatabase(owner);
  const { user } = appCredentials(config.testDb.app);
  if (!user) throw new Error('Test app role is not configured');
  await setupAppRole({ conn: owner, appUser: user, appPassword: TEST_APP_PASSWORD });
  return (await provideTestStorage(project)).teardown; // only after every guard passed
}
