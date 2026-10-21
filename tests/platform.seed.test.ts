// Seed 10_platform: Lakeview Academy and Riverside College onboarded like POST /platform/schools
// (school + settings + admin + subscription + platform audit), idempotent, admins sign in with the
// demo password, and the plans show up in the platform usage view.
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import config from '../src/config/index.js';
import { DEMO_PASSWORD, runSeeds } from '../src/db/seed.js';
import { PLATFORM_DEMO_SCHOOLS } from '../src/db/seeds/10_platform.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import { buildApp, type TestApp } from './helpers/authApp.js';

let t: TestApp;
const password = config.seedDefaultPassword ?? DEMO_PASSWORD;

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
});
afterAll(closeDb);

describe('10_platform seed', () => {
  it('creates the two platform demo tenants idempotently', async () => {
    expect((await runSeeds({ only: '10_' })).ran).toEqual(['10_platform.ts']);
    await runSeeds({ only: '10_' });
    const rows = await ownerQuery<{ code: string; institution_type: string; settings: number; admins: number; plan: string; max_buses: number; valid_until: string | null; audits: number }>(
      `select s.code, s.institution_type,
              (select count(*)::int from school_settings x where x.school_id = s.id) as settings,
              (select count(*)::int from users u where u.school_id = s.id and u.role = 'school_admin') as admins,
              sub.plan, sub.max_buses, sub.valid_until,
              (select count(*)::int from audit_logs a where a.entity_id = s.id and a.action = 'school.create' and a.school_id is null) as audits
         from schools s join school_subscriptions sub on sub.school_id = s.id and sub.status = 'active'
        order by s.code`,
    );
    expect(rows.rows.map((r) => [r.code, r.institution_type, r.settings, r.admins, r.plan, r.max_buses, r.audits])).toEqual([
      ['LAKEVIEW-HYD', 'school', 1, 1, 'standard', 12, 1],
      ['RIVERSIDE-COK', 'college', 1, 1, 'premium', 20, 1],
    ]);
    expect(rows.rows.every((r) => r.valid_until !== null)).toBe(true);
    expect((await ownerQuery('select count(*)::int as n from school_subscriptions')).rows[0]!.n).toBe(2);
  });

  it('the seeded admins sign in with the demo password', async () => {
    for (const s of PLATFORM_DEMO_SCHOOLS) {
      const res = await request(t.app).post('/api/v1/auth/school/login').send({ email: s.admin.email, password });
      expect(res.status, s.admin.email).toBe(200);
      expect(res.body.data.user.school).toMatchObject({ code: s.code, institutionType: s.institutionType });
    }
  });
});
