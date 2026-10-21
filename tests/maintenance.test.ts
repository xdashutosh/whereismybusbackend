// Maintenance logs (BP §8.3 Fuel/Maintenance, §13.3 Maintenance, §7.3 maintenance-due-scan): create /
// edit / soft delete with the invoice file, date and km rules (also against stored values), due state
// per log (overdue / due soon / scheduled / completed / none), odometer warnings, list filters / sort /
// totals / CSV, audit rows, and isolation. The due list and the alert refresh job: tests/maintenance.due.test.ts.
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appPool, closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { buildApp, loginParent, loginSchoolAdmin, loginStaff, passwordHash, type TestApp } from './helpers/authApp.js';

let t: TestApp;
let fx: f.TwoSchoolFixture;
let adminA: string;
let adminB: string;
let driverA: string;
let parentA: string;
let busId: string;
let today: string;
const ids: Record<string, string> = {};

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const api = (path: string) => `/api/v1${path}`;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');

function day(offset: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}
const create = (body: Record<string, unknown>, token = adminA) => request(t.app).post(api('/school/maintenance-logs')).set(auth(token)).send(body);
const patch = (id: string, body: Record<string, unknown>, token = adminA) => request(t.app).patch(api(`/school/maintenance-logs/${id}`)).set(auth(token)).send(body);
const del = (id: string, token = adminA) => request(t.app).delete(api(`/school/maintenance-logs/${id}`)).set(auth(token));
const get = (path: string, token = adminA) => request(t.app).get(api(path)).set(auth(token));
async function upload(entityId: string, { token = adminA, category = 'maintenance_invoice', entityType = 'bus' } = {}): Promise<string> {
  const res = await request(t.app).post(api('/files/upload')).set(auth(token)).field('category', category).field('entityType', entityType).field('entityId', entityId).attach('file', PDF, 'invoice.pdf');
  if (res.status !== 201) throw new Error(`upload failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.id as string;
}
async function createOk(body: Record<string, unknown>) {
  const res = await create(body);
  if (res.status !== 201) throw new Error(`create failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data as { id: string } & Record<string, unknown>;
}
const codes = (w: { code: string }[]) => w.map((x) => x.code);

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  fx = await f.twoSchoolFixture();
  await ownerQuery('update users set password_hash = $1 where id = any ($2)', [await passwordHash(), [fx.a.admin.id, fx.b.admin.id, fx.a.driverUser.id]]);
  adminA = (await loginSchoolAdmin(t.app, String(fx.a.admin.email))).accessToken;
  adminB = (await loginSchoolAdmin(t.app, String(fx.b.admin.email))).accessToken;
  driverA = (await loginStaff(t.app, String(fx.a.school.code), String(fx.a.driverUser.phone))).accessToken;
  parentA = (await loginParent(t, String(fx.a.parent.phone))).accessToken;
  today = (await ownerQuery<{ d: string }>("select to_char((now() at time zone 'Asia/Kolkata')::date, 'YYYY-MM-DD') as d")).rows[0]!.d;
  busId = (await f.bus(fx.a.school.id, { code: 'R7', registration_no: 'KA01MM7777', last_known_odometer: 40000, odometer_updated_at: `${day(-60)}T06:00:00Z` })).id;
});
afterAll(closeDb);

describe('create and validation', () => {
  it('creates a log in the token school and audits it', async () => {
    const res = await create({
      busId, serviceType: '  Oil change ', serviceDate: day(-90), cost: 3200.5, odometer: 35000, vendor: 'Sri Ganesh Motors', notes: 'Synthetic 15W-40',
      nextDueDate: day(30), nextDueKm: 45000, school_id: fx.b.school.id,
    });
    expect(res.status).toBe(201);
    const d = res.body.data;
    ids.oil = d.id;
    expect(d).toMatchObject({
      busId, busCode: 'R7', busRegistrationNo: 'KA01MM7777', busOdometer: 40000, serviceType: 'Oil change', serviceDate: day(-90), cost: 3200.5,
      odometer: 35000, vendor: 'Sri Ganesh Motors', invoice: null, nextDueDate: day(30), nextDueKm: 45000, dueStatus: 'scheduled', daysToDue: 30,
      kmToDue: 5000, odometerFlags: [], warnings: [], createdBy: fx.a.admin.id, createdByName: 'Anita Rao',
    });
    expect((await ownerQuery('select school_id from maintenance_logs where id = $1', [d.id])).rows[0]!.school_id).toBe(fx.a.school.id);
    const a = (await ownerQuery<{ new_values: Record<string, unknown> }>("select new_values from audit_logs where action = 'maintenance_log.create' and entity_id = $1", [d.id])).rows[0]!;
    expect(a.new_values).toMatchObject({ serviceType: 'Oil change', cost: 3200.5, nextDueKm: 45000 });
  });

  it('validates fields, dates and km', async () => {
    const base = { busId, serviceType: 'Brake inspection', serviceDate: day(-5) };
    const bad = async (body: Record<string, unknown>, path: string) => {
      const res = await create(body);
      expect([res.status, res.body.error.code]).toEqual([400, 'VALIDATION_ERROR']);
      expect(res.body.error.details.map((x: { path: string }) => x.path)).toContain(path);
    };
    await bad({ ...base, serviceType: '   ' }, 'serviceType');
    await bad({ ...base, serviceType: 'x'.repeat(101) }, 'serviceType');
    await bad({ ...base, serviceDate: day(1) }, 'serviceDate');
    await bad({ ...base, nextDueDate: day(-5) }, 'nextDueDate');
    await bad({ ...base, odometer: 40000, nextDueKm: 40000 }, 'nextDueKm');
    await bad({ ...base, cost: -2 }, 'cost');
    await bad({ ...base, odometer: 'abc' }, 'odometer');
    expect((await create({ ...base, busId: fx.b.bus.id })).status).toBe(404);
    const minimal = await createOk(base);
    expect(minimal).toMatchObject({ cost: null, odometer: null, nextDueDate: null, nextDueKm: null, dueStatus: 'none', daysToDue: null, kmToDue: null });
    ids.brake = minimal.id;
  });

  it('re-checks the due rules against stored values on a partial update', async () => {
    const r1 = await patch(ids.oil!, { nextDueDate: day(-100) });
    expect([r1.status, r1.body.error.details[0].path]).toEqual([400, 'nextDueDate']);
    const r2 = await patch(ids.oil!, { odometer: 46000 });
    expect([r2.status, r2.body.error.details[0].path]).toEqual([400, 'nextDueKm']);
    const r3 = await patch(ids.oil!, { serviceDate: day(35) });
    expect(r3.status).toBe(400);
    const ok = await patch(ids.oil!, { odometer: 36000, nextDueKm: null });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ odometer: 36000, nextDueKm: null, kmToDue: null, dueStatus: 'scheduled' });
    const a = (await ownerQuery<{ old_values: unknown; new_values: unknown }>("select old_values, new_values from audit_logs where action = 'maintenance_log.update' and entity_id = $1", [ids.oil])).rows[0]!;
    expect(a).toEqual({ old_values: { odometer: 35000, nextDueKm: 45000 }, new_values: { odometer: 36000, nextDueKm: null } });
    expect((await patch(ids.oil!, {})).status).toBe(400);
    expect((await patch(ids.oil!, { busId: fx.b.bus.id })).status).toBe(404);
  });
});

describe('due state per log', () => {
  it('computes overdue / due soon / scheduled by date and by km against the bus odometer', async () => {
    const make = async (serviceType: string, extra: Record<string, unknown>) => createOk({ busId, serviceType, serviceDate: day(-200), ...extra });
    expect(await make('Air filter', { nextDueDate: day(-1) })).toMatchObject({ dueStatus: 'overdue', daysToDue: -1 });
    expect(await make('Coolant flush', { nextDueDate: day(0) })).toMatchObject({ dueStatus: 'due_soon', daysToDue: 0 });
    expect(await make('Wheel alignment', { nextDueDate: day(7) })).toMatchObject({ dueStatus: 'due_soon', daysToDue: 7 });
    expect(await make('AC service', { nextDueDate: day(8) })).toMatchObject({ dueStatus: 'scheduled', daysToDue: 8 });
    expect(await make('Tyre rotation', { odometer: 30000, nextDueKm: 40000 })).toMatchObject({ dueStatus: 'overdue', kmToDue: 0 });
    expect(await make('Clutch overhaul', { odometer: 30000, nextDueKm: 40500 })).toMatchObject({ dueStatus: 'due_soon', kmToDue: 500 });
    expect(await make('Battery replacement', { odometer: 30000, nextDueKm: 40501 })).toMatchObject({ dueStatus: 'scheduled', kmToDue: 501 });
  });

  it('marks an older log completed once a newer log of the same type (case-insensitive) exists', async () => {
    const newer = await createOk({ busId, serviceType: 'air FILTER ', serviceDate: day(-1), nextDueDate: day(180) });
    expect(newer.dueStatus).toBe('scheduled');
    const list = await get(`/school/maintenance-logs?busId=${busId}&serviceType=Air%20filter&sort=serviceDate`);
    expect(list.body.data.map((x: { dueStatus: string }) => x.dueStatus)).toEqual(['completed', 'scheduled']);
    const overdue = await get(`/school/maintenance-logs?busId=${busId}&dueStatus=overdue`);
    expect(overdue.body.data.map((x: { serviceType: string }) => x.serviceType)).toEqual(['Tyre rotation']);
    expect((await get(`/school/maintenance-logs?busId=${busId}&dueStatus=completed,none`)).body.meta.total).toBe(2);
  });
});

describe('invoice file and odometer warnings', () => {
  it('links an uploaded maintenance_invoice and rejects other files', async () => {
    const fileId = await upload(busId);
    const res = await patch(ids.brake!, { invoiceFileId: fileId, cost: 1800 });
    expect(res.status).toBe(200);
    expect(res.body.data.invoice).toEqual({ id: fileId, fileName: 'invoice.pdf', contentType: 'application/pdf', sizeBytes: PDF.length, hasThumbnail: false });
    const dup = await create({ busId, serviceType: 'Body repair', serviceDate: day(-3), invoiceFileId: fileId });
    expect([dup.status, dup.body.error.details]).toEqual([409, { attachedTo: ids.brake }]);
    const bill = await upload(busId, { category: 'fuel_bill' });
    expect((await create({ busId, serviceType: 'Body repair', serviceDate: day(-3), invoiceFileId: bill })).status).toBe(400);
    const otherBus = await upload(fx.a.otherBus.id);
    expect((await create({ busId, serviceType: 'Body repair', serviceDate: day(-3), invoiceFileId: otherBus })).status).toBe(400);
    const own = await upload(ids.brake!, { entityType: 'maintenance_log' });
    expect((await patch(ids.brake!, { invoiceFileId: own })).body.data.invoice.id).toBe(own);
    const bFile = await upload(fx.b.bus.id, { token: adminB });
    expect((await patch(ids.brake!, { invoiceFileId: bFile })).status).toBe(404);
    expect((await get(`/school/maintenance-logs?busId=${busId}&hasInvoice=true`)).body.data.map((x: { id: string }) => x.id)).toEqual([ids.brake]);
  });

  it('warns about decreasing readings across fuel logs, trips and maintenance logs, and duplicates', async () => {
    await f.fuelLog(fx.a.school.id, busId, { fuel_date: day(-20), odometer: 39000 });
    const low = await create({ busId, serviceType: 'GPS device check', serviceDate: day(-10), odometer: 38000 });
    expect(low.status).toBe(201);
    // Also below the bus's last known 40,000 km recorded on day -60 (higher than every earlier log reading).
    expect(codes(low.body.data.warnings)).toEqual(['ODOMETER_BELOW_PREVIOUS', 'ODOMETER_BELOW_BUS']);
    expect(low.body.data.warnings[0].details).toMatchObject({ previousReading: 39000, previousSource: 'fuel_log', previousDate: day(-20) });
    expect(low.body.data.odometerFlags).toEqual(['below_previous']);
    const again = await create({ busId, serviceType: 'gps device CHECK', serviceDate: day(-10) });
    expect(codes(again.body.data.warnings)).toEqual(['POSSIBLE_DUPLICATE']);
    expect((await get(`/school/maintenance-logs?busId=${busId}&flagged=true`)).body.data.map((x: { id: string }) => x.id)).toEqual([low.body.data.id]);
    await del(low.body.data.id);
    await del(again.body.data.id);
    expect((await get(`/school/maintenance-logs?busId=${busId}&flagged=true`)).body.meta.total).toBe(0);
  });
});

describe('list, sort, totals and CSV', () => {
  it('filters by text, date range and bus, sorts and totals the cost', async () => {
    const all = await get(`/school/maintenance-logs?busId=${busId}&limit=3&sort=-cost`);
    expect(all.status).toBe(200);
    expect(all.body.meta).toMatchObject({ total: 10, totalPages: 4, totals: { cost: 5000.5 } });
    expect(all.body.data.map((x: { cost: number | null }) => x.cost)).toEqual([3200.5, 1800, null]);
    expect((await get('/school/maintenance-logs?q=ganesh')).body.data.map((x: { id: string }) => x.id)).toEqual([ids.oil]);
    const range = await get(`/school/maintenance-logs?busId=${busId}&from=${day(-100)}&to=${day(-2)}&sort=serviceDate`);
    expect(range.body.data.map((x: { serviceType: string }) => x.serviceType)).toEqual(['Oil change', 'Brake inspection']);
    const bySeverity = await get(`/school/maintenance-logs?busId=${busId}&sort=dueStatus,serviceType&limit=1`);
    expect(bySeverity.body.data[0].serviceType).toBe('Tyre rotation');
    expect((await get('/school/maintenance-logs?sort=secret')).status).toBe(400);
    expect((await get('/school/maintenance-logs?dueStatus=late')).status).toBe(400);
    expect((await get('/school/maintenance-logs?format=pdf')).status).toBe(400);
  });

  it('exports CSV with the formula guard', async () => {
    const evil = await createOk({ busId: fx.a.otherBus.id, serviceType: 'Body repair', serviceDate: day(-4), vendor: '+91 98450 00000 Motors' });
    const res = await get(`/school/maintenance-logs?format=csv&busId=${fx.a.otherBus.id}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text.replace(/^\uFEFF/, '').split('\r\n')[0]).toBe(
      'Service date,Bus,Registration,Service type,Cost,Odometer (km),Vendor,Next due date,Next due (km),Due status,Days to due,km to due,Odometer flags,Invoice attached,Notes,Entered by,Created (UTC)',
    );
    expect(res.text).toContain("'+91 98450 00000 Motors");
    await del(evil.id);
  });
});

describe('delete', () => {
  it('soft deletes and audits', async () => {
    const victim = await createOk({ busId, serviceType: 'Fire extinguisher refill', serviceDate: day(-1) });
    const res = await del(victim.id);
    expect([res.status, res.body.data]).toEqual([200, { id: victim.id, deleted: true }]);
    expect((await get(`/school/maintenance-logs/${victim.id}`)).status).toBe(404);
    expect((await del(victim.id)).status).toBe(404);
    expect((await ownerQuery("select 1 from audit_logs where action = 'maintenance_log.delete' and entity_id = $1", [victim.id])).rowCount).toBe(1);
  });
});

describe('isolation and roles', () => {
  it("never shows or changes another school's logs", async () => {
    expect((await get(`/school/maintenance-logs/${ids.oil}`)).status).toBe(200);
    expect((await get(`/school/maintenance-logs/${ids.oil}`, adminB)).status).toBe(404);
    expect((await patch(ids.oil!, { notes: 'x' }, adminB)).status).toBe(404);
    expect((await del(ids.oil!, adminB)).status).toBe(404);
    expect((await get('/school/maintenance-logs?limit=100', adminB)).body.data.map((x: { id: string }) => x.id)).toEqual([fx.b.maintenanceLog.id]);
    expect((await get('/school/maintenance-logs?format=csv', adminB)).text).not.toContain('R7');
    expect((await create({ busId, serviceType: 'Oil change', serviceDate: day(-1) }, adminB)).status).toBe(404);
  });

  it('is for school admins only', async () => {
    expect((await get('/school/maintenance-logs', driverA)).status).toBe(403);
    expect((await get('/school/maintenance-logs/due', driverA)).status).toBe(403);
    expect((await request(t.app).get(api('/school/maintenance-logs')).set(auth(parentA)).set('X-School-Id', fx.a.school.id)).status).toBe(403);
    expect((await request(t.app).get(api('/school/maintenance-logs'))).status).toBe(401);
  });

  it('shows the app role nothing without a tenant context', async () => {
    const { rows } = await appPool().query<{ n: number }>('select count(*)::int as n from maintenance_logs');
    expect(rows[0]!.n).toBe(0);
  });
});
