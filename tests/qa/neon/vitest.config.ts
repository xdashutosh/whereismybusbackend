// Go-live readiness subset against the hosted Neon test database (see neonGlobalSetup.ts).
// Run only through tests/qa/neon/run-neon.mjs (builds TEST_DATABASE_URL from backend/.env,
// masks secrets in the output). Same settings as backend/vitest.config.ts, generous timeouts for
// a ~290 ms round trip, and a representative subset: tenancy/RLS, auth, tracking ingest, trips, files, jobs, name collation.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const backendRoot = fileURLToPath(new URL('../../..', import.meta.url));
export const NEON_SUBSET = [
  'db.tenant', 'schema.rls', 'integration.isolation', 'setupRoles', 'infra.db',
  'auth.login', 'auth.session', 'auth.ratelimit-totp',
  'tracking.ingest', 'trips.start', 'trips.end',
  'files', 'uploads',
  'jobs', 'integration.jobs',
  'qa/collation', // the Neon databases use the builtin C.UTF-8 default collation (migration 850)
];

export default defineConfig({
  root: backendRoot,
  test: {
    environment: 'node',
    include: (process.env.NEON_SUBSET ? process.env.NEON_SUBSET.split(',') : NEON_SUBSET).map((f) => `tests/${f}.test.ts`),
    setupFiles: ['tests/helpers/setupEnv.ts'],
    globalSetup: ['tests/qa/neon/neonGlobalSetup.ts'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 180000,
    hookTimeout: 600000,
    reporters: ['verbose'],
  },
});
