// Wave-4 adversarial tests — fuel logs, maintenance logs, service due list, reports and the school
// dashboard (BP §2.2 "fuel, maintenance, reports: school admin only", §4.9 isolation suite, §8.3).
// Attacks: every endpoint with every other principal (driver, conductor, the two-school parent with
// X-School-Id of either school, super admin, anonymous), school B's admin with school A's ids on every
// id/filter/export, files of another school / category / bus, concurrent links of one bill (race),
// mass assignment, writes on deleted logs, Idempotency-Key scoping and the reports feature flag on
// CSV/PDF exports (no partial download).
import crypto from 'node:crypto';
import { generate, generateSecret } from 'otplib';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encryptSecret } from '../src/shared/crypto.js';
import { buildApp, loginParent, loginSchoolAdmin, loginStaff, passwordHash, PASSWORD, DEVICE, type TestApp } from './helpers/authApp.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { drainJobs } from './helpers/trackingWorld.js';

let t: TestApp;
let fx: f.TwoSchoolFixture;
let today: string;
const tok: Record<'adminA' | 'adminB' | 'driverA' | 'conductorA' | 'parent' | 'superAdmin', string> = {} as never;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const REPORTS = ['bus-distance', 'fuel', 'maintenance', 'cost-per-km', 'service-due', 'non-school-usage', 'trip-summary'] as const;

const api = (p: string) => `/api/v1${p}`;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
function day(offset: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}
type Method = 'get' | 'post' | 'patch' | 'delete';
function call(method: Method, path: string, token: string | null, body?: object, headers: Record<string, string> = {}) {
  let r = request(t.app)[method](api(path));
  if (token) r = r.set(auth(token));
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  return body ? r.send(body) : r;
}
async function upload(entityId: string, { token = tok.adminA, category = 'fuel_bill', entityType = 'bus' } = {}) {
  return request(t.app).post(api('/files/upload')).set(auth(token)).field('category', category).field('entityType', entityType).field('entityId', entityId).attach('file', PDF, 'bill.pdf');
}
async function uploadOk(entityId: string, o: { token?: string; category?: string; entityType?: string } = {}): Promise<string> {
  const res = await upload(entityId, o);
  if (res.status !== 201) throw new Error(`upload failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.id as string;
}
const snapshot = async () =>
  (await ownerQuery("select 'f' as k, id, updated_at, deleted_at, bill_file_id as file from fuel_logs union all select 'm', id, updated_at, deleted_at, invoice_file_id from maintenance_logs order by 1, 2")).rows;

/** Every wave-4 endpoint (A's ids where an id is needed). */
function endpoints(): { method: Method; path: string; body?: object }[] {
  const a = fx.a;
  const fuelBody = { busId: a.bus.id, fuelDate: day(-1), litres: 10, cost: 900 };
  const maintBody = { busId: a.bus.id, serviceType: 'Oil change', serviceDate: day(-1) };
  return [
    { method: 'get', path: '/school/fuel-logs' },
    { method: 'get', path: '/school/fuel-logs?format=csv' },
    { method: 'post', path: '/school/fuel-logs', body: fuelBody },
    { method: 'get', path: `/school/fuel-logs/${a.fuelLog.id}` },
    { method: 'patch', path: `/school/fuel-logs/${a.fuelLog.id}`, body: { notes: 'pwned' } },
    { method: 'delete', path: `/school/fuel-logs/${a.fuelLog.id}` },
    { method: 'get', path: `/school/fuel-logs/mileage-trend?busId=${a.bus.id}` },
    { method: 'get', path: '/school/fuel-logs/mileage-summary?format=csv' },
    { method: 'get', path: '/school/maintenance-logs' },
    { method: 'post', path: '/school/maintenance-logs', body: maintBody },
    { method: 'get', path: `/school/maintenance-logs/${a.maintenanceLog.id}` },
    { method: 'patch', path: `/school/maintenance-logs/${a.maintenanceLog.id}`, body: { notes: 'pwned' } },
    { method: 'delete', path: `/school/maintenance-logs/${a.maintenanceLog.id}` },
    { method: 'get', path: '/school/maintenance-logs/due?format=csv' },
    { method: 'get', path: '/school/dashboard' },
    ...REPORTS.flatMap((k) => (['json', 'csv', 'pdf'] as const).map((fmt) => ({ method: 'get' as const, path: `/school/reports/${k}?format=${fmt}` }))),
  ];
}

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  fx = await f.twoSchoolFixture();
  await ownerQuery('update users set password_hash = $1 where id = any ($2)', [await passwordHash(), [fx.a.admin.id, fx.b.admin.id, fx.a.driverUser.id, fx.a.conductorUser.id]]);
  tok.adminA = (await loginSchoolAdmin(t.app, String(fx.a.admin.email))).accessToken;
  tok.adminB = (await loginSchoolAdmin(t.app, String(fx.b.admin.email))).accessToken;
  tok.driverA = (await loginStaff(t.app, String(fx.a.school.code), String(fx.a.driverUser.phone))).accessToken;
  tok.conductorA = (await loginStaff(t.app, String(fx.a.school.code), String(fx.a.conductorUser.phone), { ...DEVICE, deviceId: 'w4-conductor-0001' })).accessToken;
  tok.parent = (await loginParent(t, String(fx.sharedParent.phone))).accessToken;
  const secret = generateSecret();
  const su = await f.platformUser({ password_hash: await passwordHash(), totp_enabled: true, totp_secret_enc: encryptSecret(secret, { purpose: 'totp' }) });
  const login = await request(t.app).post(api('/auth/platform/login')).send({ email: su.email, password: PASSWORD, totpCode: await generate({ secret }) });
  if (login.status !== 200) throw new Error(`platform login failed ${login.status}`);
  tok.superAdmin = login.body.data.accessToken as string;
  today = (await ownerQuery<{ d: string }>("select to_char((now() at time zone 'Asia/Kolkata')::date, 'YYYY-MM-DD') as d")).rows[0]!.d;
});
afterAll(async () => {
  await drainJobs();
  await closeDb();
});

describe('role bypass (BP §2.2: fuel, maintenance, reports and the dashboard are school-admin only)', () => {
  it('drivers, conductors, the two-school parent (either X-School-Id), super admins and anonymous callers are refused everywhere; nothing changes', async () => {
    const before = await snapshot();
    const callers: [string, string | null, Record<string, string>, number][] = [
      ['driver', tok.driverA, {}, 403],
      ['conductor', tok.conductorA, {}, 403],
      ['parent→A', tok.parent, { 'X-School-Id': fx.a.school.id }, 403],
      ['parent→B', tok.parent, { 'X-School-Id': fx.b.school.id }, 403],
      ['parent', tok.parent, {}, 403],
      ['superAdmin', tok.superAdmin, {}, 403],
      ['anonymous', null, {}, 401],
      ['garbage token', 'not-a-token', {}, 401],
    ];
    for (const e of endpoints()) {
      for (const [who, token, headers, status] of callers) {
        const res = await call(e.method, e.path, token, e.body, headers);
        expect(res.status, `${who} ${e.method} ${e.path}`).toBe(status);
        expect(res.headers['content-type'], `${who} ${e.path}`).toMatch(/application\/json/);
        expect(res.body.success).toBe(false);
      }
    }
    expect(await snapshot()).toEqual(before);
    const audits = await ownerQuery("select 1 from audit_logs where action like 'fuel_log.%' or action like 'maintenance_log.%'");
    expect(audits.rowCount).toBe(0);
  });
});

describe("cross-school access (BP §4.9: A's ids with B's token → 404, nothing leaks)", () => {
  it("school B's admin gets 404 on every id endpoint of school A and changes nothing", async () => {
    const before = await snapshot();
    const a = fx.a;
    const cases: [Method, string, object?][] = [
      ['get', `/school/fuel-logs/${a.fuelLog.id}`],
      ['patch', `/school/fuel-logs/${a.fuelLog.id}`, { notes: 'pwned', litres: 1 }],
      ['delete', `/school/fuel-logs/${a.fuelLog.id}`],
      ['get', `/school/fuel-logs/mileage-trend?busId=${a.bus.id}`],
      ['post', '/school/fuel-logs', { busId: a.bus.id, fuelDate: day(-1), litres: 10, cost: 900 }],
      ['get', `/school/maintenance-logs/${a.maintenanceLog.id}`],
      ['patch', `/school/maintenance-logs/${a.maintenanceLog.id}`, { notes: 'pwned' }],
      ['delete', `/school/maintenance-logs/${a.maintenanceLog.id}`],
      ['post', '/school/maintenance-logs', { busId: a.bus.id, serviceType: 'Oil change', serviceDate: day(-1) }],
      // Moving B's own log onto A's bus.
      ['patch', `/school/fuel-logs/${fx.b.fuelLog.id}`, { busId: a.bus.id }],
      ['patch', `/school/maintenance-logs/${fx.b.maintenanceLog.id}`, { busId: a.bus.id }],
      ...REPORTS.flatMap((k) => (['json', 'csv', 'pdf'] as const).map((fmt): [Method, string] => ['get', `/school/reports/${k}?busId=${a.bus.id}&format=${fmt}`])),
    ];
    for (const [method, path, body] of cases) {
      const res = await call(method, path, tok.adminB, body);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    }
    expect(await snapshot()).toEqual(before);
  });

  it("filters and exports with school A's ids return only school B's (empty) data", async () => {
    const a = fx.a;
    const lists = [
      `/school/fuel-logs?busId=${a.bus.id}`,
      `/school/maintenance-logs?busId=${a.bus.id}`,
      `/school/maintenance-logs/due?busId=${a.bus.id}&status=overdue,due_soon,scheduled`,
    ];
    for (const path of lists) {
      const res = await call('get', path, tok.adminB);
      expect(res.status, path).toBe(200);
      expect(res.body.data, path).toEqual([]);
    }
    for (const path of ['/school/fuel-logs?format=csv', '/school/maintenance-logs?format=csv', '/school/fuel-logs/mileage-summary?format=csv', '/school/maintenance-logs/due?format=csv&status=overdue,due_soon,scheduled']) {
      const res = await call('get', path, tok.adminB);
      expect(res.status, path).toBe(200);
      for (const id of [a.fuelLog.id, a.maintenanceLog.id, a.bus.id]) expect(res.text, path).not.toContain(id);
    }
    const summary = await call('get', '/school/fuel-logs/mileage-summary', tok.adminB);
    expect(summary.body.data.map((r: { busId: string }) => r.busId)).not.toContain(a.bus.id);
    for (const k of REPORTS) {
      const res = await call('get', `/school/reports/${k}?from=${day(-30)}&to=${today}`, tok.adminB);
      expect(res.status, k).toBe(200);
      expect(JSON.stringify(res.body.data.rows), k).not.toContain(a.bus.id);
    }
    const dash = await call('get', '/school/dashboard', tok.adminB);
    expect(dash.status).toBe(200);
    expect(JSON.stringify(dash.body.data)).not.toContain(a.alert.id);
    expect(JSON.stringify(dash.body.data)).not.toContain(a.bus.id);
  });
});

describe('bill and invoice files', () => {
  it("another school's file, another category or another bus's file cannot be linked", async () => {
    const billA = await uploadOk(fx.a.bus.id);
    // B links A's file to its own log: RLS hides it → 404, and B's log keeps no bill.
    const b = await call('patch', `/school/fuel-logs/${fx.b.fuelLog.id}`, tok.adminB, { billFileId: billA });
    expect(b.status).toBe(404);
    const bCreate = await call('post', '/school/fuel-logs', tok.adminB, { busId: fx.b.bus.id, fuelDate: day(-1), litres: 10, cost: 900, billFileId: billA });
    expect(bCreate.status).toBe(404);
    const bMaint = await call('post', '/school/maintenance-logs', tok.adminB, { busId: fx.b.bus.id, serviceType: 'Brakes', serviceDate: day(-1), invoiceFileId: billA });
    expect(bMaint.status).toBe(404);
    // A uses a fuel bill as a maintenance invoice, or another bus's bill.
    const wrongCategory = await call('post', '/school/maintenance-logs', tok.adminA, { busId: fx.a.bus.id, serviceType: 'Brakes', serviceDate: day(-1), invoiceFileId: billA });
    expect(wrongCategory.status).toBe(400);
    const otherBus = await call('post', '/school/fuel-logs', tok.adminA, { busId: fx.a.otherBus.id, fuelDate: day(-1), litres: 10, cost: 900, billFileId: billA });
    expect(otherBus.status).toBe(400);
    expect((await ownerQuery('select 1 from fuel_logs where bill_file_id = $1 union all select 1 from maintenance_logs where invoice_file_id = $1', [billA])).rowCount).toBe(0);
  });

  it('only school admins upload bills; drivers, parents and school B cannot read them', async () => {
    expect((await upload(fx.a.bus.id, { token: tok.driverA })).status).toBe(403);
    const billA = await uploadOk(fx.a.bus.id);
    const log = await call('post', '/school/fuel-logs', tok.adminA, { busId: fx.a.bus.id, fuelDate: day(-2), litres: 11, cost: 990, billFileId: billA });
    expect(log.status).toBe(201);
    expect(JSON.stringify(log.body.data)).not.toMatch(/schools\/|whereismybus-test\//); // never a storage key
    expect((await call('get', `/files/${billA}/url`, tok.adminA)).status).toBe(200);
    expect([403, 404]).toContain((await call('get', `/files/${billA}/url`, tok.driverA)).status);
    expect((await call('get', `/files/${billA}/url`, tok.adminB)).status).toBe(404);
    expect([403, 404]).toContain((await call('get', `/parent/files/${billA}/url`, tok.parent, undefined, { 'X-School-Id': fx.a.school.id })).status);
    expect((await call('get', `/parent/files/${billA}/url`, tok.parent, undefined, { 'X-School-Id': fx.b.school.id })).status).toBe(404);
  });

  it('two concurrent requests linking one bill (or invoice) never attach it to two logs', async () => {
    const bill = await uploadOk(fx.a.bus.id);
    const body = (n: number) => ({ busId: fx.a.bus.id, fuelDate: day(-3), litres: 20 + n, cost: 1800, billFileId: bill });
    const results = await Promise.all([0, 1, 2, 3].map((n) => call('post', '/school/fuel-logs', tok.adminA, body(n))));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(3);
    for (const r of results.filter((x) => x.status === 409)) expect(r.body.error.code).toBe('CONFLICT');
    expect((await ownerQuery('select 1 from fuel_logs where bill_file_id = $1 and deleted_at is null', [bill])).rowCount).toBe(1);

    const invoice = await uploadOk(fx.a.bus.id, { category: 'maintenance_invoice' });
    const mres = await Promise.all([0, 1, 2].map((n) => call('post', '/school/maintenance-logs', tok.adminA, { busId: fx.a.bus.id, serviceType: `Race ${n}`, serviceDate: day(-3), invoiceFileId: invoice })));
    expect(mres.map((r) => r.status).filter((s) => s === 201)).toHaveLength(1);
    expect((await ownerQuery('select 1 from maintenance_logs where invoice_file_id = $1 and deleted_at is null', [invoice])).rowCount).toBe(1);
  });

  it('a soft-deleted log releases its bill for a new log', async () => {
    const bill = await uploadOk(fx.a.bus.id);
    const first = await call('post', '/school/fuel-logs', tok.adminA, { busId: fx.a.bus.id, fuelDate: day(-4), litres: 31, cost: 2790, billFileId: bill });
    expect(first.status).toBe(201);
    expect((await call('delete', `/school/fuel-logs/${first.body.data.id}`, tok.adminA)).status).toBe(200);
    const second = await call('post', '/school/fuel-logs', tok.adminA, { busId: fx.a.bus.id, fuelDate: day(-4), litres: 32, cost: 2880, billFileId: bill });
    expect(second.status).toBe(201);
  });
});

describe('mass assignment, invalid states and idempotency', () => {
  it('school_id / createdBy / deletedAt / id in bodies are ignored', async () => {
    const forged = { schoolId: fx.b.school.id, school_id: fx.b.school.id, createdBy: fx.b.admin.id, created_by: fx.b.admin.id, deletedAt: new Date().toISOString(), id: crypto.randomUUID() };
    const fuel = await call('post', '/school/fuel-logs', tok.adminA, { busId: fx.a.bus.id, fuelDate: day(-5), litres: 41, cost: 3690, ...forged });
    expect(fuel.status).toBe(201);
    const maint = await call('post', '/school/maintenance-logs', tok.adminA, { busId: fx.a.bus.id, serviceType: 'Forged', serviceDate: day(-5), ...forged });
    expect(maint.status).toBe(201);
    const rows = await ownerQuery<{ id: string; school_id: string; created_by: string; deleted_at: string | null }>(
      'select id, school_id, created_by, deleted_at from fuel_logs where id = $1 union all select id, school_id, created_by, deleted_at from maintenance_logs where id = $2',
      [fuel.body.data.id, maint.body.data.id],
    );
    for (const r of rows.rows) {
      expect(r).toMatchObject({ school_id: fx.a.school.id, created_by: fx.a.admin.id, deleted_at: null });
      expect(r.id).not.toBe(forged.id);
    }
    // A PATCH carrying only unknown keys changes nothing.
    expect((await call('patch', `/school/fuel-logs/${fuel.body.data.id}`, tok.adminA, { schoolId: fx.b.school.id, deletedAt: null })).status).toBe(400);
    // A report or list with ?schoolId= stays in the token's school.
    const list = await call('get', `/school/fuel-logs?schoolId=${fx.b.school.id}&limit=100`, tok.adminA);
    expect(list.body.data.map((x: { id: string }) => x.id)).not.toContain(fx.b.fuelLog.id);
  });

  it('deleted logs cannot be read, edited, revived or deleted again', async () => {
    const fuel = await call('post', '/school/fuel-logs', tok.adminA, { busId: fx.a.bus.id, fuelDate: day(-6), litres: 51, cost: 4590 });
    const maint = await call('post', '/school/maintenance-logs', tok.adminA, { busId: fx.a.bus.id, serviceType: 'Deleted', serviceDate: day(-6) });
    for (const [kind, id] of [['fuel-logs', fuel.body.data.id], ['maintenance-logs', maint.body.data.id]] as const) {
      expect((await call('delete', `/school/${kind}/${id}`, tok.adminA)).status).toBe(200);
      expect((await call('get', `/school/${kind}/${id}`, tok.adminA)).status).toBe(404);
      expect((await call('patch', `/school/${kind}/${id}`, tok.adminA, { notes: 'revive', deletedAt: null })).status).toBe(404);
      expect((await call('delete', `/school/${kind}/${id}`, tok.adminA)).status).toBe(404);
    }
    const audits = await ownerQuery<{ action: string }>('select action from audit_logs where entity_id = any ($1) order by created_at', [[fuel.body.data.id, maint.body.data.id]]);
    expect(audits.rows.map((r) => r.action).sort()).toEqual(['fuel_log.create', 'fuel_log.delete', 'maintenance_log.create', 'maintenance_log.delete']);
  });

  it('rejects future dates, a due date before the stored service date and a due km below the stored reading', async () => {
    expect((await call('post', '/school/fuel-logs', tok.adminA, { busId: fx.a.bus.id, fuelDate: day(2), litres: 5, cost: 450 })).status).toBe(400);
    const m = await call('post', '/school/maintenance-logs', tok.adminA, { busId: fx.a.bus.id, serviceType: 'Rules', serviceDate: day(-7), odometer: 5000 });
    expect(m.status).toBe(201);
    expect((await call('patch', `/school/maintenance-logs/${m.body.data.id}`, tok.adminA, { nextDueDate: day(-8) })).status).toBe(400);
    expect((await call('patch', `/school/maintenance-logs/${m.body.data.id}`, tok.adminA, { nextDueKm: 4999 })).status).toBe(400);
    expect((await call('patch', `/school/maintenance-logs/${m.body.data.id}`, tok.adminA, { serviceDate: day(3) })).status).toBe(400);
  });

  it('Idempotency-Key replays one create per principal and refuses a different body', async () => {
    const key = `w4-fuel-${crypto.randomUUID()}`;
    const body = { busId: fx.a.bus.id, fuelDate: day(-8), litres: 61, cost: 5490 };
    const first = await call('post', '/school/fuel-logs', tok.adminA, body, { 'Idempotency-Key': key });
    const replay = await call('post', '/school/fuel-logs', tok.adminA, body, { 'Idempotency-Key': key });
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    const changed = await call('post', '/school/fuel-logs', tok.adminA, { ...body, litres: 62 }, { 'Idempotency-Key': key });
    expect(changed.status).toBe(409);
    expect((await ownerQuery('select 1 from fuel_logs where bus_id = $1 and fuel_date = $2 and litres in (61, 62)', [fx.a.bus.id, day(-8)])).rowCount).toBe(1);
    // The same key from school B is B's own request (never A's stored response).
    const other = await call('post', '/school/fuel-logs', tok.adminB, { ...body, busId: fx.b.bus.id }, { 'Idempotency-Key': key });
    expect(other.status).toBe(201);
    expect(other.body.data.id).not.toBe(first.body.data.id);
    expect(other.body.data.busId).toBe(fx.b.bus.id);
  });
});

describe('reports feature flag', () => {
  it('a school with reports disabled gets a JSON 403 for every format (no partial CSV/PDF); the dashboard still works', async () => {
    await ownerQuery(`update school_settings set features = features || '{"reports": false}'::jsonb where school_id = $1`, [fx.b.school.id]);
    try {
      for (const k of REPORTS) {
        for (const fmt of ['json', 'csv', 'pdf']) {
          const res = await call('get', `/school/reports/${k}?format=${fmt}`, tok.adminB);
          expect(res.status, `${k} ${fmt}`).toBe(403);
          expect(res.headers['content-type']).toMatch(/application\/json/);
          expect(res.body.error.details).toMatchObject({ reason: 'FEATURE_DISABLED', feature: 'reports' });
        }
      }
      expect((await call('get', '/school/dashboard', tok.adminB)).status).toBe(200);
      expect((await call('get', '/school/reports/fuel', tok.adminA)).status).toBe(200);
    } finally {
      await ownerQuery(`update school_settings set features = features - 'reports' where school_id = $1`, [fx.b.school.id]);
    }
  });
});

describe('subscription modules (contract §9: plan modules are enforced)', () => {
  it("a plan without the reports module disables reports although the school's own flag is on", async () => {
    await ownerQuery("update school_subscriptions set status = 'cancelled' where school_id = $1 and status = 'active'", [fx.b.school.id]);
    const sub = await f.schoolSubscription(fx.b.school.id, { modules: JSON.stringify({ reports: false, email: false }) });
    try {
      const res = await call('get', '/school/reports/fuel', tok.adminB);
      expect(res.status).toBe(403);
      expect(res.body.error.details).toMatchObject({ reason: 'FEATURE_DISABLED', feature: 'reports' });
      const settings = await call('get', '/school/settings', tok.adminB);
      expect(settings.body.data.features.reports).toBe(true); // the school's own choice is kept
      expect(settings.body.data.effective.features).toMatchObject({ reports: false, emailDigest: false });
      expect((await call('get', '/school/reports/fuel', tok.adminA)).status).toBe(200); // A's plan is untouched
    } finally {
      await ownerQuery('update school_subscriptions set modules = $2::jsonb where id = $1', [sub.id, JSON.stringify({ reports: true })]);
    }
    expect((await call('get', '/school/reports/fuel', tok.adminB)).status).toBe(200);
  });
});
