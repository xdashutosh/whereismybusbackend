// Seed 01_demo_tenants: two schools, one admin/driver/conductor each, one parent with children in
// both schools — idempotent, and every demo account signs in through the real auth flows.
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import config from '../src/config/index.js';
import { DEMO_PASSWORD, runSeeds } from '../src/db/seed.js';
import { DEMO_PARENT, DEMO_PIN, DEMO_SCHOOLS } from '../src/db/seeds/01_demo_tenants.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import { buildApp, type TestApp } from './helpers/authApp.js';

let t: TestApp;
const password = config.seedDefaultPassword ?? DEMO_PASSWORD;

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
});
afterAll(closeDb);

describe('01_demo_tenants seed', () => {
  it('creates the two demo schools idempotently', async () => {
    expect((await runSeeds({ only: '01_' })).ran).toEqual(['01_demo_tenants.ts']);
    await runSeeds({ only: '01_' });
    const counts = await ownerQuery(`select
      (select count(*)::int from schools) as schools,
      (select count(*)::int from users) as users,
      (select count(*)::int from staff_profiles where user_id is not null) as staff,
      (select count(*)::int from students) as students,
      (select count(*)::int from parent_accounts) as parents,
      (select count(distinct school_id)::int from student_parents) as linked_schools,
      (select count(*)::int from school_subscriptions where status = 'active') as subscriptions`);
    expect(counts.rows[0]).toEqual({ schools: 2, users: 6, staff: 4, students: 2, parents: 1, linked_schools: 2, subscriptions: 2 });
  });

  it('every demo account signs in', async () => {
    for (const s of DEMO_SCHOOLS) {
      const admin = await request(t.app).post('/api/v1/auth/school/login').send({ email: s.admin.email, password });
      expect(admin.status).toBe(200);
      expect(admin.body.data.user.school).toMatchObject({ code: s.code, name: s.name });
      const driver = await request(t.app)
        .post('/api/v1/auth/staff/login')
        .send({ schoolCode: s.code, username: s.driver.username, pin: DEMO_PIN, device: { deviceId: `seed-${s.code}`, platform: 'android' } });
      expect(driver.status).toBe(200);
      const conductor = await request(t.app)
        .post('/api/v1/auth/staff/login')
        .send({ schoolCode: s.code, phone: s.conductor.phone, password, device: { deviceId: `seed-c-${s.code}`, platform: 'android' } });
      expect(conductor.status).toBe(200);
    }
    expect((await request(t.app).post('/api/v1/auth/parent/otp/request').send({ phone: DEMO_PARENT.phone })).status).toBe(202);
    const verify = await request(t.app).post('/api/v1/auth/parent/otp/verify').send({ phone: DEMO_PARENT.phone, otp: t.sms.lastOtp(DEMO_PARENT.phone) });
    expect(verify.status).toBe(200);
    expect(verify.body.data.user.schools.map((x: { school: { code: string }; children: unknown[] }) => [x.school.code, x.children.length])).toEqual([
      ['GWIS-BLR', 1],
      ['SUNRISE-JPR', 1],
    ]);
  });
});
