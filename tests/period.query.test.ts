// `period=<from>..<to>` on the date-filtered lists and reports (the format of the web filters and the
// dashboard quick links), next to the older `from` / `to`: trips, fuel logs, maintenance logs, alerts
// and reports. Explicit from / to win; a malformed period is a 400 on `period`.
import { alertListQuery, fuelLogListQuery, maintenanceLogListQuery, reportQuery, tripListQuery } from '@wimb/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { buildApp, loginSchoolAdmin, passwordHash, type TestApp } from './helpers/authApp.js';

describe('withPeriod (shared query schemas)', () => {
  it('expands a range, a single day and open ends into from / to', () => {
    expect(tripListQuery.parse({ period: '2026-10-01..2026-10-31' })).toMatchObject({ from: '2026-10-01', to: '2026-10-31' });
    expect(fuelLogListQuery.parse({ period: '2026-10-19' })).toMatchObject({ from: '2026-10-19', to: '2026-10-19' });
    expect(maintenanceLogListQuery.parse({ period: '2026-10-01..' })).toMatchObject({ from: '2026-10-01' });
    expect(maintenanceLogListQuery.parse({ period: '2026-10-01..' }).to).toBeUndefined();
    expect(alertListQuery.parse({ period: '..2026-10-31' })).toMatchObject({ to: '2026-10-31' });
    expect(reportQuery.parse({ period: '2026-10-01..2026-10-07' })).toMatchObject({ from: '2026-10-01', to: '2026-10-07' });
    const parsed = tripListQuery.parse({ period: '2026-10-01..2026-10-31' });
    expect('period' in parsed).toBe(false);
  });

  it('keeps explicit from / to (older links) and the plain from / to form', () => {
    expect(tripListQuery.parse({ period: '2026-10-01..2026-10-31', from: '2026-10-10' })).toMatchObject({ from: '2026-10-10', to: '2026-10-31' });
    expect(tripListQuery.parse({ from: '2026-10-02', to: '2026-10-03' })).toMatchObject({ from: '2026-10-02', to: '2026-10-03' });
    expect(tripListQuery.parse({ period: '' })).not.toHaveProperty('from');
  });

  it('rejects malformed periods and reversed ranges', () => {
    const bad = tripListQuery.safeParse({ period: 'last-week' });
    expect(bad.success).toBe(false);
    expect(bad.error!.issues[0]!.path).toEqual(['period']);
    expect(fuelLogListQuery.safeParse({ period: '2026-10-31..2026-10-01' }).success).toBe(false); // from after to
    expect(tripListQuery.safeParse({ period: '2026-02-30..2026-03-01' }).success).toBe(false); // not a calendar day
    expect(reportQuery.safeParse({ period: '2025-01-01..2026-10-01' }).success).toBe(false); // longer than the report maximum
  });
});

describe('HTTP', () => {
  let t: TestApp;
  let admin: string;
  let today: string;
  let busId: string;
  let schoolId: string;

  beforeAll(async () => {
    await truncateAll({ keep: ['platform_settings'] });
    t = buildApp();
    const fx = await f.twoSchoolFixture();
    schoolId = fx.a.school.id;
    await ownerQuery('update users set password_hash = $1 where id = $2', [await passwordHash(), fx.a.admin.id]);
    admin = (await loginSchoolAdmin(t.app, String(fx.a.admin.email))).accessToken;
    today = (await ownerQuery<{ d: string }>("select to_char((now() at time zone 'Asia/Kolkata')::date, 'YYYY-MM-DD') as d")).rows[0]!.d;
    busId = (await f.bus(schoolId, { code: 'P1' })).id;
  });
  afterAll(closeDb);

  const get = (path: string) => request(t.app).get(`/api/v1${path}`).set({ Authorization: `Bearer ${admin}` });
  const shift = (days: number) => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };

  it('GET /school/trips and /school/fuel-logs filter by period exactly as by from / to', async () => {
    await f.trip(schoolId, busId, { trip_date: today, status: 'scheduled' });
    await f.trip(schoolId, busId, { trip_date: shift(-3), status: 'scheduled', direction: 'afternoon' });
    const byPeriod = await get(`/school/trips?period=${today}..${today}`);
    const byRange = await get(`/school/trips?from=${today}&to=${today}`);
    expect(byPeriod.status).toBe(200);
    expect(byPeriod.body.meta.total).toBeGreaterThan(0);
    expect(byPeriod.body.data.map((r: { id: string }) => r.id)).toEqual(byRange.body.data.map((r: { id: string }) => r.id));
    expect(byPeriod.body.data.every((r: { tripDate: string }) => r.tripDate === today)).toBe(true);

    await f.fuelLog(schoolId, busId, { fuel_date: shift(-2), odometer: 1000 });
    await f.fuelLog(schoolId, busId, { fuel_date: shift(-10), odometer: 900 });
    const fuel = await get(`/school/fuel-logs?period=${shift(-5)}..${today}&busId=${busId}`);
    expect(fuel.status).toBe(200);
    expect(fuel.body.data.map((r: { fuelDate: string }) => r.fuelDate)).toEqual([shift(-2)]);
    expect(fuel.body.meta.totals.fills).toBe(1);

    const bad = await get('/school/trips?period=yesterday');
    expect(bad.status).toBe(400);
    expect(bad.body.error.details).toEqual([expect.objectContaining({ path: 'query.period' })]);
  });

  it("follows the dashboard's trips quick link to the same trips as from / to", async () => {
    const dash = await get('/school/dashboard');
    const link = (dash.body.data.quickLinks as { key: string; path: string }[]).find((l) => l.key === 'trips')!;
    expect(link.path).toBe(`/school/trips?period=${today}..${today}`);
    const res = await get(link.path);
    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBe((await get(`/school/trips?from=${today}&to=${today}`)).body.meta.total);
  });
});
