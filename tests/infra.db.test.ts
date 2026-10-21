// DB-backed infrastructure through the app role: type parsers, one-round-trip paged lists, and the
// default bootstrap loaders (session, parent link, school timezones, min versions, school state)
// — both before the core schema provides their functions/tables and against minimal fixtures.
import { afterAll, describe, expect, it } from 'vitest';
import { getAppPool } from '../src/db/pool.js';
import { withTenant } from '../src/db/tenant.js';
import { loadSchoolTimezones } from '../src/jobs/schoolCron.js';
import { loadSchoolStateFromDb, parentLinkFromDb } from '../src/middleware/resolveTenant.js';
import { loadMinVersionsFromDb } from '../src/middleware/versionGate.js';
import { buildPagedQuery, pagedQuery, parsePagination, parseSort } from '../src/shared/pagination.js';
import { loadSessionFromDb } from '../src/shared/sessions.js';
import { closeDb, ownerQuery } from './helpers/db.js';
import { TEST_APP_ROLE } from './helpers/testEnv.js';

const SCHOOL_A = '0a000000-0000-4000-8000-00000000000a';
const SCHOOL_B = '0b000000-0000-4000-8000-00000000000b';
const RANDOM = '9f000000-0000-4000-8000-00000000009f';
const ctxA = { schoolId: SCHOOL_A, actorId: null, role: 'system' } as const;

async function exists(kind: 'table' | 'function', name: string): Promise<boolean> {
  const sql = kind === 'table' ? 'select to_regclass($1) is not null as present' : 'select exists(select 1 from pg_proc where proname = $1) as present';
  return Boolean((await ownerQuery<{ present: boolean }>(sql, [kind === 'table' ? `public.${name}` : name])).rows[0]?.present);
}

const created: string[] = [];
afterAll(async () => {
  for (const t of created) await ownerQuery(`drop table if exists ${t}`);
  await closeDb();
});

describe('type parsers', () => {
  it('keeps DATE/TIME as strings, INT8/NUMERIC as numbers, timestamptz as ISO strings', async () => {
    const { rows } = await getAppPool().query(
      "select '2026-10-17'::date as d, '07:30:00'::time as t, 12345678901::int8 as big, 12.50::numeric(6,2) as amount, '2026-10-17 07:30:00+05:30'::timestamptz as at, array['2026-01-01'::date] as days, array[1.5::numeric] as nums",
    );
    expect(rows[0]).toEqual({ d: '2026-10-17', t: '07:30:00', big: 12345678901, amount: 12.5, at: '2026-10-17T02:00:00.000Z', days: ['2026-01-01'], nums: [1.5] });
  });
});

describe('paged queries', () => {
  const spec = (page: number, limit: number) => {
    const { orderBy } = parseSort('-n', { allowed: { n: 'g.n' }, tiebreaker: 'g.n' });
    const { offset } = parsePagination({ page, limit });
    return { select: 'g.n', from: 'from generate_series(1, 45) as g(n)', where: 'g.n % $1 = 0', params: [1], orderBy, limit, offset };
  };

  it('returns the page and the total in one statement, also past the last page', async () => {
    const first = await withTenant(ctxA, (tx) => pagedQuery<{ n: number }>(tx, spec(1, 20)), { readOnly: true });
    expect(first.total).toBe(45);
    expect(first.rows.slice(0, 2)).toEqual([{ n: 45 }, { n: 44 }]);
    const last = await withTenant(ctxA, (tx) => pagedQuery(tx, spec(3, 20)), { readOnly: true });
    expect(last.rows).toHaveLength(5);
    const beyond = await withTenant(ctxA, (tx) => pagedQuery(tx, spec(9, 20)), { readOnly: true });
    expect(beyond).toEqual({ rows: [], total: 45 });
    expect(buildPagedQuery(spec(1, 10)).values).toEqual([1, 10, 0]);
  });

  it('validates pagination and sort input', () => {
    expect(() => parsePagination({ page: 0 })).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(() => parsePagination({ limit: 101 })).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(parsePagination({})).toEqual({ page: 1, limit: 20, offset: 0 });
    expect(() => parseSort('name;drop', { allowed: { name: 'b.name' } })).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(() => parseSort('secret', { allowed: { name: 'b.name' } })).toThrow(/Unsupported sort field/);
    expect(parseSort('', { allowed: { name: 'b.name', createdAt: 'b.created_at' }, defaultSort: '-createdAt,name' }).orderBy).toBe('ORDER BY b.created_at DESC NULLS LAST, b.name ASC NULLS LAST');
  });
});

describe('bootstrap loaders', () => {
  it('session loader: 503 until auth_session_actor() exists, then null for unknown sessions', async () => {
    if (await exists('function', 'auth_session_actor')) expect(await loadSessionFromDb(RANDOM)).toBeNull();
    else await expect(loadSessionFromDb(RANDOM)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('parent link check: 503 until parent_children_index() exists, then false for unknown parents', async () => {
    if (await exists('function', 'parent_children_index')) expect(await parentLinkFromDb(RANDOM, SCHOOL_A)).toBe(false);
    else await expect(parentLinkFromDb(RANDOM, SCHOOL_A)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('school timezones: empty until school_timezones() exists', async () => {
    const result = await loadSchoolTimezones();
    if (!(await exists('function', 'school_timezones'))) expect(result).toEqual([]);
    else expect(Array.isArray(result)).toBe(true);
  });

  it('min versions: empty without platform settings, parsed from the setting otherwise', async () => {
    if (!(await exists('table', 'platform_settings'))) {
      expect(await loadMinVersionsFromDb()).toEqual({});
      await ownerQuery('create table platform_settings (key text primary key, value jsonb not null)');
      created.push('platform_settings');
      await ownerQuery('alter table platform_settings enable row level security');
      await ownerQuery('alter table platform_settings force row level security');
      await ownerQuery("create policy super_admin_only on platform_settings using (current_setting('app.actor_role', true) = 'super_admin')");
      await ownerQuery(`grant select on platform_settings to ${TEST_APP_ROLE}`);
      await ownerQuery(`insert into platform_settings (key, value) values ('min_supported_version', '{"driver_app":"1.4.0","parent_app":"bad","other":"1.0.0"}')`);
      expect(await loadMinVersionsFromDb()).toEqual({ driver_app: '1.4.0' });
    } else {
      expect(typeof (await loadMinVersionsFromDb())).toBe('object');
    }
  });

  it('school state: read inside the school own RLS context', async () => {
    if (await exists('table', 'schools')) {
      expect(await loadSchoolStateFromDb(RANDOM)).toBeNull();
      return;
    }
    await ownerQuery(`create table schools (
        id uuid primary key, status text not null default 'active', deleted_at timestamptz,
        timezone text not null default 'Asia/Kolkata', tenant_mode text not null default 'shared', db_connection_ref text)`);
    created.push('schools');
    await ownerQuery('alter table schools enable row level security');
    await ownerQuery('alter table schools force row level security');
    await ownerQuery(`create policy school_visibility on schools using (
        current_setting('app.actor_role', true) = 'super_admin' or id = nullif(current_setting('app.school_id', true), '')::uuid)`);
    await ownerQuery(`grant select on schools to ${TEST_APP_ROLE}`);
    await ownerQuery("insert into schools (id, status, deleted_at) values ($1, 'active', null), ($2, 'suspended', now())", [SCHOOL_A, SCHOOL_B]);
    expect(await loadSchoolStateFromDb(SCHOOL_A)).toEqual({ id: SCHOOL_A, status: 'active', deleted: false, timezone: 'Asia/Kolkata', tenantMode: 'shared', dbConnectionRef: null });
    expect(await loadSchoolStateFromDb(SCHOOL_B)).toMatchObject({ status: 'suspended', deleted: true });
    expect(await loadSchoolStateFromDb(RANDOM)).toBeNull();
    // Another school's context cannot see school A.
    expect(await withTenant({ schoolId: SCHOOL_B, actorId: null, role: 'system' }, (tx) => tx.many('select id from schools where id = $1', [SCHOOL_A]))).toEqual([]);
  });
});
