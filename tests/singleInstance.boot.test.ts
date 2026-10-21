// Single-instance production (the Render Blueprint): the real API entry point (src/server.ts) boots
// with NODE_ENV=production, SINGLE_INSTANCE=true, JOBS_IN_PROCESS=true and NO REDIS_URL against the
// test database, then serves /healthz + /readyz (redis skipped), a Socket.IO connection that joins a
// room, and an on-demand job that runs on the in-process runner. Every variable the backend reads is
// passed explicitly (empty unless set below), so nothing from backend/.env or .env.local reaches the
// child; S3 and SMS settings are well-formed fakes on the reserved .invalid domain (never contacted
// by this flow; an accidental call cannot resolve).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import config, { ROOT_DIR, SINGLE_INSTANCE_WARNING } from '../src/config/index.js';
import { envSchema } from '../src/config/env.js';
import { rooms } from '../src/shared/realtime.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { PASSWORD, passwordHash } from './helpers/authApp.js';
import { TEST_APP_PASSWORD, TEST_APP_ROLE } from './helpers/testEnv.js';

const TSX = path.join(ROOT_DIR, 'node_modules', '.bin', 'tsx');
const METRICS_TOKEN = 'single-instance-metrics-token-0123456789';
const JWT_SECRET = 'single-instance-boot-test-secret-0123456789abcdef';

let child: ChildProcess | null = null;
let base = '';
let output = '';
let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
let schoolId = '';
let adminEmail = '';
let busId = '';
const sockets: ClientSocket[] = [];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

/** Every key of the env schema set to '' (blocks backend/.env*), then the production settings. */
function childEnv(port: number): NodeJS.ProcessEnv {
  const owner = config.testDb.owner!;
  const blank = Object.fromEntries(Object.keys(envSchema.shape).map((k) => [k, '']));
  const db = owner.connectionString
    ? { DATABASE_URL: owner.connectionString }
    : { DB_HOST: owner.host ?? '', DB_PORT: String(owner.port ?? 5432), DB_USER: owner.user ?? '', DB_PASSWORD: owner.password ?? '', DB_NAME: owner.database, DB_SSL: owner.ssl ? 'true' : 'false' };
  return {
    ...blank,
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    NODE_ENV: 'production',
    PORT: String(port),
    LOG_LEVEL: 'info',
    ...db,
    DB_APP_USER: TEST_APP_ROLE,
    DB_APP_PASSWORD: TEST_APP_PASSWORD,
    DB_POOL_MAX: '4',
    JWT_ACCESS_SECRET: JWT_SECRET,
    CORS_ORIGINS: 'https://admin.example.org',
    APP_PUBLIC_URL: 'https://admin.example.org',
    TRUST_PROXY: '1',
    RATE_LIMIT_ENABLED: 'true',
    SINGLE_INSTANCE: 'true',
    JOBS_IN_PROCESS: 'true',
    REDIS_URL: '',
    STORAGE_DRIVER: 's3',
    S3_PROVIDER: 'linode',
    AWS_REGION: 'in-maa-1',
    S3_ENDPOINT: 'https://s3.example.invalid',
    S3_KEY_PREFIX: 'whereismybus-test/',
    AWS_BUCKET_NAME: 'fake-bucket',
    AWS_ACCESS_KEY_ID: 'FAKEACCESSKEY',
    AWS_SECRET_ACCESS_KEY: 'fake-secret-access-key',
    SMS_PROVIDER: 'webpayservices',
    SMS_API_URL: 'https://sms.example.invalid/api/pushsms.php',
    SMS_API_USERNAME: 'fake-user',
    SMS_API_KEY: 'fake-sms-api-key',
    SMS_SENDER_ID: 'WIMBUS',
    SMS_ROUTE: 'OTP',
    SMS_DLT_TEMPLATE_ID: '1707170000000000001',
    SMS_OTP_MESSAGE: '{otp} is your Where Is My Bus login code. It is valid for 10 minutes. Do not share it.',
    SMS_ALLOWLIST_ONLY: 'true',
    SMS_DEV_ALLOWED_NUMBERS: '+919900000001',
    PLATFORM_ADMIN_EMAIL: 'founder@example.org',
    METRICS_TOKEN,
  };
}

const http = (p: string, init: RequestInit = {}) => fetch(`${base}${p}`, { ...init, signal: AbortSignal.timeout(10_000) });
const json = async (res: Response) => (await res.json()) as { success: boolean; data?: Record<string, unknown>; error?: { code: string } };

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs: number, everyMs = 250): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (exited) throw new Error(`the API exited (${JSON.stringify(exited)}) while waiting for ${what}:\n${output.slice(-4000)}`);
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* not yet */
    }
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}:\n${output.slice(-4000)}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

async function login(): Promise<string> {
  const res = await http('/api/v1/auth/school/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: adminEmail, password: PASSWORD }) });
  const body = await json(res);
  if (res.status !== 200) throw new Error(`login failed ${res.status} ${JSON.stringify(body)}`);
  return body.data!.accessToken as string;
}

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  const fx = await f.twoSchoolFixture();
  await ownerQuery('update users set password_hash = $1 where id = $2', [await passwordHash(), fx.a.admin.id]);
  schoolId = fx.a.school.id;
  adminEmail = String(fx.a.admin.email);
  busId = fx.a.bus.id;

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(TSX, ['src/server.ts'], { cwd: ROOT_DIR, env: childEnv(port), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.on('data', (d: Buffer) => (output += d.toString()));
  child.stderr!.on('data', (d: Buffer) => (output += d.toString()));
  child.once('exit', (code, signal) => (exited = { code, signal }));
  await waitFor('/healthz', async () => (await http('/healthz')).status === 200, 60_000);
}, 90_000);

afterAll(async () => {
  for (const s of sockets) s.close();
  if (child && !exited) {
    const done = new Promise((r) => child!.once('exit', r));
    child.kill('SIGTERM');
    await Promise.race([done, new Promise((r) => setTimeout(r, 15_000))]);
    if (!exited) child.kill('SIGKILL');
  }
  await closeDb();
}, 30_000);

describe('production boot without Redis (SINGLE_INSTANCE=true)', () => {
  it('starts with one single-instance WARN and one SMS allow-list WARN', () => {
    const lines = output.split('\n').filter(Boolean).map((l) => {
      try {
        return JSON.parse(l) as { level?: number; msg?: string; config?: { env?: string; redisEnabled?: boolean; singleInstance?: boolean; jobsInProcess?: boolean } };
      } catch {
        return {};
      }
    });
    const summary = lines.find((l) => l.config)?.config;
    expect(summary).toMatchObject({ env: 'production', redisEnabled: false, singleInstance: true, jobsInProcess: true });
    expect(lines.filter((l) => l.msg === SINGLE_INSTANCE_WARNING && l.level === 40)).toHaveLength(1);
    expect(lines.filter((l) => l.level === 40 && l.msg?.startsWith('SMS_ALLOWLIST_ONLY=true'))).toHaveLength(1);
    expect(output).toContain('In-process job schedules started');
    expect(output).not.toMatch(/ECONNREFUSED.*6379|ioredis/i);
    // Secrets passed to the child never reach its log.
    for (const secret of [JWT_SECRET, 'fake-sms-api-key', 'fake-secret-access-key', TEST_APP_PASSWORD]) expect(output).not.toContain(secret);
  });

  it('answers /healthz and /readyz with 200; readiness reports Redis as skipped', async () => {
    const health = await http('/healthz');
    expect(health.status).toBe(200);
    const ready = await http('/readyz');
    const body = await json(ready);
    expect(ready.status).toBe(200);
    expect(body.data).toMatchObject({ status: 'ready', checks: { database: { ok: true }, redis: { ok: true, skipped: true }, migrations: { ok: true } } });
  });

  it('accepts a Socket.IO connection that joins its school fleet room (in-memory adapter)', async () => {
    const token = await login();
    const socket = connect(`${base}/rt`, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', (err) => reject(err));
    });
    const ack = (await socket.timeout(5000).emitWithAck('join', { room: rooms.schoolFleet(schoolId) })) as { ok: boolean; room?: string };
    expect(ack).toEqual({ ok: true, room: `school:${schoolId}:fleet` });
  });

  it('runs an on-demand job on the in-process runner (maintenance-due-refresh after a new maintenance log)', async () => {
    const token = await login();
    const today = (await ownerQuery<{ d: string }>("select to_char((now() at time zone 'Asia/Kolkata')::date - 1, 'YYYY-MM-DD') as d")).rows[0]!.d;
    const res = await http('/api/v1/school/maintenance-logs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ busId, serviceType: 'Brake check', serviceDate: today, cost: 1500 }),
    });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    const line = await waitFor(
      'a successful maintenance-due-refresh run in /metrics',
      async () => {
        const m = await http('/metrics', { headers: { authorization: `Bearer ${METRICS_TOKEN}` } });
        if (m.status !== 200) return null;
        return (await m.text()).split('\n').find((l) => l.startsWith('wimb_job_runs_total{') && l.includes('job="maintenance-due-refresh"') && l.includes('outcome="success"') && Number(l.split(' ').pop()) >= 1);
      },
      20_000,
    );
    expect(line).toBeTruthy();
  });

  it('refuses to start the separate worker in single-instance mode (jobs would run twice)', async () => {
    const r = spawnSync(TSX, ['src/worker.ts'], { cwd: ROOT_DIR, env: childEnv(await freePort()), encoding: 'utf8', timeout: 60_000 });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}\n${r.stderr}`).toContain('SINGLE_INSTANCE=true: jobs run inside the API process');
  });

  it('refuses production without Redis when SINGLE_INSTANCE is off', async () => {
    const r = spawnSync(TSX, ['src/server.ts'], { cwd: ROOT_DIR, env: { ...childEnv(await freePort()), SINGLE_INSTANCE: 'false' }, encoding: 'utf8', timeout: 60_000 });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}\n${r.stderr}`).toMatch(/REDIS_URL is required in production/);
  });
});
