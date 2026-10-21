// Per-school location-history retention (BP §12; migration 800): school_settings
// location_retention_months via PUT /school/settings, bounded by the platform maximum
// location.retention_months (public so school admins can read it), effective = min(override,
// platform), and the partition-maintenance job deleting only that school's older points.
import type { SchoolSettingsDto } from '@wimb/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/tenant.js';
import { partitionMaintenance } from '../src/jobs/index.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { buildApp, loginSchoolAdmin, passwordHash, type TestApp } from './helpers/authApp.js';

let t: TestApp;
let fx: f.TwoSchoolFixture;
let adminA: string;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const put = (body: unknown) => request(t.app).put('/api/v1/school/settings').set(auth(adminA)).send(body as object);
const get = async (): Promise<SchoolSettingsDto> => (await request(t.app).get('/api/v1/school/settings').set(auth(adminA))).body.data as SchoolSettingsDto;
const setPlatformRetention = (months: number) =>
  ownerQuery("update platform_settings set value = $1::jsonb where key = 'location.retention_months'", [JSON.stringify(months)]);

/** First day of the UTC month `offset` months from now, plus `days` days. */
function monthDay(offset: number, days = 0): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1 + days, 6));
}

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  await setPlatformRetention(12);
  t = buildApp();
  fx = await f.twoSchoolFixture();
  await ownerQuery('update users set password_hash = $1 where id = any ($2)', [await passwordHash(), [fx.a.admin.id]]);
  adminA = (await loginSchoolAdmin(t.app, String(fx.a.admin.email))).accessToken;
});
afterAll(async () => {
  await setPlatformRetention(12);
  await closeDb();
});

describe('location retention setting', () => {
  it('defaults to the platform value, which is a public setting', async () => {
    const isPublic = await ownerQuery<{ is_public: boolean }>("select is_public from platform_settings where key = 'location.retention_months'");
    expect(isPublic.rows[0]!.is_public).toBe(true);
    const d = await get();
    expect(d.locationRetentionMonths).toBeNull();
    expect(d.platformDefaults.locationRetentionMonths).toBe(12);
    expect(d.effective.locationRetentionMonths).toBe(12);
  });

  it('accepts a shorter override, refuses one above the platform maximum, and null resets it', async () => {
    const ok = await put({ locationRetentionMonths: 6 });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ locationRetentionMonths: 6, effective: { locationRetentionMonths: 6 } });
    const audit = await ownerQuery<{ new_values: Record<string, unknown> }>(
      "select new_values from audit_logs where action = 'school_settings.update' and school_id = $1 order by created_at desc limit 1",
      [fx.a.school.id],
    );
    expect(audit.rows[0]!.new_values).toMatchObject({ locationRetentionMonths: 6 });

    const tooLong = await put({ locationRetentionMonths: 13 });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.details).toEqual([expect.objectContaining({ path: 'locationRetentionMonths', message: expect.stringContaining('12 months') })]);
    expect((await put({ locationRetentionMonths: 0 })).status).toBe(400);
    expect((await put({ locationRetentionMonths: 61 })).status).toBe(400);

    const reset = await put({ locationRetentionMonths: null });
    expect(reset.body.data).toMatchObject({ locationRetentionMonths: null, effective: { locationRetentionMonths: 12 } });
  });

  it('caps the effective value when the platform maximum is later lowered; unrelated updates still work', async () => {
    expect((await put({ locationRetentionMonths: 10 })).status).toBe(200);
    await setPlatformRetention(4);
    const d = await get();
    expect(d).toMatchObject({ locationRetentionMonths: 10, platformDefaults: { locationRetentionMonths: 4 }, effective: { locationRetentionMonths: 4 } });
    expect((await put({ tripDelayThresholdMin: 12 })).status).toBe(200);
    expect((await put({ locationRetentionMonths: 5 })).status).toBe(400);
    await setPlatformRetention(12);
    expect((await put({ locationRetentionMonths: null })).status).toBe(200);
  });
});

describe('partition-maintenance purge', () => {
  it("deletes only the overriding school's points older than its retention, keeping newer ones and other schools'", async () => {
    // Month partitions 4 months back (inside the 12-month platform window).
    await withTenant({ schoolId: null, actorId: null, role: 'system' }, (tx) => tx.query('select create_location_partitions($1::date, 4)', [monthDay(-4).toISOString().slice(0, 10)]));
    const old = monthDay(-4, 5); // older than a 2-month school retention
    const recent = monthDay(-1, 9); // within it
    const point = (schoolId: string, tripId: string, at: Date) =>
      ownerQuery('insert into location_points (school_id, trip_id, recorded_at, latitude, longitude) values ($1, $2, $3, 12.97, 77.59)', [schoolId, tripId, at.toISOString()]);
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const tripAOld = await f.trip(fx.a.school.id, fx.a.bus.id, { trip_date: day(old), direction: 'afternoon' });
    const tripARecent = await f.trip(fx.a.school.id, fx.a.bus.id, { trip_date: day(recent), direction: 'afternoon' });
    const tripBOld = await f.trip(fx.b.school.id, fx.b.bus.id, { trip_date: day(old), direction: 'afternoon' });
    await point(fx.a.school.id, tripAOld.id, old);
    await point(fx.a.school.id, tripAOld.id, new Date(old.getTime() + 60_000));
    await point(fx.a.school.id, tripARecent.id, recent);
    await point(fx.b.school.id, tripBOld.id, old);

    // No override → nothing purged.
    expect((await partitionMaintenance()).schoolRowsPurged).toBe(0);

    await f.schoolSettings(fx.a.school.id, { location_retention_months: 2 });
    const result = await partitionMaintenance();
    expect(result.schoolRowsPurged).toBe(2);
    const left = await ownerQuery<{ trip_id: string }>('select trip_id from location_points where trip_id = any ($1) order by recorded_at', [[tripAOld.id, tripARecent.id, tripBOld.id]]);
    expect(left.rows.map((r) => r.trip_id).sort()).toEqual([tripARecent.id, tripBOld.id].sort());

    // Idempotent; an override equal to or above the platform value purges nothing extra.
    expect((await partitionMaintenance()).schoolRowsPurged).toBe(0);
    await f.schoolSettings(fx.a.school.id, { location_retention_months: 12 });
    expect((await partitionMaintenance()).schoolRowsPurged).toBe(0);
    await f.schoolSettings(fx.a.school.id, { location_retention_months: null });
  });
});

describe('retention end to end (migration 926, tracking/retention.ts)', () => {
  it('location_retention_cutoffs(): the platform value is the maximum, a shorter school override wins', async () => {
    await f.schoolSettings(fx.a.school.id, { location_retention_months: 2 });
    await f.schoolSettings(fx.b.school.id, { location_retention_months: 20 }); // stale override above the platform's 12
    const rows = await withTenant({ schoolId: null, actorId: null, role: 'system' }, (tx) =>
      tx.many<{ school_id: string; retention_months: number; cutoff: string }>('select school_id, retention_months, cutoff from location_retention_cutoffs()'),
    );
    const by = new Map(rows.map((r) => [r.school_id, r]));
    expect(by.get(fx.a.school.id)!.retention_months).toBe(2);
    expect(by.get(fx.b.school.id)!.retention_months).toBe(12);
    expect(new Date(by.get(fx.a.school.id)!.cutoff).toISOString()).toBe(new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 2, 1)).toISOString());
    await f.schoolSettings(fx.b.school.id, { location_retention_months: null });
  });

  it("keeps the simplified path of a trip about to lose its points and clears old device-event coordinates at each school's cutoff", async () => {
    await withTenant({ schoolId: null, actorId: null, role: 'system' }, (tx) => tx.query('select create_location_partitions($1::date, 4)', [monthDay(-4).toISOString().slice(0, 10)]));
    await f.schoolSettings(fx.a.school.id, { location_retention_months: 2 });
    const old = monthDay(-4, 6);
    const day = (d: Date) => d.toISOString().slice(0, 10);
    // A trip cancelled while running: the finalizer never stored its path.
    const cancelled = await f.trip(fx.a.school.id, fx.a.bus.id, {
      trip_date: day(old), direction: 'afternoon', status: 'cancelled', started_at: old.toISOString(), ended_at: new Date(old.getTime() + 20 * 60_000).toISOString(),
      closed_at: new Date(old.getTime() + 20 * 60_000).toISOString(), points_count: 5,
    });
    for (let i = 0; i < 5; i += 1) {
      await ownerQuery('insert into location_points (school_id, trip_id, recorded_at, latitude, longitude, accuracy_m) values ($1, $2, $3, $4, 77.59, 8)', [
        fx.a.school.id, cancelled.id, new Date(old.getTime() + i * 60_000).toISOString(), 12.97 + i * 0.002,
      ]);
    }
    const event = (schoolId: string, tripId: string, at: Date) =>
      ownerQuery(
        `insert into trip_device_events (school_id, trip_id, event_type, occurred_at, device_occurred_at, latitude, longitude)
         values ($1, $2, 'gps_disabled', $3, $3, 12.97, 77.59) returning id`,
        [schoolId, tripId, at.toISOString()],
      );
    const tripB = await f.trip(fx.b.school.id, fx.b.bus.id, { trip_date: day(old), direction: 'afternoon' });
    const recentA = await f.trip(fx.a.school.id, fx.a.bus.id, { trip_date: day(monthDay(-1, 3)), direction: 'afternoon' });
    const oldEventA = (await event(fx.a.school.id, cancelled.id, old)).rows[0]!.id as string;
    const recentEventA = (await event(fx.a.school.id, recentA.id, monthDay(-1, 3))).rows[0]!.id as string;
    const oldEventB = (await event(fx.b.school.id, tripB.id, old)).rows[0]!.id as string;

    const result = await partitionMaintenance();
    expect(result.pathsRetained).toBeGreaterThanOrEqual(1);
    expect(result.deviceEventCoordsPurged).toBe(1);
    expect(result.schoolRowsPurged).toBeGreaterThanOrEqual(5);

    const trip = await ownerQuery<{ summary: { path: { encoded: string | null; pointCount: number; retainedAt: string }; points: { total: number } } }>('select summary from trips where id = $1', [cancelled.id]);
    expect(trip.rows[0]!.summary.path).toMatchObject({ encoded: expect.any(String), retainedAt: expect.any(String) });
    expect(trip.rows[0]!.summary.points.total).toBe(5);
    expect((await ownerQuery('select count(*)::int as n from location_points where trip_id = $1', [cancelled.id])).rows[0]!.n).toBe(0);

    // The trip page still draws the driven path after the purge.
    const path = await request(t.app).get(`/api/v1/school/trips/${cancelled.id}/path`).set(auth(adminA));
    expect(path.status).toBe(200);
    expect(path.body.data.actual).toMatchObject({ polyline: trip.rows[0]!.summary.path.encoded, pointCount: 5 });

    const coords = await ownerQuery<{ id: string; latitude: string | null }>('select id, latitude from trip_device_events where id = any ($1)', [[oldEventA, recentEventA, oldEventB]]);
    const lat = new Map(coords.rows.map((r) => [r.id, r.latitude]));
    expect(lat.get(oldEventA)).toBeNull(); // event kept (timeline), coordinates gone
    expect(lat.get(recentEventA)).not.toBeNull();
    expect(lat.get(oldEventB)).not.toBeNull(); // school B keeps 12 months

    // Idempotent: nothing more to keep or clear.
    const again = await partitionMaintenance();
    expect(again).toMatchObject({ pathsRetained: 0, deviceEventCoordsPurged: 0, schoolRowsPurged: 0 });
    await f.schoolSettings(fx.a.school.id, { location_retention_months: null });
  });
});
