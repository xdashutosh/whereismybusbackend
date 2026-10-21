#!/usr/bin/env node
// Checks the Render Blueprint (render.yaml: ONE native Node web service, no Docker, no Redis, no
// worker) and the CI workflow against the backend code, and that no Docker configuration is left.
//   node scripts/check-render-config.mjs                        → exit 1 on any error
//   node scripts/check-render-config.mjs --self-test            → proves each check catches its regression
//   node scripts/check-render-config.mjs --env-file <file>      → also checks a Render "Add from .env"
//                                                                  file (key names only; values never printed)
// This repo IS the backend: render.yaml and .github/workflows/ci.yml are read from the repo root
// (./render.yaml, no rootDir). No dependencies: YAML is parsed with the `yaml` package when
// node_modules has it, else with Ruby's built-in YAML (macOS / most CI images).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The repo root (this script lives in <repo>/scripts). render.yaml must not set rootDir.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_DIR = '';
const inRepo = (p) => path.join(REPO, p);

function parseYaml(file) {
  try {
    const req = createRequire(inRepo('package.json'));
    return req('yaml').parse(readFileSync(file, 'utf8'));
  } catch {
    const r = spawnSync('ruby', ['-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.safe_load(File.read(ARGV[0])))', file], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`cannot parse ${file}: install Ruby or the yaml package (${(r.stderr || r.error?.message || '').trim()})`);
    return JSON.parse(r.stdout);
  }
}

/** Keys the backend accepts (src/config/env.ts envSchema) plus platform keys. */
function backendEnvKeys(envTs) {
  const body = envTs.slice(envTs.indexOf('export const envSchema'));
  return new Set([...body.slice(0, body.indexOf('\n});')).matchAll(/^\s{2}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]).concat(['NODE_VERSION']));
}

const SECRET_KEY = /(PASSWORD|SECRET|_KEY$|API_KEY|ACCESS_KEY_ID|SERVICE_ACCOUNT|SMTP_PASS|DB_USER|DB_HOST|DATABASE_URL|DATABASE_APP_URL|API_USERNAME)/;

/** Values entered in Render (sync: false), in render.yaml order. Also the keys of .env.render.local. */
export const SYNC_FALSE_KEYS = [
  'DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_APP_USER', 'DB_APP_PASSWORD',
  'AWS_BUCKET_NAME', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
  'JWT_ACCESS_SECRET',
  'SMS_API_URL', 'SMS_API_USERNAME', 'SMS_API_KEY', 'SMS_SENDER_ID', 'SMS_DLT_TEMPLATE_ID', 'SMS_OTP_MESSAGE', 'SMS_DEV_ALLOWED_NUMBERS',
  'CORS_ORIGINS', 'APP_PUBLIC_URL', 'PLATFORM_ADMIN_EMAIL', 'GOOGLE_MAPS_SERVER_KEY',
];

/** Fixed values the single-instance demo deployment depends on. */
const FIXED = {
  NODE_ENV: 'production',
  TRUST_PROXY: '1',
  RATE_LIMIT_ENABLED: 'true',
  JOBS_IN_PROCESS: 'true',
  SINGLE_INSTANCE: 'true',
  STORAGE_DRIVER: 's3',
  DB_SSL: 'true',
  SMS_PROVIDER: 'webpayservices',
};

const DOCKER_KEYS = ['dockerfilePath', 'dockerContext', 'dockerCommand', 'image', 'registryCredential'];

// ── checks: each returns a list of error strings ──────────────────────────────
export function checkRender(r, { envKeys, backendScripts, engines, rootDir }) {
  const e = [];
  if (!r || typeof r !== 'object') return ['render.yaml: empty or not a mapping'];
  for (const k of Object.keys(r)) if (k !== 'services') e.push(`render.yaml: only "services" is used (found top-level ${k}: no envVarGroups, databases or other resources)`);
  const services = r.services ?? [];
  if (services.length !== 1) e.push(`render.yaml: exactly one service (the API) — found ${services.length}: no worker, no Key Value/Redis`);
  for (const s of services) if (s.type !== 'web') e.push(`render.yaml: service ${s.name} has type ${s.type}; only the web API is deployed (no worker, keyvalue or redis)`);
  const web = services.find((s) => s.type === 'web');
  if (!web) return [...e, 'render.yaml: no web service for the API'];
  const n = `render.yaml ${web.name}`;
  if (web.name !== 'whereismybus-api') e.push(`${n}: name must be whereismybus-api (docs, admin panel rewrite and app builds use whereismybus-api.onrender.com)`);
  if (web.runtime !== 'node') e.push(`${n}: runtime must be node (no Docker)`);
  for (const k of DOCKER_KEYS) if (web[k] !== undefined) e.push(`${n}: ${k} is Docker configuration; use the native node runtime`);
  if (web.region !== 'virginia') e.push(`${n}: region must be virginia (next to Neon, AWS us-east-1)`);
  if (!web.plan) e.push(`${n}: set a plan (starter; free also works)`);
  if (web.numInstances !== undefined && Number(web.numInstances) !== 1) e.push(`${n}: numInstances must be 1 (SINGLE_INSTANCE keeps state in the process)`);
  if (web.scaling) e.push(`${n}: no autoscaling (SINGLE_INSTANCE keeps state in the process)`);
  const actualRoot = String(web.rootDir ?? '').replace(/^\.\/?|\/$/g, '');
  if (actualRoot !== rootDir) e.push(`${n}: rootDir must be ${rootDir ? `"${rootDir}"` : 'unset'} (render.yaml sits next to package.json at the repo root), found "${web.rootDir ?? ''}"`);

  const b = String(web.buildCommand ?? '');
  if (!(/\bnpm ci\b/.test(b) && b.indexOf('npm run build') > b.search(/\bnpm ci\b/))) e.push(`${n}: buildCommand must be npm ci --include=dev && npm run build`);
  if (!/npm ci[^&]*--include=dev/.test(b)) e.push(`${n}: npm ci must use --include=dev (TypeScript is a dev dependency)`);
  if (/--ignore-scripts/.test(b)) e.push(`${n}: npm ci must run scripts (postinstall builds the vendored shared/ package)`);
  for (const [what, cmd] of [['buildCommand', b], ['startCommand', web.startCommand], ['preDeployCommand', web.preDeployCommand]]) {
    if (/(^|[\s;&|])cd\s|\.\.\//.test(String(cmd ?? ''))) e.push(`${n}: ${what} runs at the repo root (no cd, no ../ paths): ${cmd}`);
    if (/docker/i.test(String(cmd ?? ''))) e.push(`${n}: ${what} must not use Docker: ${cmd}`);
  }
  // startCommand: `npm run release && npm start` — migrations at boot also work on the Free plan (no pre-deploy).
  const release = String(backendScripts?.release ?? '');
  const start = String(web.startCommand ?? '');
  const releaseAt = start.search(/npm run release\b/);
  const startAt = start.search(/npm start\b/);
  if (startAt < 0) e.push(`${n}: startCommand must run npm start (forces NODE_ENV=production)`);
  if (releaseAt < 0 || releaseAt > startAt || !/&&/.test(start.slice(releaseAt, startAt))) e.push(`${n}: startCommand must be npm run release && npm start (migrations before the API starts; a failed release must not start it)`);
  const order = [/migrate(\.js up|\b)/, /setup-?[Rr]oles/, /bootstrap/].map((re) => release.search(re));
  if (order.some((i) => i < 0) || order[1] < order[0] || order[2] < order[1]) e.push('package.json: the release script must run migrate, then db:setup-roles, then db:bootstrap');
  if (web.healthCheckPath !== '/healthz') e.push(`${n}: healthCheckPath must be /healthz (liveness; a Neon blip on /readyz would restart the API)`);
  if (web.autoDeploy !== true) e.push(`${n}: autoDeploy must be true`);

  const env = web.envVars ?? [];
  const by = {};
  for (const x of env) {
    if (x.fromGroup) { e.push(`${n}: no envVarGroups (fromGroup ${x.fromGroup}): every variable is listed on the service`); continue; }
    if (!x.key) { e.push(`${n}: env entry without a key`); continue; }
    if (by[x.key]) e.push(`${n}: duplicate env key ${x.key}`);
    by[x.key] = x;
    if (!envKeys.has(x.key)) e.push(`${n}: unknown env key ${x.key} (not in src/config/env.ts)`);
    if (x.fromService || x.fromDatabase) e.push(`${n}: ${x.key} must not come from another Render resource (single service, Neon database)`);
    if (SECRET_KEY.test(x.key) && x.value !== undefined) e.push(`${n}: ${x.key} is a secret — use sync: false, never an inline value`);
  }
  if (by.REDIS_URL) e.push(`${n}: no REDIS_URL (single-instance mode runs without Redis)`);
  for (const [k, v] of Object.entries(FIXED)) if (String(by[k]?.value ?? '') !== v) e.push(`${n}: ${k} must be ${v}`);
  if (!by.DB_NAME?.value) e.push(`${n}: DB_NAME must name the Neon database (whereismybus_dev = the seeded demo data)`);
  for (const k of SYNC_FALSE_KEYS) {
    if (!by[k]) e.push(`${n}: missing ${k} (sync: false)`);
    else if (by[k].sync !== false) e.push(`${n}: ${k} must be sync: false (entered in Render${k === 'JWT_ACCESS_SECRET' ? '; not generated: it must equal .env because local dev shares the demo database' : ''})`);
  }
  if (by.JWT_ACCESS_SECRET?.generateValue) e.push(`${n}: JWT_ACCESS_SECRET must not be generated (TOTP secrets in the shared demo database are encrypted with it)`);
  if (String(by.SMS_ALLOWLIST_ONLY?.value ?? '') === 'true' && !by.SMS_DEV_ALLOWED_NUMBERS) e.push(`${n}: SMS_ALLOWLIST_ONLY=true needs SMS_DEV_ALLOWED_NUMBERS`);
  const nodeVersion = String(by.NODE_VERSION?.value ?? '');
  const minMajor = Number(/(\d+)/.exec(String(engines?.node ?? ''))?.[1] ?? 0);
  if (!/^\d+\.\d+\.\d+$/.test(nodeVersion)) e.push(`${n}: NODE_VERSION must be an exact version (e.g. 24.11.1)`);
  else if (Number(nodeVersion.split('.')[0]) < minMajor) e.push(`${n}: NODE_VERSION ${nodeVersion} is below package.json engines.node ${engines.node}`);
  return e;
}

/** No Docker configuration at the repo root. */
export function checkNoDocker(exists) {
  const e = [];
  for (const p of ['Dockerfile', '.dockerignore', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml', 'deploy']) {
    if (exists(inRepo(p))) e.push(`${p}: Docker configuration is not used (Render runs the native node runtime)`);
  }
  return e;
}

/** All `run:` lines of a job, joined. */
const runsOf = (job) => (job?.steps ?? []).map((s) => String(s.run ?? '')).join('\n');

/** CI workflow: same Node version as render.yaml, runs this checker and the backend gates. */
export function checkCi(ci, { renderNodeVersion, backendScripts, rootDir }) {
  if (!ci) return ['.github/workflows/ci.yml is missing'];
  const e = [];
  const on = ci.on ?? ci[true] ?? ci.true; // YAML 1.1 parsers (Ruby) read the key `on` as true
  const triggers = typeof on === 'string' ? [on] : Array.isArray(on) ? on : Object.keys(on ?? {});
  for (const t of ['push', 'pull_request']) if (!triggers.includes(t)) e.push(`ci.yml: must run on ${t}`);
  if (String(ci.env?.NODE_VERSION ?? '') !== String(renderNodeVersion ?? '')) e.push(`ci.yml: env.NODE_VERSION (${ci.env?.NODE_VERSION}) must equal NODE_VERSION in render.yaml (${renderNodeVersion})`);
  const jobs = Object.values(ci.jobs ?? {});
  if (!jobs.some((j) => /check-render-config\.mjs/.test(runsOf(j)))) e.push('ci.yml: no job runs node scripts/check-render-config.mjs');
  const wd = (j) => String(j?.defaults?.run?.['working-directory'] ?? '').replace(/^\.\/?|\/$/g, '');
  const backend = jobs.find((j) => j.env?.TEST_DATABASE_URL !== undefined);
  if (!backend) return [...e, 'ci.yml: no backend job (the job with env.TEST_DATABASE_URL)'];
  if (wd(backend) !== rootDir) e.push(`ci.yml backend: working-directory must be ${rootDir || 'the repo root'}`);
  const r = runsOf(backend);
  for (const s of ['lint', 'typecheck', 'test', 'build']) if (!new RegExp(`npm (run )?${s}\\b`).test(r)) e.push(`ci.yml backend: must run npm run ${s}`);
  if (!/npm ci\b[^\n]*--include=dev/.test(r)) e.push('ci.yml backend: install with npm ci --include=dev (same as render.yaml)');
  if (/npm ci\b[^\n]*--ignore-scripts/.test(r)) e.push('ci.yml backend: npm ci must run scripts (postinstall builds shared/, same as render.yaml)');
  if (/packages\/shared|\.\.\//.test(r)) e.push('ci.yml backend: the repo is self-contained (no ../ or packages/shared installs)');
  if (/docker|redis/i.test(r) || Object.values(backend.services ?? {}).some((s) => /redis|valkey/.test(String(s.image ?? '')))) e.push('ci.yml backend: no Docker commands or Redis service (single-instance mode)');
  let testUrl = null;
  try { testUrl = new URL(String(backend.env.TEST_DATABASE_URL)); } catch { /* reported below */ }
  if (!testUrl || !['localhost', '127.0.0.1'].includes(testUrl.hostname) || !/test/i.test(testUrl.pathname)) e.push('ci.yml backend: TEST_DATABASE_URL must be on localhost and its database name must contain "test"');
  for (const m of r.matchAll(/npm run ([\w:-]+)/g)) if (!(m[1] in (backendScripts ?? {}))) e.push(`ci.yml backend: npm run ${m[1]} is not a script in package.json`);
  return e;
}

/** A Render "Add from .env" file: exactly the sync:false keys, each with a value. Never prints values. */
export function checkEnvFile(text) {
  const e = [];
  const keys = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m) { e.push('env file: a line is not KEY=value'); continue; }
    keys.push(m[1]);
    if (!m[2].trim() || /^(""|'')$/.test(m[2].trim())) e.push(`env file: ${m[1]} is empty`);
  }
  const missing = SYNC_FALSE_KEYS.filter((k) => !keys.includes(k));
  const extra = keys.filter((k) => !SYNC_FALSE_KEYS.includes(k));
  const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (missing.length) e.push(`env file: missing ${missing.join(', ')}`);
  if (extra.length) e.push(`env file: not a sync:false key of render.yaml: ${extra.join(', ')}`);
  if (dup.length) e.push(`env file: duplicate ${[...new Set(dup)].join(', ')}`);
  return e;
}

// ── main ─────────────────────────────────────────────────────────────────────
function load() {
  const render = parseYaml(inRepo('render.yaml'));
  const pkg = JSON.parse(readFileSync(inRepo('package.json'), 'utf8'));
  const ciFile = [inRepo('.github/workflows/ci.yml')].find((f) => existsSync(f));
  const web = (render?.services ?? []).find((s) => s.type === 'web');
  return {
    render,
    envKeys: backendEnvKeys(readFileSync(inRepo('src/config/env.ts'), 'utf8')),
    backendScripts: pkg.scripts ?? {},
    engines: pkg.engines ?? {},
    rootDir: ROOT_DIR,
    ci: ciFile ? parseYaml(ciFile) : null,
    renderNodeVersion: (web?.envVars ?? []).find((v) => v.key === 'NODE_VERSION')?.value,
    exists: existsSync,
  };
}

function runAll(c) {
  return [...checkRender(c.render, c), ...checkNoDocker(c.exists), ...checkCi(c.ci, c)];
}

function selfTest(c) {
  const web = (x) => x.render.services[0];
  const envVar = (x, k) => web(x).envVars.find((v) => v.key === k);
  const dropVar = (x, k) => { web(x).envVars = web(x).envVars.filter((v) => v.key !== k); };
  const backendJob = (x) => Object.values(x.ci.jobs).find((j) => j.env?.TEST_DATABASE_URL);
  const cases = {
    'worker service added': (x) => { x.render.services.push({ type: 'worker', name: 'whereismybus-worker', runtime: 'node' }); },
    'keyvalue added': (x) => { x.render.services.push({ type: 'keyvalue', name: 'whereismybus-redis' }); },
    'envVarGroups added': (x) => { x.render.envVarGroups = [{ name: 'g', envVars: [] }]; },
    'docker runtime': (x) => { web(x).runtime = 'docker'; },
    'dockerfilePath set': (x) => { web(x).dockerfilePath = './Dockerfile'; },
    'wrong region': (x) => { web(x).region = 'singapore'; },
    'scaled out': (x) => { web(x).numInstances = 2; },
    'rootDir wrong': (x) => { web(x).rootDir = x.rootDir ? '.' : 'backend'; },
    'build without dev deps': (x) => { web(x).buildCommand = 'npm ci && npm run build'; },
    'build skips postinstall': (x) => { web(x).buildCommand = 'npm ci --include=dev --ignore-scripts && npm run build'; },
    'build cds': (x) => { web(x).buildCommand = 'cd backend && npm ci --include=dev && npm run build'; },
    'start without release': (x) => { web(x).startCommand = 'npm start'; },
    'release after start': (x) => { web(x).startCommand = 'npm start && npm run release'; },
    'release not chained': (x) => { web(x).startCommand = 'npm run release; npm start'; },
    'release without bootstrap': (x) => { x.backendScripts = { ...x.backendScripts, release: 'node dist/db/migrate.js up && node dist/db/setupRoles.js' }; },
    'health check removed': (x) => { delete web(x).healthCheckPath; },
    'autoDeploy off': (x) => { web(x).autoDeploy = false; },
    'secret inlined': (x) => { delete envVar(x, 'DB_PASSWORD').sync; envVar(x, 'DB_PASSWORD').value = 'x'; },
    'unknown env key': (x) => { web(x).envVars.push({ key: 'CORS_ORIGIN', sync: false }); },
    'duplicate env key': (x) => { web(x).envVars.push({ key: 'NODE_ENV', value: 'production' }); },
    'REDIS_URL added': (x) => { web(x).envVars.push({ key: 'REDIS_URL', sync: false }); },
    'single instance off': (x) => { envVar(x, 'SINGLE_INSTANCE').value = 'false'; },
    'jobs not in process': (x) => { envVar(x, 'JOBS_IN_PROCESS').value = 'false'; },
    'spoofable TRUST_PROXY': (x) => { envVar(x, 'TRUST_PROXY').value = '2'; },
    'console SMS': (x) => { envVar(x, 'SMS_PROVIDER').value = 'console'; },
    'local storage': (x) => { envVar(x, 'STORAGE_DRIVER').value = 'local'; },
    'DB_NAME missing': (x) => { dropVar(x, 'DB_NAME'); },
    'JWT secret generated': (x) => { delete envVar(x, 'JWT_ACCESS_SECRET').sync; envVar(x, 'JWT_ACCESS_SECRET').generateValue = true; },
    'sync:false key missing': (x) => { dropVar(x, 'GOOGLE_MAPS_SERVER_KEY'); },
    'allow-list without numbers': (x) => { dropVar(x, 'SMS_DEV_ALLOWED_NUMBERS'); },
    'node version below engines': (x) => { envVar(x, 'NODE_VERSION').value = '18.20.0'; },
    'Dockerfile reintroduced': (x) => { x.exists = (p) => p === inRepo('Dockerfile') || existsSync(p); },
    'docker-compose reintroduced': (x) => { x.exists = (p) => p === inRepo('docker-compose.yml') || existsSync(p); },
    'ci.yml missing': (x) => { x.ci = null; },
    'ci node version drift': (x) => { x.ci.env.NODE_VERSION = '20.0.0'; },
    'ci checker step removed': (x) => { for (const j of Object.values(x.ci.jobs)) j.steps = (j.steps ?? []).filter((s) => !/check-render-config/.test(String(s.run ?? ''))); },
    'ci backend tests skipped': (x) => { const b = backendJob(x); b.steps = b.steps.filter((s) => !/^npm (run )?test\b/m.test(String(s.run ?? ''))); },
    'ci monorepo install': (x) => { backendJob(x).steps.push({ run: 'npm --prefix ../packages/shared ci --include=dev' }); },
    'ci redis service': (x) => { backendJob(x).services = { ...backendJob(x).services, redis: { image: 'redis:7' } }; },
    'ci remote test database': (x) => { backendJob(x).env.TEST_DATABASE_URL = 'postgresql://u:p@ep-x.us-east-1.aws.neon.tech/whereismybus_test'; },
    'ci unknown npm script': (x) => { backendJob(x).steps.push({ run: 'npm run typecheck:all' }); },
  };
  let failed = 0;
  for (const [name, mutate] of Object.entries(cases)) {
    const x = { ...structuredClone({ render: c.render, ci: c.ci, backendScripts: c.backendScripts, engines: c.engines }), envKeys: c.envKeys, rootDir: c.rootDir, exists: c.exists };
    mutate(x);
    x.renderNodeVersion = (x.render.services?.[0]?.envVars ?? []).find((v) => v.key === 'NODE_VERSION')?.value;
    if (name === 'ci node version drift') x.renderNodeVersion = c.renderNodeVersion;
    const caught = runAll(x).length > 0;
    console.log(`${caught ? 'ok  ' : 'MISS'} ${name}`);
    if (!caught) failed++;
  }
  // The env-file check, on synthetic content (never a real file).
  const good = SYNC_FALSE_KEYS.map((k) => `${k}=v`).join('\n');
  for (const [name, text, expectErrors] of [
    ['env file complete', good, false],
    ['env file missing key', good.split('\n').slice(1).join('\n'), true],
    ['env file extra key', `${good}\nREDIS_URL=v`, true],
    ['env file empty value', good.replace('DB_HOST=v', 'DB_HOST='), true],
  ]) {
    const ok = (checkEnvFile(text).length > 0) === expectErrors;
    console.log(`${ok ? 'ok  ' : 'MISS'} ${name}`);
    if (!ok) failed++;
  }
  return failed;
}

const c = load();
if (process.argv.includes('--self-test')) {
  const base = runAll(c);
  if (base.length) { console.error('Current config has errors; fix them first:\n' + base.join('\n')); process.exit(1); }
  process.exit(selfTest(c) ? 1 : 0);
}
const errors = runAll(c);
const envFlag = process.argv.indexOf('--env-file');
if (envFlag > 0) {
  const file = path.resolve(process.argv[envFlag + 1] ?? '');
  errors.push(...(existsSync(file) ? checkEnvFile(readFileSync(file, 'utf8')) : [`env file ${file} not found`]));
}
if (errors.length) {
  console.error(`Deployment config: ${errors.length} problem(s)\n- ${errors.join('\n- ')}`);
  process.exit(1);
}
const web = c.render.services[0];
console.log(`Deployment config OK (render.yaml: ${web.type}:${web.name}, runtime ${web.runtime}, rootDir ${web.rootDir ?? '.'}, ${web.envVars.length} env vars, ${SYNC_FALSE_KEYS.length} sync:false; no Docker files; ci.yml jobs: ${Object.keys(c.ci.jobs).join(', ')}${envFlag > 0 ? '; env file OK' : ''})`);
