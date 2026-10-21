// db:setup-roles: idempotent role provisioning, generic grants on whatever tables exist,
// insert-only audit_logs (the core schema's table), select-only schema_migrations, default
// privileges for later tables.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import config from '../src/config/index.js';
import { getOwnerPool } from '../src/db/pool.js';
import { appCredentials, setupAppRole } from '../src/db/setupRoles.js';
import { withTenant } from '../src/db/tenant.js';
import { closeDb, ownerQuery } from './helpers/db.js';
import { TEST_APP_PASSWORD, TEST_APP_ROLE } from './helpers/testEnv.js';

const SCHOOL = '5c000000-0000-4000-8000-000000000005';
const ctx = { schoolId: SCHOOL, actorId: null, role: 'system' } as const;
const noSchool = { schoolId: null, actorId: null, role: 'system' } as const;

async function privileges(table: string): Promise<string[]> {
  const { rows } = await ownerQuery<{ p: string }>(
    `select privilege_type as p from information_schema.role_table_grants where grantee = $1 and table_name = $2 order by 1`,
    [TEST_APP_ROLE, table],
  );
  return rows.map((r) => r.p);
}

beforeAll(async () => {
  await ownerQuery('create table probe_items (id bigserial primary key, label text)');
});

afterAll(async () => {
  await ownerQuery("delete from audit_logs where action = 'probe.create'");
  await ownerQuery('drop table if exists probe_items, probe_later');
  await closeDb();
});

describe('setupAppRole', () => {
  it('is idempotent and reports what it covered', async () => {
    const { user } = appCredentials(config.db.app);
    expect(user).toBe(TEST_APP_ROLE);
    const first = await setupAppRole({ pool: getOwnerPool(), appUser: TEST_APP_ROLE, appPassword: TEST_APP_PASSWORD });
    const second = await setupAppRole({ pool: getOwnerPool(), appUser: TEST_APP_ROLE });
    expect(first.created).toBe(false);
    expect(second.attributesChanged).toEqual([]);
    expect(second.tables).toBeGreaterThanOrEqual(3);
  });

  it('grants the four DML privileges on ordinary tables and never TRUNCATE', async () => {
    expect(await privileges('probe_items')).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    await withTenant(ctx, async (tx) => {
      await tx.query("insert into probe_items (label) values ('x')");
      await tx.query("update probe_items set label = 'y'");
    });
    await expect(withTenant(ctx, (tx) => tx.query('truncate probe_items'))).rejects.toMatchObject({ code: '42501' });
  });

  it('keeps audit_logs insert/select-only and schema_migrations select-only', async () => {
    expect(await privileges('audit_logs')).toEqual(['INSERT', 'SELECT']);
    expect(await privileges('schema_migrations')).toEqual(['SELECT']);
    // Platform-level row (no school context) — the core schema's audit_logs policies allow appending it.
    await withTenant(noSchool, (tx) => tx.query("insert into audit_logs (action) values ('probe.create')"));
    await expect(withTenant(ctx, (tx) => tx.query("update audit_logs set action = 'tampered'"))).rejects.toMatchObject({ code: '42501' });
    await expect(withTenant(ctx, (tx) => tx.query('delete from audit_logs'))).rejects.toMatchObject({ code: '42501' });
    await expect(withTenant(ctx, (tx) => tx.query("insert into schema_migrations (id, checksum) values ('999_x', 'x')"))).rejects.toMatchObject({ code: '42501' });
  });

  it('covers tables created later through default privileges', async () => {
    await ownerQuery('create table probe_later (id bigserial primary key)');
    expect(await privileges('probe_later')).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    await withTenant(ctx, (tx) => tx.query('insert into probe_later default values'));
  });

  it('cannot create objects in schema public', async () => {
    await expect(withTenant(ctx, (tx) => tx.query('create table app_owned (id int)'))).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses the owner as app role and bad identifiers', async () => {
    const { rows } = await ownerQuery<{ u: string }>('select current_user as u');
    await expect(setupAppRole({ pool: getOwnerPool(), appUser: rows[0]!.u })).rejects.toThrow(/must differ/);
    await expect(setupAppRole({ pool: getOwnerPool(), appUser: 'bad-name; drop' })).rejects.toThrow(/plain identifier/);
  });
});
