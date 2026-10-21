// withTenant / withPlatform / withSystem against the real test database as the RLS-restricted app
// role: context is transaction-local (cleared after COMMIT on the same pooled connection), RLS
// isolates schools, READ ONLY is enforced, errors roll back.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import config from '../src/config/index.js';
import { createPool } from '../src/db/pool.js';
import { withPlatform, withSchoolSystem, withSystem, withTenant } from '../src/db/tenant.js';
import { closeDb, ownerQuery } from './helpers/db.js';
import { TEST_APP_ROLE } from './helpers/testEnv.js';

const SCHOOL_A = '0a000000-0000-4000-8000-00000000000a';
const SCHOOL_B = '0b000000-0000-4000-8000-00000000000b';
const ACTOR = 'ac000000-0000-4000-8000-0000000000ac';

// A single-connection app pool proves that context does not leak between transactions.
const pool = createPool(config.db.app, { max: 1, applicationName: 'wimb-test-tenant' });

const settings = "select current_setting('app.school_id', true) as school, current_setting('app.actor_id', true) as actor, current_setting('app.actor_role', true) as role, current_user as usr";

beforeAll(async () => {
  await ownerQuery(`create table harness_probe (
      id uuid primary key default gen_random_uuid(),
      school_id uuid not null,
      label text not null)`);
  await ownerQuery('alter table harness_probe enable row level security');
  await ownerQuery('alter table harness_probe force row level security');
  await ownerQuery(`create policy tenant_isolation on harness_probe
      using (school_id = nullif(current_setting('app.school_id', true), '')::uuid)
      with check (school_id = nullif(current_setting('app.school_id', true), '')::uuid)`);
  await ownerQuery(`grant select, insert, update, delete on harness_probe to ${TEST_APP_ROLE}`);
  await ownerQuery("insert into harness_probe (school_id, label) values ($1, 'a1'), ($1, 'a2'), ($2, 'b1')", [SCHOOL_A, SCHOOL_B]);
});

afterAll(async () => {
  await pool.end();
  await ownerQuery('drop table if exists harness_probe');
  await closeDb();
});

describe('withTenant', () => {
  it('runs as the NOBYPASSRLS app role and sets the three settings for the transaction only', async () => {
    const inside = await withTenant({ schoolId: SCHOOL_A, actorId: ACTOR, role: 'school_admin' }, (tx) => tx.one(settings), { pool });
    expect(inside).toEqual({ school: SCHOOL_A, actor: ACTOR, role: 'school_admin', usr: TEST_APP_ROLE });
    const role = await ownerQuery<{ rolbypassrls: boolean; rolsuper: boolean }>('select rolbypassrls, rolsuper from pg_roles where rolname = $1', [TEST_APP_ROLE]);
    expect(role.rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
    // Same (only) connection, outside any withTenant: nothing left behind.
    const after = await pool.query(settings);
    expect(after.rows[0]).toMatchObject({ school: '', actor: '', role: '' });
  });

  it('clears the context after a rolled-back transaction too', async () => {
    await expect(
      withTenant({ schoolId: SCHOOL_B, actorId: ACTOR, role: 'school_admin' }, async (tx) => {
        await tx.query("insert into harness_probe (school_id, label) values ($1, 'rolled-back')", [SCHOOL_B]);
        throw new Error('boom');
      }, { pool }),
    ).rejects.toThrow('boom');
    expect((await pool.query(settings)).rows[0]).toMatchObject({ school: '', role: '' });
    const { rows } = await ownerQuery("select count(*)::int as n from harness_probe where label = 'rolled-back'");
    expect(rows[0]?.n).toBe(0);
  });

  it('isolates schools through RLS and ignores client-supplied school ids', async () => {
    const a = await withTenant({ schoolId: SCHOOL_A, actorId: ACTOR, role: 'school_admin' }, (tx) => tx.many<{ label: string }>('select label from harness_probe order by label'), { pool });
    expect(a.map((r) => r.label)).toEqual(['a1', 'a2']);
    const crossRead = await withTenant({ schoolId: SCHOOL_A, actorId: ACTOR, role: 'school_admin' }, (tx) => tx.many('select * from harness_probe where school_id = $1', [SCHOOL_B]), { pool });
    expect(crossRead).toEqual([]);
    await expect(
      withTenant({ schoolId: SCHOOL_A, actorId: ACTOR, role: 'school_admin' }, (tx) => tx.query("insert into harness_probe (school_id, label) values ($1, 'x')", [SCHOOL_B]), { pool }),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('returns zero tenant rows for platform and system contexts', async () => {
    expect(await withPlatform({ actorId: ACTOR }, (tx) => tx.many('select * from harness_probe'), { pool })).toEqual([]);
    expect(await withSystem((tx) => tx.many('select * from harness_probe'), { pool })).toEqual([]);
    const ctx = await withSystem((tx) => tx.one(settings), { pool });
    expect(ctx).toMatchObject({ school: '', actor: '', role: 'system' });
    expect(await withSchoolSystem(SCHOOL_B, (tx) => tx.many<{ label: string }>('select label from harness_probe'), { pool })).toEqual([{ label: 'b1' }]);
  });

  it('enforces READ ONLY transactions', async () => {
    await expect(
      withTenant({ schoolId: SCHOOL_A, actorId: ACTOR, role: 'school_admin' }, (tx) => tx.query("insert into harness_probe (school_id, label) values ($1, 'ro')", [SCHOOL_A]), { pool, readOnly: true }),
    ).rejects.toMatchObject({ code: '25006' });
  });

  it('rejects malformed context values before touching the database', async () => {
    await expect(withTenant({ schoolId: "x' or 1=1", actorId: null, role: 'system' }, async () => 1, { pool })).rejects.toThrow(TypeError);
    await expect(withTenant({ schoolId: null, actorId: 'nope', role: 'system' }, async () => 1, { pool })).rejects.toThrow(TypeError);
  });

  it('retries serialization failures when maxRetries is set', async () => {
    let calls = 0;
    const result = await withTenant(
      { schoolId: SCHOOL_A, actorId: ACTOR, role: 'school_admin' },
      async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('could not serialize'), { code: '40001', severity: 'ERROR' });
        return 'ok';
      },
      { pool, maxRetries: 2 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('exposes one/maybeOne/many helpers', async () => {
    await withTenant({ schoolId: SCHOOL_A, actorId: ACTOR, role: 'school_admin' }, async (tx) => {
      expect(await tx.maybeOne("select label from harness_probe where label = 'zzz'")).toBeNull();
      await expect(tx.one("select label from harness_probe where label = 'zzz'")).rejects.toThrow('Expected one row');
      expect(tx.ctx).toEqual({ schoolId: SCHOOL_A, actorId: ACTOR, role: 'school_admin' });
    }, { pool, readOnly: true });
  });
});
