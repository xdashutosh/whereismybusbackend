// Seed 70_trips: last school days' trips generated from the schedules, completed with continuous odometer
// readings that end at the bus's last known reading, stored evidence photos, the demo anomalies with their
// alerts, a non-school trip — idempotent and visible through the real admin API (evidence URLs work).
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import config from '../src/config/index.js';
import { DEMO_PASSWORD, runSeeds } from '../src/db/seed.js';
import { DEMO_SCHOOLS } from '../src/db/seeds/01_demo_tenants.js';
import { storage } from '../src/shared/storage.js';
import { buildApp, type TestApp } from './helpers/authApp.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';

let t: TestApp;
const password = config.seedDefaultPassword ?? DEMO_PASSWORD;
const COUNTS = `select (select count(*)::int from trips) as trips, (select count(*)::int from trip_odometer_evidence) as evidence,
                       (select count(*)::int from files where category = 'odometer') as files, (select count(*)::int from alerts) as alerts`;

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  for (const only of ['00_', '01_', '10_', '20_', '30_', '40_', '50_', '60_']) await runSeeds({ only });
});
afterAll(closeDb);

describe('70_trips seed', () => {
  it('creates history with evidence and alerts, idempotently', async () => {
    expect((await runSeeds({ only: '70_' })).ran).toEqual(['70_trips.ts']);
    const first = (await ownerQuery(COUNTS)).rows[0]!;
    await runSeeds({ only: '70_' });
    expect((await ownerQuery(COUNTS)).rows[0]).toEqual(first);
    expect(first.trips).toBeGreaterThan(40);

    const perSchool = await ownerQuery<{ code: string; closed: number; non_school: number; types: string[] }>(
      `select s.code, (select count(*)::int from trips t where t.school_id = s.id and t.status in ('completed', 'auto_closed')) as closed,
              (select count(*)::int from trips t where t.school_id = s.id and t.trip_type = 'non_school') as non_school,
              (select array_agg(distinct a.alert_type order by a.alert_type) from alerts a where a.school_id = s.id) as types
         from schools s order by s.code`,
    );
    for (const row of perSchool.rows) {
      expect(row.closed).toBeGreaterThan(10);
      expect(row.non_school).toBe(1);
      expect(row.types).toEqual(expect.arrayContaining(['non_school_trip']));
    }
    const allTypes = new Set(perSchool.rows.flatMap((r) => r.types));
    for (const type of ['odometer_gap', 'odometer_gps_mismatch', 'trip_auto_closed', 'trip_not_started', 'non_school_trip']) expect(allTypes.has(type)).toBe(true);

    // Every started trip has start evidence, every completed one an end photo; readings never go backwards.
    const missing = await ownerQuery(
      `select t.id from trips t
        where (t.start_odometer is not null and not exists (select 1 from trip_odometer_evidence e where e.trip_id = t.id and e.kind = 'start' and e.reading = t.start_odometer))
           or (t.end_odometer is not null and not exists (select 1 from trip_odometer_evidence e where e.trip_id = t.id and e.kind = 'end' and e.reading = t.end_odometer))`,
    );
    expect(missing.rows).toEqual([]);
    const backwards = await ownerQuery(
      `select id from (select t.id, t.start_odometer, lag(coalesce(t.end_odometer, t.start_odometer)) over (partition by t.bus_id order by t.started_at) as prev
                         from trips t where t.started_at is not null) x where x.start_odometer < x.prev`,
    );
    expect(backwards.rows).toEqual([]);
    const lastKnown = await ownerQuery(
      `select b.code, b.last_known_odometer, (select t.end_odometer from trips t where t.bus_id = b.id and t.end_odometer is not null order by t.ended_at desc limit 1) as last_end
         from buses b where exists (select 1 from trips t where t.bus_id = b.id and t.end_odometer is not null)`,
    );
    for (const r of lastKnown.rows) expect(r.last_known_odometer).toBe(r.last_end);
    const key = await ownerQuery<{ key: string }>("select key from files where category = 'odometer' limit 1");
    expect(await storage.headObject(key.rows[0]!.key)).not.toBeNull();
  });

  it('school trips start and end where their route does (not at the school), evidence at the same spot', async () => {
    // Morning: first pick-up stop → school; afternoon: school → last drop stop (a few metres of jitter).
    const rows = await ownerQuery<{ id: string; direction: string; status: string; d_start_first: number; d_start_school: number; d_end_school: number | null; d_end_last: number | null; ev_start: number; ev_end: number | null }>(
      `select t.id, t.direction, t.status,
              st_distance(st_makepoint(t.start_lng, t.start_lat)::geography, st_makepoint(fs.longitude, fs.latitude)::geography) as d_start_first,
              st_distance(st_makepoint(t.start_lng, t.start_lat)::geography, st_makepoint(s.longitude, s.latitude)::geography) as d_start_school,
              st_distance(st_makepoint(t.end_lng, t.end_lat)::geography, st_makepoint(s.longitude, s.latitude)::geography) as d_end_school,
              st_distance(st_makepoint(t.end_lng, t.end_lat)::geography, st_makepoint(ls.longitude, ls.latitude)::geography) as d_end_last,
              (select st_distance(st_makepoint(e.longitude, e.latitude)::geography, st_makepoint(t.start_lng, t.start_lat)::geography)
                 from trip_odometer_evidence e where e.trip_id = t.id and e.kind = 'start') as ev_start,
              (select st_distance(st_makepoint(e.longitude, e.latitude)::geography, st_makepoint(t.end_lng, t.end_lat)::geography)
                 from trip_odometer_evidence e where e.trip_id = t.id and e.kind = 'end') as ev_end
         from trips t join schools s on s.id = t.school_id
         join lateral (select latitude, longitude from stops where route_id = t.route_id and deleted_at is null order by sequence limit 1) fs on true
         join lateral (select latitude, longitude from stops where route_id = t.route_id and deleted_at is null order by sequence desc limit 1) ls on true
        where t.trip_type = 'school' and t.status in ('completed', 'auto_closed')`,
    );
    expect(rows.rows.length).toBeGreaterThan(20);
    for (const r of rows.rows) {
      expect(Number(r.ev_start), r.id).toBeLessThan(1);
      if (r.direction === 'morning') {
        expect(Number(r.d_start_first), r.id).toBeLessThan(40);
        expect(Number(r.d_start_school), r.id).toBeGreaterThan(300);
        if (r.status === 'completed') expect(Number(r.d_end_school), r.id).toBeLessThan(40);
      } else {
        expect(Number(r.d_start_school), r.id).toBeLessThan(40);
        if (r.status === 'completed') expect(Number(r.d_end_last), r.id).toBeLessThan(40);
      }
      if (r.status === 'completed') expect(Number(r.ev_end), r.id).toBeLessThan(1);
      else expect(r.d_end_school).toBeNull(); // auto-closed: no end reading, no end position
    }
  });

  it('the school admin sees the trips with working evidence URLs', async () => {
    const s = DEMO_SCHOOLS[0];
    const login = await request(t.app).post('/api/v1/auth/school/login').send({ email: s.admin.email, password });
    expect(login.status).toBe(200);
    const auth = { Authorization: `Bearer ${login.body.data.accessToken}` };
    const list = await request(t.app).get('/api/v1/school/trips?status=completed&type=school&limit=5').set(auth);
    expect(list.status).toBe(200);
    expect(list.body.meta.total).toBeGreaterThan(5);
    const detail = await request(t.app).get(`/api/v1/school/trips/${list.body.data[0].id}`).set(auth);
    expect(detail.body.data.evidence.map((e: { kind: string }) => e.kind)).toEqual(['start', 'end']);
    const url = new URL(detail.body.data.evidence[0].photoUrl as string);
    const photo = await request(t.app).get(url.pathname + url.search);
    expect(photo.status).toBe(200);
    expect(photo.headers['content-type']).toContain('image/jpeg');
    const flagged = await request(t.app).get('/api/v1/school/trips?flagged=true').set(auth);
    expect(flagged.body.data.length).toBeGreaterThan(0);
  });
});
