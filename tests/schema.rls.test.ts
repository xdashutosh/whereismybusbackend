// Core schema RLS (contract §4, BP §4.3/§4.9/App. C) against the real migrations, as the
// NOBYPASSRLS test app role: catalog coverage (fails on any omission), no context → zero tenant
// rows, school A → only A, WITH CHECK blocks foreign school ids, super admin → zero tenant rows but
// every school, platform-table policies.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type TenantContext } from '../src/db/tenant.js';
import { appPool, closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import { contexts, twoSchoolFixture, type TwoSchoolFixture } from './helpers/factories.js';

let f: TwoSchoolFixture;

interface TableInfo {
  name: string;
  partition: boolean;
}
let tenantTables: TableInfo[] = [];

const read = <T extends Record<string, unknown> = Record<string, unknown>>(ctx: TenantContext, sql: string, params: unknown[] = []) =>
  withTenant(ctx, (tx) => tx.many<T>(sql, params), { readOnly: true });

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  f = await twoSchoolFixture();
  const { rows } = await ownerQuery<{ name: string; partition: boolean }>(
    `select c.relname as name, c.relispartition as partition
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute a on a.attrelid = c.oid and a.attname = 'school_id' and not a.attisdropped
      where n.nspname = 'public' and c.relkind in ('r', 'p')
      order by 1`,
  );
  tenantTables = rows;
});

afterAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  await closeDb();
});

describe('RLS catalog coverage', () => {
  it('covers the full BP §6.2 schema', () => {
    const names = tenantTables.filter((t) => !t.partition).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([
      'alerts', 'announcements', 'audit_logs', 'bus_documents', 'bus_images', 'bus_route_assignments', 'bus_staff_assignments', 'buses',
      'devices', 'files', 'fuel_logs', 'idempotency_keys', 'location_points', 'maintenance_logs', 'notification_events',
      'notification_preferences', 'parent_notifications', 'routes', 'school_holidays', 'school_parents', 'school_settings',
      'school_subscriptions', 'sessions', 'staff_documents', 'staff_profiles', 'stops', 'student_assignments', 'student_parents',
      'students', 'trip_odometer_evidence', 'trip_schedules', 'trip_stop_events', 'trips', 'users',
    ]));
    expect(tenantTables.filter((t) => t.partition).length).toBeGreaterThanOrEqual(3); // location_points_YYYY_MM
  });

  it('every table with school_id (partitions included) has RLS ENABLED + FORCED, tenant_isolation and a parent decision', async () => {
    const { rows } = await ownerQuery<{ name: string; rls: boolean; force: boolean; policies: string[] }>(
      `select c.relname as name, c.relrowsecurity as rls, c.relforcerowsecurity as force,
              coalesce(array_agg(p.polname::text order by p.polname) filter (where p.polname is not null), '{}') as policies
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a on a.attrelid = c.oid and a.attname = 'school_id' and not a.attisdropped
         left join pg_policy p on p.polrelid = c.oid
        where n.nspname = 'public' and c.relkind in ('r', 'p')
        group by c.relname, c.relrowsecurity, c.relforcerowsecurity`,
    );
    const problems: string[] = [];
    for (const r of rows) {
      if (!r.rls) problems.push(`${r.name}: RLS not enabled`);
      if (!r.force) problems.push(`${r.name}: RLS not forced`);
      if (!r.policies.includes('tenant_isolation')) problems.push(`${r.name}: no tenant_isolation policy`);
      if (!r.policies.includes('definer_access')) problems.push(`${r.name}: no definer_access policy`);
      const parentDecision = r.name === 'audit_logs' ? 'audit_readers' : 'parent_scope';
      if (!r.policies.includes(parentDecision)) problems.push(`${r.name}: no ${parentDecision} policy (apply_parent_scope)`);
    }
    expect(problems).toEqual([]);
    expect(rows.length).toBe(tenantTables.length);
  });

  it('tenant_isolation compares school_id with app.school_id in USING and WITH CHECK', async () => {
    const { rows } = await ownerQuery<{ name: string; qual: string; check: string }>(
      `select c.relname as name, pg_get_expr(p.polqual, p.polrelid) as qual, pg_get_expr(p.polwithcheck, p.polrelid) as check
         from pg_policy p join pg_class c on c.oid = p.polrelid where p.polname = 'tenant_isolation'`,
    );
    for (const r of rows) {
      expect(r.qual, r.name).toMatch(/school_id = \(NULLIF\(current_setting\('app\.school_id'::text, true\), ''::text\)\)::uuid/);
      expect(r.check, r.name).toBe(r.qual);
    }
  });

  it('every non-tenant application table has RLS ENABLED + FORCED as well', async () => {
    const { rows } = await ownerQuery<{ name: string; rls: boolean; force: boolean }>(
      `select c.relname as name, c.relrowsecurity as rls, c.relforcerowsecurity as force
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relname <> 'schema_migrations'
          and not exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'school_id' and not a.attisdropped)
          and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
        order by 1`,
    );
    expect(rows.map((r) => r.name)).toEqual(['job_dispatch_state', 'otp_codes', 'parent_accounts', 'platform_settings', 'platform_users', 'schools']);
    expect(rows.every((r) => r.rls && r.force)).toBe(true);
  });
});

describe('tenant isolation as the app role', () => {
  it('fixture populated every tenant table for both schools (precondition)', async () => {
    for (const t of tenantTables.filter((x) => !x.partition)) {
      const { rows } = await ownerQuery<{ a: number; b: number }>(
        `select count(*) filter (where school_id = $1)::int as a, count(*) filter (where school_id = $2)::int as b from ${t.name}`,
        [f.a.school.id, f.b.school.id],
      );
      expect(rows[0]!.a, t.name).toBeGreaterThan(0);
      expect(rows[0]!.b, t.name).toBeGreaterThan(0);
    }
  });

  it('without any context the app role sees zero rows in every tenant and private platform table', async () => {
    for (const t of [...tenantTables.map((x) => x.name), 'schools', 'platform_users', 'parent_accounts', 'otp_codes']) {
      const { rows } = await appPool().query<{ n: number }>(`select count(*)::int as n from ${t}`);
      expect(rows[0]!.n, t).toBe(0);
    }
    const settings = await appPool().query<{ n: number }>('select count(*)::int as n from platform_settings where not is_public');
    expect(settings.rows[0]!.n).toBe(0);
  });

  it('school A context sees exactly school A rows in every tenant table', async () => {
    const ctxA = contexts.schoolAdmin(f.a.school.id, f.a.admin.id);
    for (const t of tenantTables.filter((x) => !x.partition)) {
      const [own] = await read<{ mine: number; foreign: number }>(
        ctxA,
        `select count(*) filter (where school_id = $1)::int as mine, count(*) filter (where school_id is distinct from $1)::int as foreign from ${t.name}`,
        [f.a.school.id],
      );
      const { rows } = await ownerQuery<{ n: number }>(`select count(*)::int as n from ${t.name} where school_id = $1`, [f.a.school.id]);
      expect(own!.foreign, `${t.name} leaks other schools`).toBe(0);
      expect(own!.mine, `${t.name} hides own rows`).toBe(rows[0]!.n);
    }
  });

  it('identical codes resolve per school (R1, Route 1, Stop 1)', async () => {
    const ctxB = contexts.schoolAdmin(f.b.school.id, f.b.admin.id);
    const rows = await read<{ id: string }>(ctxB, "select b.id from buses b where b.code = 'R1'");
    expect(rows).toEqual([{ id: f.b.bus.id }]);
    const stops = await read<{ id: string }>(ctxB, "select s.id from stops s join routes r on r.id = s.route_id where r.code = 'R1' and s.name = 'Stop 1'");
    expect(stops).toEqual([{ id: f.b.stop1.id }]);
    expect(await read(ctxB, 'select id from buses where id = $1', [f.a.bus.id])).toEqual([]);
  });

  it('WITH CHECK blocks moving any row of school A to school B', async () => {
    const ctxA = contexts.schoolAdmin(f.a.school.id, f.a.admin.id);
    const outcomes: string[] = [];
    for (const t of tenantTables.filter((x) => !x.partition && x.name !== 'audit_logs')) {
      const code = await withTenant(ctxA, (tx) => tx.query(`update ${t.name} set school_id = $1 where school_id = $2`, [f.b.school.id, f.a.school.id])).then(
        (r) => `updated ${r.rowCount ?? 0}`,
        (err: { code?: string }) => err.code,
      );
      if (code !== '42501') outcomes.push(`${t.name}: ${code}`);
    }
    // Subscriptions and parent consent records are read-only for school admins (restrictive policies):
    // nothing to move at all.
    expect(outcomes).toEqual(['parent_consents: updated 0', 'school_subscriptions: updated 0']);
  });

  it('WITH CHECK blocks inserting rows for another school', async () => {
    const ctxA = contexts.schoolAdmin(f.a.school.id, f.a.admin.id);
    const attempts: [string, string, unknown[]][] = [
      ['buses', 'insert into buses (school_id, code, registration_no) values ($1, $2, $3)', [f.b.school.id, 'X9', 'KA09ZZ9999']],
      ['students', 'insert into students (school_id, full_name) values ($1, $2)', [f.b.school.id, 'Intruder']],
      ['alerts', "insert into alerts (school_id, alert_type, severity, title) values ($1, 'speeding', 'warning', 'x')", [f.b.school.id]],
      ['location_points', 'insert into location_points (school_id, trip_id, recorded_at, latitude, longitude) values ($1, $2, now(), 12.9, 77.6)', [f.b.school.id, f.b.trip.id]],
      ['audit_logs', "insert into audit_logs (school_id, action) values ($1, 'bus.create')", [f.b.school.id]],
    ];
    for (const [name, sql, params] of attempts) {
      await expect(withTenant(ctxA, (tx) => tx.query(sql, params)), name).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('super admin context sees zero tenant rows but every school (and platform audit rows only)', async () => {
    const ctx = contexts.superAdmin(f.superAdmin.id);
    for (const t of tenantTables.filter((x) => !x.partition && x.name !== 'school_subscriptions')) {
      const [r] = await read<{ n: number }>(ctx, `select count(*)::int as n from ${t.name} where school_id is not null`);
      expect(r!.n, t.name).toBe(0);
    }
    const schools = await read<{ id: string }>(ctx, 'select id from schools where id = any($1::uuid[])', [[f.a.school.id, f.b.school.id]]);
    expect(schools).toHaveLength(2);
    const audit = await read<{ action: string }>(ctx, 'select action from audit_logs');
    expect(audit.map((r) => r.action)).toEqual(['school.create']);
    // Subscriptions are platform-managed: visible and editable for super admins.
    expect(await read(ctx, 'select id from school_subscriptions')).toHaveLength(2);
  });
});
