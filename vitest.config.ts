import { defineConfig } from 'vitest/config';

// Tests run against a real local PostgreSQL test database (TEST_DATABASE_URL / TEST_DB_NAME;
// the name must contain "test"). globalSetup recreates its schema, applies every migration as the
// owner and provisions a dedicated NOBYPASSRLS app role, so runtime code paths (getAppPool,
// withTenant) are exercised under RLS. Files share the database → they run sequentially.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/helpers/setupEnv.ts'],
    globalSetup: ['tests/helpers/globalSetup.ts'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
