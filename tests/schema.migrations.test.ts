// Core migrations on the suite database: idempotent re-run, BP §6 conventions enforced by catalog
// probes (UUID v7 keys, timestamptz, STORED generated columns, composite tenant foreign keys,
// school_id-leading indexes), platform defaults identical to src/db/platformDefaults.ts, and the
// platform seed (super admin with TOTP not enrolled; idempotent).
import { afterAll, describe, expect, it } from 'vitest';
import config from '../src/config/index.js';
import { loadMigrations, migrate, migrationStatus } from '../src/db/migrate.js';
import { getOwnerPool } from '../src/db/pool.js';
import { PLATFORM_SETTING_DEFAULTS } from '../src/db/platformDefaults.js';
import { DEMO_PASSWORD, runSeeds } from '../src/db/seed.js';
import { verifyPassword } from '../src/shared/crypto.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';

afterAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  await closeDb();
});

describe('core migrations', () => {
  it('are all applied, in the core range, and re-running them is a no-op', async () => {
    const files = await loadMigrations();
    expect(files.length).toBeGreaterThanOrEqual(13);
    expect(files.every((m) => Number(m.id.slice(0, 3)) >= 1)).toBe(true);
    expect(await migrate({ pool: getOwnerPool() })).toEqual({ applied: [], alreadyApplied: files.length });
    expect((await migrationStatus({ pool: getOwnerPool() })).every((s) => s.status === 'applied')).toBe(true);
  });

  it('installs the required extensions', async () => {
    const { rows } = await ownerQuery<{ extname: string }>("select extname from pg_extension where extname in ('postgis', 'citext', 'pgcrypto', 'btree_gist') order by 1");
    expect(rows.map((r) => r.extname)).toEqual(['btree_gist', 'citext', 'pgcrypto', 'postgis']);
  });

  it('seeds the platform defaults exactly as src/db/platformDefaults.ts declares them', async () => {
    const { rows } = await ownerQuery<{ key: string; value: unknown; description: string; is_public: boolean }>('select key, value, description, is_public from platform_settings order by key');
    const expected = [...PLATFORM_SETTING_DEFAULTS].sort((a, b) => a.key.localeCompare(b.key)).map((d) => ({ key: d.key, value: d.value, description: d.description, is_public: d.isPublic }));
    expect(rows).toEqual(expected);
  });
});

describe('schema conventions (catalog probes — also guard module migrations)', () => {
  it('uuid primary keys default to uuid_v7() and every timestamp is timestamptz', async () => {
    const pk = await ownerQuery<{ t: string; def: string | null }>(
      `select c.relname as t, pg_get_expr(d.adbin, d.adrelid) as def
         from pg_index i join pg_class c on c.oid = i.indrelid join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a on a.attrelid = c.oid and a.attnum = i.indkey[0] and a.atttypid = 'uuid'::regtype
         left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
        where n.nspname = 'public' and i.indisprimary and i.indnatts = 1 and not c.relispartition`,
    );
    const bad = pk.rows.filter((r) => r.t !== 'school_settings' && r.def !== 'uuid_v7()');
    expect(bad).toEqual([]);
    const ts = await ownerQuery<{ col: string }>(
      `select c.relname || '.' || a.attname as col from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped and a.atttypid = 'timestamp'::regtype`,
    );
    expect(ts.rows).toEqual([]);
  });

  it('generated columns are STORED', async () => {
    const { rows } = await ownerQuery<{ col: string; kind: string }>(
      `select c.relname || '.' || a.attname as col, a.attgenerated as kind from pg_attribute a join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and a.attgenerated <> '' and not c.relispartition order by 1`,
    );
    expect(rows).toEqual([{ col: 'schools.geom', kind: 's' }, { col: 'stops.geom', kind: 's' }]);
  });

  it('foreign keys between tenant tables include school_id (no cross-tenant references possible)', async () => {
    const { rows } = await ownerQuery<{ fk: string }>(
      `select con.conrelid::regclass || ' → ' || con.confrelid::regclass || ' (' || con.conname || ')' as fk
         from pg_constraint con
         join pg_attribute src on src.attrelid = con.conrelid and src.attname = 'school_id'
         join pg_attribute dst on dst.attrelid = con.confrelid and dst.attname = 'school_id'
        where con.contype = 'f' and con.connamespace = 'public'::regnamespace and con.conparentid = 0
          and not (src.attnum = any (con.conkey) and dst.attnum = any (con.confkey))
          and not (con.confrelid = 'stops'::regclass and con.conkey @> array[(select attnum from pg_attribute where attrelid = con.conrelid and attname = 'route_id')])
        order by 1`,
    );
    // sessions.device_id keeps a plain FK for school-less (parent/super admin) sessions next to
    // its composite (school_id, device_id) FK; stops(route_id, id) is checked alongside (school_id, stop_id).
    expect(rows.map((r) => r.fk)).toEqual(['sessions → devices (sessions_device_id_fkey)']);
    const composite = await ownerQuery<{ n: number }>(
      "select count(*)::int as n from pg_constraint where conrelid = 'sessions'::regclass and contype = 'f' and confrelid = 'devices'::regclass and array_length(conkey, 1) = 2",
    );
    expect(composite.rows[0]!.n).toBe(1);
  });

  it('every tenant table has an index whose first column is school_id (list screens, BP §6.3)', async () => {
    const { rows } = await ownerQuery<{ t: string }>(
      `select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a on a.attrelid = c.oid and a.attname = 'school_id'
        where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
          and c.relname not in ('location_points', 'student_parents', 'notification_preferences', 'idempotency_keys')
          and not exists (select 1 from pg_index i where i.indrelid = c.oid and i.indkey[0] = a.attnum)`,
    );
    expect(rows).toEqual([]);
  });
});

describe('platform seed (00_platform)', () => {
  it('creates the super admin (TOTP not enrolled) and missing defaults, idempotently', async () => {
    await ownerQuery("delete from platform_settings where key = 'modules'");
    const first = await runSeeds({ only: '00_' });
    expect(first.ran).toEqual(['00_platform.ts']);
    await runSeeds({ only: '00_' });
    const { rows } = await ownerQuery<{ email: string; totp_enabled: boolean; totp_secret_enc: string | null; password_hash: string; must_change_password: boolean }>(
      'select email, totp_enabled, totp_secret_enc, password_hash, must_change_password from platform_users where email = $1',
      [config.platformAdminEmail],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ totp_enabled: false, totp_secret_enc: null, must_change_password: false });
    expect(await verifyPassword(rows[0]!.password_hash, config.seedDefaultPassword ?? DEMO_PASSWORD)).toBe(true);
    const modules = await ownerQuery<{ value: unknown }>("select value from platform_settings where key = 'modules'");
    expect(modules.rows[0]!.value).toEqual({ push: true, sms: false, whatsapp: false, email: true });
  });
});
