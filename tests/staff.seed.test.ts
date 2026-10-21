// Seed 40_staff: crews for the demo schools (profiles, logins, documents, bus assignments) —
// idempotent, identity numbers as last 4 only, and usable through the real API (admin list,
// parent preview) and the driver app sign-in (username + PIN).
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import config from '../src/config/index.js';
import { DEMO_PASSWORD, runSeeds } from '../src/db/seed.js';
import { DEMO_PIN, DEMO_SCHOOLS } from '../src/db/seeds/01_demo_tenants.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import { buildApp, DEVICE, type TestApp } from './helpers/authApp.js';

let t: TestApp;
const password = config.seedDefaultPassword ?? DEMO_PASSWORD;

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
});
afterAll(closeDb);

describe('40_staff seed', () => {
  it('creates crews, documents and assignments idempotently', async () => {
    await runSeeds({ only: '01_' });
    await runSeeds({ only: '30_' });
    expect((await runSeeds({ only: '40_' })).ran).toEqual(['40_staff.ts']);
    await runSeeds({ only: '40_' });
    const counts = await ownerQuery<{ code: string; drivers: number; conductors: number; logins: number; docs: number; primaries: number; conductorSlots: number; backups: number }>(
      `select s.code,
              (select count(*)::int from staff_profiles sp where sp.school_id = s.id and sp.staff_type = 'driver') as drivers,
              (select count(*)::int from staff_profiles sp where sp.school_id = s.id and sp.staff_type = 'conductor') as conductors,
              (select count(*)::int from staff_profiles sp where sp.school_id = s.id and sp.user_id is not null) as logins,
              (select count(*)::int from staff_documents d where d.school_id = s.id and d.is_current) as docs,
              (select count(*)::int from bus_staff_assignments a where a.school_id = s.id and a.assignment_role = 'primary_driver' and a.valid_to is null) as primaries,
              (select count(*)::int from bus_staff_assignments a where a.school_id = s.id and a.assignment_role = 'conductor' and a.valid_to is null) as "conductorSlots",
              (select count(*)::int from bus_staff_assignments a where a.school_id = s.id and a.assignment_role = 'backup_driver' and a.valid_to is null) as backups
         from schools s order by s.code`,
    );
    // 6 drivers + 5 conductors per school; 5 active buses (R6 is in maintenance) + R1's backup driver.
    for (const row of counts.rows) expect(row).toMatchObject({ drivers: 6, conductors: 5, logins: 11, docs: 67, primaries: 5, conductorSlots: 5, backups: 1 });
    expect(counts.rows.map((r) => r.code)).toEqual(['GWIS-BLR', 'SUNRISE-JPR']);
  });

  it('stores identity numbers as last 4 only and keeps identity documents private', async () => {
    const bad = await ownerQuery(
      `select 1 from staff_profiles where id_proof_last4 is null or length(id_proof_last4) <> 4
       union all select 1 from staff_documents where doc_type = 'identity' and (length(doc_number) <> 4 or visible_to_parents_status or visible_to_parents_file)`,
    );
    expect(bad.rowCount).toBe(0);
    const expiring = await ownerQuery<{ n: number }>("select count(*)::int as n from staff_profiles where licence_expiry_date between current_date and current_date + 30");
    expect(expiring.rows[0]!.n).toBeGreaterThanOrEqual(2);
  });

  it('is usable through the API: admin list, parent preview and driver sign-in with PIN', async () => {
    const s = DEMO_SCHOOLS[0];
    const login = await request(t.app).post('/api/v1/auth/school/login').send({ email: s.admin.email, password });
    expect(login.status).toBe(200);
    const auth = { Authorization: `Bearer ${login.body.data.accessToken}` };
    const list = await request(t.app).get('/api/v1/school/staff?type=driver&sort=fullName&limit=100').set(auth);
    expect(list.body.meta.total).toBe(6);
    const ravi = list.body.data.find((x: { fullName: string }) => x.fullName === s.driver.name);
    expect(ravi).toMatchObject({ hasLogin: true, idProofMasked: expect.stringMatching(/^XXXX XXXX \d{4}$/), currentBuses: [{ busCode: 'R1', role: 'primary_driver' }] });
    const preview = await request(t.app).get(`/api/v1/school/staff/${ravi.id}/parent-preview`).set(auth);
    expect(preview.body.data).toMatchObject({ visibleToParents: true, card: { fullName: s.driver.name, phone: null } });
    const signIn = await request(t.app).post('/api/v1/auth/staff/login').send({ schoolCode: s.code, username: 'gwis.manjunath', pin: DEMO_PIN, device: DEVICE });
    expect(signIn.status).toBe(200);
  });
});
