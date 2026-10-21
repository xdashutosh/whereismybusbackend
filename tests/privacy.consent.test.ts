// Parent consent (BP §16 parental consent flow; migration 901 parent_consents, privacy module):
// required version per school (platform value or school override), accept with X-School-Id,
// re-consent after a version bump, consent state in the sign-in profile, audit, and tenant
// isolation / RLS of the consent records (parents read only their own, nobody writes directly).
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/tenant.js';
import { clearLegalCaches } from '../src/modules/privacy/index.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { buildApp, loginParent, loginSchoolAdmin, schoolAdmin, type TestApp, type Tokens } from './helpers/authApp.js';

let t: TestApp;
let fx: f.TwoSchoolFixture;
let parentA: Tokens; // child in school A only
let shared: Tokens; // children in A and B
let adminA: string;

const api = (p: string) => `/api/v1${p}`;
const bearer = (token: string, schoolId?: string) => ({ Authorization: `Bearer ${token}`, ...(schoolId ? { 'X-School-Id': schoolId } : {}) });
const accept = (tok: Tokens, schoolId: string | null, version: string) => {
  const r = request(t.app).post(api('/parent/consent')).set(bearer(tok.accessToken, schoolId ?? undefined)).set({ 'X-App-Name': 'parent_app', 'X-App-Version': '1.4.0', 'User-Agent': 'ParentApp/1.4.0' });
  return r.send({ version });
};
const status = (tok: Tokens) => request(t.app).get(api('/parent/consent')).set(bearer(tok.accessToken));

async function resetLegal() {
  await ownerQuery(`update platform_settings set value = '"1"' where key = 'legal.consent_version'`);
  await ownerQuery(`update platform_settings set value = 'null' where key in ('legal.privacy_url', 'legal.terms_url')`);
  await ownerQuery('update school_settings set privacy_policy_url = null, terms_url = null, consent_version = null');
  await ownerQuery('delete from parent_consents');
  clearLegalCaches();
}

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  fx = await f.twoSchoolFixture();
  await ownerQuery("update schools set name = 'Alpha School' where id = $1", [fx.a.school.id]);
  await ownerQuery("update schools set name = 'Beta School' where id = $1", [fx.b.school.id]);
  for (const s of [fx.a.school.id, fx.b.school.id]) await ownerQuery('insert into school_settings (school_id) values ($1) on conflict do nothing', [s]);
  parentA = await loginParent(t, String(fx.a.parent.phone));
  shared = await loginParent(t, String(fx.sharedParent.phone));
  adminA = (await loginSchoolAdmin(t.app, String((await schoolAdmin(fx.a.school.id)).email))).accessToken;
});
beforeEach(resetLegal);
afterAll(async () => {
  await resetLegal();
  await closeDb();
});

describe('GET /parent/consent', () => {
  it('lists every linked school with the required version; consent is required before the first acceptance', async () => {
    const res = await status(shared);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data.consentRequired).toBe(true);
    expect(res.body.data.schools).toEqual([
      { schoolId: fx.a.school.id, schoolName: 'Alpha School', requiredVersion: '1', acceptedVersion: null, acceptedAt: null, consentRequired: true, privacyUrl: null, termsUrl: null },
      { schoolId: fx.b.school.id, schoolName: 'Beta School', requiredVersion: '1', acceptedVersion: null, acceptedAt: null, consentRequired: true, privacyUrl: null, termsUrl: null },
    ]);
    const onlyA = await status(parentA);
    expect(onlyA.body.data.schools.map((s: { schoolId: string }) => s.schoolId)).toEqual([fx.a.school.id]);
  });

  it('is for parents only', async () => {
    expect((await request(t.app).get(api('/parent/consent')).set(bearer(adminA))).status).toBe(403);
    expect((await request(t.app).get(api('/parent/consent'))).status).toBe(401);
  });
});

describe('POST /parent/consent', () => {
  it('records the acceptance per school with app and network details, audited in that school', async () => {
    const res = await accept(shared, fx.a.school.id, '1');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ schoolId: fx.a.school.id, requiredVersion: '1', acceptedVersion: '1', consentRequired: false });
    expect(Date.parse(res.body.data.acceptedAt)).toBeGreaterThan(Date.now() - 60_000);
    const row = (await ownerQuery('select school_id, parent_account_id, version, app_name, app_version, user_agent, ip from parent_consents')).rows;
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ school_id: fx.a.school.id, parent_account_id: fx.sharedParent.id, version: '1', app_name: 'parent_app', app_version: '1.4.0', user_agent: 'ParentApp/1.4.0' });
    const audit = (await ownerQuery("select school_id, actor_type, actor_id, new_values from audit_logs where action = 'privacy.consent_accept'")).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ school_id: fx.a.school.id, actor_type: 'parent_account', actor_id: fx.sharedParent.id, new_values: { version: '1', appName: 'parent_app', appVersion: '1.4.0' } });
    // School B still needs consent.
    const s = await status(shared);
    expect(s.body.data.consentRequired).toBe(true);
    expect(s.body.data.schools.find((x: { schoolId: string }) => x.schoolId === fx.b.school.id).consentRequired).toBe(true);
    expect(s.body.data.schools.find((x: { schoolId: string }) => x.schoolId === fx.a.school.id).consentRequired).toBe(false);
  });

  it('is idempotent (one record, one audit row)', async () => {
    await accept(parentA, fx.a.school.id, '1');
    const again = await accept(parentA, fx.a.school.id, '1');
    expect(again.status).toBe(200);
    expect((await ownerQuery<{ n: number }>('select count(*)::int as n from parent_consents where parent_account_id = $1', [fx.a.parent.id])).rows[0]!.n).toBe(1);
    expect((await ownerQuery<{ n: number }>("select count(*)::int as n from audit_logs where action = 'privacy.consent_accept' and actor_id = $1", [fx.a.parent.id])).rows[0]!.n).toBe(1);
  });

  it('refuses an outdated version with 409 and the required version', async () => {
    await ownerQuery(`update platform_settings set value = '"2026-11"' where key = 'legal.consent_version'`);
    clearLegalCaches();
    const res = await accept(parentA, fx.a.school.id, '1');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'CONFLICT', details: { reason: 'CONSENT_VERSION_CHANGED', requiredVersion: '2026-11' } });
    expect((await ownerQuery<{ n: number }>('select count(*)::int as n from parent_consents')).rows[0]!.n).toBe(0);
  });

  it('validates the body and requires X-School-Id of a school with an active child link', async () => {
    expect((await accept(parentA, fx.a.school.id, 'two words')).status).toBe(400);
    expect((await request(t.app).post(api('/parent/consent')).set(bearer(parentA.accessToken, fx.a.school.id)).send({ version: '1', extra: true })).status).toBe(400);
    expect((await accept(parentA, null, '1')).status).toBe(400);
    const foreign = await accept(parentA, fx.b.school.id, '1');
    expect(foreign.status).toBe(403);
    expect((await request(t.app).post(api('/parent/consent')).set(bearer(adminA, fx.a.school.id)).send({ version: '1' })).status).toBe(403);
    expect((await ownerQuery<{ n: number }>('select count(*)::int as n from parent_consents')).rows[0]!.n).toBe(0);
  });
});

describe('re-consent after a version bump', () => {
  it('a platform version change asks again everywhere; a school override only in that school', async () => {
    await accept(shared, fx.a.school.id, '1');
    await accept(shared, fx.b.school.id, '1');
    expect((await status(shared)).body.data.consentRequired).toBe(false);

    await ownerQuery("update school_settings set consent_version = 'b-2', privacy_policy_url = 'https://beta.example.com/privacy' where school_id = $1", [fx.b.school.id]);
    clearLegalCaches();
    let s = (await status(shared)).body.data;
    expect(s.consentRequired).toBe(true);
    expect(s.schools.find((x: { schoolId: string }) => x.schoolId === fx.a.school.id)).toMatchObject({ consentRequired: false, acceptedVersion: '1' });
    expect(s.schools.find((x: { schoolId: string }) => x.schoolId === fx.b.school.id)).toMatchObject({ consentRequired: true, requiredVersion: 'b-2', acceptedVersion: '1', privacyUrl: 'https://beta.example.com/privacy' });
    const ok = await accept(shared, fx.b.school.id, 'b-2');
    expect(ok.body.data).toMatchObject({ acceptedVersion: 'b-2', consentRequired: false });
    // The record keeps the links in force at acceptance.
    expect((await ownerQuery("select privacy_url from parent_consents where version = 'b-2'")).rows[0]).toEqual({ privacy_url: 'https://beta.example.com/privacy' });

    await ownerQuery(`update platform_settings set value = '"2"' where key = 'legal.consent_version'`);
    clearLegalCaches();
    s = (await status(shared)).body.data;
    expect(s.schools.find((x: { schoolId: string }) => x.schoolId === fx.a.school.id)).toMatchObject({ consentRequired: true, requiredVersion: '2' });
    expect(s.schools.find((x: { schoolId: string }) => x.schoolId === fx.b.school.id)).toMatchObject({ consentRequired: false, requiredVersion: 'b-2' });
  });

  it('reverting to a version the parent already accepted needs no new consent', async () => {
    await accept(parentA, fx.a.school.id, '1');
    await ownerQuery(`update platform_settings set value = '"2"' where key = 'legal.consent_version'`);
    clearLegalCaches();
    await accept(parentA, fx.a.school.id, '2');
    await ownerQuery(`update platform_settings set value = '"1"' where key = 'legal.consent_version'`);
    clearLegalCaches();
    expect((await status(parentA)).body.data.schools[0]).toMatchObject({ requiredVersion: '1', acceptedVersion: '1', consentRequired: false });
  });

  it('the sign-in profile carries the consent state (consentRequired + per school)', async () => {
    await accept(shared, fx.a.school.id, '1');
    const me = await request(t.app).get(api('/auth/me')).set(bearer(shared.accessToken));
    expect(me.status).toBe(200);
    expect(me.body.data.consentRequired).toBe(true);
    const bySchool = new Map((me.body.data.schools as { school: { id: string; privacyUrl: string | null }; consent: { consentRequired: boolean } }[]).map((s) => [s.school.id, s]));
    expect(bySchool.get(fx.a.school.id)!.consent).toMatchObject({ requiredVersion: '1', acceptedVersion: '1', consentRequired: false });
    expect(bySchool.get(fx.b.school.id)!.consent).toMatchObject({ acceptedVersion: null, consentRequired: true });
    expect(bySchool.get(fx.a.school.id)!.school).toHaveProperty('privacyUrl', null);
    await accept(shared, fx.b.school.id, '1');
    expect((await request(t.app).get(api('/auth/me')).set(bearer(shared.accessToken))).body.data.consentRequired).toBe(false);
  });
});

describe('RLS on parent_consents', () => {
  it('parents read only their own records; nobody inserts, updates or deletes directly', async () => {
    await accept(parentA, fx.a.school.id, '1');
    await accept(shared, fx.a.school.id, '1');
    const asParent = (parentId: string, schoolId: string) => ({ schoolId, actorId: parentId, role: 'parent' as const });
    const mine = await withTenant(asParent(fx.a.parent.id, fx.a.school.id), (tx) => tx.many<{ parent_account_id: string }>('select parent_account_id from parent_consents'), { readOnly: true });
    expect(mine.map((r) => r.parent_account_id)).toEqual([fx.a.parent.id]);
    // A parent cannot forge or delete records.
    await expect(withTenant(asParent(fx.a.parent.id, fx.a.school.id), (tx) => tx.query("insert into parent_consents (school_id, parent_account_id, version) values ($1, $2, '9')", [fx.a.school.id, fx.a.parent.id]))).rejects.toThrow(/row-level security/);
    const deleted = await withTenant(asParent(fx.a.parent.id, fx.a.school.id), (tx) => tx.query('delete from parent_consents'));
    expect(deleted.rowCount).toBe(0);
    // School admins read their school's records but cannot write them.
    const admin = { schoolId: fx.a.school.id, actorId: fx.a.admin.id, role: 'school_admin' as const };
    expect((await withTenant(admin, (tx) => tx.many('select 1 from parent_consents'), { readOnly: true })).length).toBe(2);
    await expect(withTenant(admin, (tx) => tx.query("insert into parent_consents (school_id, parent_account_id, version) values ($1, $2, '9')", [fx.a.school.id, fx.a.parent.id]))).rejects.toThrow(/row-level security/);
    expect((await withTenant(admin, (tx) => tx.query("update parent_consents set version = '9'"))).rowCount).toBe(0);
    expect((await withTenant(admin, (tx) => tx.query('delete from parent_consents'))).rowCount).toBe(0);
    // School B sees none of school A's records.
    const adminB = { schoolId: fx.b.school.id, actorId: fx.b.admin.id, role: 'school_admin' as const };
    expect((await withTenant(adminB, (tx) => tx.many('select 1 from parent_consents'), { readOnly: true })).length).toBe(0);
    expect((await ownerQuery<{ n: number }>('select count(*)::int as n from parent_consents')).rows[0]!.n).toBe(2);
  });

  it('parent_accept_consent refuses a non-parent context and a school without an active link', async () => {
    const admin = { schoolId: fx.a.school.id, actorId: fx.a.admin.id, role: 'school_admin' as const };
    await expect(withTenant(admin, (tx) => tx.query("select * from parent_accept_consent('1', null, null, null, null)"))).rejects.toMatchObject({ code: '42501' });
    await expect(withTenant({ schoolId: fx.b.school.id, actorId: fx.a.parent.id, role: 'parent' }, (tx) => tx.query("select * from parent_accept_consent('1', null, null, null, null)"))).rejects.toMatchObject({ code: '42501' });
    await expect(withTenant({ schoolId: fx.a.school.id, actorId: fx.a.parent.id, role: 'parent' }, (tx) => tx.query("select * from parent_accept_consent('7', null, null, null, null)"))).rejects.toMatchObject({ code: 'P0001' });
  });
});
