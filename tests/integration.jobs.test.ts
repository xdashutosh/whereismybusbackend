// Integrator regressions — core housekeeping jobs (contract §8, BP §12):
//   session-cleanup        expired/revoked sessions, OTP codes, idempotency records
//   files-staging-cleanup  '<key>.part' staging objects of presigned uploads older than 24 h
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import config from '../src/config/index.js';
import { FILES_STAGING_CLEANUP_JOB, filesStagingCleanup, JOB_DEFINITIONS, SESSION_CLEANUP_JOB, sessionCleanup, STAGING_MAX_AGE_MS } from '../src/jobs/index.js';
import { storage } from '../src/shared/storage.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';

const DAY = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

beforeAll(() => truncateAll({ keep: ['platform_settings'] }));
afterAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  await closeDb();
});

describe('job registry', () => {
  it('registers session-cleanup and files-staging-cleanup next to partition-maintenance', () => {
    const names = JOB_DEFINITIONS.map((d) => d.name);
    expect(names).toEqual(expect.arrayContaining(['partition-maintenance', SESSION_CLEANUP_JOB, FILES_STAGING_CLEANUP_JOB]));
    for (const name of [SESSION_CLEANUP_JOB, FILES_STAGING_CLEANUP_JOB]) expect(JOB_DEFINITIONS.find((d) => d.name === name)?.kind).toBe('cron');
  });
});

describe('session-cleanup', () => {
  it('deletes sessions expired/revoked beyond retention, expired OTPs and idempotency records only', async () => {
    const school = await f.school();
    const admin = await f.user(school.id, { role: 'school_admin', email: `admin-${crypto.randomUUID()}@x.example` });
    const owner = { owner_type: 'user', owner_id: admin.id, school_id: school.id };
    const live = await f.session(owner);
    const recentlyRevoked = await f.session({ ...owner, revoked_at: ago(DAY) });
    const oldExpired = await f.session({ ...owner, expires_at: ago(40 * DAY) });
    const oldRevoked = await f.session({ ...owner, revoked_at: ago(31 * DAY) });
    const freshOtp = await f.otpCode();
    const staleOtp = await f.otpCode({ expires_at: ago(2 * DAY), created_at: ago(2 * DAY) });
    const keepKey = await f.idempotencyKey({ school_id: school.id, actor_id: admin.id, expires_at: new Date(Date.now() + DAY).toISOString() });
    const dropKey = await f.idempotencyKey({ school_id: school.id, actor_id: admin.id, expires_at: ago(1000) });

    const result = await sessionCleanup();
    expect(result).toEqual({ sessionsDeleted: 2, otpsDeleted: 1, idempotencyDeleted: 1 });
    const left = async (table: string, ids: string[]) =>
      (await ownerQuery<{ id: string }>(`select id from ${table} where id = any($1::uuid[]) order by id`, [ids])).rows.map((r) => r.id).sort();
    expect(await left('sessions', [live.id, recentlyRevoked.id, oldExpired.id, oldRevoked.id])).toEqual([live.id, recentlyRevoked.id].sort());
    expect(await left('otp_codes', [freshOtp.id, staleOtp.id])).toEqual([freshOtp.id]);
    expect(await left('idempotency_keys', [keepKey.id, dropKey.id])).toEqual([keepKey.id]);
    // Idempotent.
    expect(await sessionCleanup()).toEqual({ sessionsDeleted: 0, otpsDeleted: 0, idempotencyDeleted: 0 });
  });
});

describe('files-staging-cleanup', () => {
  const root = path.resolve(config.storage.localDir);
  const schoolId = crypto.randomUUID();
  const keyOf = (name: string) => `${storage.keyPrefix}schools/${schoolId}/odometer/${crypto.randomUUID()}/${name}`;
  async function put(key: string, ageMs: number) {
    await storage.putObject({ key, body: Buffer.from('x'), contentType: 'image/jpeg' });
    const when = new Date(Date.now() - ageMs);
    await fs.utimes(path.join(root, key), when, when);
  }
  const exists = async (key: string) => (await storage.headObject(key)) !== null;

  it('deletes only staging objects older than 24 h', async () => {
    const stalePart = keyOf('a.jpg.part');
    const freshPart = keyOf('b.jpg.part');
    const staleFinal = keyOf('c.jpg');
    await put(stalePart, STAGING_MAX_AGE_MS + 60_000);
    await put(freshPart, 60_000);
    await put(staleFinal, 10 * DAY);

    const result = await filesStagingCleanup();
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(result.truncated).toBe(false);
    expect(await exists(stalePart)).toBe(false);
    expect(await exists(freshPart)).toBe(true);
    expect(await exists(staleFinal)).toBe(true);
    await storage.deleteObject(freshPart);
    await storage.deleteObject(staleFinal);
  });

  it('listObjects refuses prefixes outside S3_KEY_PREFIX', async () => {
    const it = storage.listObjects('elsewhere/');
    await expect(it[Symbol.asyncIterator]().next()).rejects.toThrow(/outside/);
    const up = storage.listObjects(`${storage.keyPrefix}../`);
    await expect(up[Symbol.asyncIterator]().next()).rejects.toThrow(/outside/);
  });
});
