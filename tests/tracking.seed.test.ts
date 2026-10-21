// Seed 75_tracking: location history for the trips of seed 70 (tracks along the routes with stop dwell),
// stop events and summaries from the real trip-finalizer, closed_at on every closed trip, a speeding stretch
// — idempotent, consistent with the odometer data (no alert beyond the planned anomalies), visible through
// the admin path endpoint. Plus the pure track generator.
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import config from '../src/config/index.js';
import { DEMO_PASSWORD, runSeeds } from '../src/db/seed.js';
import { generateTrack, MOVING_STEP_S } from '../src/db/seeds/75_tracking.js';
import type { TripGeometry } from '../src/modules/tracking/geometry.js';
import { haversineMeters } from '../src/shared/geo.js';
import { buildApp, type TestApp } from './helpers/authApp.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';

let t: TestApp;
const password = config.seedDefaultPassword ?? DEMO_PASSWORD;
const COUNTS = `select (select count(*)::int from location_points) as points, (select count(*)::int from trip_stop_events) as stop_events,
                       (select count(*)::int from alerts) as alerts, (select count(*)::int from trips where finalized_at is not null) as finalized`;

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  for (const only of ['00_', '01_', '10_', '20_', '30_', '40_', '50_', '60_', '70_']) await runSeeds({ only });
});
afterAll(closeDb);

describe('generateTrack (pure)', () => {
  const geometry: TripGeometry = {
    tripId: 't', routeId: 'r', direction: 'morning', tripDate: '2026-10-16', timezone: 'Asia/Kolkata',
    polyline: [{ lat: 12.9, lng: 77.6 }, { lat: 12.95, lng: 77.6 }], encoded: null, source: 'straight', totalM: 5560,
    stops: [1, 2, 3].map((i) => ({ id: `s${i}`, sequence: i, name: `S${i}`, lat: 12.9 + i * 0.012, lng: 77.6, radiusM: 80, expectedTime: null, plannedAtMs: null, progressM: i * 0.012 * 111_195 })),
    school: { lat: 12.95, lng: 77.6, radiusM: 200 },
  };
  it('keeps ≥ 10 s spacing, dwells inside each stop geofence and covers the route within the trip window', () => {
    const start = Date.parse('2026-10-16T01:30:00Z');
    const pts = generateTrack({ geometry, startMs: start, endMs: start + 25 * 60_000, coverage: 1, seed: 4, speedingKmh: null });
    expect(pts.length).toBeGreaterThan(40);
    for (let i = 1; i < pts.length; i += 1) expect(pts[i]!.ms - pts[i - 1]!.ms).toBeGreaterThanOrEqual(10_000);
    expect(pts.at(-1)!.ms).toBeLessThanOrEqual(start + 25 * 60_000);
    for (const s of geometry.stops) expect(pts.filter((p) => !p.mv && haversineMeters(p, s) <= s.radiusM).length).toBeGreaterThanOrEqual(1);
    expect(haversineMeters(pts.at(-1)!, geometry.polyline!.at(-1)!)).toBeLessThan(20);
    expect(MOVING_STEP_S).toBeGreaterThanOrEqual(10);
  });
  it('stops after the covered share of the route and adds a speeding stretch on request', () => {
    const start = Date.parse('2026-10-16T01:30:00Z');
    const half = generateTrack({ geometry, startMs: start, endMs: start + 25 * 60_000, coverage: 0.5, seed: 2, speedingKmh: 62 });
    const lastLat = half.at(-1)!.lat;
    expect(lastLat).toBeLessThan(12.927);
    expect(half.filter((p) => p.spd === 62)).toHaveLength(4);
  });
});

describe('75_tracking seed', () => {
  it('adds tracks, stop events and summaries to the seeded trips, idempotently and consistently', async () => {
    const alertsBefore = await ownerQuery<{ type: string; n: number }>("select alert_type as type, count(*)::int as n from alerts group by 1");
    expect((await runSeeds({ only: '75_' })).ran).toEqual(['75_tracking.ts']);
    const first = (await ownerQuery(COUNTS)).rows[0]!;
    await runSeeds({ only: '75_' });
    expect((await ownerQuery(COUNTS)).rows[0]).toEqual(first);
    expect(first.points).toBeGreaterThan(4000);

    // Every closed school trip with a route has points, a summary and stop events; every closed trip has closed_at.
    const gaps = await ownerQuery(
      `select t.id from trips t where t.trip_type = 'school' and t.route_id is not null and t.status in ('completed', 'auto_closed')
          and (t.points_count < 10 or t.summary is null or not exists (select 1 from trip_stop_events e where e.trip_id = t.id))`,
    );
    expect(gaps.rows).toEqual([]);
    expect((await ownerQuery("select count(*)::int as n from trips where status in ('completed', 'auto_closed') and closed_at is null")).rows[0]!.n).toBe(0);
    // The only new alerts are one speeding alert per school (the finalizer's GPS check agrees with seed 70).
    const alertsAfter = await ownerQuery<{ type: string; n: number }>("select alert_type as type, count(*)::int as n from alerts group by 1");
    const diff = Object.fromEntries(alertsAfter.rows.map((r) => [r.type, r.n - (alertsBefore.rows.find((b) => b.type === r.type)?.n ?? 0)]).filter(([, n]) => n !== 0));
    const schools = (await ownerQuery<{ n: number }>('select count(*)::int as n from schools')).rows[0]!.n;
    expect(diff).toEqual({ speeding: schools });
    // Normal trips: the GPS distance is within the odometer tolerance.
    const off = await ownerQuery(
      `select t.id from trips t where t.status = 'completed' and t.trip_type = 'school' and t.distance_gps_km is not null
          and not exists (select 1 from alerts a where a.trip_id = t.id and a.alert_type = 'odometer_gps_mismatch')
          and abs(t.distance_odometer_km - t.distance_gps_km) >= 2`,
    );
    expect(off.rows).toEqual([]);
  });

  it('the admin path endpoint shows the planned route, the actual path and the stop events', async () => {
    const login = await request(t.app).post('/api/v1/auth/school/login').send({ email: 'admin@greenwood.example', password });
    expect(login.status).toBe(200);
    const { rows } = await ownerQuery<{ id: string }>(
      "select t.id from trips t join schools s on s.id = t.school_id where s.code = 'GWIS-BLR' and t.status = 'completed' and t.trip_type = 'school' order by t.started_at desc limit 1",
    );
    const res = await request(t.app).get(`/api/v1/school/trips/${rows[0]!.id}/path`).set('Authorization', `Bearer ${login.body.data.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.planned.stops).toHaveLength(8);
    expect(res.body.data.actual.encoded ?? res.body.data.actual.polyline).toBeTruthy();
    expect(res.body.data.stopEvents.length).toBeGreaterThanOrEqual(7);
  });
});
