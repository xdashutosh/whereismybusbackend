// POST /driver/trips/:id/end (BP §10.3): end ≥ start hard reject, live photo, GPS distance and the
// odometer ↔ GPS mismatch with its minimum-km guard, end below the last known reading, non-school info
// alert, last_known_odometer update, idempotent retry, device binding, events after commit, and the
// default SQL GPS distance (accuracy filter, jump filter, minimum points).
import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { withSchoolSystem } from '../src/db/tenant.js';
import { events, type AppEvents } from '../src/shared/events.js';
import { registerGpsDistanceProvider, sqlGpsDistance } from '../src/modules/trips/index.js';
import { buildApp, type TestApp } from './helpers/authApp.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { alertsOf, as, endBody, odometerPhoto, startBody, startScheduled, tripWorld, type TripWorld } from './trips.fixtures.js';

let t: TestApp;
let restoreGps: (() => void) | null = null;

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
});
afterEach(() => {
  restoreGps?.();
  restoreGps = null;
});
afterAll(closeDb);

const fakeGps = (km: number | null, points = 20) => {
  restoreGps = registerGpsDistanceProvider(async () => ({ km, points }));
};

async function started(settings?: f.Values, reading = 1000): Promise<TripWorld> {
  const w = await tripWorld(t, settings ? { settings } : {});
  const res = await startScheduled(w, reading);
  expect(res.status).toBe(201);
  return w;
}

async function end(w: TripWorld, reading: number, o: { photoBy?: string; entity?: 'bus' | 'trip' } = {}) {
  const photo = await odometerPhoto(w.sid, o.photoBy ?? w.driver.user.id, o.entity === 'bus' ? { type: 'bus', id: w.bus.id } : { type: 'trip', id: w.trip.id });
  return { res: await as(t, w.driver).post(`/driver/trips/${w.trip.id}/end`, endBody({ odometerReading: reading, odometerFileId: photo.id })), photo };
}

describe('end a trip', () => {
  it('completes it: distances, evidence, last known odometer, audit and status event', async () => {
    const w = await started();
    fakeGps(17.6);
    const seen: AppEvents['trip.status_changed'][] = [];
    const off = events.on('trip.status_changed', (p) => void seen.push(p));
    const { res, photo } = await end(w, 1018.04);
    off();
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ replayed: false, alerts: [], trip: { id: w.trip.id, status: 'completed', startOdometer: 1000, endOdometer: 1018, distanceOdometerKm: 18, distanceGpsKm: 17.6 } });
    expect(Date.parse(res.body.data.acceptPointsUntil) - Date.parse(res.body.data.trip.endedAt)).toBe(24 * 3600_000);
    const bus = await ownerQuery('select last_known_odometer, odometer_updated_at from buses where id = $1', [w.bus.id]);
    expect(bus.rows[0]).toMatchObject({ last_known_odometer: 1018 });
    expect(bus.rows[0]!.odometer_updated_at).not.toBeNull();
    const ev = await ownerQuery<{ kind: string; file_id: string }>('select kind, file_id from trip_odometer_evidence where trip_id = $1 order by kind desc', [w.trip.id]);
    expect(ev.rows.map((r) => r.kind)).toEqual(['start', 'end']);
    expect(ev.rows[1]!.file_id).toBe(photo.id);
    const trip = await ownerQuery('select ended_by, end_lat, end_device_time from trips where id = $1', [w.trip.id]);
    expect(trip.rows[0]).toMatchObject({ ended_by: w.driver.user.id, end_lat: 12.9716 });
    const audit = await ownerQuery("select count(*)::int as n from audit_logs where entity_id = $1 and action = 'trip.end'", [w.trip.id]);
    expect(audit.rows[0]!.n).toBe(1);
    await new Promise((r) => setTimeout(r, 5));
    expect(seen.find((p) => p.tripId === w.trip.id)).toMatchObject({ schoolId: w.sid, status: 'completed', previousStatus: 'in_progress', busId: w.bus.id });
  });

  it('hard-rejects an end reading below the start (422 ODOMETER_INVALID)', async () => {
    const w = await started(undefined, 1000);
    const { res } = await end(w, 999.9);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'ODOMETER_INVALID', details: { startOdometer: 1000, endOdometer: 999.9 } });
    const row = await ownerQuery('select status from trips where id = $1', [w.trip.id]);
    expect(row.rows[0]!.status).toBe('in_progress');
  });

  it('requires a live camera photo of the caller', async () => {
    const w = await started();
    const gallery = await odometerPhoto(w.sid, w.driver.user.id, { type: 'trip', id: w.trip.id }, { source: 'gallery' });
    const res = await as(t, w.driver).post(`/driver/trips/${w.trip.id}/end`, endBody({ odometerReading: 1010, odometerFileId: gallery.id }));
    expect(res.status).toBe(400);
    expect(res.body.error.details[0]).toMatchObject({ path: 'odometerFileId', message: expect.stringMatching(/live camera/) });
    const { res: other } = await end(w, 1010, { photoBy: w.conductor.user.id });
    expect(other.status).toBe(400);
  });

  it('is idempotent for the same reading and photo; other ends of a completed trip are refused', async () => {
    const w = await started();
    fakeGps(10);
    const photo = await odometerPhoto(w.sid, w.driver.user.id, { type: 'bus', id: w.bus.id });
    const body = endBody({ odometerReading: 1010, odometerFileId: photo.id });
    expect((await as(t, w.driver).post(`/driver/trips/${w.trip.id}/end`, body)).status).toBe(200);
    const again = await as(t, w.driver).post(`/driver/trips/${w.trip.id}/end`, body);
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ replayed: true, trip: { status: 'completed', endOdometer: 1010 } });
    const { res: different } = await end(w, 1011);
    expect(different.status).toBe(409);
    expect(different.body.error.code).toBe('INVALID_STATE');
  });

  it('only the starting device may end it; other staff get 404', async () => {
    const w = await started();
    const photo = await odometerPhoto(w.sid, w.driver.user.id, { type: 'trip', id: w.trip.id });
    await ownerQuery('update trips set device_id = (select id from devices where owner_id = $2 limit 1) where id = $1', [w.trip.id, w.conductor.user.id]);
    const res = await as(t, w.driver).post(`/driver/trips/${w.trip.id}/end`, endBody({ odometerReading: 1010, odometerFileId: photo.id }));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('DEVICE_NOT_BOUND');
    const stranger = await tripWorld(t);
    const foreign = await as(t, stranger.driver).post(`/driver/trips/${w.trip.id}/end`, endBody({ odometerReading: 1010, odometerFileId: photo.id }));
    expect(foreign.status).toBe(404);
    const unknown = await as(t, w.driver).post(`/driver/trips/${crypto.randomUUID()}/end`, endBody({ odometerReading: 1010, odometerFileId: photo.id }));
    expect(unknown.status).toBe(404);
  });
});

describe('odometer ↔ GPS comparison (BP §10.3 rule 3)', () => {
  it('raises odometer_gps_mismatch beyond the variance and the minimum km', async () => {
    const w = await started();
    fakeGps(12);
    const { res } = await end(w, 1020);
    expect(res.body.data.alerts).toEqual([{ type: 'odometer_gps_mismatch', severity: 'warning', title: expect.stringContaining('odometer 20 km vs GPS 12 km') }]);
    expect(await alertsOf(w.trip.id)).toEqual([
      expect.objectContaining({ alert_type: 'odometer_gps_mismatch', dedupe_key: `odometer_gps_mismatch:${w.trip.id}`, details: expect.objectContaining({ odometerKm: 20, gpsKm: 12, diffKm: 8, diffPct: 40, variancePct: 15, minKm: 2 }) }),
    ]);
  });

  it('min-km guard: a large relative difference on a short trip is not flagged', async () => {
    const w = await started();
    fakeGps(0.5);
    const { res } = await end(w, 1001.5);
    expect(res.status).toBe(200);
    expect(res.body.data.alerts).toEqual([]);
    expect(await alertsOf(w.trip.id)).toEqual([]);
  });

  it('within the variance nothing is flagged; without usable GPS data a trip of at least the minimum km is flagged no_gps_data', async () => {
    const w = await started();
    fakeGps(18.5);
    expect((await end(w, 1020)).res.body.data.alerts).toEqual([]);
    const w2 = await started();
    fakeGps(null, 1);
    const { res } = await end(w2, 1040);
    expect(res.body.data.trip.distanceGpsKm).toBeNull();
    expect(res.body.data.alerts).toEqual([{ type: 'odometer_gps_mismatch', severity: 'warning', title: expect.stringContaining('odometer 40 km but no GPS data') }]);
    expect(await alertsOf(w2.trip.id)).toEqual([
      expect.objectContaining({ dedupe_key: `odometer_gps_mismatch:${w2.trip.id}:no_gps`, details: expect.objectContaining({ reason: 'no_gps_data', odometerKm: 40, gpsKm: null, gpsPoints: 1 }) }),
    ]);
    // Below the minimum km (default 2 km) a GPS-less trip is not flagged.
    const w3 = await started();
    fakeGps(null, 0);
    expect((await end(w3, 1001.5)).res.body.data.alerts).toEqual([]);
  });

  it('honours the school variance and minimum settings', async () => {
    const w = await started({ odometer_gps_variance_pct: 50, odometer_gps_min_km: 0 });
    fakeGps(12);
    expect((await end(w, 1020)).res.body.data.alerts).toEqual([]);
    const w2 = await started({ odometer_gps_variance_pct: 5, odometer_gps_min_km: 0.5 });
    fakeGps(1);
    expect((await end(w2, 1002)).res.body.data.alerts.map((a: { type: string }) => a.type)).toEqual(['odometer_gps_mismatch']);
  });
});

describe('other end-time alerts', () => {
  it('raises odometer_decrease when the end is below the last known reading', async () => {
    const w = await started(undefined, 1000);
    fakeGps(5);
    await ownerQuery('update buses set last_known_odometer = 2000 where id = $1', [w.bus.id]);
    const { res } = await end(w, 1005);
    expect(res.body.data.alerts.map((a: { type: string }) => a.type)).toContain('odometer_decrease');
    const decrease = (await alertsOf(w.trip.id)).filter((a) => a.alert_type === 'odometer_decrease');
    expect(decrease.map((a) => a.details.phase)).toEqual(['end']);
    const bus = await ownerQuery('select last_known_odometer from buses where id = $1', [w.bus.id]);
    expect(bus.rows[0]!.last_known_odometer).toBe(1005);
  });

  it('logs a non-school trip in the info feed at the end', async () => {
    const w = await tripWorld(t, { settings: { allow_non_school_trips: true } });
    const photo = await odometerPhoto(w.sid, w.driver.user.id, { type: 'bus', id: w.bus.id });
    const startRes = await as(t, w.driver).post('/driver/trips/start', startBody({ busId: w.bus.id, purpose: 'Annual service at the depot', odometerReading: 1000, odometerFileId: photo.id }));
    expect(startRes.status).toBe(201);
    const id = startRes.body.data.trip.id as string;
    fakeGps(7.8);
    const endPhoto = await odometerPhoto(w.sid, w.driver.user.id, { type: 'trip', id });
    const res = await as(t, w.driver).post(`/driver/trips/${id}/end`, endBody({ odometerReading: 1008, odometerFileId: endPhoto.id }));
    expect(res.status).toBe(200);
    expect(res.body.data.alerts).toEqual([{ type: 'non_school_trip', severity: 'info', title: expect.stringContaining('Annual service at the depot') }]);
  });
});

describe('default GPS distance (SQL provider)', () => {
  it('sums segment lengths, ignoring inaccurate points and GPS jumps; null below two points', async () => {
    const w = await tripWorld(t);
    const trip = await f.activeTrip(w.sid, w.bus.id, { started_at: new Date(Date.now() - 3600_000).toISOString() });
    const base = Date.now() - 30 * 60_000;
    const pts: [number, number, number, number][] = [
      // [minute, lat, lng, accuracy]
      [0, 12.9, 77.6, 5],
      [1, 12.909, 77.6, 5], // ~1.0 km north
      [2, 13.5, 77.6, 5], // jump (~65 km in a minute) → both segments dropped
      [3, 12.918, 77.6, 5], // ~1.0 km from the point before the jump? (segment from the jump is dropped)
      [4, 12.927, 77.6, 500], // inaccurate → ignored
    ];
    for (const [m, lat, lng, acc] of pts) {
      await ownerQuery('insert into location_points (school_id, trip_id, recorded_at, latitude, longitude, accuracy_m) values ($1, $2, $3, $4, $5, $6)', [
        w.sid, trip.id, new Date(base + m * 60_000).toISOString(), lat, lng, acc,
      ]);
    }
    const res = await withSchoolSystem(w.sid, (tx) => sqlGpsDistance(tx, { id: trip.id, started_at: null, ended_at: null }));
    expect(res.points).toBe(4);
    expect(res.km).toBe(1);
    const lone = await f.activeTrip(w.sid, (await f.bus(w.sid)).id);
    await ownerQuery('insert into location_points (school_id, trip_id, recorded_at, latitude, longitude) values ($1, $2, now(), 12.9, 77.6)', [w.sid, lone.id]);
    expect(await withSchoolSystem(w.sid, (tx) => sqlGpsDistance(tx, { id: lone.id, started_at: null, ended_at: null }))).toEqual({ km: null, points: 1 });
  });
});
