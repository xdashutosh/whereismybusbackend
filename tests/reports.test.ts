// Reports (BP §8.3, §13.3 Reports): every report's numbers on crafted fixtures, totals, the school's
// reports feature flag, the bus filter and tenant isolation (BP §4.9) — school B holds the same codes
// with 10× the quantities, so any leak would change A's numbers.
import type { BusDistanceRow, CostPerKmRow, FuelRow, MaintenanceRow, NonSchoolUsageRow, ReportResponse, ServiceDueRow, TripSummaryRow } from '@wimb/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/tenant.js';
import { runReport } from '../src/modules/reports/repository.js';
import { buildApp, loginSchoolAdmin, schoolAdmin, type TestApp } from './helpers/authApp.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { auth, localDay, outsiders, reportsWorld, type ReportsWorld } from './reports.fixtures.js';

let t: TestApp;
let a: ReportsWorld;
let b: ReportsWorld;

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  a = await reportsWorld(t.app);
  b = await reportsWorld(t.app, { scale: 10, name: 'Greenfield Public School' });
});
afterAll(closeDb);

const range = () => ({ from: localDay('Asia/Kolkata', -10), to: localDay('Asia/Kolkata') });
const get = (token: string, kind: string, query: Record<string, string> = {}) => request(t.app).get(`/api/v1/school/reports/${kind}`).query(query).set(auth(token));
async function report<R>(w: ReportsWorld, kind: string, query: Record<string, string> = range()): Promise<Omit<ReportResponse, 'rows'> & { rows: R[] }> {
  const res = await get(w.admin.accessToken, kind, query);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as Omit<ReportResponse, 'rows'> & { rows: R[] };
}
const byCode = <R extends { busCode: string | null }>(rows: R[], code: string) => rows.find((r) => r.busCode === code);

describe('bus-distance', () => {
  it('sums trips that ran per bus, lists idle buses and deleted buses with activity', async () => {
    const r = await report<BusDistanceRow>(a, 'bus-distance');
    expect(r).toMatchObject({ report: 'bus-distance', title: 'Bus distance', range: range(), busId: null, timezone: 'Asia/Kolkata', truncated: false });
    expect(r.rows.map((x) => x.busCode)).toEqual(['R1', 'R2', 'R8']);
    expect(byCode(r.rows, 'R1')).toEqual({
      busId: a.r1.id, busCode: 'R1', registrationNo: 'KA01AB1001', busStatus: 'active', busDeleted: false,
      trips: 4, schoolTrips: 3, nonSchoolTrips: 1, activeDays: 3, odometerKm: 50, gpsKm: 39.5, distanceKm: 70.5, avgKmPerTrip: 17.6,
      firstTripDate: localDay('Asia/Kolkata', -5), lastTripDate: localDay('Asia/Kolkata', -3),
    });
    expect(byCode(r.rows, 'R2')).toMatchObject({ trips: 0, distanceKm: 0, avgKmPerTrip: null, firstTripDate: null, busStatus: 'maintenance' });
    expect(byCode(r.rows, 'R8')).toMatchObject({ busDeleted: true, trips: 1, distanceKm: 12 });
    expect(r.totals).toEqual({ trips: 5, schoolTrips: 4, nonSchoolTrips: 1, odometerKm: 62, gpsKm: 39.5, distanceKm: 82.5, avgKmPerTrip: 16.5 });
    expect(r.columns[0]).toEqual({ key: 'busCode', label: 'Bus', type: 'text' });
  });

  it('a range that includes the old trip adds it', async () => {
    const r = await report<BusDistanceRow>(a, 'bus-distance', { from: localDay('Asia/Kolkata', -60), to: localDay('Asia/Kolkata') });
    expect(byCode(r.rows, 'R1')).toMatchObject({ trips: 5, distanceKm: 170.5 });
  });
});

describe('fuel', () => {
  it('sums fills in range (deleted / out-of-range ignored) against the odometer distance, trip km as fallback', async () => {
    const r = await report<FuelRow>(a, 'fuel');
    expect(r.rows.map((x) => x.busCode)).toEqual(['R1', 'R2', 'R8']);
    // R1: 49 000 → 49 500 between its two fills = 500 km over the 20 L of the second fill (the first has no
    // earlier reading), not the 70.5 km its trips recorded.
    expect(byCode(r.rows, 'R1')).toEqual({
      busId: a.r1.id, busCode: 'R1', registrationNo: 'KA01AB1001', fuelType: 'diesel', busDeleted: false, fills: 2, units: ['L'],
      litres: 60, kg: 0, kwh: 0, litresCost: 5800, kgCost: 0, kwhCost: 0, cost: 5800, avgPricePerUnit: 96.67,
      odometerKm: 500, tripKm: 70.5, distanceKm: 500, distanceSource: 'odometer', kmQuantity: 20, kmCost: 2000,
      kmPerUnit: 25, fuelCostPerKm: 4, lastFillDate: localDay('Asia/Kolkata', -2),
    });
    // R2: one reading, no trips → no distance at all; R8: no fills → trip km.
    expect(byCode(r.rows, 'R2')).toMatchObject({
      fills: 1, units: ['L'], litres: 10, cost: 1000, avgPricePerUnit: 100, odometerKm: null, tripKm: 0, distanceKm: 0, distanceSource: null,
      kmQuantity: null, kmCost: null, kmPerUnit: null, fuelCostPerKm: null,
    });
    expect(byCode(r.rows, 'R8')).toMatchObject({ fills: 0, units: [], litres: 0, cost: 0, odometerKm: null, tripKm: 12, distanceKm: 12, distanceSource: 'trips', avgPricePerUnit: null, kmPerUnit: null, fuelCostPerKm: null });
    // One unit only: the per-unit totals are the report's. km per litre counts the litres burnt over a distance.
    expect(r.totals).toEqual({
      fills: 3, litres: 70, kg: 0, kwh: 0, litresCost: 6800, kgCost: 0, kwhCost: 0, cost: 6800, odometerKm: 500, tripKm: 82.5, distanceKm: 512, kmCost: 2000,
      fuelCostPerKm: 3.91, avgPricePerLitre: 97.14, avgPricePerKg: null, avgPricePerKwh: null, kmPerLitre: 25, kmPerKg: null, kmPerKwh: null, avgPricePerUnit: 97.14, kmPerUnit: 25,
    });
    expect(r.columns.find((c) => c.key === 'odometerKm')?.label).toBe('Odometer km between fills');
    expect(r.columns.find((c) => c.key === 'tripKm')?.label).toBe('Trip km');
  });

  it('matches the Fuel page mileage (fill-to-fill) even when trips miss depot runs, base fill before the range included', async () => {
    const s = await f.school({ name: 'Mileage Match School', timezone: 'Asia/Kolkata' });
    await f.schoolSubscription(s.id);
    const day = (n: number) => localDay('Asia/Kolkata', n);
    const bus = await f.bus(s.id, { code: 'R1', fuel_type: 'diesel' });
    const depot = await f.bus(s.id, { code: 'R6', fuel_type: 'diesel' }); // fuel, no trips at all
    await f.fuelLog(s.id, bus.id, { fuel_date: day(-40), odometer: 10000, litres: 60, cost: 5400 }); // mileage base, before the range
    await f.fuelLog(s.id, bus.id, { fuel_date: day(-20), odometer: 10300, litres: 50, cost: 4500 });
    await f.fuelLog(s.id, bus.id, { fuel_date: day(-12), odometer: null, litres: 10, cost: 900 }); // no reading: still burnt over the span
    await f.fuelLog(s.id, bus.id, { fuel_date: day(-5), odometer: 10600, litres: 40, cost: 3600 });
    await f.fuelLog(s.id, depot.id, { fuel_date: day(-25), odometer: 5000, litres: 40, cost: 3600 });
    await f.fuelLog(s.id, depot.id, { fuel_date: day(-10), odometer: 5240, litres: 40, cost: 3600 });
    // The trips cover only 50 km of the 600 driven.
    await f.trip(s.id, bus.id, { trip_date: day(-6), status: 'completed', started_at: new Date(Date.now() - 6 * 86_400_000).toISOString(), ended_at: new Date(Date.now() - 6 * 86_400_000 + 3_600_000).toISOString(), distance_odometer_km: 50 });
    const admin = await loginSchoolAdmin(t.app, String((await schoolAdmin(s.id)).email));
    const q = { from: day(-29), to: day(0) };
    const r = await report<FuelRow>({ admin } as ReportsWorld, 'fuel', q);
    // 600 km (10 000 → 10 600) over 100 L / 9000 burnt since the base = 6 km/l, ₹15/km.
    expect(byCode(r.rows, 'R1')).toMatchObject({ fills: 3, litres: 100, cost: 9000, odometerKm: 600, tripKm: 50, distanceKm: 600, distanceSource: 'odometer', kmPerUnit: 6, fuelCostPerKm: 15 });
    expect(byCode(r.rows, 'R6')).toMatchObject({ odometerKm: 240, tripKm: 0, distanceKm: 240, distanceSource: 'odometer', kmPerUnit: 6, fuelCostPerKm: 15 });
    const trend = await request(t.app).get('/api/v1/school/fuel-logs/mileage-trend').query({ busId: bus.id, ...q }).set(auth(admin.accessToken));
    expect(trend.status).toBe(200);
    expect(trend.body.data.totals).toMatchObject({ distanceKm: 600, kmPerLitre: 6, costPerKm: 15 });
    const c = await report<CostPerKmRow>({ admin } as ReportsWorld, 'cost-per-km', q);
    expect(byCode(c.rows, 'R1')).toMatchObject({ distanceKm: 600, distanceSource: 'odometer', fuelCost: 9000, fuelCostPerKm: 15, costPerKm: 15 });
    expect(c.totals).toMatchObject({ distanceKm: 840, kmCost: 12600, fuelCostPerKm: 15, costPerKm: 15 });
  });

  it('never adds litres, kg (CNG) and kWh (electric) together; cost and cost per km stay comparable', async () => {
    const s = await f.school({ name: 'Mixed Fleet School', timezone: 'Asia/Kolkata' });
    await f.schoolSubscription(s.id);
    const day = (n: number) => localDay('Asia/Kolkata', n);
    const diesel = await f.bus(s.id, { code: 'R1', fuel_type: 'diesel' });
    const cng = await f.bus(s.id, { code: 'R3', fuel_type: 'cng' });
    const ev = await f.bus(s.id, { code: 'R5', fuel_type: 'electric' });
    const hybrid = await f.bus(s.id, { code: 'R6', fuel_type: 'diesel' }); // one log typed CNG → mixed units
    await f.fuelLog(s.id, diesel.id, { fuel_date: day(-3), litres: 50, cost: 4500 });
    await f.fuelLog(s.id, cng.id, { fuel_date: day(-3), litres: 20, cost: 1800 });
    await f.fuelLog(s.id, cng.id, { fuel_date: day(-2), litres: 10, cost: 900 });
    await f.fuelLog(s.id, ev.id, { fuel_date: day(-2), litres: 80, cost: 960 });
    await f.fuelLog(s.id, hybrid.id, { fuel_date: day(-2), litres: 30, cost: 2700 });
    await f.fuelLog(s.id, hybrid.id, { fuel_date: day(-1), litres: 5, cost: 450, fuel_type: 'cng' });
    for (const [bus, km] of [[diesel, 200], [cng, 150], [ev, 96], [hybrid, 100]] as const) {
      await f.trip(s.id, bus.id, { trip_date: day(-2), status: 'completed', started_at: new Date(Date.now() - 2 * 86_400_000).toISOString(), ended_at: new Date(Date.now() - 2 * 86_400_000 + 3_600_000).toISOString(), distance_odometer_km: km });
    }
    const admin = await loginSchoolAdmin(t.app, String((await schoolAdmin(s.id)).email));
    const r = await report<FuelRow>({ admin } as ReportsWorld, 'fuel');
    expect(r.columns.map((c) => c.key)).toEqual(expect.arrayContaining(['units', 'litres', 'kg', 'kwh', 'avgPricePerUnit', 'kmPerUnit']));
    expect(r.columns.map((c) => c.key)).not.toContain('avgPricePerLitre');
    expect(byCode(r.rows, 'R1')).toMatchObject({ units: ['L'], litres: 50, kg: 0, kwh: 0, avgPricePerUnit: 90, kmPerUnit: 4, fuelCostPerKm: 22.5 });
    expect(byCode(r.rows, 'R3')).toMatchObject({ units: ['kg'], litres: 0, kg: 30, kwh: 0, avgPricePerUnit: 90, kmPerUnit: 5, fuelCostPerKm: 18 });
    expect(byCode(r.rows, 'R5')).toMatchObject({ units: ['kWh'], litres: 0, kg: 0, kwh: 80, avgPricePerUnit: 12, kmPerUnit: 1.2, fuelCostPerKm: 10 });
    expect(byCode(r.rows, 'R6')).toMatchObject({ units: ['L', 'kg'], litres: 30, kg: 5, cost: 3150, avgPricePerUnit: null, kmPerUnit: null, fuelCostPerKm: 31.5 });
    expect(r.totals).toMatchObject({
      fills: 6, litres: 80, kg: 35, kwh: 80, cost: 11310, distanceKm: 546, fuelCostPerKm: 20.71,
      avgPricePerLitre: 90, avgPricePerKg: 90, avgPricePerKwh: 12, kmPerLitre: 4, kmPerKg: 5, kmPerKwh: 1.2,
      avgPricePerUnit: null, kmPerUnit: null,
    });
  });
});

describe('maintenance', () => {
  it('counts services and cost in range, last service and the earliest next due of the latest logs', async () => {
    const r = await report<MaintenanceRow>(a, 'maintenance');
    expect(r.rows.map((x) => x.busCode)).toEqual(['R1', 'R2']);
    expect(byCode(r.rows, 'R1')).toEqual({
      busId: a.r1.id, busCode: 'R1', registrationNo: 'KA01AB1001', busDeleted: false,
      services: 2, totalCost: 2500, avgCost: 2500, unpricedServices: 1, serviceTypes: ['Brake check', 'Oil change'],
      lastServiceDate: localDay('Asia/Kolkata', -1), lastServiceType: 'Brake check', nextDueDate: localDay('Asia/Kolkata', 3),
    });
    expect(byCode(r.rows, 'R2')).toMatchObject({ services: 0, totalCost: 0, avgCost: null, serviceTypes: [], lastServiceDate: null, nextDueDate: null });
    expect(r.totals).toEqual({ services: 2, totalCost: 2500, unpricedServices: 1, avgCost: 2500 });
  });
});

describe('cost-per-km', () => {
  it('divides fuel + maintenance cost by distance', async () => {
    const r = await report<CostPerKmRow>(a, 'cost-per-km');
    expect(byCode(r.rows, 'R1')).toEqual({
      busId: a.r1.id, busCode: 'R1', registrationNo: 'KA01AB1001', busDeleted: false,
      odometerKm: 500, tripKm: 70.5, distanceKm: 500, distanceSource: 'odometer', kmQuantity: 20, kmCost: 2000,
      fuelCost: 5800, maintenanceCost: 2500, totalCost: 8300, fuelCostPerKm: 4, maintenanceCostPerKm: 5, costPerKm: 9,
    });
    expect(byCode(r.rows, 'R2')).toMatchObject({ distanceKm: 0, distanceSource: null, fuelCost: 1000, totalCost: 1000, costPerKm: null });
    expect(byCode(r.rows, 'R8')).toMatchObject({ odometerKm: null, tripKm: 12, distanceKm: 12, distanceSource: 'trips', fuelCostPerKm: 0 });
    expect(r.totals).toEqual({
      odometerKm: 500, tripKm: 82.5, distanceKm: 512, kmCost: 2000, fuelCost: 6800, maintenanceCost: 2500, totalCost: 9300,
      fuelCostPerKm: 3.91, maintenanceCostPerKm: 4.88, costPerKm: 8.79,
    });
  });
});

describe('service-due', () => {
  it('lists the latest schedule per bus and service type, most urgent first, as of the school-local today', async () => {
    const r = await report<ServiceDueRow>(a, 'service-due', {});
    expect(r.range).toEqual({ from: null, to: null });
    expect(r.rows.map((x) => [x.serviceType, x.status, x.dueBy])).toEqual([
      ['Tyre rotation', 'overdue', 'km'],
      ['Oil change', 'due_soon', 'date'],
      ['Brake check', 'scheduled', null],
    ]);
    expect(r.rows[0]).toEqual({
      maintenanceLogId: a.maintenance.tyre.id, busId: a.r1.id, busCode: 'R1', registrationNo: 'KA01AB1001', serviceType: 'Tyre rotation',
      lastServiceDate: localDay('Asia/Kolkata', -200), lastServiceOdometer: null, vendor: null,
      nextDueDate: null, daysToDue: null, nextDueKm: 50000, currentOdometer: 50100, kmToDue: -100, status: 'overdue', dueBy: 'km',
    });
    expect(r.rows[1]).toMatchObject({ maintenanceLogId: a.maintenance.oil.id, vendor: 'City Motors', lastServiceOdometer: 50000, nextDueDate: localDay('Asia/Kolkata', 3), daysToDue: 3, kmToDue: null });
    expect(r.rows[2]).toMatchObject({ maintenanceLogId: a.maintenance.brake.id, daysToDue: 60 });
    expect(r.rows.some((x) => x.maintenanceLogId === a.maintenance.oilOld.id)).toBe(false);
    expect(r.totals).toEqual({});
  });

  it('an explicit range filters next due dates (km-only schedules drop out)', async () => {
    const r = await report<ServiceDueRow>(a, 'service-due', { from: localDay('Asia/Kolkata'), to: localDay('Asia/Kolkata', 10) });
    expect(r.range).toEqual({ from: localDay('Asia/Kolkata'), to: localDay('Asia/Kolkata', 10) });
    expect(r.rows.map((x) => x.serviceType)).toEqual(['Oil change']);
  });

  it('skips buses out of service and deleted logs', async () => {
    const retired = await f.bus(a.sid, { code: 'R5', status: 'retired', last_known_odometer: 1000 });
    await f.maintenanceLog(a.sid, retired.id, { service_type: 'Oil change', next_due_date: localDay('Asia/Kolkata', -1) });
    await f.maintenanceLog(a.sid, a.r2.id, { service_type: 'Wash', next_due_date: localDay('Asia/Kolkata', 1), deleted_at: new Date().toISOString() });
    const r = await report<ServiceDueRow>(a, 'service-due', {});
    expect(r.rows.map((x) => x.busCode)).toEqual(['R1', 'R1', 'R1']);
    await ownerQuery('delete from maintenance_logs where bus_id = any ($1::uuid[])', [[retired.id, a.r2.id]]);
    await ownerQuery('delete from buses where id = $1', [retired.id]);
  });
});

describe('non-school-usage', () => {
  it('lists non-school trips with purpose, duration and distance', async () => {
    const r = await report<NonSchoolUsageRow>(a, 'non-school-usage');
    expect(r.rows).toHaveLength(1);
    const row = r.rows[0]!;
    expect(row).toMatchObject({
      tripId: a.trips.t3.id, tripDate: localDay('Asia/Kolkata', -4), busId: a.r1.id, busCode: 'R1', registrationNo: 'KA01AB1001',
      driverName: 'Ramesh Kumar', conductorName: null, purpose: 'Picnic', status: 'completed', durationMin: 120,
      startOdometer: 2000, endOdometer: 2030, distanceKm: 30, alerts: 0,
    });
    expect(Date.parse(row.startedAt!)).toBe(Date.parse(String(a.trips.t3.started_at)));
    expect(r.totals).toEqual({ durationMin: 120, distanceKm: 30, alerts: 0 });
  });
});

describe('trip-summary', () => {
  it('counts outcomes, on-time / late starts against the grace minutes, completion rate and alerts per bus', async () => {
    const r = await report<TripSummaryRow>(a, 'trip-summary');
    expect(byCode(r.rows, 'R1')).toEqual({
      busId: a.r1.id, busCode: 'R1', registrationNo: 'KA01AB1001', busDeleted: false,
      trips: 5, schoolTrips: 4, completed: 2, autoClosed: 1, missed: 1, cancelled: 0, inProgress: 0, scheduled: 0, nonSchoolTrips: 1,
      onTimeStarts: 1, lateStarts: 1, avgStartDelayMin: 15, completionRatePct: 50, distanceKm: 70.5, alerts: 1,
    });
    expect(byCode(r.rows, 'R8')).toMatchObject({ busDeleted: true, trips: 1, completed: 1, completionRatePct: 100, avgStartDelayMin: null });
    expect(byCode(r.rows, 'R2')).toMatchObject({ trips: 0, completionRatePct: null });
    expect(r.totals).toMatchObject({ trips: 6, schoolTrips: 5, completed: 3, missed: 1, autoClosed: 1, onTimeStarts: 1, lateStarts: 1, distanceKm: 82.5, alerts: 1, completionRatePct: 60 });
  });

  it('a longer grace makes the late start on time', async () => {
    await f.schoolSettings(a.sid, { trip_not_started_grace_min: 30 });
    const r = await report<TripSummaryRow>(a, 'trip-summary');
    expect(byCode(r.rows, 'R1')).toMatchObject({ onTimeStarts: 2, lateStarts: 0 });
    await f.schoolSettings(a.sid, { trip_not_started_grace_min: 10 });
  });
});

describe('filters and validation', () => {
  it('busId narrows every report to that bus (deleted buses included)', async () => {
    const q = { ...range(), busId: a.r1.id };
    for (const kind of ['bus-distance', 'fuel', 'maintenance', 'cost-per-km', 'service-due', 'non-school-usage', 'trip-summary']) {
      const r = await report<{ busId: string }>(a, kind, kind === 'service-due' ? { busId: a.r1.id } : q);
      expect(r.busId).toBe(a.r1.id);
      expect(r.rows.length, kind).toBeGreaterThan(0);
      expect(r.rows.every((x) => x.busId === a.r1.id), kind).toBe(true);
    }
    const r8 = await report<BusDistanceRow>(a, 'bus-distance', { ...range(), busId: a.r8Deleted.id });
    expect(r8.rows.map((x) => x.busCode)).toEqual(['R8']);
  });

  it('rejects bad ranges, formats and ids; unknown reports are 404', async () => {
    const tok = a.admin.accessToken;
    let res = await get(tok, 'fuel', { from: localDay('Asia/Kolkata'), to: localDay('Asia/Kolkata', -1) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    res = await get(tok, 'fuel', { from: '2025-01-01', to: '2026-01-02' });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].message).toMatch(/366 days/);
    res = await get(tok, 'fuel', { from: '2020-01-01' });
    expect(res.status).toBe(400);
    expect((await get(tok, 'fuel', { from: '2026-02-30' })).status).toBe(400);
    expect((await get(tok, 'fuel', { format: 'xlsx' })).status).toBe(400);
    expect((await get(tok, 'fuel', { busId: 'nope' })).status).toBe(400);
    res = await get(tok, 'fuel-economy');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect((await get(tok, 'fuel', { from: '2025-01-01', to: '2026-01-01' })).status).toBe(200);
  });

  it('the school reports feature flag gates every report', async () => {
    await ownerQuery(`update school_settings set features = features || '{"reports": false}'::jsonb where school_id = $1`, [a.sid]);
    try {
      const res = await get(a.admin.accessToken, 'trip-summary');
      expect(res.status).toBe(403);
      expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', details: { reason: 'FEATURE_DISABLED', feature: 'reports' } });
      expect((await get(b.admin.accessToken, 'trip-summary')).status).toBe(200);
    } finally {
      await ownerQuery(`update school_settings set features = features || '{"reports": true}'::jsonb where school_id = $1`, [a.sid]);
    }
  });
});

describe('tenant isolation (BP §4.9)', () => {
  it('each school sees only its own numbers for identical bus codes', async () => {
    const ra = await report<FuelRow>(a, 'fuel');
    const rb = await report<FuelRow>(b, 'fuel');
    expect(byCode(ra.rows, 'R1')).toMatchObject({ busId: a.r1.id, litres: 60, cost: 5800 });
    expect(byCode(rb.rows, 'R1')).toMatchObject({ busId: b.r1.id, litres: 600, cost: 58000 });
    const da = await report<BusDistanceRow>(a, 'bus-distance');
    expect(da.rows.map((x) => x.busId).sort()).toEqual([a.r1.id, a.r2.id, a.r8Deleted.id].sort());
    const na = await report<NonSchoolUsageRow>(a, 'non-school-usage');
    expect(na.rows.map((x) => x.tripId)).toEqual([a.trips.t3.id]);
  });

  it("another school's bus id answers 404; a schoolId in the query is ignored", async () => {
    for (const kind of ['bus-distance', 'service-due', 'non-school-usage']) {
      const res = await get(a.admin.accessToken, kind, { busId: b.r1.id });
      expect(res.status, kind).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    }
    const r = await report<FuelRow>(a, 'fuel', { ...range(), schoolId: b.sid });
    expect(byCode(r.rows, 'R1')).toMatchObject({ busId: a.r1.id, cost: 5800 });
  });

  it('only school admins: drivers, parents, super admins and anonymous callers are refused', async () => {
    const o = await outsiders(t, a, 'reports-driver-0001');
    for (const [who, token] of Object.entries(o)) {
      const res = await get(token, 'fuel');
      expect(res.status, who).toBe(403);
      const parentWithSchool = await request(t.app).get('/api/v1/school/reports/fuel').set(auth(token)).set('X-School-Id', a.sid);
      expect(parentWithSchool.status, who).toBe(403);
    }
    expect((await request(t.app).get('/api/v1/school/reports/fuel')).status).toBe(401);
    expect((await request(t.app).get('/api/v1/school/reports/fuel').set(auth('not-a-token'))).status).toBe(401);
  });

  it('the app role without a school context sees no report rows', async () => {
    const q = { from: localDay('Asia/Kolkata', -10), to: localDay('Asia/Kolkata'), busId: null, today: localDay('Asia/Kolkata'), cap: 100 };
    for (const kind of ['bus-distance', 'fuel', 'maintenance', 'cost-per-km', 'service-due', 'non-school-usage', 'trip-summary'] as const) {
      const rows = await withTenant(f.contexts.superAdmin(), (tx) => runReport(tx, kind, q), { readOnly: true });
      expect(rows, kind).toEqual([]);
    }
    const own = await withTenant(f.contexts.schoolAdmin(a.sid), (tx) => runReport(tx, 'fuel', q), { readOnly: true });
    expect(own.map((r) => r.bus_id).sort()).toEqual([a.r1.id, a.r2.id, a.r8Deleted.id].sort());
  });
});
