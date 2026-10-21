// School settings and parent visibility (BP §8.3 GET/PUT /school/settings, /settings/parent-visibility,
// §13.3): defaults + platform fallbacks, partial updates, cross-field validation on effective values,
// alert recipients limited to this school's admins, platform-narrowed features, audit, events,
// cross-school isolation and the helpers other modules use (parent context included).
import { DEFAULT_PARENT_VISIBILITY } from '@wimb/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/tenant.js';
import { isFeatureEnabled, loadParentVisibility, loadSchoolSettings } from '../src/modules/school/index.js';
import { events } from '../src/shared/events.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { buildApp, loginSchoolAdmin, loginStaff, passwordHash, type TestApp } from './helpers/authApp.js';

let t: TestApp;
let fx: f.TwoSchoolFixture;
let adminA: string;
let adminB: string;
let driverA: string;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const put = (token: string, body: unknown) => request(t.app).put('/api/v1/school/settings').set(auth(token)).send(body as object);
const paths = (res: request.Response) => (res.body.error.details as { path: string }[]).map((d) => d.path);

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  fx = await f.twoSchoolFixture();
  await ownerQuery('update users set password_hash = $1 where id = any ($2)', [await passwordHash(), [fx.a.admin.id, fx.b.admin.id, fx.a.driverUser.id]]);
  adminA = (await loginSchoolAdmin(t.app, String(fx.a.admin.email))).accessToken;
  adminB = (await loginSchoolAdmin(t.app, String(fx.b.admin.email))).accessToken;
  driverA = (await loginStaff(t.app, String(fx.a.school.code), String(fx.a.driverUser.phone))).accessToken;
});
afterAll(closeDb);

describe('GET /school/settings', () => {
  it('returns stored values, platform defaults and effective values', async () => {
    const res = await request(t.app).get('/api/v1/school/settings').set(auth(adminA));
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d).toMatchObject({
      allowNonSchoolTrips: false,
      odometerGalleryAllowed: false,
      odometerMismatchThresholdKm: 5,
      odometerGpsVariancePct: 15,
      tripNotStartedGraceMin: 10,
      stopDurationAlertMin: 10,
      routeDeviationM: 300,
      approachingStopMinutes: 5,
      speedLimitKmh: null,
      locationMovingIntervalS: null,
      alertRecipients: [],
      features: { sms: false, announcements: true, routeDeviation: true },
    });
    expect(d.platformDefaults).toMatchObject({ movingIntervalS: 10, stoppedIntervalS: 90, movingSpeedKmh: 4, stoppedAfterS: 60, documentReminderDays: [60, 30, 15, 7, 1], staleTripCloseHours: 3 });
    expect(d.effective).toMatchObject({ movingIntervalS: 10, stoppedIntervalS: 90, features: { announcements: true, sms: false } });
  });

  it('is refused to drivers', async () => {
    expect((await request(t.app).get('/api/v1/school/settings').set(auth(driverA))).status).toBe(403);
    expect((await put(driverA, { speedLimitKmh: 60 })).status).toBe(403);
  });
});

describe('PUT /school/settings', () => {
  it('updates only the given fields, audits the diff, emits an event and leaves school B alone', async () => {
    const seen: unknown[] = [];
    const off = events.on('school.settings_changed', (p) => void seen.push(p));
    const res = await put(adminA, {
      speedLimitKmh: 50,
      enableSpeedingAlert: true,
      allowNonSchoolTrips: true,
      odometerMismatchThresholdKm: 3.5,
      locationMovingIntervalS: 15,
      documentReminderDays: [7, 30, 15],
      school_id: fx.b.school.id,
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      speedLimitKmh: 50,
      enableSpeedingAlert: true,
      allowNonSchoolTrips: true,
      odometerMismatchThresholdKm: 3.5,
      locationMovingIntervalS: 15,
      documentReminderDays: [30, 15, 7],
      tripNotStartedGraceMin: 10,
      updatedBy: fx.a.admin.id,
    });
    expect(res.body.data.effective).toMatchObject({ movingIntervalS: 15, documentReminderDays: [30, 15, 7] });
    const b = await ownerQuery<{ speed_limit_kmh: number | null }>('select speed_limit_kmh from school_settings where school_id = $1', [fx.b.school.id]);
    expect(b.rows[0]!.speed_limit_kmh).toBeNull();
    const log = await ownerQuery<{ old_values: Record<string, unknown>; new_values: Record<string, unknown> }>(
      "select old_values, new_values from audit_logs where school_id = $1 and action = 'school_settings.update' order by id desc limit 1",
      [fx.a.school.id],
    );
    expect(log.rows[0]).toEqual({
      old_values: { speedLimitKmh: null, enableSpeedingAlert: false, allowNonSchoolTrips: false, odometerMismatchThresholdKm: 5, locationMovingIntervalS: null, documentReminderDays: null },
      new_values: { speedLimitKmh: 50, enableSpeedingAlert: true, allowNonSchoolTrips: true, odometerMismatchThresholdKm: 3.5, locationMovingIntervalS: 15, documentReminderDays: [30, 15, 7] },
    });
    await new Promise((r) => setTimeout(r, 5));
    off();
    expect(seen).toEqual([{ schoolId: fx.a.school.id, changedFields: expect.arrayContaining(['speedLimitKmh', 'locationMovingIntervalS']) }]);
  });

  it('null resets an override to the platform default', async () => {
    const res = await put(adminA, { locationMovingIntervalS: null });
    expect(res.status).toBe(200);
    expect(res.body.data.locationMovingIntervalS).toBeNull();
    expect(res.body.data.effective.movingIntervalS).toBe(10);
  });

  it('validates ranges and cross-field rules against the effective values', async () => {
    const ranges = await put(adminA, { locationMovingIntervalS: 5, odometerGpsVariancePct: 120, routeDeviationM: 10, documentReminderDays: [7, 7], tripNotStartedGraceMin: 1.5 });
    expect(ranges.status).toBe(400);
    expect(paths(ranges)).toEqual(expect.arrayContaining(['locationMovingIntervalS', 'odometerGpsVariancePct', 'routeDeviationM', 'documentReminderDays', 'tripNotStartedGraceMin']));
    const speeding = await put(adminA, { speedLimitKmh: null });
    expect(speeding.status).toBe(400);
    expect(paths(speeding)).toEqual(['speedLimitKmh']);
    // stopped interval (60) shorter than the moving interval (120)
    const intervals = await put(adminA, { locationMovingIntervalS: 120, locationStoppedIntervalS: 60 });
    expect(intervals.status).toBe(400);
    expect(paths(intervals)).toEqual(['locationStoppedIntervalS']);
    // moving override above the platform stopped default (90) without a stopped override
    expect(paths(await put(adminA, { locationMovingIntervalS: 100 }))).toEqual(['locationStoppedIntervalS']);
    const unchanged = await request(t.app).get('/api/v1/school/settings').set(auth(adminA));
    expect(unchanged.body.data).toMatchObject({ speedLimitKmh: 50, locationMovingIntervalS: null, locationStoppedIntervalS: null });
  });

  it("accepts this school's admins and external contacts as alert recipients, never another school's admin", async () => {
    const ok = await put(adminA, {
      alertRecipients: [
        { userId: fx.a.admin.id, minSeverity: 'critical' },
        { name: 'Transport manager', phone: '+919845000999', alertTypes: ['speeding', 'route_deviation', 'speeding'] },
        { email: 'Transport@School.TEST' },
      ],
    });
    expect(ok.status).toBe(200);
    expect(ok.body.data.alertRecipients).toEqual([
      { userId: fx.a.admin.id, name: null, email: null, phone: null, minSeverity: 'critical', alertTypes: null },
      { userId: null, name: 'Transport manager', email: null, phone: '+919845000999', minSeverity: 'warning', alertTypes: ['speeding', 'route_deviation'] },
      { userId: null, name: null, email: 'transport@school.test', phone: null, minSeverity: 'warning', alertTypes: null },
    ]);
    const stored = await ownerQuery<{ r: unknown[] }>('select alert_recipients as r from school_settings where school_id = $1', [fx.a.school.id]);
    expect(stored.rows[0]!.r[0]).toMatchObject({ user_id: fx.a.admin.id, min_severity: 'critical' });

    const cross = await put(adminA, { alertRecipients: [{ userId: fx.b.admin.id }] });
    expect(cross.status).toBe(400);
    expect(paths(cross)).toEqual(['alertRecipients[0].userId']);
    const driver = await put(adminA, { alertRecipients: [{ userId: fx.a.driverUser.id }] });
    expect(paths(driver)).toEqual(['alertRecipients[0].userId']);
    const empty = await put(adminA, { alertRecipients: [{ name: 'Nobody' }] });
    expect(empty.status).toBe(400);
    const dup = await put(adminA, { alertRecipients: [{ email: 'a@b.test' }, { email: 'A@B.test' }] });
    expect(paths(dup)).toEqual(['alertRecipients[1]']);
  });

  it('merges feature flags and narrows them by the platform flags', async () => {
    const res = await put(adminA, { features: { sms: true, harshDriving: true } });
    expect(res.status).toBe(200);
    expect(res.body.data.features).toMatchObject({ sms: true, harshDriving: true, announcements: true, routeDeviation: true });
    // platform modules.sms = false (default) → SMS not in force; platform harsh_driving = false (default)
    expect(res.body.data.effective.features).toMatchObject({ sms: false, harshDriving: false, routeDeviation: true });
    const stored = await ownerQuery<{ features: Record<string, boolean> }>('select features from school_settings where school_id = $1', [fx.a.school.id]);
    expect(stored.rows[0]!.features).toMatchObject({ sms: true, harsh_driving: true, email_digest: false });

    await ownerQuery(`update platform_settings set value = jsonb_set(value, '{harsh_driving}', 'true') where key = 'features'`);
    try {
      const after = await request(t.app).get('/api/v1/school/settings').set(auth(adminA));
      expect(after.body.data.effective.features.harshDriving).toBe(true);
      expect(await withTenant(f.contexts.schoolAdmin(fx.a.school.id, fx.a.admin.id), (tx) => isFeatureEnabled(tx, 'harshDriving'))).toBe(true);
    } finally {
      await ownerQuery(`update platform_settings set value = jsonb_set(value, '{harsh_driving}', 'false') where key = 'features'`);
    }
  });

  it('an empty update changes nothing and writes no audit row', async () => {
    const before = await ownerQuery<{ n: number }>("select count(*)::int as n from audit_logs where action = 'school_settings.update'");
    const res = await put(adminA, {});
    expect(res.status).toBe(200);
    const after = await ownerQuery<{ n: number }>("select count(*)::int as n from audit_logs where action = 'school_settings.update'");
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it("school B's admin sees only school B's settings", async () => {
    const res = await request(t.app).get('/api/v1/school/settings').set(auth(adminB));
    expect(res.body.data).toMatchObject({ speedLimitKmh: null, alertRecipients: [], features: { sms: false } });
  });
});

describe('parent visibility', () => {
  it('GET returns the BP default matrix and the defaults', async () => {
    const res = await request(t.app).get('/api/v1/school/settings/parent-visibility').set(auth(adminA));
    expect(res.status).toBe(200);
    expect(res.body.data.matrix).toEqual(DEFAULT_PARENT_VISIBILITY);
    expect(res.body.data.defaults).toEqual(DEFAULT_PARENT_VISIBILITY);
  });

  it('PUT merges a partial matrix, stores snake_case keys and audits each changed cell', async () => {
    const res = await request(t.app)
      .put('/api/v1/school/settings/parent-visibility')
      .set(auth(adminA))
      .send({ driver: { phone: true, unknownField: true }, bus: { capacity: true, insuranceFile: true } });
    expect(res.status).toBe(200);
    expect(res.body.data.matrix.driver).toMatchObject({ phone: true, photo: true, licenceFile: false });
    expect(res.body.data.matrix.bus).toMatchObject({ capacity: true, insuranceFile: true, insuranceStatus: true });
    expect(res.body.data.matrix.driver).not.toHaveProperty('unknownField');
    const stored = await ownerQuery<{ pv: Record<string, Record<string, boolean>> }>('select parent_visibility as pv from school_settings where school_id = $1', [fx.a.school.id]);
    expect(stored.rows[0]!.pv.driver).toMatchObject({ phone: true, licence_validity: true, character_cert_status: true });
    expect(stored.rows[0]!.pv.bus).toMatchObject({ insurance_file: true });
    const log = await ownerQuery<{ old_values: unknown; new_values: unknown }>(
      "select old_values, new_values from audit_logs where school_id = $1 and action = 'school_settings.parent_visibility_update' order by id desc limit 1",
      [fx.a.school.id],
    );
    expect(log.rows[0]).toEqual({
      old_values: { 'driver.phone': false, 'bus.capacity': false, 'bus.insuranceFile': false },
      new_values: { 'driver.phone': true, 'bus.capacity': true, 'bus.insuranceFile': true },
    });
    const b = await request(t.app).get('/api/v1/school/settings/parent-visibility').set(auth(adminB));
    expect(b.body.data.matrix).toEqual(DEFAULT_PARENT_VISIBILITY);
  });

  it('refuses a document file without its status and non-boolean values', async () => {
    const res = await request(t.app).put('/api/v1/school/settings/parent-visibility').set(auth(adminA)).send({ bus: { insuranceStatus: false } });
    expect(res.status).toBe(400);
    expect(paths(res)).toEqual(['bus.insuranceFile']);
    const lic = await request(t.app).put('/api/v1/school/settings/parent-visibility').set(auth(adminA)).send({ driver: { licenceFile: true, licenceValidity: false } });
    expect(paths(lic)).toEqual(['driver.licenceFile']);
    const bad = await request(t.app).put('/api/v1/school/settings/parent-visibility').set(auth(adminA)).send({ conductor: { phone: 'yes' } });
    expect(bad.status).toBe(400);
    expect(paths(bad)).toEqual(['conductor.phone']);
  });

  it('other modules read the matrix and settings through the helpers, parents included', async () => {
    const m = await withTenant(f.contexts.parent(String(fx.a.parent.id), fx.a.school.id), (tx) => loadParentVisibility(tx), { readOnly: true });
    expect(m.driver.phone).toBe(true);
    const mB = await withTenant(f.contexts.parent(String(fx.sharedParent.id), fx.b.school.id), (tx) => loadParentVisibility(tx), { readOnly: true });
    expect(mB).toEqual(DEFAULT_PARENT_VISIBILITY);
    const s = await withTenant(f.contexts.system(fx.a.school.id), (tx) => loadSchoolSettings(tx), { readOnly: true });
    expect(s).toMatchObject({ speedLimitKmh: 50, effective: { movingIntervalS: 10 } });
  });
});
