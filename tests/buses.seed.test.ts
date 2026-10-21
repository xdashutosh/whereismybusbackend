// Seed 30_buses: demo fleets for the demo schools (codes R1…R6, state plates), documents with
// expired/expiring examples and primary driver/conductor assignments — idempotent, and visible
// through the real API as the school admin.
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import config from '../src/config/index.js';
import { DEMO_PASSWORD, runSeeds } from '../src/db/seed.js';
import { DEMO_SCHOOLS } from '../src/db/seeds/01_demo_tenants.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import { buildApp, type TestApp } from './helpers/authApp.js';

let t: TestApp;
const password = config.seedDefaultPassword ?? DEMO_PASSWORD;

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
});
afterAll(closeDb);

describe('30_buses seed', () => {
  it('creates fleets, documents and assignments idempotently', async () => {
    await runSeeds({ only: '01_' });
    expect((await runSeeds({ only: '30_' })).ran).toEqual(['30_buses.ts']);
    await runSeeds({ only: '30_' });
    const counts = await ownerQuery<{ code: string; buses: number; docs: number; primaries: number; conductors: number; expired: number; expiring: number }>(
      `select s.code,
              (select count(*)::int from buses b where b.school_id = s.id) as buses,
              (select count(*)::int from bus_documents d where d.school_id = s.id and d.is_current) as docs,
              (select count(*)::int from bus_staff_assignments a where a.school_id = s.id and a.assignment_role = 'primary_driver' and a.valid_to is null) as primaries,
              (select count(*)::int from bus_staff_assignments a where a.school_id = s.id and a.assignment_role = 'conductor' and a.valid_to is null) as conductors,
              (select count(*)::int from bus_documents d where d.school_id = s.id and d.expiry_date < current_date) as expired,
              (select count(*)::int from bus_documents d where d.school_id = s.id and d.expiry_date between current_date and current_date + 30) as expiring
         from schools s order by s.code`,
    );
    expect(counts.rows).toEqual([
      { code: 'GWIS-BLR', buses: 6, docs: 24, primaries: 1, conductors: 1, expired: 2, expiring: 2 },
      { code: 'SUNRISE-JPR', buses: 6, docs: 24, primaries: 1, conductors: 1, expired: 2, expiring: 2 },
    ]);
    const plates = await ownerQuery<{ registration_no: string }>("select b.registration_no from buses b join schools s on s.id = b.school_id where s.code = 'SUNRISE-JPR' order by b.code");
    expect(plates.rows.every((r) => r.registration_no.startsWith('RJ14'))).toBe(true);
  });

  it('the school admin sees the seeded fleet with driver names and document badges', async () => {
    const s = DEMO_SCHOOLS[0];
    const login = await request(t.app).post('/api/v1/auth/school/login').send({ email: s.admin.email, password });
    expect(login.status).toBe(200);
    const res = await request(t.app).get('/api/v1/school/buses?sort=code').set('Authorization', `Bearer ${login.body.data.accessToken}`);
    expect(res.body.data.map((b: { code: string }) => b.code)).toEqual(['R1', 'R2', 'R3', 'R4', 'R5', 'R6']);
    expect(res.body.data[0]).toMatchObject({ primaryDriverName: s.driver.name, conductorName: s.conductor.name, registrationNo: 'KA01AB1201' });
    expect(res.body.data[1]).toMatchObject({ expiringDocuments: 1, expiredDocuments: 0 });
    expect(res.body.data[5]).toMatchObject({ status: 'maintenance', expiredDocuments: 1 });
  });
});
