// Seed 78_fleet_ops: five months of fuel logs and a year of maintenance history per demo bus — idempotent,
// continuous readings (one deliberate typo on R4), realistic mileage bands, generated bills / invoices,
// a due list with every state, and alerts once maintenance-due-scan runs. Checked through the real API.
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import config from '../src/config/index.js';
import { DEMO_PASSWORD, runSeeds } from '../src/db/seed.js';
import { DEMO_SCHOOLS } from '../src/db/seeds/01_demo_tenants.js';
import { fuelSeries, maintenanceSeries } from '../src/db/seeds/78_fleet_ops.js';
import { maintenanceDueScan } from '../src/modules/alerts/jobs.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import { buildApp, type TestApp } from './helpers/authApp.js';

let t: TestApp;
let token: string;
const password = config.seedDefaultPassword ?? DEMO_PASSWORD;
const get = (path: string) => request(t.app).get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  await runSeeds({ only: '01_' });
  await runSeeds({ only: '30_' });
});
afterAll(closeDb);

describe('series generators', () => {
  it('produce continuous readings below the anchor, with the R4 typo and the R2 missing reading only', () => {
    for (const busCode of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6']) {
      const fills = fuelSeries({ schoolCode: 'GWIS-BLR', busCode, fuelType: 'diesel', anchorDay: '2026-10-13', anchorReading: 50000, lastDay: '2026-10-12', fromDay: '2026-05-16' });
      expect(fills.length).toBeGreaterThan(15);
      for (let i = 1; i < fills.length; i += 1) {
        expect(fills[i]!.day > fills[i - 1]!.day).toBe(true);
        expect(fills[i]!.reading).toBeGreaterThan(fills[i - 1]!.reading);
      }
      expect(fills[fills.length - 1]!.reading).toBeLessThan(50000);
      const odd = fills.filter((f) => f.entered !== f.reading);
      expect(odd.length).toBe(busCode === 'R4' || busCode === 'R2' ? 1 : 0);
      if (busCode === 'R4') expect(odd[0]!.reading - odd[0]!.entered!).toBeCloseTo(900, 1);
      if (busCode === 'R2') expect(odd[0]!.entered).toBeNull();
      const services = maintenanceSeries({ schoolCode: 'GWIS-BLR', busCode, fills, busOdometer: 50100, today: '2026-10-18' });
      const withReading = services.filter((s) => s.odometer !== null);
      for (const s of withReading) expect(s.odometer!).toBeLessThan(50100);
      expect(services.filter((s) => s.latest).length).toBeGreaterThanOrEqual(4);
    }
  });
});

describe('78_fleet_ops seed', () => {
  it('creates fuel and maintenance history with documents, idempotently', async () => {
    expect((await runSeeds({ only: '78_' })).ran).toEqual(['78_fleet_ops.ts']);
    const before = await ownerQuery<{ code: string; fuel: number; maint: number; docs: number; billed: number; invoiced: number }>(
      `select s.code,
              (select count(*)::int from fuel_logs f where f.school_id = s.id) as fuel,
              (select count(*)::int from maintenance_logs m where m.school_id = s.id) as maint,
              (select count(*)::int from files x where x.school_id = s.id and x.category in ('fuel_bill', 'maintenance_invoice')) as docs,
              (select count(*)::int from fuel_logs f where f.school_id = s.id and f.bill_file_id is not null) as billed,
              (select count(*)::int from maintenance_logs m where m.school_id = s.id and m.invoice_file_id is not null) as invoiced
         from schools s order by s.code`,
    );
    await runSeeds({ only: '78_' });
    const after = await ownerQuery(
      `select s.code, (select count(*)::int from fuel_logs f where f.school_id = s.id) as fuel, (select count(*)::int from maintenance_logs m where m.school_id = s.id) as maint
         from schools s order by s.code`,
    );
    expect(after.rows).toEqual(before.rows.map(({ code, fuel, maint }) => ({ code, fuel, maint })));
    for (const r of before.rows) {
      expect(r.fuel).toBeGreaterThan(120);
      expect(r.maint).toBeGreaterThan(50);
      expect([r.docs, r.billed, r.invoiced]).toEqual([12, 6, 6]);
    }
  });

  it('shows the school admin realistic mileage, one flagged typo and a due list with every state', async () => {
    const login = await request(t.app).post('/api/v1/auth/school/login').send({ email: DEMO_SCHOOLS[0].admin.email, password });
    expect(login.status).toBe(200);
    token = login.body.data.accessToken;

    const summary = (await get('/school/fuel-logs/mileage-summary')).body.data as { busCode: string; kmPerLitre: number; flaggedLogs: number; fuelType: string }[];
    expect(summary.map((s) => s.busCode)).toEqual(['R1', 'R2', 'R3', 'R4', 'R5', 'R6']);
    const band: Record<string, [number, number]> = { R1: [5.5, 6.5], R2: [5.3, 6.3], R3: [3.5, 4.3], R4: [8.5, 10.1], R5: [5.5, 6.7], R6: [4.9, 5.9] };
    for (const s of summary) {
      expect(s.kmPerLitre).toBeGreaterThanOrEqual(band[s.busCode]![0]);
      expect(s.kmPerLitre).toBeLessThanOrEqual(band[s.busCode]![1]);
      expect(s.flaggedLogs).toBe(s.busCode === 'R4' ? 2 : 0);
    }
    const flagged = await get('/school/fuel-logs?flagged=true&sort=fuelDate');
    expect(flagged.body.data.map((x: { busCode: string; odometerFlags: string[] }) => [x.busCode, x.odometerFlags])).toEqual([['R4', ['above_next']], ['R4', ['below_previous']]]);
    expect((await get('/school/maintenance-logs?flagged=true')).body.meta.total).toBe(0);

    const due = (await get('/school/maintenance-logs/due')).body.data as { busCode: string; serviceType: string; status: string; reason: string }[];
    expect(due.map((d) => `${d.status}:${d.reason}:${d.busCode}:${d.serviceType}`)).toEqual([
      'overdue:date:R2:Oil change',
      'overdue:date:R3:CNG kit service',
      'overdue:km:R6:General service',
      'due_soon:date:R5:Battery health check',
      'due_soon:date:R1:General service',
      'due_soon:km:R2:Tyre rotation',
    ]);

    const latestBill = (await get('/school/fuel-logs?hasBill=true&limit=1')).body.data[0];
    expect(latestBill.bill).toMatchObject({ contentType: 'application/pdf' });
    expect((await get(`/files/${latestBill.bill.id}/url`)).status).toBe(200);
  });

  it('maintenance-due-scan raises one service_due alert per due item', async () => {
    const school = (await ownerQuery<{ id: string }>("select id from schools where code = 'GWIS-BLR'")).rows[0]!;
    const res = await maintenanceDueScan({ schoolId: school.id });
    expect(res.raised).toBe(6);
  });
});
