// Seed 20_school: second admin per demo school, holiday calendar, announcements in every publish
// state and settings with alert recipients — idempotent, and visible through the school APIs.
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import config from '../src/config/index.js';
import { DEMO_PASSWORD, runSeeds } from '../src/db/seed.js';
import { COMMON_HOLIDAYS, DEMO_ANNOUNCEMENTS, SCHOOL_SEEDS } from '../src/db/seeds/20_school.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import { buildApp, type TestApp } from './helpers/authApp.js';

let t: TestApp;
const password = config.seedDefaultPassword ?? DEMO_PASSWORD;

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
});
afterAll(closeDb);

describe('20_school seed', () => {
  it('adds admins, holidays, announcements and settings to the demo schools idempotently', async () => {
    expect((await runSeeds({ only: '01_' })).ran).toEqual(['01_demo_tenants.ts']);
    expect((await runSeeds({ only: '20_' })).ran).toEqual(['20_school.ts']);
    await runSeeds({ only: '20_' });
    const counts = await ownerQuery(`select
      (select count(*)::int from users where role = 'school_admin') as admins,
      (select count(*)::int from school_holidays) as holidays,
      (select count(*)::int from announcements) as announcements,
      (select count(*)::int from school_settings where speed_limit_kmh is not null and jsonb_array_length(alert_recipients) = 2) as configured`);
    expect(counts.rows[0]).toEqual({ admins: 4, holidays: 2 * (COMMON_HOLIDAYS.length + 1), announcements: 2 * DEMO_ANNOUNCEMENTS.length, configured: 2 });
  });

  it('the seeded transport coordinator signs in and sees the school data through the API', async () => {
    const gwis = SCHOOL_SEEDS.find((s) => s.code === 'GWIS-BLR')!;
    const login = await request(t.app).post('/api/v1/auth/school/login').send({ email: gwis.admin.email, password });
    expect(login.status).toBe(200);
    const auth = { Authorization: `Bearer ${login.body.data.accessToken as string}` };
    const admins = await request(t.app).get('/api/v1/school/admins').set(auth);
    expect(admins.body.data.map((a: { fullName: string }) => a.fullName)).toEqual(['Arjun Nair', 'Meera Iyer']);
    const holidays = await request(t.app).get('/api/v1/school/holidays?year=2026').set(auth);
    expect(holidays.body.data.map((h: { name: string }) => h.name)).toEqual(['Kannada Rajyotsava', 'Diwali break', 'Annual Day (no afternoon trips)', 'Christmas']);
    const states = await request(t.app).get('/api/v1/school/announcements?sort=title').set(auth);
    expect(states.body.data.map((a: { state: string }) => a.state).sort()).toEqual(['active', 'active', 'expired', 'scheduled']);
    const settings = await request(t.app).get('/api/v1/school/settings').set(auth);
    expect(settings.body.data).toMatchObject({ speedLimitKmh: 50, enableSpeedingAlert: true });
    expect(settings.body.data.alertRecipients).toHaveLength(2);
  });

  it('never overwrites settings a school has saved', async () => {
    await ownerQuery("update school_settings set speed_limit_kmh = 35, updated_by = (select id from users where email = 'admin@sunrise.example') where school_id = (select id from schools where code = 'SUNRISE-JPR')");
    await runSeeds({ only: '20_' });
    const row = await ownerQuery<{ speed_limit_kmh: number }>("select speed_limit_kmh from school_settings where school_id = (select id from schools where code = 'SUNRISE-JPR')");
    expect(row.rows[0]!.speed_limit_kmh).toBe(35);
  });
});
