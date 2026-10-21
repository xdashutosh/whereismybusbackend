// Name sorting is locale-aware on every host (migration 850_icu_name_collation). The hosted Neon
// databases use the builtin C.UTF-8 default collation (code-point order: 'Zara Khan' < 'aarav sharma'),
// so name/code columns carry an explicit ICU collation instead of relying on the database default.
// The catalog probe also guards name-like columns added by later migrations; the API checks use values
// whose code-point order differs from the expected order, so they would fail on a C-collated column.
import type { ParentChildrenResponse } from '@wimb/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, ownerQuery, truncateAll } from '../helpers/db.js';
import * as f from '../helpers/factories.js';
import { buildApp, loginParent, loginSchoolAdmin, passwordHash, type TestApp } from '../helpers/authApp.js';

const ICU = ['en-US-x-icu', 'und-x-icu'];
let t: TestApp;
let fx: f.TwoSchoolFixture;
let adminA: string;
let parentA: string;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const api = (path: string) => `/api/v1${path}`;

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  fx = await f.twoSchoolFixture();
  await ownerQuery('update users set password_hash = $1 where id = $2', [await passwordHash(), fx.a.admin.id]);
  adminA = (await loginSchoolAdmin(t.app, String(fx.a.admin.email))).accessToken;
  parentA = (await loginParent(t, String(fx.a.parent.phone))).accessToken;
  for (const name of ['Zara Khan', 'aarav mehta', 'Éva Nagy']) {
    const s = await f.student(fx.a.school.id, { full_name: name });
    await f.studentParent(fx.a.school.id, s.id, fx.a.parent.id, { is_primary: false });
  }
  for (const code of ['bus 2', 'Bus 10']) await f.bus(fx.a.school.id, { code });
});
afterAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  await closeDb();
});

describe('name collation (catalog)', () => {
  it('ICU is available and every application name/title/code column uses it', async () => {
    const { rows } = await ownerQuery<{ col: string; coll: string }>(
      `select c.relname || '.' || a.attname as col, co.collname as coll
         from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_collation co on co.oid = a.attcollation
        where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relispartition
          and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
          and a.attnum > 0 and not a.attisdropped
          and a.atttypid in ('text'::regtype, 'varchar'::regtype, 'bpchar'::regtype)
          and a.attname ~ '(^|_)(name|title|code|label)(_snapshot)?$'`,
    );
    expect(rows.length).toBeGreaterThan(20);
    expect(rows.filter((r) => !ICU.includes(r.coll))).toEqual([]);
    const key = rows.filter((r) => ['students.full_name', 'staff_profiles.full_name', 'users.full_name', 'schools.name', 'routes.name', 'buses.code'].includes(r.col));
    expect(key).toHaveLength(6);
  });

  it('keeps equality exact (deterministic collation): case differences are still distinct values', async () => {
    const { rows } = await ownerQuery<{ n: number }>("select count(*)::int as n from students where full_name = 'AARAV SHARMA' or full_name = 'Zara khan'");
    expect(rows[0]!.n).toBe(0);
  });
});

describe('name collation (API order)', () => {
  it('the test data really differs between code-point and locale order', async () => {
    const { rows } = await ownerQuery<{ names: string[] }>(
      `select array_agg(full_name::text collate "C" order by full_name::text collate "C") as names from students where school_id = $1`, [fx.a.school.id]);
    expect(rows[0]!.names).toEqual(['Aarav Sharma', 'Diya Patel', 'Zara Khan', 'aarav mehta', 'Éva Nagy']);
  });

  it('school students sorted by fullName ignore case and accents first', async () => {
    const res = await request(t.app).get(api('/school/students?sort=fullName')).set(auth(adminA));
    expect(res.status).toBe(200);
    expect((res.body.data as { fullName: string }[]).map((s) => s.fullName)).toEqual(['aarav mehta', 'Aarav Sharma', 'Diya Patel', 'Éva Nagy', 'Zara Khan']);
  });

  it('bus codes sort case-insensitively', async () => {
    const res = await request(t.app).get(api('/school/buses?sort=code')).set(auth(adminA));
    expect(res.status).toBe(200);
    expect((res.body.data as { code: string }[]).map((b) => b.code)).toEqual(['Bus 10', 'bus 2', 'R1', 'R2']);
  });

  it("a parent's children are listed in locale order", async () => {
    const res = await request(t.app).get(api('/parent/children')).set(auth(parentA));
    expect(res.status).toBe(200);
    const data = res.body.data as ParentChildrenResponse;
    expect(data.schools).toHaveLength(1);
    expect(data.schools[0]!.children.map((c) => c.fullName)).toEqual(['aarav mehta', 'Aarav Sharma', 'Éva Nagy', 'Zara Khan']);
  });
});
