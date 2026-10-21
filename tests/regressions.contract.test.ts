// Regression suite — contract & robustness (contract §3/§4/§5/§8, BP §6.2/§7.2/§11.2).
// Each test pins a defect found by independent verification of the v2 foundation and fixed since:
// idempotency claims survive client disconnects, late school-cron ticks catch up, the seed CLI and
// the test harness refuse remote databases before connecting, core-schema SQLSTATEs map to contract
// codes, audit redaction is word-based, date defaults are school-local, trip-level notification
// events are deduplicated, location_points always has a partition, and repositories never import a
// pool.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import config, { type DbConnection, ROOT_DIR } from '../src/config/index.js';
import { assertSeedable } from '../src/db/seed.js';
import { withPlatform, withTenant } from '../src/db/tenant.js';
import { JOB_DEFINITIONS, partitionMaintenance, runBootMaintenance } from '../src/jobs/index.js';
import { defineSchoolCronJob } from '../src/jobs/registry.js';
import { createSchoolCronDispatcher } from '../src/jobs/schoolCron.js';
import { errorHandler, toAppError } from '../src/middleware/errorHandler.js';
import { idempotency } from '../src/middleware/idempotency.js';
import { requestId } from '../src/middleware/requestId.js';
import { redactSecrets } from '../src/shared/audit.js';
import { createIdempotencyStore } from '../src/shared/idempotency.js';
import { createMemoryKv } from '../src/shared/kv.js';
import { logger } from '../src/shared/logger.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as F from './helpers/factories.js';

const TSX = path.join(ROOT_DIR, 'node_modules', '.bin', 'tsx');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
});

afterAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  await closeDb();
});

// ── 1. Idempotency-Key (contract §5, BP §7.2) ─────────────────────────────────────────────────
describe('idempotency: a dropped connection never lets a retry run the create twice', () => {
  it('keeps the in-flight claim when the client disconnects mid-request', async () => {
    const store = createIdempotencyStore(createMemoryKv());
    let executions = 0;
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const app = express();
    app.use(requestId());
    app.use(express.json());
    app.use((req, _res, next) => {
      req.auth = {
        sessionId: '11111111-1111-4111-8111-111111111111',
        ownerType: 'user',
        actorId: '22222222-2222-4222-8222-222222222222',
        role: 'driver',
        schoolId: '33333333-3333-4333-8333-333333333333',
        deviceId: null,
        actorName: null,
        mustChangePassword: false,
        tokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
      next();
    });
    app.post('/create', idempotency({ store }), async (_req, res) => {
      executions += 1;
      if (executions === 1) await gate; // first attempt is slow (e.g. S3 upload, busy DB)
      res.status(201).json({ success: true, data: { n: executions } });
    });
    app.use(errorHandler());
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    const { port } = server.address() as AddressInfo;
    const body = JSON.stringify({ reading: 1234.5 });
    try {
      // Attempt 1: the mobile network drops while the server is still working.
      const first = http.request({
        host: '127.0.0.1',
        port,
        path: '/create',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Idempotency-Key': 'retry-key-0001' },
      });
      first.on('error', () => undefined);
      first.end(body);
      for (let i = 0; i < 100 && executions === 0; i += 1) await sleep(10);
      expect(executions).toBe(1);
      first.destroy();
      await sleep(150);

      // Attempt 2: the app retries with the SAME key (exactly what Idempotency-Key exists for).
      const retry = await request(server).post('/create').set('Idempotency-Key', 'retry-key-0001').set('Content-Type', 'application/json').send(body);
      expect(executions, 'the retry executed the non-idempotent create a second time').toBe(1);
      expect(retry.status).toBe(409);
      expect(retry.body.error.details.reason).toBe('IDEMPOTENCY_IN_PROGRESS');
    } finally {
      releaseFirst();
      await sleep(20);
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

// ── 2. School-local cron dispatch (contract §8: generate-daily-trips at 00:05 school-local) ───
describe('school-cron dispatcher: a late dispatcher tick still dispatches the missed school-local run', () => {
  it('still enqueues the 00:05 IST run when the 00:05 tick is processed a minute late', async () => {
    const enqueued: { name: string; payload: unknown }[] = [];
    const def = defineSchoolCronJob({ name: 'generate-daily-trips', cron: '5 0 * * *', handler: async () => undefined });
    // Ticks as a BullMQ worker sees them after a short backlog/restart: 00:04 IST on time, then the
    // 00:05 tick is only picked up at 00:06:00.2 IST.
    const clock = [new Date('2026-10-17T18:34:00.100Z'), new Date('2026-10-17T18:36:00.200Z')];
    let tick = 0;
    const dispatcher = createSchoolCronDispatcher({
      defs: [def],
      loadSchools: async () => [{ schoolId: '44444444-4444-4444-8444-444444444444', timezone: 'Asia/Kolkata' }],
      enqueue: async (name, payload) => {
        enqueued.push({ name, payload });
      },
      now: () => clock[Math.min(tick, clock.length - 1)]!,
    });
    const ctx = { name: dispatcher.name, jobId: 'x', attempt: 1, logger, signal: new AbortController().signal };
    await dispatcher.handler(ctx);
    tick = 1;
    await dispatcher.handler(ctx);
    expect(enqueued.map((e) => e.name), 'generate-daily-trips for 2026-10-18 was silently skipped').toContain('generate-daily-trips');
  });
});

// ── 3. Seed CLI safety (backend/.env holds PRODUCTION credentials) ──────────────────────────────
describe('seed CLI refuses a remote database outside production', () => {
  it('does not connect to a non-local host with NODE_ENV=development', () => {
    const remote = 'postgresql://wimb@seed-target.invalid:5432/whereismybus';
    const r = spawnSync(TSX, ['src/db/seed.ts'], {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        // A real env var wins over backend/.env.local (which may set ALLOW_REMOTE_DEV_DB=true for the
        // remote dev DB), so the guard is exercised on every checkout, not only in CI.
        ALLOW_REMOTE_DEV_DB: 'false',
        DATABASE_URL: remote,
        DATABASE_APP_URL: 'postgresql://wimb_app:x@seed-target.invalid:5432/whereismybus',
        LOG_LEVEL: 'silent',
      },
    });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out, 'seed tried to reach the remote host (demo data + known super-admin password would be written)').not.toMatch(/ENOTFOUND|getaddrinfo/);
    expect(out).toMatch(/refus/i);
    expect(r.status).not.toBe(0);
  });

  it('only --force or ALLOW_REMOTE_DEV_DB=true lets a non-production seed past a remote host', () => {
    const remote: DbConnection = { source: 'test', host: 'seed-target.invalid', user: 'wimb', database: 'whereismybus', ssl: undefined, max: 1 };
    const local: DbConnection = { ...remote, host: 'localhost' };
    expect(() => assertSeedable(remote, { isProduction: false, force: false, allowRemote: false })).toThrow(/Refusing to seed "whereismybus"/);
    expect(() => assertSeedable(remote, { isProduction: false, force: false, allowRemote: true })).not.toThrow();
    expect(() => assertSeedable(remote, { isProduction: false, force: true, allowRemote: false })).not.toThrow();
    expect(() => assertSeedable(local, { isProduction: false, force: false, allowRemote: false })).not.toThrow();
    // Production ignores ALLOW_REMOTE_DEV_DB: only --force seeds it.
    expect(() => assertSeedable(local, { isProduction: true, force: false, allowRemote: true })).toThrow(/NODE_ENV=production/);
    expect(() => assertSeedable(null, { isProduction: false, force: true, allowRemote: true })).toThrow(/not configured/);
  });

  it('the test process never inherits ALLOW_REMOTE_DEV_DB from backend/.env.local', () => {
    expect(process.env.ALLOW_REMOTE_DEV_DB).toBe('false');
    expect(config.allowRemoteDevDb).toBe(false);
  });
});

// ── 4. Test harness safety (globalSetup header: "REFUSES unless … the host is local") ──────────
describe('test globalSetup refuses a remote test database before connecting', () => {
  it('rejects a non-local TEST_DATABASE_URL without opening a connection to it', () => {
    const gs = path.join(ROOT_DIR, 'tests', 'helpers', 'globalSetup.ts');
    const code = `import(${JSON.stringify(gs)}).then((m) => m.default()).then(() => { console.log('SETUP-OK'); process.exit(0); }, (e) => { console.error('SETUP-ERR ' + (e && e.message)); process.exit(1); })`;
    const r = spawnSync(TSX, ['-e', code], {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, TEST_DATABASE_URL: 'postgresql://postgres@test-target.invalid:5432/whereismybus_test' },
    });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status).not.toBe(0);
    expect(out, 'globalSetup connected to the remote server (and may CREATE DATABASE there) before the localhost guard').not.toMatch(/ENOTFOUND|getaddrinfo/);
    expect(out).toMatch(/localhost/);
  });
});

// ── 5. Error envelope mapping (contract §5) ──────────────────────────────────────────────────
describe('errorHandler maps the SQLSTATEs the core schema raises', () => {
  it('platform_create_school_admin on an unknown school → 404 NOT_FOUND, not 500', async () => {
    const err = await withPlatform({ actorId: null }, (tx) =>
      tx.query("select platform_create_school_admin($1::uuid, 'Admin', 'nobody@school.test'::citext, 'hash')", ['55555555-5555-4555-8555-555555555555']),
    ).then(
      () => null,
      (e: unknown) => e as { code?: string },
    );
    expect(err?.code).toBe('P0002');
    const mapped = toAppError(err);
    expect(mapped.code, 'P0002 (no_data_found) must map to NOT_FOUND').toBe('NOT_FOUND');
    expect(mapped.status).toBe(404);
  });
});

// ── 6. Audit redaction (contract §5: secrets redacted — but not ordinary BP columns) ──────────
describe('audit redaction keeps ordinary business fields', () => {
  it('does not redact schools.pincode (BP §6.2) or passenger/compass-like names', () => {
    const out = redactSecrets({ pincode: '560001', passengerCount: 32, password: 'x' }) as Record<string, unknown>;
    expect(out.password).toBe('[REDACTED]');
    expect(out.pincode, 'school address pincode is lost from the audit trail').toBe('560001');
    expect(out.passengerCount).toBe(32);
  });
});

// ── 7. Session TimeZone independence (contract §3) ───────────────────────────────────────────
describe('column defaults never depend on the session TimeZone (contract §3)', () => {
  it('student_assignments.valid_from defaults to the school-local date under any session TimeZone', async () => {
    const s = await F.school();
    const b = await F.bus(s.id);
    const r = await F.route(s.id, { direction: 'morning' });
    const st = await F.stop(s.id, r.id);
    const kids = [await F.student(s.id), await F.student(s.id)];
    const zones = ['Pacific/Kiritimati', 'Etc/GMT+12']; // UTC+14 / UTC-12: at least one always differs from IST
    const results: { tz: string; valid_from: string; local: string }[] = [];
    for (const [i, tz] of zones.entries()) {
      const row = await withTenant({ schoolId: s.id, actorId: null, role: 'school_admin' }, async (tx) => {
        await tx.query(`set local timezone = '${tz}'`);
        return tx.one<{ valid_from: string; local: string }>(
          `insert into student_assignments (school_id, student_id, trip_direction, bus_id, route_id, stop_id)
           values ($1, $2, 'morning', $3, $4, $5) returning valid_from::text as valid_from, app_local_date()::text as local`,
          [s.id, kids[i]!.id, b.id, r.id, st.id],
        );
      });
      results.push({ tz, ...row });
    }
    for (const r2 of results) expect(r2.valid_from, `default current_date under ${r2.tz} ≠ school-local date`).toBe(r2.local);
  });
});

// ── 8. Notification dedupe (BP §11.2: one per event per trip) ────────────────────────────────
describe('notification_events dedupe', () => {
  it('rejects a duplicate (trip, event) when student_id is NULL', async () => {
    const s = await F.school();
    const b = await F.bus(s.id);
    const t = await F.trip(s.id, b.id);
    await F.notificationEvent(s.id, t.id, { event_type: 'trip_delayed', student_id: null });
    const second = await F.notificationEvent(s.id, t.id, { event_type: 'trip_delayed', student_id: null }).then(
      () => null,
      (e: unknown) => e as { code?: string },
    );
    expect(second?.code, 'a second identical trip-level event was stored (NULLs are distinct in UNIQUE)').toBe('23505');
  });
});

// ── 9. location_points partitions (contract §3/§8: partitions created ahead by a job) ────────
describe('location_points partition coverage', () => {
  it('a partition-maintenance job is registered', () => {
    expect(JOB_DEFINITIONS.map((d) => d.name)).toContain('partition-maintenance');
  });

  it('accepts a point recorded beyond the pre-created monthly partitions', async () => {
    const s = await F.school();
    const b = await F.bus(s.id);
    const t = await F.trip(s.id, b.id);
    const err = await ownerQuery(
      `insert into location_points (school_id, trip_id, recorded_at, latitude, longitude)
       values ($1, $2, date_trunc('month', now() at time zone 'UTC') at time zone 'UTC' + interval '3 months 1 hour', 12.97, 77.59)`,
      [s.id, t.id],
    ).then(
      () => null,
      (e: unknown) => e as { code?: string; message?: string },
    );
    expect(err, `ingestion fails once the pre-created window ends: ${err?.message ?? ''}`).toBeNull();
  });
});

describe('partition-maintenance (location_partition_maintenance, migration 014)', () => {
  const placeOf = async (tripId: string, at: string) =>
    (await ownerQuery<{ part: string }>('select tableoid::regclass::text as part from location_points where trip_id = $1 and recorded_at = $2', [tripId, at])).rows[0]?.part;

  it('moves DEFAULT-partition rows into the month it creates, drops expired months and purges expired default rows', async () => {
    const s = await F.school();
    const b = await F.bus(s.id);
    const t = await F.trip(s.id, b.id);
    const monthStart = (offset: number) => {
      const d = new Date();
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1));
    };
    const ahead = new Date(monthStart(5).getTime() + 3_600_000).toISOString();
    const ancient = '2001-02-03T04:05:06.000Z';
    const insert = `insert into location_points (school_id, trip_id, recorded_at, latitude, longitude) values ($1, $2, $3, 12.97, 77.59)`;
    await ownerQuery(insert, [s.id, t.id, ahead]);
    await ownerQuery(insert, [s.id, t.id, ancient]);
    expect(await placeOf(t.id, ahead)).toBe('location_points_default');
    // An expired month partition (24 months back) that retention (12 months) must drop.
    const expired = monthStart(-24).toISOString().slice(0, 10);
    const expiredName = `location_points_${expired.slice(0, 4)}_${expired.slice(5, 7)}`;
    await withTenant({ schoolId: null, actorId: null, role: 'system' }, (tx) => tx.query('select create_location_partitions($1::date, 1)', [expired]));

    const result = await partitionMaintenance({ monthsAhead: 7 });
    const aheadName = `location_points_${ahead.slice(0, 4)}_${ahead.slice(5, 7)}`;
    expect(result.created).toContain(aheadName);
    expect(result.dropped).toContain(expiredName);
    expect(result.retentionMonths).toBe(12);
    expect(await placeOf(t.id, ahead)).toBe(aheadName);
    expect(await placeOf(t.id, ancient)).toBeUndefined();
    const left = await ownerQuery<{ n: number }>('select count(*)::int as n from location_points_default');
    expect(result.defaultRows).toBe(left.rows[0]!.n);

    // Idempotent: a second pass creates and drops nothing.
    const again = await partitionMaintenance({ monthsAhead: 7 });
    expect({ created: again.created, dropped: again.dropped }).toEqual({ created: [], dropped: [] });
  });

  it('the boot run never throws', async () => {
    await expect(runBootMaintenance()).resolves.toBeUndefined();
  });

  it('maps a missing-partition insert to retryable 503 SERVICE_UNAVAILABLE, not 400', () => {
    const err = Object.assign(new Error('no partition of relation "location_points" found for row'), { code: '23514', severity: 'ERROR' });
    expect(toAppError(err).code).toBe('SERVICE_UNAVAILABLE');
  });
});

describe('school_subscriptions.valid_from defaults to the school-local date', () => {
  it('uses the school timezone even when the platform session runs in another TimeZone', async () => {
    const s = await F.school({ timezone: 'Pacific/Kiritimati' });
    const row = await withPlatform({ actorId: null }, async (tx) => {
      await tx.query("set local timezone = 'Etc/GMT+12'");
      return tx.one<{ valid_from: string; expected: string }>(
        `insert into school_subscriptions (school_id, plan) values ($1, 'standard')
         returning valid_from::text as valid_from, (now() at time zone 'Pacific/Kiritimati')::date::text as expected`,
        [s.id],
      );
    });
    expect(row.valid_from).toBe(row.expected);
  });
});

// ── 10. Repositories never import the global pool (contract §4, BP §7.1) ───────────────────────
describe('repositories receive tx only', () => {
  it('no src/modules/*/repository.ts imports getAppPool/getOwnerPool', () => {
    const modulesDir = path.join(ROOT_DIR, 'src', 'modules');
    const offenders = fs
      .readdirSync(modulesDir)
      .map((m) => path.join(modulesDir, m, 'repository.ts'))
      .filter((f) => fs.existsSync(f) && /\bget(App|Owner)Pool\b/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT_DIR, f));
    expect(offenders).toEqual([]);
  });
});
