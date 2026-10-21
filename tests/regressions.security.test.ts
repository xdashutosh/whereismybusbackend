// Regression suite — tenancy & security (contract §3/§4/§6, BP §4.3/§5.4/§12). Each test pins a
// defect found by an attacker-lens verification of the v2 foundation and fixed since:
//   1. Sign-in lockout reserves the attempt atomically before the credential is checked, so a
//      parallel burst evaluates at most N passwords / PINs (BP §5.4).
//   2. The failures-only rate limiter counts atomically up front (refund on success).
//   3. Presigned upload URLs target a staging key; replaying one after POST /files/:id/complete
//      cannot alter the validated object.
//   4. A school admin cannot rewrite the global identity of a parent shared with another school.
//   5. db:setup-roles refuses an app role that inherits privileges through role membership.
//   6. Known and unknown identifiers share one lockout window (no account enumeration).
//   7. A parent cannot move its global identity to another phone number.
import crypto from 'node:crypto';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { buildApp, DEVICE, loginSchoolAdmin, PASSWORD, schoolAdmin, staffUser, type TestApp } from './helpers/authApp.js';

let t: TestApp;
let school: f.Row;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const pathOf = (url: string) => {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
};

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  school = await f.school({ code: 'VERIFY-SEC', name: 'Verify School' });
});
afterAll(closeDb);

describe('lockout race (BP §5.4 "lock after N failures")', () => {
  it('evaluates at most 5 wrong passwords for one account even when they arrive in parallel', async () => {
    t = buildApp({ rateLimitsEnabled: true });
    const admin = await schoolAdmin(school.id);
    const burst = await Promise.all(
      Array.from({ length: 30 }, (_, i) => request(t.app).post('/api/v1/auth/school/login').send({ email: admin.email, password: `Wrong#${i}guess` })),
    );
    const evaluated = burst.filter((r) => r.status === 401).length;
    const audited = await ownerQuery("select count(*)::int as n from audit_logs where entity_id = $1 and action in ('auth.login_failed', 'auth.account_locked')", [admin.id]);
    // Correct behaviour: the 6th+ attempt is refused (429) without checking the password.
    expect({ evaluated, audited: audited.rows[0]!.n }).toEqual({ evaluated: 5, audited: 5 });
  });

  it('a parallel PIN burst cannot test more than 5 PINs per lockout window (4-digit PIN space)', async () => {
    t = buildApp({ rateLimitsEnabled: true });
    const driver = await staffUser(school.id, 'driver');
    const pins = Array.from({ length: 40 }, (_, i) => String(1000 + i));
    const burst = await Promise.all(
      pins.map((pin) => request(t.app).post('/api/v1/auth/staff/login').send({ schoolCode: school.code, phone: driver.phone, pin, device: DEVICE })),
    );
    const evaluated = burst.filter((r) => r.status === 401).length;
    expect(evaluated).toBeLessThanOrEqual(5);
  });

  it('the correct password inside a parallel burst does not get through after the lock threshold', async () => {
    t = buildApp({ rateLimitsEnabled: false }); // isolate the DB lockout from the HTTP limiter
    const admin = await schoolAdmin(school.id);
    // 5 sequential failures would lock the account; here 25 wrong guesses + the right one race.
    const bodies = [...Array.from({ length: 25 }, (_, i) => ({ email: admin.email, password: `Nope#${i}x` })), { email: admin.email, password: PASSWORD }];
    const burst = await Promise.all(bodies.map((b) => request(t.app).post('/api/v1/auth/school/login').send(b)));
    const wrongEvaluated = burst.slice(0, 25).filter((r) => r.status === 401).length;
    expect(wrongEvaluated).toBeLessThanOrEqual(5);
  });
});

describe('failures-only rate limiter race (login limiter: 10 failures / 15 min per IP+identifier)', () => {
  it('does not let a parallel burst exceed the limiter budget for an unknown identifier', async () => {
    t = buildApp({ rateLimitsEnabled: true });
    const burst = await Promise.all(
      Array.from({ length: 30 }, (_, i) => request(t.app).post('/api/v1/auth/school/login').send({ email: 'ghost-race@nowhere.test', password: `Wrong#${i}x` })),
    );
    const notLimited = burst.filter((r) => !(r.status === 429)).length;
    // Unknown-account lockout (5) or the limiter (10) must cap the evaluated attempts.
    expect(notLimited).toBeLessThanOrEqual(10);
  });
});

describe('presigned upload URL reuse after complete (contract §2 Files: magic bytes / sha256 / EXIF strip)', () => {
  it('refuses a second PUT to the upload URL once the file has been validated', async () => {
    t = buildApp();
    const admin = await schoolAdmin(school.id);
    const token = (await loginSchoolAdmin(t.app, String(admin.email))).accessToken;
    const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#ff0000' } }).png().toBuffer();
    const sha = crypto.createHash('sha256').update(png).digest('hex');
    const created = await request(t.app)
      .post('/api/v1/files/upload-url')
      .set(auth(token))
      .send({ category: 'school_logo', contentType: 'image/png', sizeBytes: png.length, sha256: sha });
    expect(created.status).toBe(201);
    const { file, upload } = created.body.data as { file: { id: string }; upload: { url: string } };
    expect((await request(t.app).put(pathOf(upload.url)).set('Content-Type', 'image/png').send(png)).status).toBe(200);
    const done = await request(t.app).post(`/api/v1/files/${file.id}/complete`).set(auth(token)).send({});
    expect(done.status).toBe(200);
    expect(done.body.data.status).toBe('uploaded');

    // Attacker (or a buggy client) replays the still-valid URL with arbitrary bytes of the same length.
    const payload = Buffer.alloc(png.length, 0x41);
    const replay = await request(t.app).put(pathOf(upload.url)).set('Content-Type', 'image/png').send(payload);
    const { rows } = await ownerQuery<{ key: string; sha256: string }>('select key, sha256 from files where id = $1', [file.id]);
    const url = await request(t.app).get(`/api/v1/files/${file.id}/url`).set(auth(token));
    const served = await request(t.app)
      .get(pathOf(url.body.data.url as string))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    const servedSha = crypto.createHash('sha256').update(served.body as Buffer).digest('hex');
    // Correct behaviour: the replay is refused and the served bytes still match files.sha256.
    expect(replay.status).not.toBe(200);
    expect(servedSha).toBe(rows[0]!.sha256);
  });
});

describe('parent identity: a school cannot take over a parent shared with another school (contract §4)', () => {
  it("a school admin cannot rewrite the global credentials of a parent who belongs to another school", async () => {
    const { withTenant } = await import('../src/db/tenant.js');
    const { hashPassword } = await import('../src/shared/crypto.js');
    t = buildApp();
    const fx = await f.twoSchoolFixture();
    const victim = fx.b.parent; // linked ONLY in school B
    const adminA = f.contexts.schoolAdmin(fx.a.school.id, fx.a.admin.id);
    const attackerHash = await hashPassword(PASSWORD);
    let updated: number;
    try {
      updated = await withTenant(adminA, async (tx) => {
        // ensure_parent_account hands out the existing global id for any phone the admin knows …
        const id = (await tx.one<{ id: string }>('select ensure_parent_account($1, $2) as id', [victim.phone, 'Anyone'])).id;
        expect(id).toBe(victim.id);
        // … school A links it to itself and then rewrites the global credentials (or the phone).
        await tx.query('insert into school_parents (school_id, parent_account_id, full_name) values ($1, $2, $3)', [fx.a.school.id, id, 'Linked by A']);
        const r = await tx.query('update parent_accounts set password_hash = $2 where id = $1', [id, attackerHash]);
        return r.rowCount ?? 0;
      });
    } catch {
      updated = 0;
    }
    // The attacker now signs in as the victim and reads school B's child.
    const login = await request(t.app).post('/api/v1/auth/parent/password-login').send({ phone: victim.phone, password: PASSWORD });
    let schoolBChildren: string[] = [];
    if (login.status === 200) {
      const me = await request(t.app).get('/api/v1/auth/me').set(auth(login.body.data.accessToken as string));
      const schools = me.body.data.schools as { school: { id: string }; children: { id: string }[] }[];
      schoolBChildren = schools.filter((s) => s.school.id === fx.b.school.id).flatMap((s) => s.children.map((c) => c.id));
    }
    expect({ updated, loginStatus: login.status, schoolBChildren }).toEqual({ updated: 0, loginStatus: 401, schoolBChildren: [] });
  });
});

describe('db:setup-roles and inherited privileges (contract §3: audit_logs INSERT/SELECT only)', () => {
  it('refuses (or neutralises) an app role that inherits write privileges through role membership', async () => {
    const { getOwnerPool } = await import('../src/db/pool.js');
    const { setupAppRole } = await import('../src/db/setupRoles.js');
    const role = `wimb_regress_member_${crypto.randomBytes(3).toString('hex')}`;
    const owner = getOwnerPool();
    await owner.query(`create role ${role} login nobypassrls password 'regress-only-local'`);
    try {
      // e.g. a role created in a hosted console that is a member of a broad predefined role.
      await owner.query(`grant pg_write_all_data to ${role}`);
      let refused = false;
      try {
        await setupAppRole({ pool: owner, appUser: role });
      } catch {
        refused = true;
      }
      const { rows } = await owner.query<{ upd: boolean; del: boolean }>(
        "select has_table_privilege($1, 'public.audit_logs', 'UPDATE') as upd, has_table_privilege($1, 'public.audit_logs', 'DELETE') as del",
        [role],
      );
      expect(refused || (!rows[0]!.upd && !rows[0]!.del)).toBe(true);
    } finally {
      await owner.query(`revoke pg_write_all_data from ${role}`);
      await owner.query(`drop owned by ${role}`);
      await owner.query(`drop role ${role}`);
    }
  });
});

describe('lockout semantics for unknown identifiers (no account enumeration)', () => {
  it('a known and an unknown e-mail behave the same once the 15-minute window of the first failures has passed', async () => {
    t = buildApp();
    const admin = await schoolAdmin(school.id);
    const unknown = 'nobody-enum@nowhere.test';
    const attempt = (email: string, i: number) => request(t.app).post('/api/v1/auth/school/login').send({ email, password: `Wrong#${i}enum` });
    for (let i = 0; i < 4; i += 1) {
      expect((await attempt(String(admin.email), i)).status).toBe(401);
      expect((await attempt(unknown, i)).status).toBe(401);
    }
    // 16 minutes later: the KV window of the unknown identifier has expired (simulated by removing
    // the expired keys, exactly what the Redis TTL does); the known account row keeps its count.
    await t.kv.deleteByPrefix('auth-unknown:');
    expect((await attempt(String(admin.email), 5)).status).toBe(401);
    expect((await attempt(unknown, 5)).status).toBe(401);
    const known6 = await attempt(String(admin.email), 6);
    const unknown6 = await attempt(unknown, 6);
    expect(known6.status).toBe(unknown6.status);
  });
});

describe('parent identity: a parent cannot claim a phone number before its owner is registered', () => {
  it('a parent cannot move its global identity to another phone number through RLS', async () => {
    const { withTenant } = await import('../src/db/tenant.js');
    const fx = await f.twoSchoolFixture();
    const attacker = fx.a.parent;
    const futureVictimPhone = f.uniquePhone(); // a parent school B will register tomorrow
    let moved: number;
    try {
      moved = await withTenant(f.contexts.parent(attacker.id, null), async (tx) =>
        (await tx.query('update parent_accounts set phone = $2 where id = $1', [attacker.id, futureVictimPhone])).rowCount ?? 0,
      );
    } catch {
      moved = 0;
    }
    // School B registers the real owner of that number: it receives the attacker's identity.
    const registered = await withTenant(f.contexts.schoolAdmin(fx.b.school.id, fx.b.admin.id), async (tx) =>
      (await tx.one<{ id: string }>('select ensure_parent_account($1, $2) as id', [futureVictimPhone, 'Real Owner'])).id,
    );
    expect({ moved, registeredIsAttacker: registered === attacker.id }).toEqual({ moved: 0, registeredIsAttacker: false });
  });
});

describe('parent identity: column guard and the school phone-correction flow (migration 014)', () => {
  it('a parent may change its own display name and language but not its phone or active flag', async () => {
    const { withTenant } = await import('../src/db/tenant.js');
    const p = await f.parentAccount({ display_name: 'Before' });
    const ctx = f.contexts.parent(p.id, null);
    const n = await withTenant(ctx, async (tx) => (await tx.query("update parent_accounts set display_name = 'After', preferred_language = 'hi' where id = $1", [p.id])).rowCount);
    expect(n).toBe(1);
    await expect(withTenant(ctx, (tx) => tx.query('update parent_accounts set is_active = false where id = $1', [p.id]))).rejects.toMatchObject({ code: '42501' });
    await expect(withTenant(ctx, (tx) => tx.query('update parent_accounts set phone = $2 where id = $1', [p.id, f.uniquePhone()]))).rejects.toMatchObject({ code: '42501' });
    const row = (await ownerQuery<{ display_name: string; preferred_language: string; is_active: boolean; phone: string }>('select display_name, preferred_language, is_active, phone from parent_accounts where id = $1', [p.id])).rows[0]!;
    expect(row).toEqual({ display_name: 'After', preferred_language: 'hi', is_active: true, phone: p.phone });
  });

  it('school admins have no UPDATE path on parent_accounts, even for parents linked only to them', async () => {
    const { withTenant } = await import('../src/db/tenant.js');
    const s = await f.school();
    const p = await f.parentAccount();
    await f.schoolParent(s.id, p.id);
    const n = await withTenant(f.contexts.schoolAdmin(s.id), async (tx) => (await tx.query("update parent_accounts set display_name = 'Renamed' where id = $1", [p.id])).rowCount);
    expect(n).toBe(0);
    // …but they still read the parents linked to their school (phone, name).
    const seen = await withTenant(f.contexts.schoolAdmin(s.id), (tx) => tx.maybeOne<{ phone: string }>('select phone from parent_accounts where id = $1', [p.id]), { readOnly: true });
    expect(seen?.phone).toBe(p.phone);
  });

  it('school_update_parent_phone corrects the phone of a parent that belongs to the caller school only', async () => {
    const { withTenant } = await import('../src/db/tenant.js');
    const { toAppError } = await import('../src/middleware/errorHandler.js');
    const a = await f.school();
    const b = await f.school();
    const own = await f.parentAccount();
    await f.schoolParent(a.id, own.id);
    const shared = await f.parentAccount();
    await f.schoolParent(a.id, shared.id);
    await f.schoolParent(b.id, shared.id);
    const foreign = await f.parentAccount();
    await f.schoolParent(b.id, foreign.id);
    const call = (ctx: Parameters<typeof withTenant>[0], id: string, phone: string) =>
      withTenant(ctx, (tx) => tx.one<{ id: string }>('select school_update_parent_phone($1, $2) as id', [id, phone]));
    const errOf = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => toAppError(e).code);

    const newPhone = f.uniquePhone();
    expect((await call(f.contexts.schoolAdmin(a.id), own.id, newPhone)).id).toBe(own.id);
    expect((await ownerQuery<{ phone: string }>('select phone from parent_accounts where id = $1', [own.id])).rows[0]!.phone).toBe(newPhone);
    expect(await errOf(call(f.contexts.schoolAdmin(a.id), shared.id, f.uniquePhone()))).toBe('INVALID_STATE');
    expect(await errOf(call(f.contexts.schoolAdmin(a.id), foreign.id, f.uniquePhone()))).toBe('NOT_FOUND');
    expect(await errOf(call(f.contexts.schoolAdmin(a.id), own.id, String(foreign.phone)))).toBe('DUPLICATE');
    expect(await errOf(call(f.contexts.parent(own.id, null), own.id, f.uniquePhone()))).toBe('FORBIDDEN');
  });
});

describe('lockout: the account row is authoritative over the KV lock', () => {
  it('a super admin password reset unlocks a locked school admin immediately', async () => {
    const { withPlatform } = await import('../src/db/tenant.js');
    const { hashPassword } = await import('../src/shared/crypto.js');
    t = buildApp();
    const admin = await schoolAdmin(school.id);
    const login = (password: string) => request(t.app).post('/api/v1/auth/school/login').send({ email: admin.email, password });
    for (let i = 0; i < 5; i += 1) expect((await login(`Wrong#${i}reset`)).status).toBe(401);
    expect((await login(PASSWORD)).status).toBe(429);
    const temporary = 'Temp#Reset42';
    const temporaryHash = await hashPassword(temporary);
    await withPlatform({ actorId: null }, (tx) => tx.query('select platform_reset_school_admin_password($1, $2, $3)', [school.id, admin.id, temporaryHash]));
    const after = await login(temporary);
    expect(after.status).toBe(200);
    expect(after.body.data.mustChangePassword).toBe(true);
  });
});
