// Migration runner on a throw-away database (<testdb>_migrate): ordering, idempotency, checksum
// immutability, concurrent runners (advisory lock), file-name/transaction guards, status.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import config, { type DbConnection } from '../src/config/index.js';
import { replaceDatabaseInUrl } from '../src/config/db.js';
import { assertMigrationsApplied, loadMigrations, migrate, MigrationError, migrationStatus } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { maintenanceConnection } from './helpers/db.js';

const owner = config.db.owner!;
const dbName = `${owner.database}_migrate`;
const conn: DbConnection = owner.connectionString
  ? { ...owner, connectionString: replaceDatabaseInUrl(owner.connectionString, dbName), database: dbName }
  : { ...owner, database: dbName };
let dir: string;

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client(maintenanceConnection(owner));
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function write(name: string, sql: string) {
  await fs.writeFile(path.join(dir, name), sql);
}

beforeAll(async () => {
  await admin(async (c) => {
    await c.query(`drop database if exists ${c.escapeIdentifier(dbName)} with (force)`);
    await c.query(`create database ${c.escapeIdentifier(dbName)}`);
  });
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wimb-migrations-'));
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
  await admin((c) => c.query(`drop database if exists ${c.escapeIdentifier(dbName)} with (force)`));
});

describe('migration runner', () => {
  it('treats a missing or empty directory as "no migrations"', async () => {
    expect(await loadMigrations(path.join(dir, 'missing'))).toEqual([]);
    expect(await migrate({ conn, dir })).toEqual({ applied: [], alreadyApplied: 0 });
  });

  it('applies files in order, each once, and records checksums', async () => {
    await write('001_first.sql', 'create table t1 (id int primary key);');
    await write('002_second.sql', 'insert into t1 values (1), (2);');
    expect((await migrate({ conn, dir })).applied).toEqual(['001_first', '002_second']);
    expect(await migrate({ conn, dir })).toEqual({ applied: [], alreadyApplied: 2 });
    const status = await migrationStatus({ conn, dir });
    expect(status.map((s) => [s.id, s.status])).toEqual([
      ['001_first', 'applied'],
      ['002_second', 'applied'],
    ]);
    await expect(assertMigrationsApplied({ conn, dir })).resolves.toHaveLength(2);
  });

  it('serialises concurrent runners with the advisory lock', async () => {
    await write('003_third.sql', 'create table t3 (id int); select pg_sleep(0.2);');
    const results = await Promise.all([migrate({ conn, dir }), migrate({ conn, dir }), migrate({ conn, dir })]);
    expect(results.flatMap((r) => r.applied)).toEqual(['003_third']);
  });

  it('rolls back a failing file completely and reports its line', async () => {
    await write('004_broken.sql', 'create table t4 (id int);\nselect * from no_such_table;');
    const err = await migrate({ conn, dir }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MigrationError);
    expect((err as Error).message).toMatch(/004_broken\.sql \(line 2\)/);
    const pool = createPool(conn, { max: 1 });
    try {
      expect((await pool.query("select to_regclass('t4') as t")).rows[0].t).toBeNull();
      expect((await pool.query("select count(*)::int as n from schema_migrations where id = '004_broken'")).rows[0].n).toBe(0);
    } finally {
      await pool.end();
    }
    await expect(assertMigrationsApplied({ conn, dir })).rejects.toThrow(/004_broken \(pending\)/);
    await fs.rm(path.join(dir, '004_broken.sql'));
  });

  it('refuses modified applied files', async () => {
    await write('001_first.sql', 'create table t1 (id int primary key); -- edited');
    await expect(migrate({ conn, dir })).rejects.toThrow(/Checksum mismatch for applied migration 001_first/);
    expect((await migrationStatus({ conn, dir })).find((s) => s.id === '001_first')?.status).toBe('checksum_mismatch');
    await write('001_first.sql', 'create table t1 (id int primary key);');
  });

  it('rejects bad names, duplicate numbers, transaction control and CONCURRENTLY', async () => {
    const bad = await fs.mkdtemp(path.join(os.tmpdir(), 'wimb-bad-'));
    try {
      await fs.writeFile(path.join(bad, '1_x.sql'), 'select 1;');
      await expect(loadMigrations(bad)).rejects.toThrow(/Invalid migration file name/);
      await fs.rm(path.join(bad, '1_x.sql'));
      await fs.writeFile(path.join(bad, '005_a.sql'), 'select 1;');
      await fs.writeFile(path.join(bad, '005_b.sql'), 'select 1;');
      await expect(loadMigrations(bad)).rejects.toThrow(/Duplicate migration number 005/);
      await fs.rm(path.join(bad, '005_b.sql'));
      await fs.writeFile(path.join(bad, '006_tx.sql'), 'begin;\nselect 1;\ncommit;');
      await expect(loadMigrations(bad)).rejects.toThrow(/transaction control/);
      await fs.rm(path.join(bad, '006_tx.sql'));
      await fs.writeFile(path.join(bad, '007_idx.sql'), 'create index concurrently i on t (x);');
      await expect(loadMigrations(bad)).rejects.toThrow(/CONCURRENTLY/);
    } finally {
      await fs.rm(bad, { recursive: true, force: true });
    }
  });

  it('reports applied ids whose file disappeared as missing_file (not a boot blocker)', async () => {
    await fs.rm(path.join(dir, '003_third.sql'));
    const status = await migrationStatus({ conn, dir });
    expect(status.find((s) => s.id === '003_third')?.status).toBe('missing_file');
    await expect(assertMigrationsApplied({ conn, dir })).resolves.toBeDefined();
  });
});
