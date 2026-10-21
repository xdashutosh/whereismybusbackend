// Tracking jobs (BP §7.3, §9.6): location-gap-detector (Location unavailable + deduplicated GPS
// alert, restored on new points, per school), trip-finalizer outputs (GPS distance with outlier
// filtering, simplified path, stop dwell incl. stops only the finalizer saw, deviation, over-speed,
// flags, idempotence) and the GPS distance provider used by the trips module, partition maintenance,
// and the job registry.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchoolSystem, withSystem } from '../src/db/tenant.js';
import { JOB_DEFINITIONS, partitionMaintenance } from '../src/jobs/index.js';
import { events } from '../src/shared/events.js';
import { detectLocationGaps, detectLocationGapsAllSchools } from '../src/modules/tracking/gap.js';
import { gpsDistanceKm, runTripFinalizer } from '../src/modules/tracking/index.js';
import { liveStore, newLiveState } from '../src/modules/tracking/liveState.js';
import { lateFinalize } from '../src/modules/tracking/persist.js';
import { useRealtime } from '../src/modules/tracking/publish.js';
import { gpsDistance } from '../src/modules/trips/gps.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { buildApp, DEVICE, type TestApp } from './helpers/authApp.js';
import { drainJobs, KM_LAT, northbound, ORIGIN, parked, postPoints, trackingWorld, type GenPoint, type TrackingWorld } from './helpers/trackingWorld.js';

let t: TestApp;
let a: TrackingWorld;
let b: TrackingWorld;
let restore: () => void;
const emitted: { room: string; event: string; payload: { change?: string } }[] = [];

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  lateFinalize.delayMs = 0;
  t = buildApp();
  a = await trackingWorld(t.app, { settings: { speed_limit_kmh: 40, enable_speeding_alert: true, enable_route_deviation_alert: true, route_deviation_m: 150 } });
  b = await trackingWorld(t.app, { device: { ...DEVICE, deviceId: 'device-b-0002' } });
  restore = useRealtime({ emit: async (room: string, event: string, payload: unknown) => void emitted.push({ room, event, payload: payload as { change?: string } }), disconnectSessions: async () => undefined, revalidateActors: async () => undefined, disconnectSchool: async () => undefined });
});
afterAll(async () => {
  restore();
  await drainJobs();
  await closeDb();
});

const alertsOf = async (schoolId: string) => (await ownerQuery<{ alert_type: string; trip_id: string; dedupe_key: string; details: Record<string, unknown> }>('select alert_type, trip_id, dedupe_key, details from alerts where school_id = $1', [schoolId])).rows;

describe('location-gap-detector', () => {
  it('flags a running trip without points as Location unavailable and raises one GPS alert', async () => {
    const r = await detectLocationGaps(String(a.school.id));
    expect(r).toMatchObject({ checked: 1, flagged: 1, alerts: 1 });
    const state = await liveStore.get(String(a.school.id), a.trip.id);
    expect(state!.locationUnavailable).toBe(true);
    const alerts = await alertsOf(String(a.school.id));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ alert_type: 'gps_disabled', trip_id: a.trip.id, dedupe_key: `gps_disabled:${a.trip.id}` });
    expect(alerts[0]!.details.reason).toBe('location_gap');
    expect(emitted.some((e) => e.room === `trip:${a.trip.id}` && e.payload.change === 'location_unavailable')).toBe(true);
    expect(emitted.some((e) => e.room === `school:${a.school.id}:fleet` && e.payload.change === 'location_unavailable')).toBe(true);
    // School B is untouched by school A's pass.
    expect(await liveStore.get(String(b.school.id), b.trip.id)).toBeNull();
    expect(await alertsOf(String(b.school.id))).toHaveLength(0);
  });

  it('is idempotent (no second flag, alert deduplicated while open)', async () => {
    const r = await detectLocationGaps(String(a.school.id));
    expect(r).toMatchObject({ flagged: 0, alerts: 0 });
    expect(await alertsOf(String(a.school.id))).toHaveLength(1);
  });

  it('clears the flag when points resume and does not flag a fresh trip', async () => {
    const res = await postPoints(t.app, a, northbound({ baseMs: Date.now() - 2000, fromKm: -0.4, count: 1 }));
    expect(res.status).toBe(200);
    await drainJobs();
    expect((await liveStore.get(String(a.school.id), a.trip.id))!.locationUnavailable).toBe(false);
    expect(emitted.some((e) => e.payload.change === 'location_restored')).toBe(true);
    expect((await detectLocationGaps(String(a.school.id))).flagged).toBe(0);
  });

  it('flags after 3× the expected interval and picks low_battery / no_network from the last fix', async () => {
    const nowMs = Date.now();
    const busX = await f.bus(a.school.id);
    const tripX = await f.activeTrip(a.school.id, busX.id, { started_at: new Date(nowMs - 3600_000).toISOString() });
    const s = newLiveState({ schoolId: String(a.school.id), tripId: tripX.id, busId: busX.id, routeId: null, direction: 'morning', tripStatus: 'in_progress', lastPointAt: null });
    s.point = { t: new Date(nowMs - 25_000).toISOString(), lat: 12.9, lng: 77.6, spd: 30, hdg: 0, acc: 8, bat: 5, net: '4g', mv: true };
    await liveStore.put(s);
    expect((await detectLocationGaps(String(a.school.id), { nowMs })).flagged).toBe(0); // 25 s < 30 s
    expect((await detectLocationGaps(String(a.school.id), { nowMs: nowMs + 10_000 })).flagged).toBe(1); // 35 s
    expect((await detectLocationGaps(String(a.school.id), { nowMs: nowMs + 6 * 60_000 })).alerts).toBe(1);
    const alert = (await alertsOf(String(a.school.id))).find((x) => x.trip_id === tripX.id)!;
    expect(alert.alert_type).toBe('low_battery');
    await ownerQuery("update trips set status = 'cancelled' where id = $1", [tripX.id]);
  });

  it('runs over every active school', async () => {
    const r = await detectLocationGapsAllSchools();
    expect(r.checked).toBeGreaterThanOrEqual(2);
    expect(await alertsOf(String(b.school.id))).toHaveLength(1);
  });
});

/** A morning run: stop 1 dwell, stops 2–4 passed, a GPS spike and an inaccurate fix, a speeding run. */
function history(baseMs: number): GenPoint[] {
  const pts: GenPoint[] = [
    ...northbound({ baseMs, fromKm: -0.3, kmh: 30, count: 4 }),
    ...parked({ baseMs: baseMs + 40_000, km: 0, stepS: 10, count: 7 }),
    ...northbound({ baseMs: baseMs + 110_000, fromKm: 0.1, kmh: 30, count: 30 }),
  ];
  pts.push({ t: new Date(baseMs + 410_000).toISOString(), lat: ORIGIN.lat + 9 * KM_LAT, lng: ORIGIN.lng, spd: 30, acc: 8 }); // spike
  pts.push({ t: new Date(baseMs + 420_000).toISOString(), lat: ORIGIN.lat + 2.6 * KM_LAT, lng: ORIGIN.lng, spd: 30, acc: 400 }); // inaccurate
  pts.push(...northbound({ baseMs: baseMs + 430_000, fromKm: 2.6, kmh: 60, count: 5 }));
  pts.push(...northbound({ baseMs: baseMs + 480_000, fromKm: 3.45, kmh: 30, count: 10 }));
  return pts;
}

interface SummaryShape {
  points: { total: number; kept: number; outliers: number };
  path: { encoded: string | null; pointCount: number };
  stops: { planned: number; visited: number; missedStopIds: string[]; dwell: { stopId: string; dwellS: number | null; source: string }[] };
  deviation: { maxM: number; avgM: number; longestRunOverThreshold: number };
  speed: Record<string, unknown>;
  dataQuality: Record<string, unknown>;
  flags: string[];
}

describe('trip-finalizer', () => {
  let tripId: string;
  let schoolId: string;
  beforeAll(async () => {
    schoolId = String(a.school.id);
    tripId = a.trip.id;
    await ownerQuery('delete from location_points where trip_id = $1', [tripId]);
    await ownerQuery('delete from trip_stop_events where trip_id = $1', [tripId]);
    await ownerQuery('update trips set points_count = 0, last_point_at = null where id = $1', [tripId]);
    await liveStore.del(schoolId, tripId);
    const base = Date.parse(String(a.trip.started_at)) + 60_000;
    const res = await postPoints(t.app, a, history(base));
    expect(res.status).toBe(200);
    await drainJobs();
    // Stop 4 only exists in points the live pass never analysed (inserted directly).
    await ownerQuery("delete from trip_stop_events where trip_id = $1 and stop_id = $2", [tripId, a.stops[3]!.id]);
    await ownerQuery("update trips set status = 'completed', ended_at = $2, end_odometer = 1006 where id = $1", [tripId, new Date(base + 600_000).toISOString()]);
  });

  it('skips trips that are not closed', async () => {
    expect(await runTripFinalizer({ schoolId: String(b.school.id), tripId: b.trip.id })).toMatchObject({ finalized: false, reason: 'NOT_CLOSED' });
  });

  it('stores GPS distance, simplified path, stops, deviation, speed, quality and flags', async () => {
    const r = await runTripFinalizer({ schoolId, tripId });
    expect(r.finalized).toBe(true);
    const { rows } = await ownerQuery<{ summary: SummaryShape; distance_gps_km: number; finalized_at: string | null }>('select summary, distance_gps_km, finalized_at from trips where id = $1', [tripId]);
    const s = rows[0]!.summary;
    expect(rows[0]!.finalized_at).not.toBeNull();
    // -0.3 → 4.2 km northbound ≈ 4.5 km; the 9-km spike and the 400-m-accuracy fix are filtered.
    expect(rows[0]!.distance_gps_km).toBeGreaterThan(4.2);
    expect(rows[0]!.distance_gps_km).toBeLessThan(4.8);
    expect(s.points).toMatchObject({ outliers: 2 });
    expect(s.path.encoded).toEqual(expect.any(String));
    expect(s.path.pointCount).toBeLessThan(s.points.kept);
    expect(s.stops).toMatchObject({ planned: 4, visited: 4, missedStopIds: [] });
    const s1 = s.stops.dwell.find((d) => d.stopId === a.stops[0]!.id)!;
    expect(s1.dwellS).toBeGreaterThanOrEqual(60);
    expect(s.stops.dwell.find((d) => d.stopId === a.stops[3]!.id)!.source).toBe('finalizer');
    // The run starts 300 m before stop 1 (outside the planned path); everything else is on the route.
    expect(s.deviation.maxM).toBeGreaterThan(290);
    expect(s.deviation.maxM).toBeLessThan(310);
    expect(s.deviation.avgM).toBeLessThan(30);
    expect(s.deviation.longestRunOverThreshold).toBe(2);
    expect(s.speed).toMatchObject({ limitKmh: 40, overSpeedEvents: 1, maxKmh: 60 });
    expect(s.dataQuality).toMatchObject({ sufficient: true, reasons: [] });
    expect(s.flags).toEqual(['speeding']);
    const audit = await ownerQuery("select 1 from audit_logs where action = 'trip.finalize' and entity_id = $1", [tripId]);
    expect(audit.rowCount).toBe(1);
  });

  it('is idempotent and agrees with gpsDistanceKm and the trips module provider', async () => {
    const before = (await ownerQuery<{ distance_gps_km: number }>('select distance_gps_km from trips where id = $1', [tripId])).rows[0]!.distance_gps_km;
    await runTripFinalizer({ schoolId, tripId });
    const after = (await ownerQuery<{ distance_gps_km: number; n: number }>("select distance_gps_km, (select count(*)::int from trip_stop_events e where e.trip_id = t.id) as n from trips t where id = $1", [tripId])).rows[0]!;
    expect(after.distance_gps_km).toBe(before);
    expect(after.n).toBe(4);
    const km = await withSchoolSystem(schoolId, (tx) => gpsDistanceKm(tx, tripId));
    expect(km).toBe(before);
    const viaTrips = await withSchoolSystem(schoolId, async (tx) => {
      const trip = await tx.one<{ id: string; started_at: string; ended_at: string }>('select id, started_at, ended_at from trips where id = $1', [tripId]);
      return gpsDistance(tx, trip);
    });
    expect(viaTrips.km).toBe(before);
    expect(await liveStore.get(schoolId, tripId)).toBeNull(); // live state removed once finalized
  });

  it('cannot read another school’s trip (RLS): finalizer and distance see nothing', async () => {
    expect(await runTripFinalizer({ schoolId: String(b.school.id), tripId })).toMatchObject({ finalized: false, reason: 'NOT_FOUND' });
    expect(await withSchoolSystem(String(b.school.id), (tx) => gpsDistanceKm(tx, tripId))).toBe(0);
  });

  it('re-runs after late backfill reaches a finalized trip', async () => {
    const ended = Date.parse((await ownerQuery<{ ended_at: string }>('select ended_at from trips where id = $1', [tripId])).rows[0]!.ended_at);
    await ownerQuery('update trips set finalized_at = null where id = $1', [tripId]);
    const res = await postPoints(t.app, a, [{ t: new Date(ended - 5_000).toISOString(), lat: ORIGIN.lat + 4.25 * KM_LAT, lng: ORIGIN.lng, spd: 10, acc: 8 }]);
    expect(res.body.data).toMatchObject({ tripStatus: 'completed', accepted: 1 });
    await drainJobs();
    const row = (await ownerQuery<{ finalized_at: string | null }>('select finalized_at from trips where id = $1', [tripId])).rows[0]!;
    expect(row.finalized_at).not.toBeNull();
  });

  it('re-runs the odometer ↔ GPS comparison with the final distance (one alert per trip)', async () => {
    const mismatches = async () => (await alertsOf(schoolId)).filter((x) => x.alert_type === 'odometer_gps_mismatch');
    const gpsKm = (await ownerQuery<{ distance_gps_km: number }>('select distance_gps_km from trips where id = $1', [tripId])).rows[0]!.distance_gps_km;
    await ownerQuery('update trips set start_odometer = 1000, end_odometer = $2 where id = $1', [tripId, 1000 + Math.round(gpsKm)]);
    expect((await runTripFinalizer({ schoolId, tripId })).alerts).toEqual([]); // odometer ≈ GPS: no alert
    expect(await mismatches()).toHaveLength(0);
    await ownerQuery('update trips set end_odometer = 1020 where id = $1', [tripId]);
    const announced: string[] = [];
    const off = events.on('alert.raised', (x) => void announced.push(`${x.type}:${x.tripId}`));
    const r = await runTripFinalizer({ schoolId, tripId }).finally(off);
    expect(announced).toEqual([`odometer_gps_mismatch:${tripId}`]);
    expect(r.alerts).toHaveLength(1);
    const found = await mismatches();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ trip_id: tripId, dedupe_key: `odometer_gps_mismatch:${tripId}` });
    expect(found[0]!.details).toMatchObject({ odometerKm: 20, gpsKm: r.distanceGpsKm });
    expect((await runTripFinalizer({ schoolId, tripId })).alerts).toEqual([]);
    expect(await mismatches()).toHaveLength(1);
  });

  it('stores an unknown GPS distance (null) for a closed trip without usable points', async () => {
    const empty = await f.trip(schoolId, String(a.bus.id), {
      status: 'completed',
      route_id: a.route.id,
      started_at: new Date(Date.now() - 3_600_000).toISOString(),
      ended_at: new Date(Date.now() - 1_800_000).toISOString(),
    });
    const r = await runTripFinalizer({ schoolId, tripId: String(empty.id) });
    expect(r).toMatchObject({ finalized: true, distanceGpsKm: null, alerts: [] });
    const row = (await ownerQuery<{ distance_gps_km: number | null; summary: SummaryShape }>('select distance_gps_km, summary from trips where id = $1', [empty.id])).rows[0]!;
    expect(row.distance_gps_km).toBeNull();
    expect(row.summary.dataQuality).toMatchObject({ sufficient: false, reasons: ['TOO_FEW_POINTS'] });
  });
});

describe('partition maintenance and registry', () => {
  it('creates months ahead with RLS forced, drops expired months and moves DEFAULT rows into new months', async () => {
    const first = await partitionMaintenance();
    expect(first.retentionMonths).toBe(12);
    const months = (await ownerQuery<{ relname: string; forced: boolean }>(
      `select c.relname, c.relforcerowsecurity as forced from pg_inherits i join pg_class c on c.oid = i.inhrelid
        where i.inhparent = 'location_points'::regclass and c.relname <> 'location_points_default' order by c.relname`,
    )).rows;
    const now = new Date();
    const name = (offset: number) => {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
      return `location_points_${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    };
    expect(months.map((m) => m.relname)).toEqual(expect.arrayContaining([name(0), name(1), name(2)]));
    expect(months.every((m) => m.forced)).toBe(true);

    await withSystem((tx) => tx.query("select create_location_partitions('2020-01-01'::date, 1)"));
    await ownerQuery(`drop table ${name(2)}`);
    const futureAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 3)).toISOString();
    await ownerQuery('insert into location_points (school_id, trip_id, recorded_at, latitude, longitude) values ($1, $2, $3, 12.9, 77.6)', [b.school.id, b.trip.id, futureAt]);
    const second = await partitionMaintenance();
    expect(second.dropped).toContain('location_points_2020_01');
    expect(second.created).toContain(name(2));
    expect(second.defaultRows).toBe(0);
    const where = await ownerQuery<{ part: string }>('select tableoid::regclass::text as part from location_points where trip_id = $1 and recorded_at = $2', [b.trip.id, futureAt]);
    expect(where.rows[0]!.part).toBe(name(2));
  });

  it('registers points-persist, trip-finalizer and location-gap-detector next to partition-maintenance', () => {
    const names = JOB_DEFINITIONS.map((d) => `${d.name}:${d.kind}`);
    expect(names).toEqual(expect.arrayContaining(['points-persist:queue', 'trip-finalizer:queue', 'location-gap-detector:cron', 'partition-maintenance:cron']));
  });
});
