// BP §11.2 / §13.3 (coverage finding): "Bus left school" and the long-stop exclusion use the school
// geofence the admin sets in Settings → Profile (schools.geofence_radius_m), not a fixed 200 m. The
// radius travels with the cached trip geometry, and a profile change (school admin or super admin)
// drops the cached geometry of the school's open trips so the new geofence applies at once.
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSchoolSystem } from '../../src/db/tenant.js';
import { analyzePoints } from '../../src/modules/tracking/analytics.js';
import type { TrackingConfig } from '../../src/modules/tracking/config.js';
import { buildGeometry, DEFAULT_SCHOOL_RADIUS_M, geometryKey, loadGeometry, schoolRadiusM, type TripGeometry } from '../../src/modules/tracking/geometry.js';
import { newLiveState } from '../../src/modules/tracking/liveState.js';
import { kv } from '../../src/shared/kv.js';
import { closeDb, ownerQuery, truncateAll } from '../helpers/db.js';
import * as f from '../helpers/factories.js';
import { buildApp, loginSchoolAdmin, passwordHash, type TestApp } from '../helpers/authApp.js';

const KM = 1 / 111.195;
const LAT0 = 12.9;
const at = (m: number) => ({ lat: LAT0 + (m / 1000) * KM, lng: 77.6 });
const T0 = Date.parse('2026-10-19T08:30:00.000Z');
const cfg: TrackingConfig = {
  movingIntervalS: 10, stoppedIntervalS: 90, movingSpeedKmh: 4, stoppedAfterS: 60, speedLimitKmh: null, speedingEnabled: false,
  routeDeviationEnabled: false, routeDeviationM: 300, stopDurationAlertMin: 10, tripDelayThresholdMin: 10, tripNotStartedGraceMin: 10,
  approachingStopMinutes: 5, etaV2Enabled: false,
};
const pt = (m: number, ms: number, spd = 25) => ({ ms, t: new Date(ms).toISOString(), ...at(m), spd, hdg: 0, acc: 8, bat: 80, net: '4g', mv: spd > 0, backfilled: false });
const geometryWith = (school: TripGeometry['school']): TripGeometry => ({
  tripId: 'trip-1', routeId: 'route-1', direction: 'afternoon', tripDate: '2026-10-19', timezone: 'Asia/Kolkata',
  polyline: [at(0), at(5000)], encoded: null, source: 'straight', totalM: 5000, school, stops: [],
});
const state = () => newLiveState({ schoolId: 'school-A', tripId: 'trip-1', busId: 'bus-1', routeId: 'route-1', direction: 'afternoon', tripStatus: 'in_progress', lastPointAt: null });
const leftSchool = (g: TripGeometry, metres: number[]) =>
  analyzePoints(state(), metres.map((m, i) => pt(m, T0 + i * 10_000)), g, cfg, T0 + metres.length * 10_000).events.filter((e) => e.kind === 'left_school');

describe('analytics uses the configured school geofence', () => {
  it('reports no "left school" while the bus is still inside a 500 m campus geofence', () => {
    expect(leftSchool(geometryWith({ ...at(0), radiusM: 500 }), [50, 150, 300])).toEqual([]);
  });

  it('reports "left school" once past the configured radius × exit hysteresis', () => {
    expect(leftSchool(geometryWith({ ...at(0), radiusM: 500 }), [50, 300, 700])).toHaveLength(1);
    // A small 50 m geofence: 100 m out is already outside (the old fixed 200 m would wait).
    expect(leftSchool(geometryWith({ ...at(0), radiusM: 50 }), [10, 100])).toHaveLength(1);
  });

  it('treats a long stop inside a large campus geofence as no unscheduled stop', () => {
    const s = state();
    s.motion = 'stopped';
    s.stoppedSinceMs = T0;
    const g = geometryWith({ ...at(0), radiusM: 500 });
    const out = analyzePoints(s, [pt(400, T0 + 11 * 60_000, 0)], g, { ...cfg, stopDurationAlertMin: 10 }, T0 + 11 * 60_000);
    expect(out.alerts.filter((a) => a.type === 'long_stop')).toEqual([]);
  });

  it('falls back to the default radius for a cached geometry without one', () => {
    expect(schoolRadiusM({ lat: 1, lng: 1 })).toBe(DEFAULT_SCHOOL_RADIUS_M);
    expect(schoolRadiusM({ lat: 1, lng: 1, radiusM: 750 })).toBe(750);
    const legacy = geometryWith({ ...at(0) } as TripGeometry['school']);
    expect(leftSchool(legacy, [50, 150])).toEqual([]);
    expect(leftSchool(legacy, [50, 300])).toHaveLength(1);
  });

  it('builds the geometry with schools.geofence_radius_m', () => {
    const g = buildGeometry({
      trip_id: 't', route_id: null, direction: 'morning', trip_date: '2026-10-19', polyline_encoded: null, polyline_source: null,
      school_lat: 12.9, school_lng: 77.6, school_radius_m: 420, timezone: 'Asia/Kolkata', stops: [],
    });
    expect(g.school).toEqual({ lat: 12.9, lng: 77.6, radiusM: 420 });
  });
});

describe('cached trip geometry follows profile changes', () => {
  let t: TestApp;
  let fx: f.TwoSchoolFixture;
  let admin: string;
  const load = () => withSchoolSystem(fx.a.school.id, (tx) => loadGeometry(tx, fx.a.trip.id));
  const waitGone = async (key: string) => {
    for (let i = 0; i < 50 && (await kv.get(key)) !== null; i++) await new Promise((r) => setTimeout(r, 20));
    return kv.get(key);
  };

  beforeAll(async () => {
    await truncateAll({ keep: ['platform_settings'] });
    t = buildApp();
    fx = await f.twoSchoolFixture();
    await ownerQuery('update users set password_hash = $1 where id = $2', [await passwordHash(), fx.a.admin.id]);
    admin = (await loginSchoolAdmin(t.app, String(fx.a.admin.email))).accessToken;
  });
  afterAll(closeDb);

  it('loads the school radius and drops the cache when the admin changes the geofence', async () => {
    await ownerQuery('update schools set geofence_radius_m = 300 where id = $1', [fx.a.school.id]);
    expect((await load())!.school).toMatchObject({ radiusM: 300 });
    const key = geometryKey(fx.a.school.id, fx.a.trip.id);
    expect(await kv.get(key)).not.toBeNull();

    const res = await request(t.app).patch('/api/v1/school/profile').set({ Authorization: `Bearer ${admin}` }).send({ geofenceRadiusM: 600 });
    expect(res.status).toBe(200);
    expect(await waitGone(key)).toBeNull();
    expect((await load())!.school).toMatchObject({ radiusM: 600 });
  });
});
