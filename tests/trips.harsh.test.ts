// Harsh driving (BP §9.6 "harsh events (when sensor data is sent)", §11.1 harsh_driving "Sensor-based (flag)"):
// the driver app reports harsh_braking / harsh_acceleration / harsh_cornering device events; they raise one open
// `harsh_driving` warning per trip only while the school's enableHarshDrivingAlert AND its effective harshDriving
// feature (platform features + plan modules) are on. The trip config tells the app whether to report them.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type TestApp } from './helpers/authApp.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { alertsOf, as, startScheduled, tripWorld } from './trips.fixtures.js';

let t: TestApp;
let platformFeatures: unknown;

const setPlatformHarsh = (on: boolean) =>
  ownerQuery(`update platform_settings set value = value || jsonb_build_object('harsh_driving', $1::boolean) where key = 'features'`, [on]);

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  platformFeatures = (await ownerQuery<{ value: unknown }>(`select value from platform_settings where key = 'features'`)).rows[0]?.value ?? null;
});
afterAll(async () => {
  if (platformFeatures !== null) await ownerQuery(`update platform_settings set value = $1::jsonb where key = 'features'`, [JSON.stringify(platformFeatures)]);
  await closeDb();
});

const harsh = (at: string) => ({
  events: [
    { type: 'harsh_braking', occurredAt: at, gForce: 0.62, speedKmh: 41, latitude: 12.93, longitude: 77.62 },
    { type: 'harsh_cornering', occurredAt: at, gForce: 0.5 },
  ],
});

describe('harsh driving device events', () => {
  it('are accepted but raise nothing while the platform default (harsh_driving off) or the school flag keeps them off', async () => {
    await setPlatformHarsh(false);
    const w = await tripWorld(t, { settings: { enable_harsh_driving_alert: true, features: JSON.stringify({ harsh_driving: true }) } });
    await startScheduled(w);
    const active = await as(t, w.driver).get('/driver/trips/active');
    expect(active.body.data.config.harshDrivingEnabled).toBe(false);
    const res = await as(t, w.driver).post(`/driver/trips/${w.trip.id}/events`, harsh(new Date().toISOString()));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ accepted: 2, alerts: [] });
    expect((await alertsOf(w.trip.id)).filter((a) => a.alert_type === 'harsh_driving')).toEqual([]);

    await setPlatformHarsh(true);
    await f.schoolSettings(w.sid, { enable_harsh_driving_alert: false });
    const off = await as(t, w.driver).post(`/driver/trips/${w.trip.id}/events`, harsh(new Date().toISOString()));
    expect(off.body.data.alerts).toEqual([]);
  });

  it('raise one harsh_driving warning per trip when the school and platform enable it; a plan without the module stops it', async () => {
    await setPlatformHarsh(true);
    const w = await tripWorld(t, { settings: { enable_harsh_driving_alert: true, features: JSON.stringify({ harsh_driving: true }) } });
    await startScheduled(w);
    expect((await as(t, w.driver).get('/driver/trips/active')).body.data.config.harshDrivingEnabled).toBe(true);
    const res = await as(t, w.driver).post(`/driver/trips/${w.trip.id}/events`, harsh(new Date().toISOString()));
    expect(res.status).toBe(200);
    expect(res.body.data.accepted).toBe(2);
    expect(res.body.data.alerts).toEqual([{ type: 'harsh_driving', severity: 'warning', title: 'Bus R1: harsh braking (0.62 g)' }]);
    const rows = (await alertsOf(w.trip.id)).filter((a) => a.alert_type === 'harsh_driving');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ severity: 'warning', dedupe_key: `harsh_driving:${w.trip.id}`, details: expect.objectContaining({ event: 'harsh_braking', gForce: 0.62, speedKmh: 41 }) });

    // Plan modules narrow the feature (contract §9): harsh_driving false in the active subscription → no alert.
    await ownerQuery(`update alerts set status = 'closed', closed_at = now() where school_id = $1 and alert_type = 'harsh_driving'`, [w.sid]);
    await ownerQuery(
      `insert into school_subscriptions (school_id, plan, status, modules, valid_from) values ($1, 'basic', 'active', '{"harsh_driving": false}'::jsonb, current_date)`,
      [w.sid],
    );
    expect((await as(t, w.driver).get('/driver/trips/active')).body.data.config.harshDrivingEnabled).toBe(false);
    const planned = await as(t, w.driver).post(`/driver/trips/${w.trip.id}/events`, harsh(new Date().toISOString()));
    expect(planned.body.data.alerts).toEqual([]);
  });

  it('rejects out-of-range sensor values', async () => {
    const w = await tripWorld(t);
    await startScheduled(w);
    const bad = await as(t, w.driver).post(`/driver/trips/${w.trip.id}/events`, { events: [{ type: 'harsh_braking', occurredAt: new Date().toISOString(), gForce: 40 }] });
    expect(bad.status).toBe(400);
  });
});
