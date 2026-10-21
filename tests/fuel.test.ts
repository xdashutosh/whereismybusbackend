// Fuel logs (BP §8.3 Fuel/Maintenance, §13.3 Fuel): create / edit / soft delete with the bill file,
// the not-in-the-future rule, validation, non-blocking odometer warnings (fuel + maintenance + trip
// readings, bus odometer, duplicates), list filters / sort / totals / CSV (formula guard), fill-to-fill
// mileage, audit rows, and isolation (other school → 404, other roles → 403, no context → 0 rows).
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

/** School-local calendar day (Asia/Kolkata) with an offset. */
function day(offset: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}
const create = (body: Record<string, unknown>, token = adminA) => request(t.app).post(api('/school/fuel-logs')).set(auth(token)).send(body);
const patch = (id: string, body: Record<string, unknown>, token = adminA) => request(t.app).patch(api(`/school/fuel-logs/${id}`)).set(auth(token)).send(body);
const get = (path: string, token = adminA) => request(t.app).get(api(path)).set(auth(token));
async function upload(entityId: string, { token = adminA, category = 'fuel_bill', entityType = 'bus' } = {}): Promise<string> {
  const res = await request(t.app).post(api('/files/upload')).set(auth(token)).field('category', category).field('entityType', entityType).field('entityId', entityId).attach('file', PDF, 'bill.pdf');
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
  busId = (await f.bus(fx.a.school.id, { code: 'R7', registration_no: 'KA01FF7777', fuel_type: 'diesel', last_known_odometer: null })).id;
});
afterAll(closeDb);

describe('create', () => {
  it('creates a log in the token school, defaults the fuel type to the bus and audits it', async () => {
    const res = await create({ busId, fuelDate: day(-40), odometer: 10000, litres: 50, cost: 4500, station: 'HP, Hosur Road', notes: 'Full tank', school_id: fx.b.school.id, schoolId: fx.b.school.id });
    expect(res.status).toBe(201);
    const d = res.body.data;
    expect(d).toMatchObject({
      busId, busCode: 'R7', busRegistrationNo: 'KA01FF7777', fuelDate: day(-40), odometer: 10000, litres: 50, cost: 4500, pricePerLitre: 90,
      fuelType: 'diesel', station: 'HP, Hosur Road', notes: 'Full tank', bill: null, distanceKm: null, kmPerLitre: null, costPerKm: null,
      odometerFlags: [], warnings: [], createdBy: fx.a.admin.id, createdByName: 'Anita Rao',
    });
    const row = (await ownerQuery('select school_id, created_by from fuel_logs where id = $1', [d.id])).rows[0]!;
    expect(row).toEqual({ school_id: fx.a.school.id, created_by: fx.a.admin.id });
    const auditRow = (await ownerQuery<{ new_values: Record<string, unknown> }>("select new_values from audit_logs where action = 'fuel_log.create' and entity_id = $1", [d.id])).rows[0]!;
    expect(auditRow.new_values).toMatchObject({ busCode: 'R7', litres: 50, cost: 4500, odometer: 10000 });
  });

  it('validates the body', async () => {
    const base = { busId, fuelDate: day(-39), litres: 10, cost: 900 };
    const bad = async (body: Record<string, unknown>, path: string) => {
      const res = await create(body);
      expect([res.status, res.body.error.code]).toEqual([400, 'VALIDATION_ERROR']);
      expect(res.body.error.details.map((x: { path: string }) => x.path)).toContain(path);
    };
    await bad({ ...base, litres: 0 }, 'litres');
    await bad({ ...base, litres: 5001 }, 'litres');
    await bad({ ...base, cost: -1 }, 'cost');
    await bad({ ...base, odometer: -5 }, 'odometer');
    await bad({ ...base, fuelDate: '2026-02-30' }, 'fuelDate');
    await bad({ ...base, fuelType: 'kerosene' }, 'fuelType');
    await bad({ ...base, busId: 'nope' }, 'busId');
    await bad({ fuelDate: day(-1), litres: 5, cost: 1 }, 'busId');
    await bad({ ...base, fuelDate: day(2) }, 'fuelDate');
    expect((await create({ ...base, busId: '0190a0a0-0000-7000-8000-000000000000' })).status).toBe(404);
    expect((await create({ ...base, busId: fx.b.bus.id })).status).toBe(404);
    const electric = await createOk({ ...base, fuelType: 'electric', litres: 12.345, cost: 0 });
    expect([electric.fuelType, electric.litres, electric.pricePerLitre]).toEqual(['electric', 12.35, 0]);
    expect((await request(t.app).delete(api(`/school/fuel-logs/${electric.id}`)).set(auth(adminA))).status).toBe(200);
  });

  it('accepts a log dated today and rejects a deleted bus', async () => {
    const gone = await f.bus(fx.a.school.id, { code: 'R8', registration_no: 'KA01FF8888', deleted_at: new Date().toISOString() });
    expect((await create({ busId: gone.id, fuelDate: day(0), litres: 5, cost: 450 })).status).toBe(404);
    const todays = await create({ busId: fx.a.otherBus.id, fuelDate: day(0), litres: 5, cost: 450 });
    expect(todays.status).toBe(201);
  });
});

describe('fill-to-fill mileage and odometer warnings', () => {
  it('computes distance, km per litre and cost per km from the previous reading of the bus', async () => {
    const second = await createOk({ busId, fuelDate: day(-30), odometer: 10400, litres: 40, cost: 3600 });
    expect(second).toMatchObject({ distanceKm: 400, spanLitres: 40, spanCost: 3600, kmPerLitre: 10, costPerKm: 9, warnings: [] });
    ids.second = second.id;
    const noReading = await createOk({ busId, fuelDate: day(-25), litres: 20, cost: 1800 });
    expect([noReading.distanceKm, noReading.kmPerLitre, noReading.odometerFlags]).toEqual([null, null, []]);
    const third = await createOk({ busId, fuelDate: day(-20), odometer: 10850, litres: 45, cost: 4140 });
    // The fill without a reading belongs to this span: 450 km on 20 + 45 litres (₹1,800 + ₹4,140).
    expect(third).toMatchObject({ distanceKm: 450, spanLitres: 65, spanCost: 5940, kmPerLitre: 6.92, costPerKm: 13.2 });
    ids.third = third.id;
  });

  it('warns (without blocking) when a reading is below an earlier one or above a later one', async () => {
    const low = await create({ busId, fuelDate: day(-15), odometer: 10500, litres: 30, cost: 2700 });
    expect(low.status).toBe(201);
    expect(codes(low.body.data.warnings)).toEqual(['ODOMETER_BELOW_PREVIOUS']);
    expect(low.body.data.warnings[0]).toMatchObject({ details: { odometer: 10500, previousReading: 10850, previousDate: day(-20), previousSource: 'fuel_log' } });
    expect(low.body.data.odometerFlags).toEqual(['below_previous']);
    expect(low.body.data.distanceKm).toBeNull();

    const backdated = await create({ busId, fuelDate: day(-35), odometer: 10600, litres: 30, cost: 2700 });
    expect(codes(backdated.body.data.warnings)).toEqual(['ODOMETER_ABOVE_NEXT']);
    expect(backdated.body.data.warnings[0].details).toMatchObject({ nextReading: 10400, nextDate: day(-30) });
    expect(backdated.body.data.odometerFlags).toEqual(['above_next']);
    expect((await ownerQuery<{ new_values: { warnings: string[] } }>("select new_values from audit_logs where action = 'fuel_log.create' and entity_id = $1", [backdated.body.data.id])).rows[0]!.new_values.warnings).toEqual(['ODOMETER_ABOVE_NEXT']);

    // Both sides of a decrease are flagged: either reading may be the wrong one.
    const flagged = await get(`/school/fuel-logs?busId=${busId}&flagged=true&sort=fuelDate`);
    expect(flagged.body.data.map((x: { id: string; odometerFlags: string[] }) => [x.id, x.odometerFlags])).toEqual([
      [backdated.body.data.id, ['above_next']],
      [ids.second, ['below_previous']],
      [ids.third, ['above_next']],
      [low.body.data.id, ['below_previous']],
    ]);
    const clean = await get(`/school/fuel-logs?busId=${busId}&flagged=false`);
    expect(clean.body.meta.total).toBe(2);
    for (const id of [backdated.body.data.id, low.body.data.id]) expect((await request(t.app).delete(api(`/school/fuel-logs/${id}`)).set(auth(adminA))).status).toBe(200);
  });

  it('compares with trip odometer readings and maintenance logs of the bus', async () => {
    const trip = await f.trip(fx.a.school.id, busId, { trip_date: day(-12), status: 'completed', started_at: `${day(-12)}T02:00:00Z`, ended_at: `${day(-12)}T03:00:00Z`, start_odometer: 11000, end_odometer: 11040 });
    const res = await create({ busId, fuelDate: day(-14), odometer: 11100, litres: 20, cost: 1800 });
    expect(codes(res.body.data.warnings)).toEqual(['ODOMETER_ABOVE_NEXT']);
    expect(res.body.data.warnings[0].details).toMatchObject({ nextReading: 11000, nextSource: 'trip' });
    await f.maintenanceLog(fx.a.school.id, busId, { service_date: day(-11), odometer: 11500, next_due_date: null });
    const below = await create({ busId, fuelDate: day(-10), odometer: 11200, litres: 20, cost: 1800 });
    expect(below.body.data.warnings[0]).toMatchObject({ code: 'ODOMETER_BELOW_PREVIOUS', details: { previousReading: 11500, previousSource: 'maintenance_log' } });
    await ownerQuery('delete from maintenance_logs where bus_id = $1', [busId]);
    await ownerQuery('delete from fuel_logs where id = any ($1)', [[res.body.data.id, below.body.data.id]]);
    await ownerQuery('delete from trips where id = $1', [trip.id]);
  });

  it("warns when a reading is below the bus's last known odometer recorded earlier, and on duplicates", async () => {
    await ownerQuery("update buses set last_known_odometer = 20000, odometer_updated_at = now() - interval '3 days' where id = $1", [busId]);
    const res = await create({ busId, fuelDate: day(0), odometer: 15000, litres: 45, cost: 4100 });
    expect(codes(res.body.data.warnings)).toEqual(['ODOMETER_BELOW_BUS']);
    expect(res.body.data.warnings[0].details).toMatchObject({ busOdometer: 20000 });
    const dup = await create({ busId, fuelDate: day(0), litres: 45, cost: 4100 });
    expect(codes(dup.body.data.warnings)).toEqual(['POSSIBLE_DUPLICATE']);
    expect(dup.body.data.warnings[0].details.fuelLogId).toBe(res.body.data.id);
    await ownerQuery('delete from fuel_logs where id = any ($1)', [[res.body.data.id, dup.body.data.id]]);
    await ownerQuery('update buses set last_known_odometer = null, odometer_updated_at = null where id = $1', [busId]);
  });
});

describe('bill file', () => {
  it('links an uploaded fuel_bill of the bus and rejects other files', async () => {
    const fileId = await upload(busId);
    const res = await create({ busId, fuelDate: day(-8), litres: 30, cost: 2700, billFileId: fileId });
    expect(res.status).toBe(201);
    ids.billed = res.body.data.id;
    expect(res.body.data.bill).toEqual({ id: fileId, fileName: 'bill.pdf', contentType: 'application/pdf', sizeBytes: PDF.length, hasThumbnail: false });
    const url = await get(`/files/${fileId}/url`);
    expect(url.status).toBe(200);

    const again = await create({ busId, fuelDate: day(-7), litres: 31, cost: 2790, billFileId: fileId });
    expect([again.status, again.body.error.code, again.body.error.details]).toEqual([409, 'CONFLICT', { attachedTo: ids.billed }]);
    const otherBus = await upload(fx.a.otherBus.id);
    const wrongBus = await create({ busId, fuelDate: day(-7), litres: 31, cost: 2790, billFileId: otherBus });
    expect([wrongBus.status, wrongBus.body.error.details[0].path]).toEqual([400, 'billFileId']);
    const doc = await upload(busId, { category: 'bus_document' });
    expect((await create({ busId, fuelDate: day(-7), litres: 31, cost: 2790, billFileId: doc })).status).toBe(400);
    const bFile = await upload(fx.b.bus.id, { token: adminB });
    expect((await create({ busId, fuelDate: day(-7), litres: 31, cost: 2790, billFileId: bFile })).status).toBe(404);
  });

  it('accepts a bill uploaded for the log itself, replaces and removes it', async () => {
    const own = await upload(ids.billed!, { entityType: 'fuel_log' });
    const res = await patch(ids.billed!, { billFileId: own });
    expect([res.status, res.body.data.bill.id]).toEqual([200, own]);
    const foreign = await createOk({ busId: fx.a.otherBus.id, fuelDate: day(-7), litres: 10, cost: 900 });
    const forOther = await upload(foreign.id, { entityType: 'fuel_log' });
    expect((await patch(ids.billed!, { billFileId: forOther })).status).toBe(400);
    const cleared = await patch(ids.billed!, { billFileId: null });
    expect(cleared.body.data.bill).toBeNull();
    expect((await get(`/school/fuel-logs?busId=${busId}&hasBill=true`)).body.meta.total).toBe(0);
    await patch(ids.billed!, { billFileId: own });
    expect((await get(`/school/fuel-logs?busId=${busId}&hasBill=true`)).body.data.map((x: { id: string }) => x.id)).toEqual([ids.billed]);
  });
});

describe('list, sort, totals and CSV', () => {
  it('filters by bus, date range, fuel type and text, with totals of every match', async () => {
    const all = await get(`/school/fuel-logs?busId=${busId}&limit=2&sort=fuelDate`);
    expect(all.status).toBe(200);
    expect(all.body.meta).toMatchObject({
      page: 1, limit: 2, total: 5, totalPages: 3,
      totals: { fills: 5, cost: 16740, unit: 'L', quantity: 185, litres: 185, byUnit: [{ unit: 'L', fills: 5, quantity: 185, cost: 16740, avgPricePerUnit: 90.49 }] },
    });
    expect(all.body.data[0].unit).toBe('L');
    expect(all.body.data.map((x: { fuelDate: string }) => x.fuelDate)).toEqual([day(-40), day(-30)]);
    const range = await get(`/school/fuel-logs?busId=${busId}&from=${day(-30)}&to=${day(-20)}`);
    expect(range.body.data.map((x: { fuelDate: string }) => x.fuelDate)).toEqual([day(-20), day(-25), day(-30)]);
    expect((await get(`/school/fuel-logs?q=hosur`)).body.data.map((x: { station: string }) => x.station)).toEqual(['HP, Hosur Road']);
    expect((await get(`/school/fuel-logs?busId=${busId}&fuelType=cng`)).body.meta).toMatchObject({ total: 0, totals: { fills: 0, litres: 0, quantity: 0, cost: 0, unit: null, byUnit: [] } });
    const past = await get(`/school/fuel-logs?busId=${busId}&page=9`);
    expect([past.body.data, past.body.meta.total, past.body.meta.totals]).toEqual([[], 5, null]);
    const byMileage = await get(`/school/fuel-logs?busId=${busId}&sort=-kmPerLitre,fuelDate`);
    expect(byMileage.body.data.slice(0, 2).map((x: { kmPerLitre: number }) => x.kmPerLitre)).toEqual([10, 6.92]);
    expect((await get('/school/fuel-logs?sort=password')).status).toBe(400);
    expect((await get('/school/fuel-logs?format=pdf')).status).toBe(400);
    expect((await get(`/school/fuel-logs?from=${day(-1)}&to=${day(-5)}`)).status).toBe(400);
  });

  it('totals litres, kg (CNG) and kWh (electric) per unit, never as one number', async () => {
    const cng = await f.bus(fx.a.school.id, { code: 'R3', registration_no: 'KA01CN0003', fuel_type: 'cng', last_known_odometer: null });
    const ev = await f.bus(fx.a.school.id, { code: 'R5', registration_no: 'KA01EV0005', fuel_type: 'electric', last_known_odometer: null });
    const created = [
      await createOk({ busId: cng.id, fuelDate: day(-4), litres: 20, cost: 1800 }),
      await createOk({ busId: cng.id, fuelDate: day(-3), litres: 10, cost: 900 }),
      await createOk({ busId: ev.id, fuelDate: day(-3), litres: 80, cost: 960 }),
    ];
    try {
      expect(created.map((c) => c.unit)).toEqual(['kg', 'kg', 'kWh']);
      const scope = `from=${day(-4)}&to=${day(-3)}`;
      const mixed = (await get(`/school/fuel-logs?${scope}&limit=1`)).body.meta.totals;
      expect(mixed).toEqual({
        fills: 3, cost: 3660, unit: null, quantity: null, litres: null,
        byUnit: [
          { unit: 'kg', fills: 2, quantity: 30, cost: 2700, avgPricePerUnit: 90 },
          { unit: 'kWh', fills: 1, quantity: 80, cost: 960, avgPricePerUnit: 12 },
        ],
      });
      const onlyCng = (await get(`/school/fuel-logs?${scope}&fuelType=cng`)).body.meta.totals;
      expect(onlyCng).toMatchObject({ fills: 2, unit: 'kg', quantity: 30, litres: 30, cost: 2700 });
      const csv = (await get(`/school/fuel-logs?format=csv&busId=${ev.id}`)).text.replace(/^\uFEFF/, '').trim().split('\r\n');
      expect(csv[1]).toContain(',80,kWh,960,12,electric,');
    } finally {
      for (const c of created) await request(t.app).delete(api(`/school/fuel-logs/${c.id}`)).set(auth(adminA));
    }
  });

  it('exports CSV with the formula guard', async () => {
    const evil = await createOk({ busId: fx.a.otherBus.id, fuelDate: day(-3), litres: 12, cost: 1080, station: '=HYPERLINK("http://x")' });
    const res = await get(`/school/fuel-logs?format=csv&busId=${fx.a.otherBus.id}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const lines = res.text.replace(/^\uFEFF/, '').trim().split('\r\n');
    expect(lines[0]).toContain('Date,Bus,Registration,Odometer (km),Quantity,Unit,Cost,Price per unit');
    expect(res.text).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(res.text).not.toContain(fx.b.school.id);
    expect(lines.length).toBeGreaterThan(1);
    await request(t.app).delete(api(`/school/fuel-logs/${evil.id}`)).set(auth(adminA));
  });
});

describe('update and delete', () => {
  it('updates fields, recomputes warnings and audits only the changes', async () => {
    const res = await patch(ids.billed!, { odometer: 11300, notes: 'Corrected', school_id: fx.b.school.id });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ odometer: 11300, notes: 'Corrected', distanceKm: 450, kmPerLitre: 15, warnings: [] });
    const a = (await ownerQuery<{ old_values: Record<string, unknown>; new_values: Record<string, unknown> }>("select old_values, new_values from audit_logs where action = 'fuel_log.update' and entity_id = $1 order by created_at desc limit 1", [ids.billed])).rows[0]!;
    expect(a).toEqual({ old_values: { odometer: null, notes: null }, new_values: { odometer: 11300, notes: 'Corrected' } });
    expect((await patch(ids.billed!, {})).status).toBe(400);
    expect((await patch(ids.billed!, { fuelDate: day(3) })).status).toBe(400);
    expect((await patch(ids.billed!, { busId: fx.b.bus.id })).status).toBe(404);
    const moved = await patch(ids.billed!, { busId: fx.a.otherBus.id });
    expect([moved.status, moved.body.data.busCode]).toEqual([200, 'R2']);
    await patch(ids.billed!, { busId });
  });

  it('soft deletes and audits; the log disappears from lists and details', async () => {
    const victim = await createOk({ busId, fuelDate: day(-2), litres: 5, cost: 450 });
    const del = await request(t.app).delete(api(`/school/fuel-logs/${victim.id}`)).set(auth(adminA));
    expect([del.status, del.body.data]).toEqual([200, { id: victim.id, deleted: true }]);
    expect((await get(`/school/fuel-logs/${victim.id}`)).status).toBe(404);
    expect((await request(t.app).delete(api(`/school/fuel-logs/${victim.id}`)).set(auth(adminA))).status).toBe(404);
    expect((await ownerQuery('select deleted_at is not null as gone from fuel_logs where id = $1', [victim.id])).rows[0]!.gone).toBe(true);
    expect((await ownerQuery("select 1 from audit_logs where action = 'fuel_log.delete' and entity_id = $1", [victim.id])).rowCount).toBe(1);
  });
});

describe('mileage trend and summary', () => {
  it('returns every fill of a bus with totals and monthly buckets', async () => {
    const res = await get(`/school/fuel-logs/mileage-trend?busId=${busId}`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.bus).toEqual({ id: busId, code: 'R7', registrationNo: 'KA01FF7777', fuelType: 'diesel', lastKnownOdometer: null });
    expect(d.points.map((p: { fuelDate: string }) => p.fuelDate)).toEqual([day(-40), day(-30), day(-25), day(-20), day(-8)]);
    expect(d.points.map((p: { distanceKm: number | null }) => p.distanceKm)).toEqual([null, 400, null, 450, 450]);
    // Σ distance 1300 km over the span litres of the fills that have a distance (40 + 65 + 30 = 135; ₹12,240).
    expect(d.totals).toEqual({ fills: 5, litres: 185, cost: 16740, distanceKm: 1300, kmPerLitre: 9.63, costPerKm: 9.42, avgPricePerLitre: 90.49 });
    const monthSum = d.monthly.reduce((s: number, m: { fills: number }) => s + m.fills, 0);
    expect(monthSum).toBe(5);
    for (const m of d.monthly) expect(m.month).toMatch(/^\d{4}-\d{2}$/);

    const windowed = await get(`/school/fuel-logs/mileage-trend?busId=${busId}&from=${day(-30)}&to=${day(-20)}`);
    // The first fill of the window still measures from the reading before the window.
    expect(windowed.body.data.points.map((p: { distanceKm: number | null }) => p.distanceKm)).toEqual([400, null, 450]);
    expect(windowed.body.data.totals).toMatchObject({ fills: 3, distanceKm: 850, kmPerLitre: 8.1 });
    expect([windowed.body.data.from, windowed.body.data.to]).toEqual([day(-30), day(-20)]);

    expect((await get('/school/fuel-logs/mileage-trend')).status).toBe(400);
    expect((await get(`/school/fuel-logs/mileage-trend?busId=${fx.b.bus.id}`)).status).toBe(404);
    const empty = await get(`/school/fuel-logs/mileage-trend?busId=${fx.a.bus.id}&from=${day(-400)}&to=${day(-399)}`);
    expect(empty.body.data).toMatchObject({ points: [], monthly: [], totals: { fills: 0, litres: 0, kmPerLitre: null, costPerKm: null, avgPricePerLitre: null } });
  });

  it('summarises every bus with fuel logs (JSON and CSV)', async () => {
    const res = await get(`/school/fuel-logs/mileage-summary?from=${day(-60)}`);
    expect(res.status).toBe(200);
    const r7 = res.body.data.find((x: { busCode: string }) => x.busCode === 'R7');
    expect(r7).toMatchObject({ busId, fills: 5, litres: 185, distanceKm: 1300, kmPerLitre: 9.63, costPerKm: 9.42, firstFuelDate: day(-40), lastFuelDate: day(-8), flaggedLogs: 0 });
    expect(res.body.data.every((x: { busId: string }) => x.busId !== fx.b.bus.id)).toBe(true);
    expect((await get('/school/fuel-logs/mileage-summary?q=R7')).body.data.map((x: { busCode: string }) => x.busCode)).toEqual(['R7']);
    const csv = await get('/school/fuel-logs/mileage-summary?format=csv&q=R7');
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text).toContain('Bus,Registration,Fuel type,Fills,Litres,Cost,Distance (km),km per litre');
    expect(csv.text).toContain('R7,KA01FF7777,diesel,5,185,16740,1300,9.63,9.42,90.49');
  });
});

describe('isolation and roles', () => {
  it("never shows or changes another school's logs", async () => {
    const own = await get(`/school/fuel-logs/${ids.billed}`);
    expect(own.status).toBe(200);
    expect((await get(`/school/fuel-logs/${ids.billed}`, adminB)).status).toBe(404);
    expect((await patch(ids.billed!, { notes: 'x' }, adminB)).status).toBe(404);
    expect((await request(t.app).delete(api(`/school/fuel-logs/${ids.billed}`)).set(auth(adminB))).status).toBe(404);
    const listB = await get('/school/fuel-logs?limit=100', adminB);
    expect(listB.body.data.map((x: { id: string }) => x.id)).toEqual([fx.b.fuelLog.id]);
    expect((await get(`/school/fuel-logs?busId=${busId}`, adminB)).body.meta.total).toBe(0);
    const csvB = await get('/school/fuel-logs?format=csv', adminB);
    expect(csvB.text).not.toContain('R7');
    expect((await get(`/school/fuel-logs/mileage-trend?busId=${busId}`, adminB)).status).toBe(404);
    expect((await get('/school/fuel-logs/mileage-summary', adminB)).body.data.map((x: { busId: string }) => x.busId)).toEqual([fx.b.bus.id]);
    expect((await create({ busId, fuelDate: day(-1), litres: 5, cost: 1 }, adminB)).status).toBe(404);
  });

  it('is for school admins only', async () => {
    expect((await get('/school/fuel-logs', driverA)).status).toBe(403);
    expect((await create({ busId, fuelDate: day(-1), litres: 5, cost: 1 }, driverA)).status).toBe(403);
    expect((await request(t.app).get(api('/school/fuel-logs')).set(auth(parentA)).set('X-School-Id', fx.a.school.id)).status).toBe(403);
    expect((await request(t.app).get(api('/school/fuel-logs'))).status).toBe(401);
    expect((await request(t.app).get(api('/school/fuel-logs/mileage-trend')).query({ busId })).status).toBe(401);
  });

  it('shows the app role nothing without a tenant context', async () => {
    const { rows } = await appPool().query<{ n: number }>('select count(*)::int as n from fuel_logs');
    expect(rows[0]!.n).toBe(0);
  });
});

describe('nearest-neighbour odometer flags', () => {
  it('flags a single mistyped reading and one neighbour only, not the rest of the history', async () => {
    const bus = (await f.bus(fx.a.school.id, { code: 'R9', registration_no: 'KA01FF9999' })).id;
    const readings = [1000, 1200, 140, 1600, 1800];
    const made = [];
    for (const [i, odometer] of readings.entries()) made.push(await createOk({ busId: bus, fuelDate: day(-50 + i * 5), odometer, litres: 20, cost: 1800 }));
    const list = await get(`/school/fuel-logs?busId=${bus}&sort=fuelDate`);
    expect(list.body.data.map((x: { odometer: number; odometerFlags: string[] }) => [x.odometer, x.odometerFlags])).toEqual([
      [1000, []],
      [1200, ['above_next']],
      [140, ['below_previous']],
      [1600, []],
      [1800, []],
    ]);
    // Mileage skips the typo: 1600 measures from 1200 and burns the litres of both fills since then.
    expect(list.body.data.map((x: { distanceKm: number | null; spanLitres: number | null; kmPerLitre: number | null }) => [x.distanceKm, x.spanLitres, x.kmPerLitre])).toEqual([
      [null, null, null],
      [200, 20, 10],
      [null, null, null],
      [400, 40, 10],
      [200, 20, 10],
    ]);
    // A new entry is compared with its neighbours, not with the old typo.
    const next = await create({ busId: bus, fuelDate: day(-20), odometer: 2000, litres: 20, cost: 1800 });
    expect(next.body.data.warnings).toEqual([]);
    expect(made[3]!.warnings).toEqual([]);
  });
});
