// npm run db:bootstrap (src/db/bootstrap.ts): platform defaults + first Super Admin for production,
// idempotent, never touching an existing admin, no demo data; the created admin must change the
// password and enrol TOTP at first sign-in.
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import config from '../src/config/index.js';
import { BootstrapError, initialPasswordIssue, runBootstrap } from '../src/db/bootstrap.js';
import { PLATFORM_SETTING_DEFAULTS } from '../src/db/platformDefaults.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import { buildApp, type TestApp } from './helpers/authApp.js';

const EMAIL = 'founder@wimb.example';
const INITIAL = 'Initial#Pass42';
let t: TestApp;

const silent = { info() {}, warn() {}, error() {}, child() { return silent; } } as never;
const run = (o: Parameters<typeof runBootstrap>[0] = {}) => runBootstrap({ conn: config.db.owner, email: EMAIL, initialPassword: INITIAL, logger: silent, ...o });
const admins = () => ownerQuery<{ email: string; password_hash: string; must_change_password: boolean; totp_enabled: boolean; totp_secret_enc: string | null }>('select email::text, password_hash, must_change_password, totp_enabled, totp_secret_enc from platform_users order by email');
const tenantRows = async () => (await ownerQuery<{ n: number }>('select (select count(*) from schools) + (select count(*) from users) + (select count(*) from buses) as n')).rows[0]!.n;

beforeAll(() => {
  t = buildApp();
});
beforeEach(async () => {
  await truncateAll();
});
afterAll(closeDb);

describe('db:bootstrap', () => {
  it('creates every platform default and the Super Admin (forced password change, no TOTP), and no demo data', async () => {
    const r = await run();
    expect(r).toMatchObject({ settingsInserted: PLATFORM_SETTING_DEFAULTS.length, superAdmin: 'created' });
    expect((await ownerQuery<{ n: number }>('select count(*)::int as n from platform_settings')).rows[0]!.n).toBe(PLATFORM_SETTING_DEFAULTS.length);
    const [a] = (await admins()).rows;
    expect(a).toMatchObject({ email: EMAIL, must_change_password: true, totp_enabled: false, totp_secret_enc: null });
    expect(a!.password_hash).not.toContain(INITIAL);
    expect(Number(await tenantRows())).toBe(0);
  });

  it('is idempotent and never overwrites an existing admin, its password or its TOTP', async () => {
    await run();
    await ownerQuery("update platform_users set password_hash = 'kept-hash', must_change_password = false, totp_enabled = true, totp_secret_enc = 'enc' where email = $1", [EMAIL]);
    await ownerQuery("update platform_settings set value = '99'::jsonb where key = 'location.stale_after_s'");
    await ownerQuery("delete from platform_settings where key = 'features'");
    const again = await run({ initialPassword: 'Another#Pass77' });
    expect(again.superAdmin).toBe('exists');
    expect(again.settingsInserted).toBe(1);
    expect(again.warnings.join(' ')).toMatch(/PLATFORM_ADMIN_INITIAL_PASSWORD is still set/);
    expect((await admins()).rows).toEqual([{ email: EMAIL, password_hash: 'kept-hash', must_change_password: false, totp_enabled: true, totp_secret_enc: 'enc' }]);
    expect((await ownerQuery<{ value: unknown }>("select value from platform_settings where key = 'location.stale_after_s'")).rows[0]!.value).toBe(99);
    // e-mail matching is case-insensitive (citext): no second admin
    expect((await run({ email: EMAIL.toUpperCase() })).superAdmin).toBe('exists');
    expect((await admins()).rows).toHaveLength(1);
  });

  it('requires the initial password only while no Super Admin exists', async () => {
    await expect(run({ initialPassword: null })).rejects.toThrow(/set PLATFORM_ADMIN_INITIAL_PASSWORD/);
    expect((await admins()).rows).toHaveLength(0);
    expect((await ownerQuery<{ n: number }>('select count(*)::int as n from platform_settings')).rows[0]!.n).toBe(0); // rolled back
    await run();
    const r = await run({ initialPassword: null });
    expect(r.superAdmin).toBe('exists');
    const other = await run({ email: 'second@wimb.example', initialPassword: null });
    expect(other.superAdmin).toBe('skipped');
    expect(other.warnings.join(' ')).toMatch(/no Super Admin was created/);
    expect((await admins()).rows.map((x) => x.email)).toEqual([EMAIL]);
  });

  it('refuses a weak initial password and the placeholder e-mail in production (no secrets in messages)', async () => {
    expect(initialPasswordIssue('short1')).toMatch(/at least 8/);
    expect(initialPasswordIssue('lettersonly')).toMatch(/letter and one digit/);
    expect(initialPasswordIssue(INITIAL)).toBeNull();
    const weak = await run({ initialPassword: 'password' }).catch((e: unknown) => e as Error);
    expect(weak).toBeInstanceOf(BootstrapError);
    expect((weak as Error).message).not.toContain('password"');
    await expect(run({ email: 'superadmin@example.com', isProduction: true })).rejects.toThrow(/PLATFORM_ADMIN_EMAIL is not set/);
    expect((await admins()).rows).toHaveLength(0);
  });

  it('moves an unclaimed placeholder Super Admin to the real PLATFORM_ADMIN_EMAIL instead of creating a second one', async () => {
    await run({ email: 'superadmin@example.com' }); // bootstrapped before the real e-mail was known (non-production)
    const r = await run({ initialPassword: null });
    expect(r.superAdmin).toBe('claimed');
    expect((await admins()).rows).toEqual([expect.objectContaining({ email: EMAIL, must_change_password: true, totp_enabled: false })]);
    const res = await request(t.app).post('/api/v1/auth/platform/login').send({ email: EMAIL, password: INITIAL });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('totp_enrollment_required');
    // idempotent afterwards, and a different e-mail never renames the (now real) account again
    expect((await run({ initialPassword: null })).superAdmin).toBe('exists');
    expect((await run({ email: 'other@wimb.example', initialPassword: null })).superAdmin).toBe('skipped');
    expect((await admins()).rows.map((x) => x.email)).toEqual([EMAIL]);
  });

  it('a claimed placeholder takes PLATFORM_ADMIN_INITIAL_PASSWORD when it is set', async () => {
    await run({ email: 'superadmin@example.com', initialPassword: 'Placeholder#Pass1' });
    const r = await run({ initialPassword: INITIAL });
    expect(r.superAdmin).toBe('claimed');
    expect(r.warnings.join(' ')).toMatch(/remove PLATFORM_ADMIN_INITIAL_PASSWORD/);
    expect((await request(t.app).post('/api/v1/auth/platform/login').send({ email: EMAIL, password: INITIAL })).status).toBe(200);
    expect((await request(t.app).post('/api/v1/auth/platform/login').send({ email: EMAIL, password: 'Placeholder#Pass1' })).status).toBe(401);
    expect((await run({ email: 'x@wimb.example', initialPassword: null })).superAdmin).toBe('skipped'); // not claimable any more
    expect((await admins()).rows.map((x) => x.email)).toEqual([EMAIL]);
  });

  it('never renames a placeholder account that is already in use, or when several admins exist', async () => {
    await run({ email: 'superadmin@example.com' });
    await ownerQuery("update platform_users set must_change_password = false, totp_enabled = true, totp_secret_enc = 'enc' where email = 'superadmin@example.com'");
    expect((await run({ initialPassword: null })).superAdmin).toBe('skipped');
    expect((await admins()).rows.map((x) => x.email)).toEqual(['superadmin@example.com']);
    await truncateAll();
    await run({ email: 'second@wimb.example' });
    await run({ email: 'superadmin@example.com' }); // the placeholder e-mail itself never claims anything
    const r = await run({ email: 'third@wimb.example', initialPassword: null });
    expect(r.superAdmin).toBe('skipped');
    expect((await admins()).rows.map((x) => x.email)).toEqual(['second@wimb.example', 'superadmin@example.com']);
  });

  it('the bootstrapped admin signs in with the initial password and is sent to the password change / TOTP enrolment', async () => {
    await run();
    const res = await request(t.app).post('/api/v1/auth/platform/login').send({ email: EMAIL, password: INITIAL });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('totp_enrollment_required');
    expect((await request(t.app).post('/api/v1/auth/platform/login').send({ email: EMAIL, password: 'Wrong#Pass42' })).status).toBe(401);
  });
});
