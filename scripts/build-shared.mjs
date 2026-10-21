// Builds the vendored ./shared package (@wimb/shared, "file:./shared" dependency) to shared/dist.
// Runs as postinstall (so a plain `npm ci` from a fresh clone is ready to use) and again before
// build / typecheck / lint / test. Idempotent and Windows-safe (no shell; tsc runs through node).
//
// shared/ sits inside this repo, so `npm ci` installs its dev dependencies (typescript, zod, vitest)
// together with ours (hoisted to ./node_modules or nested in shared/node_modules). Only when they are
// missing (e.g. an install with --omit=dev) does this script install them into shared/ itself.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sharedDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'shared');
const sharedPkg = path.join(sharedDir, 'package.json');

if (!existsSync(sharedPkg)) {
  console.error(`@wimb/shared not found at ${sharedDir} (the shared/ folder is part of this repo)`);
  process.exit(1);
}

function resolveFromShared(id) {
  try {
    return createRequire(sharedPkg).resolve(id);
  } catch {
    return null;
  }
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: sharedDir, stdio: 'inherit', ...opts });
  if (res.error) {
    console.error(`@wimb/shared: cannot run ${cmd}: ${res.error.message}`);
    process.exit(1);
  }
  if (res.status !== 0) process.exit(res.status ?? 1);
}

function installSharedDeps() {
  // Settings of the outer install (--omit=dev, --prefix, …) must not leak into this one.
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^npm_config_(omit|include|production|only|dev|also|global|dry_run|package_lock_only|ignore_scripts|workspaces?|prefix)$/i.test(k)) delete env[k];
  }
  const args = [existsSync(path.join(sharedDir, 'package-lock.json')) ? 'ci' : 'install', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'];
  const cli = process.env.npm_execpath; // npm's own CLI script when started from an npm script
  if (cli && /npm-cli\.js$/.test(cli)) run(process.execPath, [cli, ...args], { env });
  else run('npm', args, { env, shell: process.platform === 'win32' }); // npm.cmd needs a shell on Windows
}

if (!resolveFromShared('typescript/package.json') || !resolveFromShared('zod')) installSharedDeps();

const tsc = path.join(path.dirname(resolveFromShared('typescript/package.json') ?? ''), 'bin', 'tsc');
if (!existsSync(tsc)) {
  console.error('@wimb/shared: typescript is not installed (run npm ci --include=dev)');
  process.exit(1);
}
run(process.execPath, [tsc, '-p', path.join(sharedDir, 'tsconfig.json')]);
