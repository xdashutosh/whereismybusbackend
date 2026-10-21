// Service due list (BP §13.3 Maintenance due list, §7.3 maintenance-due-scan): the latest log per bus +
// service type of buses in service, overdue / due soon by date or km (reason), scheduled on request,
// sort, CSV, isolation; it lists exactly what the scan raises service_due alerts for, and logging a
// service queues maintenance-due-refresh, which resolves the alert without waiting for the daily scan.
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JOB_DEFINITIONS } from '../src/jobs/index.js';
import { maintenanceDueScan } from '../src/modules/alerts/jobs.js';
import { MAINTENANCE_DUE_REFRESH_JOB, maintenanceDueRefresh } from '../src/modules/maintenance/jobs.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { buildApp, loginSchoolAdmin, passwordHash, type TestApp } from './helpers/authApp.js';

let t: TestApp;
let fx: f.TwoSchoolFixture;
let adminA: string;
let adminB: string;
let today: string;
let r7: string;
let r9: string;
const ids: Record<string, string> = {};

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const api = (path: string) => `/api/v1${path}`;
const get = (path: string, token = adminA) => request(t.app).get(api(path)).set(auth(token));
function day(offset: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}
const log = (busId: string, o: f.Values) => f.maintenanceLog(fx.a.school.id, busId, { next_due_date: null, cost: null, ...o });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  fx = await f.twoSchoolFixture();
  await ownerQuery('update users set password_hash = $1 where id = any ($2)', [await passwordHash(), [fx.a.admin.id, fx.b.admin.id]]);
  adminA = (await loginSchoolAdmin(t.app, String(fx.a.admin.email))).accessToken;
  adminB = (await loginSchoolAdmin(t.app, String(fx.b.admin.email))).accessToken;
  today = (await ownerQuery<{ d: string }>("select to_char((now() at time zone 'Asia/Kolkata')::date, 'YYYY-MM-DD') as d")).rows[0]!.d;
  r7 = (await f.bus(fx.a.school.id, { code: 'R7', registration_no: 'KA01DD7777', last_known_odometer: 40000 })).id;
  r9 = (await f.bus(fx.a.school.id, { code: 'R9', registration_no: 'KA01DD9999', status: 'maintenance', last_known_odometer: 40000 })).id;
  const retired = (await f.bus(fx.a.school.id, { code: 'R10', registration_no: 'KA01DD1010', status: 'retired', last_known_odometer: 5000 })).id;
  const deleted = (await f.bus(fx.a.school.id, { code: 'R11', registration_no: 'KA01DD1111', deleted_at: new Date().toISOString() })).id;

  ids.oilOld = (await log(r7, { service_type: 'Oil change', service_date: day(-200), next_due_date: day(-10) })).id;
  ids.oil = (await log(r7, { service_type: ' oil CHANGE', service_date: day(-5), odometer: 39500, vendor: 'Sri Ganesh Motors', next_due_date: day(3) })).id;
  ids.tyre = (await log(r7, { service_type: 'Tyre rotation', service_date: day(-100), odometer: 30200, next_due_km: 40200 })).id;
  ids.brake = (await log(r7, { service_type: 'Brake inspection', service_date: day(-120), next_due_date: day(-2) })).id;
  ids.ac = (await log(r7, { service_type: 'AC service', service_date: day(-30), next_due_date: day(40) })).id;
  await log(r7, { service_type: 'Battery replacement', service_date: day(-30) });
  ids.general = (await log(r9, { service_type: 'General service', service_date: day(-150), odometer: 29000, next_due_km: 39000 })).id;
  await log(retired, { service_type: 'Oil change', service_date: day(-300), next_due_date: day(-100) });
  await log(deleted, { service_type: 'Oil change', service_date: day(-300), next_due_date: day(-100) });
  await log(r7, { service_type: 'Wheel alignment', service_date: day(-50), next_due_date: day(-1), deleted_at: new Date().toISOString() });
});
afterAll(closeDb);

describe('due list', () => {
  it('lists overdue and due-soon services (latest log per bus + type, buses in service) by urgency', async () => {
    const res = await get('/school/maintenance-logs/due');
    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ page: 1, total: 4 });
    expect(res.body.data.map((x: { maintenanceLogId: string; status: string; reason: string }) => [x.maintenanceLogId, x.status, x.reason])).toEqual([
      [ids.brake, 'overdue', 'date'],
      [ids.general, 'overdue', 'km'],
      [ids.oil, 'due_soon', 'date'],
      [ids.tyre, 'due_soon', 'km'],
    ]);
    expect(res.body.data[2]).toEqual({
      maintenanceLogId: ids.oil, busId: r7, busCode: 'R7', registrationNo: 'KA01DD7777', busStatus: 'active', busOdometer: 40000, serviceType: 'oil CHANGE',
      lastServiceDate: day(-5), lastServiceOdometer: 39500, vendor: 'Sri Ganesh Motors', nextDueDate: day(3), nextDueKm: null, daysToDue: 3, kmToDue: null,
      status: 'due_soon', reason: 'date',
    });
    expect(res.body.data[1]).toMatchObject({ busCode: 'R9', busStatus: 'maintenance', kmToDue: -1000, daysToDue: null });
  });

  it('filters by status, bus and text and sorts on request', async () => {
    const scheduled = await get(`/school/maintenance-logs/due?status=scheduled&busId=${r7}`);
    expect(scheduled.body.data.map((x: { maintenanceLogId: string; reason: null }) => [x.maintenanceLogId, x.reason])).toEqual([[ids.ac, null]]);
    const all = await get('/school/maintenance-logs/due?status=overdue,due_soon,scheduled');
    expect(all.body.meta.total).toBe(6); // + R7 AC service and the fixture's R1 oil change
    expect((await get(`/school/maintenance-logs/due?busId=${r9}`)).body.data.map((x: { maintenanceLogId: string }) => x.maintenanceLogId)).toEqual([ids.general]);
    expect((await get('/school/maintenance-logs/due?q=ganesh')).body.data.map((x: { maintenanceLogId: string }) => x.maintenanceLogId)).toEqual([ids.oil]);
    const byKm = await get('/school/maintenance-logs/due?sort=kmToDue');
    expect(byKm.body.data.map((x: { maintenanceLogId: string }) => x.maintenanceLogId).slice(0, 2)).toEqual([ids.general, ids.tyre]);
    const paged = await get('/school/maintenance-logs/due?limit=1&page=2');
    expect([paged.body.data.length, paged.body.meta.totalPages]).toEqual([1, 4]);
    expect((await get('/school/maintenance-logs/due?status=completed')).status).toBe(400);
    expect((await get('/school/maintenance-logs/due?sort=cost')).status).toBe(400);
  });

  it('exports CSV', async () => {
    const res = await get('/school/maintenance-logs/due?format=csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const lines = res.text.replace(/^\uFEFF/, '').trim().split('\r\n');
    expect(lines[0]).toBe('Status,Reason,Bus,Registration,Bus status,Service type,Next due date,Days to due,Next due (km),Bus odometer (km),km to due,Last service,Last service odometer (km),Vendor');
    expect(lines).toHaveLength(5);
    expect(lines[1]).toMatch(/^overdue,date,R7,KA01DD7777,active,Brake inspection,/);
  });

  it("is isolated per school", async () => {
    expect((await get('/school/maintenance-logs/due', adminB)).body.data).toEqual([]);
    const scheduledB = await get('/school/maintenance-logs/due?status=scheduled', adminB);
    expect(scheduledB.body.data.map((x: { maintenanceLogId: string }) => x.maintenanceLogId)).toEqual([fx.b.maintenanceLog.id]);
    expect((await get(`/school/maintenance-logs/due?busId=${r7}`, adminB)).body.data).toEqual([]);
  });
});

describe('alignment with maintenance-due-scan and the refresh job', () => {
  it('lists exactly the logs the scan raises service_due alerts for', async () => {
    const summary = await maintenanceDueScan({ schoolId: fx.a.school.id });
    expect(summary.raised).toBe(4);
    const alerts = await ownerQuery<{ entity_id: string; severity: string }>(
      "select entity_id, severity from alerts where school_id = $1 and alert_type = 'service_due' and not (coalesce(details, '{}'::jsonb) ? 'resolvedAt') order by entity_id",
      [fx.a.school.id],
    );
    const due = (await get('/school/maintenance-logs/due')).body.data as { maintenanceLogId: string; status: string }[];
    expect(alerts.rows.map((a) => [a.entity_id, a.severity])).toEqual(
      due.map((d) => [d.maintenanceLogId, d.status === 'overdue' ? 'critical' : 'warning']).sort((a, b) => a[0]!.localeCompare(b[0]!)),
    );
  });

  it('registers maintenance-due-refresh as a queue job', () => {
    expect(JOB_DEFINITIONS.find((d) => d.name === MAINTENANCE_DUE_REFRESH_JOB)?.kind).toBe('queue');
  });

  it('logging the service through the API resolves its alert via the queued refresh', async () => {
    const res = await request(t.app).post(api('/school/maintenance-logs')).set(auth(adminA)).send({ busId: r7, serviceType: 'Brake inspection', serviceDate: day(0), nextDueDate: day(180) });
    expect(res.status).toBe(201);
    let resolved = false;
    for (let i = 0; i < 50 && !resolved; i += 1) {
      const { rows } = await ownerQuery<{ resolved: boolean }>(
        "select coalesce(details, '{}'::jsonb) ? 'resolvedAt' as resolved from alerts where entity_id = $1 and alert_type = 'service_due'",
        [ids.brake],
      );
      resolved = rows.length === 1 && rows[0]!.resolved;
      if (!resolved) await sleep(100);
    }
    expect(resolved).toBe(true);
    expect((await get('/school/maintenance-logs/due')).body.data.map((x: { maintenanceLogId: string }) => x.maintenanceLogId)).not.toContain(ids.brake);
  });

  it('the refresh handler raises alerts for a new due service and is idempotent', async () => {
    await ownerQuery('update buses set last_known_odometer = 40250 where id = $1', [r7]);
    const first = await maintenanceDueRefresh({ schoolId: fx.a.school.id });
    expect(first.raised).toBe(1); // Tyre rotation is now overdue (supersedes its due-soon alert)
    const again = await maintenanceDueRefresh({ schoolId: fx.a.school.id });
    expect(again.raised).toBe(0);
    const tyre = (await get(`/school/maintenance-logs/due?busId=${r7}`)).body.data.find((x: { maintenanceLogId: string }) => x.maintenanceLogId === ids.tyre);
    expect(tyre).toMatchObject({ status: 'overdue', reason: 'km', kmToDue: -50 });
  });
});
