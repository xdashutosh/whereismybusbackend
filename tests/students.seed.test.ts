// Seed 60_people (contract §14): 30–60 students per demo school with parents and per-direction
// assignments that satisfy the assignment rules, exactly one parent phone linked to children in two
// schools, idempotent re-runs, and the data visible through the real API.
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import config from '../src/config/index.js';
import { DEMO_PASSWORD, runSeeds } from '../src/db/seed.js';
import { DEMO_PARENT } from '../src/db/seeds/01_demo_tenants.js';
import { DEMO_PEOPLE, generatePeople } from '../src/db/seeds/60_people.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import { buildApp, loginParent, type TestApp } from './helpers/authApp.js';

let t: TestApp;
const password = config.seedDefaultPassword ?? DEMO_PASSWORD;

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  await runSeeds();
});
afterAll(closeDb);

describe('60_people seed', () => {
  it('generates deterministic, school-specific people', () => {
    for (const p of DEMO_PEOPLE) {
      const a = generatePeople(p);
      expect(a).toEqual(generatePeople(p));
      expect(new Set(a.students.map((s) => s.admissionNo)).size).toBe(p.count);
      expect(a.parents.every((x) => /^\+91[6-9]\d{9}$/.test(x.phone))).toBe(true);
    }
    const phones = DEMO_PEOPLE.flatMap((p) => generatePeople(p).parents.map((x) => x.phone));
    expect(new Set(phones).size).toBe(phones.length); // no generated phone is shared between schools
  });

  it('seeds 30–60 students per school with parents and valid assignments; re-runs change nothing', async () => {
    const counts = async () =>
      (await ownerQuery<{ code: string; students: number; parents: number; links: number; open: number }>(
        `select s.code,
                (select count(*)::int from students x where x.school_id = s.id and x.deleted_at is null) as students,
                (select count(*)::int from school_parents x where x.school_id = s.id) as parents,
                (select count(*)::int from student_parents x where x.school_id = s.id) as links,
                (select count(*)::int from student_assignments x where x.school_id = s.id and x.valid_to is null) as open
           from schools s order by s.code`,
      )).rows;
    const first = await counts();
    expect(first.map((c) => c.code)).toEqual(['GWIS-BLR', 'LAKEVIEW-HYD', 'RIVERSIDE-COK', 'SUNRISE-JPR']);
    for (const c of first) {
      expect(c.students, c.code).toBeGreaterThanOrEqual(30);
      expect(c.students, c.code).toBeLessThanOrEqual(60);
      expect(c.open, c.code).toBe(c.students * 2);
    }
    expect((await runSeeds({ only: '60_' })).ran).toEqual(['60_people.ts']);
    expect(await counts()).toEqual(first);
    const broken = await ownerQuery<{ n: number }>(
      `select count(*)::int as n from student_assignments sa join stops st on st.id = sa.stop_id join routes r on r.id = sa.route_id
        where st.route_id <> sa.route_id or r.direction <> sa.trip_direction
           or not exists (select 1 from bus_route_assignments b where b.bus_id = sa.bus_id and b.route_id = sa.route_id and b.valid_to is null)`,
    );
    expect(broken.rows[0]).toEqual({ n: 0 });
    const noPrimary = await ownerQuery<{ n: number }>('select count(*)::int as n from students s where not exists (select 1 from student_parents l where l.student_id = s.id and l.is_primary)');
    expect(noPrimary.rows[0]).toEqual({ n: 0 });
    const cross = await ownerQuery<{ phone: string; schools: number }>(
      `select pa.phone, count(distinct l.school_id)::int as schools from parent_accounts pa join student_parents l on l.parent_account_id = pa.id
        group by pa.phone having count(distinct l.school_id) > 1`,
    );
    expect(cross.rows).toEqual([{ phone: DEMO_PARENT.phone, schools: 2 }]);
  });

  it('is visible through the API: school admin lists, the cross-school parent sees both schools', async () => {
    const login = await request(t.app).post('/api/v1/auth/school/login').send({ email: 'admin@lakeview.example', password });
    expect(login.status).toBe(200);
    const token = login.body.data.accessToken as string;
    const list = await request(t.app).get('/api/v1/school/students?limit=5').set('Authorization', `Bearer ${token}`);
    expect(list.body.meta.total).toBe(36);
    expect(list.body.data[0].assignments.morning).toMatchObject({ state: 'current' });
    expect(list.body.data[0].primaryParent).not.toBeNull();
    const unassigned = await request(t.app).get('/api/v1/school/students?unassigned=true').set('Authorization', `Bearer ${token}`);
    expect(unassigned.body.meta.total).toBe(0);
    const parent = await loginParent(t, DEMO_PARENT.phone);
    const me = await request(t.app).get('/api/v1/auth/me').set('Authorization', `Bearer ${parent.accessToken}`);
    const schools = await ownerQuery<{ id: string }>("select id from schools where code in ('GWIS-BLR', 'SUNRISE-JPR')");
    for (const s of schools.rows) expect(JSON.stringify(me.body.data)).toContain(s.id);
  });
});
