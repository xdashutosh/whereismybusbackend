// Seed 50_routes: per demo school morning + afternoon routes for two lines with 8 stops each and expected
// times, straight-line planned paths through the stops and the school, bus R1/R2 assignments and
// Monday–Saturday schedules without same-bus overlaps — idempotent and visible through the real API.
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import config from '../src/config/index.js';
import { DEMO_PASSWORD, runSeeds } from '../src/db/seed.js';
import { DEMO_SCHOOLS } from '../src/db/seeds/01_demo_tenants.js';
import { decodePolyline } from '../src/shared/geo.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import { buildApp, type TestApp } from './helpers/authApp.js';

let t: TestApp;
const password = config.seedDefaultPassword ?? DEMO_PASSWORD;

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
});
afterAll(closeDb);

describe('50_routes seed', () => {
  it('creates routes, stops, paths, assignments and schedules idempotently', async () => {
    for (const only of ['00_', '01_', '10_', '30_']) await runSeeds({ only });
    expect((await runSeeds({ only: '50_' })).ran).toEqual(['50_routes.ts']);
    await runSeeds({ only: '50_' });
    const counts = await ownerQuery<{ code: string; routes: number; stops: number; straight: number; assignments: number; schedules: number }>(
      `select s.code,
              (select count(*)::int from routes r where r.school_id = s.id) as routes,
              (select count(*)::int from stops x where x.school_id = s.id) as stops,
              (select count(*)::int from routes r where r.school_id = s.id and r.polyline_source = 'straight' and r.distance_m > 0) as straight,
              (select count(*)::int from bus_route_assignments a where a.school_id = s.id and a.valid_to is null) as assignments,
              (select count(*)::int from trip_schedules ts where ts.school_id = s.id and ts.is_active) as schedules
         from schools s order by s.code`,
    );
    expect(counts.rows).toEqual(
      ['GWIS-BLR', 'LAKEVIEW-HYD', 'RIVERSIDE-COK', 'SUNRISE-JPR'].map((code) => ({ code, routes: 4, stops: 32, straight: 4, assignments: 4, schedules: 4 })),
    );
  });

  it('the school admin sees ordered stops with times, paths through the school and conflict-free schedules', async () => {
    const s = DEMO_SCHOOLS[0];
    const login = await request(t.app).post('/api/v1/auth/school/login').send({ email: s.admin.email, password });
    expect(login.status).toBe(200);
    const token = { Authorization: `Bearer ${login.body.data.accessToken}` };
    const list = await request(t.app).get('/api/v1/school/routes?sort=code,direction').set(token);
    expect(list.body.data.map((r: { code: string; direction: string }) => `${r.code}/${r.direction}`)).toEqual(['R1/afternoon', 'R1/morning', 'R2/afternoon', 'R2/morning']);
    const am = list.body.data[1];
    expect(am).toMatchObject({ stopCount: 8, firstStopTime: '07:00', lastStopTime: '07:35', polylineSource: 'straight', activeScheduleCount: 1 });
    expect(am.buses.map((b: { busCode: string }) => b.busCode)).toEqual(['R1']);

    const detail = await request(t.app).get(`/api/v1/school/routes/${am.id}`).set(token);
    expect(detail.body.data.stops[0]).toMatchObject({ sequence: 1, name: 'Kaikondrahalli Lake', code: 'A1', expectedTime: '07:00' });
    expect(detail.body.data.warnings).toEqual(['polyline_straight']);
    const path = decodePolyline(detail.body.data.polylineEncoded);
    expect(path).toHaveLength(9);
    expect(path[8]).toEqual({ lat: 12.93376, lng: 77.62275 });
    const pm = await request(t.app).get(`/api/v1/school/routes/${list.body.data[0].id}`).set(token);
    expect(pm.body.data.stops.map((x: { code: string }) => x.code)).toEqual(['A8', 'A7', 'A6', 'A5', 'A4', 'A3', 'A2', 'A1']);
    expect(pm.body.data.stops[0].expectedTime).toBe('14:40');

    const schedules = await request(t.app).get('/api/v1/school/trip-schedules?sort=busCode,plannedStartTime').set(token);
    expect(schedules.body.data.map((x: { busCode: string; routeCode: string; direction: string; plannedStartTime: string; daysOfWeek: number[] }) => `${x.busCode} ${x.routeCode}/${x.direction} ${x.plannedStartTime} ${x.daysOfWeek.join('')}`)).toEqual([
      'R1 R1/morning 06:50 123456',
      'R1 R1/afternoon 14:30 123456',
      'R2 R2/morning 06:50 123456',
      'R2 R2/afternoon 14:30 123456',
    ]);
    // Re-saving a seeded schedule passes the overlap check (the seed data is consistent with it).
    const first = schedules.body.data[0];
    expect((await request(t.app).patch(`/api/v1/school/trip-schedules/${first.id}`).set(token).send({ plannedStartTime: '06:50' })).status).toBe(200);
  });
});
