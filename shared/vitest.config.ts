import { defineConfig } from 'vitest/config';

// Unit tests of the shared enums, Zod schemas and helpers (pure functions: no database, no network).
// Test files live next to the code (src/**/*.test.ts) and are excluded from the tsc build (tsconfig.json).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
