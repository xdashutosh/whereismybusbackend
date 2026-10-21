// Runs the Neon readiness subset: node tests/qa/neon/run-neon.mjs [file,file…]
// Builds TEST_DATABASE_URL for <DB_HOST>/<TEST_DB_NAME> from backend/.env ONLY (never .env.local)
// and masks every secret value in the child output. Requires TEST_DB_NAME to contain "test".
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const backend = fileURLToPath(new URL('../../..', import.meta.url));
const require = createRequire(path.join(backend, 'package.json'));
const env = require('dotenv').parse(fs.readFileSync(path.join(backend, '.env')));
const db = env.TEST_DB_NAME;
if (!db || !db.toLowerCase().includes('test')) throw new Error('TEST_DB_NAME in backend/.env must name a test database');
const u = new URL('postgresql://h/');
u.hostname = env.DB_HOST; u.port = env.DB_PORT || '5432';
u.username = encodeURIComponent(env.DB_USER); u.password = encodeURIComponent(env.DB_PASSWORD);
u.pathname = `/${db}`; u.search = '?sslmode=verify-full';
const secrets = ['DB_PASSWORD', 'DB_APP_PASSWORD', 'DB_HOST', 'DB_USER', 'AWS_SECRET_ACCESS_KEY', 'AWS_ACCESS_KEY_ID', 'SMS_API_KEY', 'JWT_ACCESS_SECRET', 'GOOGLE_MAPS_SERVER_KEY']
  .map((k) => [k, env[k]]).filter(([, v]) => v && v.length >= 3);
const mask = (s) => secrets.reduce((o, [k, v]) => o.split(v).join(`<${k}>`).split(encodeURIComponent(v)).join(`<${k}>`), s);
const childEnv = { ...process.env, TEST_DATABASE_URL: u.toString(), NEON_TEST_RESET_CONFIRM: db, TEST_DATABASE_APP_URL: '' };
if (process.argv[2]) childEnv.NEON_SUBSET = process.argv[2];
const t0 = Date.now();
const child = spawn(path.join(backend, 'node_modules/.bin/vitest'), ['run', '--config', 'tests/qa/neon/vitest.config.ts', ...process.argv.slice(3)], { cwd: backend, env: childEnv });
child.stdout.on('data', (d) => process.stdout.write(mask(String(d))));
child.stderr.on('data', (d) => process.stderr.write(mask(String(d))));
child.on('exit', (code) => { process.stdout.write(`[run-neon] exit ${code} wall ${((Date.now() - t0) / 1000).toFixed(1)} s\n`); process.exit(code ?? 1); });
