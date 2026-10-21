// BP §9.1 (coverage finding): "Stopped interval 60–120 s, value from config (default 90 s)". The
// school override (PUT /school/settings locationStoppedIntervalS), the platform default
// (PUT /platform/settings 'location.stopped_interval_s') and the school_settings check constraint
// (migration 855) all accept exactly 60–120 s.
import { PLATFORM_SETTING_SCHEMAS, schoolSettingsBody } from '@wimb/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, ownerQuery, truncateAll } from '../helpers/db.js';
import * as f from '../helpers/factories.js';
import { buildApp, loginSchoolAdmin, passwordHash, type TestApp } from '../helpers/authApp.js';

let t: TestApp;
let fx: f.TwoSchoolFixture;
let admin: string;
const put = (body: unknown) => request(t.app).put('/api/v1/school/settings').set({ Authorization: `Bearer ${admin}` }).send(body as object);

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  fx = await f.twoSchoolFixture();
  await ownerQuery('update users set password_hash = $1 where id = $2', [await passwordHash(), fx.a.admin.id]);
  admin = (await loginSchoolAdmin(t.app, String(fx.a.admin.email))).accessToken;
});
afterAll(closeDb);

describe('stopped interval band 60–120 s', () => {
  it('validates the shared schemas to 60–120', () => {
    const platform = PLATFORM_SETTING_SCHEMAS['location.stopped_interval_s'];
    expect([30, 59, 121, 300].map((v) => platform.safeParse(v).success)).toEqual([false, false, false, false]);
    expect([60, 90, 120].map((v) => platform.safeParse(v).success)).toEqual([true, true, true]);
    expect(schoolSettingsBody.safeParse({ locationStoppedIntervalS: 30 }).success).toBe(false);
    expect(schoolSettingsBody.safeParse({ locationStoppedIntervalS: 300 }).success).toBe(false);
    expect(schoolSettingsBody.safeParse({ locationStoppedIntervalS: null }).success).toBe(true);
  });

  it('refuses a school override outside the band and accepts its edges', async () => {
    for (const v of [30, 59, 121, 300]) {
      const res = await put({ locationStoppedIntervalS: v });
      expect(res.status, String(v)).toBe(400);
      expect((res.body.error.details as { path: string }[]).map((d) => d.path)).toContain('locationStoppedIntervalS');
    }
    for (const v of [60, 120]) {
      const res = await put({ locationStoppedIntervalS: v });
      expect(res.status, String(v)).toBe(200);
      expect(res.body.data.locationStoppedIntervalS).toBe(v);
    }
  });

  it('enforces the band in the database too', async () => {
    await expect(ownerQuery('update school_settings set location_stopped_interval_s = 30 where school_id = $1', [fx.a.school.id])).rejects.toThrow(/check constraint/);
    await expect(ownerQuery('update school_settings set location_stopped_interval_s = 300 where school_id = $1', [fx.a.school.id])).rejects.toThrow(/check constraint/);
    await expect(ownerQuery('update school_settings set location_stopped_interval_s = 90 where school_id = $1', [fx.a.school.id])).resolves.toBeTruthy();
  });
});
