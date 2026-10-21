// Platform schools (BP §2.2, §4.4, §8.2, §13.2, App. A): role gate, create-school transaction
// (atomicity, defaults, initial admin, welcome e-mail, audit), list/search/CSV, details (admins,
// subscription, counts only), PATCH, and "the Super Admin never receives school-scoped rows".
import { generate, generateSecret } from 'otplib';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withPlatform } from '../src/db/tenant.js';
import { encryptSecret } from '../src/shared/crypto.js';
import { channels } from '../src/shared/notifications/index.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { buildApp, loginSchoolAdmin, loginStaff, PASSWORD, passwordHash, type TestApp } from './helpers/authApp.js';

let t: TestApp;
let fx: f.TwoSchoolFixture;
let superToken: string;
let adminToken: string;
let driverToken: string;

async function superAdminToken(app: TestApp['app'], superAdmin: f.Row): Promise<string> {
  const secret = generateSecret();
  await ownerQuery('update platform_users set password_hash = $1, totp_enabled = true, totp_secret_enc = $2 where id = $3', [await passwordHash(), encryptSecret(secret, { purpose: 'totp' }), superAdmin.id]);
  const res = await request(app).post('/api/v1/auth/platform/login').send({ email: superAdmin.email, password: PASSWORD, totpCode: await generate({ secret }) });
  if (res.status !== 200) throw new Error(`platform login failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.accessToken as string;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const sa = () => auth(superToken);

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  fx = await f.twoSchoolFixture();
  await ownerQuery('update users set password_hash = $1 where id = any ($2)', [await passwordHash(), [fx.a.admin.id, fx.a.driverUser.id]]);
  superToken = await superAdminToken(t.app, fx.superAdmin);
  adminToken = (await loginSchoolAdmin(t.app, String(fx.a.admin.email))).accessToken;
  driverToken = (await loginStaff(t.app, String(fx.a.school.code), String(fx.a.driverUser.phone))).accessToken;
});
afterAll(closeDb);
beforeEach(() => channels.email.clearSentMessages());

const newSchool = (o: Record<string, unknown> = {}) => ({
  name: 'Lakeview Academy',
  code: `lv-${f.nextSeq()}`,
  institutionType: 'school',
  address: 'Road No. 12, Banjara Hills',
  city: 'Hyderabad',
  state: 'Telangana',
  pincode: '500034',
  contact: { name: 'Kavya Reddy', phone: '040 2335 0000', email: 'office@lakeview.example' },
  brandColor: '#0B5394',
  location: { lat: 17.4126, lng: 78.4392 },
  timezone: 'Asia/Kolkata',
  admin: { name: 'Kavya Reddy', email: `admin-${f.nextSeq()}@lakeview.example`, phone: '98490 11111' },
  ...o,
});

describe('role gate', () => {
  const endpoints: [string, string][] = [
    ['get', '/api/v1/platform/schools'],
    ['post', '/api/v1/platform/schools'],
    ['get', `/api/v1/platform/schools/00000000-0000-4000-8000-000000000000`],
    ['get', '/api/v1/platform/settings'],
    ['put', '/api/v1/platform/settings'],
    ['get', '/api/v1/platform/health'],
    ['get', '/api/v1/platform/usage'],
  ];
  it('refuses school admins and drivers (403) and anonymous callers (401)', async () => {
    for (const [method, path] of endpoints) {
      const call = (h?: Record<string, string>) => {
        const r = (request(t.app) as unknown as Record<string, (p: string) => request.Test>)[method]!(path);
        return h ? r.set(h) : r;
      };
      expect((await call(auth(adminToken))).status, `${method} ${path} admin`).toBe(403);
      expect((await call(auth(driverToken))).status, `${method} ${path} driver`).toBe(403);
      expect((await call()).status, `${method} ${path} anonymous`).toBe(401);
    }
  });

  it('school admins cannot reach lifecycle, subscription or logo endpoints of their own school', async () => {
    const id = fx.a.school.id;
    expect((await request(t.app).post(`/api/v1/platform/schools/${id}/deactivate`).set(auth(adminToken))).status).toBe(403);
    expect((await request(t.app).post(`/api/v1/platform/schools/${id}/admin/reset-password`).set(auth(adminToken))).status).toBe(403);
    expect((await request(t.app).put(`/api/v1/platform/schools/${id}/subscription`).set(auth(adminToken)).send({ plan: 'free' })).status).toBe(403);
    expect((await request(t.app).patch(`/api/v1/platform/schools/${id}`).set(auth(adminToken)).send({ name: 'Hacked' })).status).toBe(403);
    expect((await ownerQuery('select status, name from schools where id = $1', [id])).rows[0]).toEqual({ status: 'active', name: 'Greenfield Public School' });
  });
});

describe('POST /platform/schools', () => {
  it('creates school + settings + initial admin + subscription + platform audit in one go', async () => {
    const body = newSchool({ school_id: fx.b.school.id, schoolId: fx.b.school.id });
    const res = await request(t.app).post('/api/v1/platform/schools').set(sa()).send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const d = res.body.data;
    expect(d.school).toMatchObject({ code: body.code.toUpperCase(), name: 'Lakeview Academy', status: 'active', institutionType: 'school', timezone: 'Asia/Kolkata', tenantMode: 'shared', location: { lat: 17.4126, lng: 78.4392 }, contact: { phone: '+914023350000', email: 'office@lakeview.example' } });
    expect(d.admin).toMatchObject({ name: 'Kavya Reddy', email: body.admin.email, phone: '+919849011111', mustChangePassword: true });
    expect(d.subscription).toMatchObject({ plan: 'standard', status: 'active', maxBuses: 25, maxStudents: 1500, validUntil: null });
    expect(d.credentials).toMatchObject({ delivery: 'show', passwordGenerated: true, emailDelivered: false });
    expect(d.credentials.temporaryPassword).toMatch(/^[A-Za-z0-9]{14}$/);
    const id = d.school.id as string;
    expect(id).not.toBe(fx.b.school.id);

    const settings = await ownerQuery('select school_id, features from school_settings where school_id = $1', [id]);
    expect(settings.rows).toHaveLength(1);
    const admin = await ownerQuery('select role, must_change_password, created_by from users where school_id = $1', [id]);
    expect(admin.rows).toEqual([{ role: 'school_admin', must_change_password: true, created_by: fx.superAdmin.id }]);
    const audit = await ownerQuery<{ school_id: string | null; actor_id: string; new_values: Record<string, unknown> }>("select school_id, actor_id, new_values from audit_logs where action = 'school.create' and entity_id = $1", [id]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ school_id: null, actor_id: fx.superAdmin.id });
    expect(JSON.stringify(audit.rows[0]!.new_values)).not.toContain(d.credentials.temporaryPassword);

    const mails = channels.email.sentMessages();
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: body.admin.email });
    expect(mails[0]!.text).toContain(body.code.toUpperCase());
    expect(mails[0]!.text).not.toContain(d.credentials.temporaryPassword);

    // The new admin signs in with the temporary password and must change it first.
    const login = await request(t.app).post('/api/v1/auth/school/login').send({ email: body.admin.email, password: d.credentials.temporaryPassword });
    expect(login.status).toBe(200);
    expect(login.body.data.mustChangePassword).toBe(true);
  });

  it("delivery 'email' sends the password with the invitation (revealed only because SMTP is not configured here)", async () => {
    const body = newSchool({ admin: { name: 'Anil Menon', email: `invite-${f.nextSeq()}@riverside.example`, delivery: 'email' }, institutionType: 'college', name: 'Riverside College' });
    const res = await request(t.app).post('/api/v1/platform/schools').set(sa()).send(body);
    expect(res.status).toBe(201);
    const { credentials } = res.body.data;
    expect(credentials).toMatchObject({ delivery: 'email', passwordGenerated: true, emailDelivered: false });
    const mail = channels.email.sentMessages().at(-1)!;
    expect(mail.text).toContain(credentials.temporaryPassword);
  });

  it('accepts a chosen password (never echoed) and an explicit subscription', async () => {
    const body = newSchool({ admin: { name: 'Admin', email: `chosen-${f.nextSeq()}@x.example`, password: 'Chosen#2026' }, subscription: { plan: 'premium', maxBuses: 3, maxStudents: 100, validUntil: '2030-03-31', modules: { sms: true, whatsapp: false } } });
    const res = await request(t.app).post('/api/v1/platform/schools').set(sa()).send(body);
    expect(res.status).toBe(201);
    expect(res.body.data.credentials.temporaryPassword).toBeUndefined();
    expect(res.body.data.subscription).toMatchObject({ plan: 'premium', maxBuses: 3, maxStudents: 100, validUntil: '2030-03-31', modules: { sms: true, whatsapp: false } });
    expect((await request(t.app).post('/api/v1/auth/school/login').send({ email: body.admin.email, password: 'Chosen#2026' })).status).toBe(200);
  });

  it('is atomic: a duplicate admin e-mail leaves no school, settings, subscription or audit behind', async () => {
    const body = newSchool({ admin: { name: 'Dup', email: String(fx.a.admin.email) } });
    const res = await request(t.app).post('/api/v1/platform/schools').set(sa()).send(body);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'DUPLICATE', details: [{ path: 'admin.email' }] });
    const code = body.code.toUpperCase();
    expect((await ownerQuery('select 1 from schools where code = $1', [code])).rowCount).toBe(0);
    expect((await ownerQuery('select 1 from school_settings s join schools x on x.id = s.school_id where x.code = $1', [code])).rowCount).toBe(0);
    expect((await ownerQuery("select 1 from audit_logs where action = 'school.create' and new_values ->> 'code' = $1", [code])).rowCount).toBe(0);
    expect(channels.email.sentMessages()).toHaveLength(0);
  });

  it('rejects a duplicate code and invalid input', async () => {
    const dup = await request(t.app).post('/api/v1/platform/schools').set(sa()).send(newSchool({ code: String(fx.a.school.code) }));
    expect(dup.status).toBe(409);
    expect(dup.body.error.details).toEqual([{ path: 'code', message: 'Already in use' }]);
    const bad = await request(t.app)
      .post('/api/v1/platform/schools')
      .set(sa())
      .send(newSchool({ code: 'x', timezone: 'Mars/Base', location: { lat: 99, lng: 0 }, admin: { name: 'A', email: 'nope', phone: '12' } }));
    expect(bad.status).toBe(400);
    const paths = (bad.body.error.details as { path: string }[]).map((d) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['code', 'timezone', 'location.lat', 'admin.email']));
    const weak = await request(t.app).post('/api/v1/platform/schools').set(sa()).send(newSchool({ admin: { name: 'A', email: `w-${f.nextSeq()}@x.example`, password: 'onlyletters' } }));
    expect(weak.status).toBe(400);
    expect(weak.body.error.details[0].path).toBe('admin.password');
    const dedicated = await request(t.app).post('/api/v1/platform/schools').set(sa()).send(newSchool({ tenantMode: 'dedicated', dbConnectionRef: 'UNREGISTERED' }));
    expect(dedicated.status).toBe(409);
    expect(dedicated.body.error.code).toBe('INVALID_STATE');
  });
});

describe('GET /platform/schools', () => {
  it('lists, searches, filters, sorts and paginates with the current subscription', async () => {
    const all = await request(t.app).get('/api/v1/platform/schools?limit=100').set(sa());
    expect(all.status).toBe(200);
    const ids = (all.body.data as { id: string }[]).map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining([fx.a.school.id, fx.b.school.id]));
    expect(all.body.meta).toMatchObject({ page: 1, limit: 100, total: ids.length });
    const a = (all.body.data as { id: string; subscription: unknown }[]).find((s) => s.id === fx.a.school.id)!;
    expect(a.subscription).toEqual({ plan: 'standard', status: 'active', validUntil: null, maxBuses: 50, maxStudents: 2000 });

    const search = await request(t.app).get('/api/v1/platform/schools?q=lakeview&sort=-createdAt').set(sa());
    expect((search.body.data as { name: string }[]).every((s) => s.name === 'Lakeview Academy')).toBe(true);
    expect(search.body.data.length).toBeGreaterThan(0);
    const colleges = await request(t.app).get('/api/v1/platform/schools?institutionType=college').set(sa());
    expect((colleges.body.data as { institutionType: string }[]).map((s) => s.institutionType)).toEqual(colleges.body.data.map(() => 'college'));
    const page = await request(t.app).get('/api/v1/platform/schools?limit=1&page=2&sort=code').set(sa());
    expect(page.body.data).toHaveLength(1);
    expect(page.body.meta).toMatchObject({ page: 2, limit: 1, total: ids.length });
    const none = await request(t.app).get('/api/v1/platform/schools?status=suspended').set(sa());
    expect(none.body.data).toEqual([]);
    expect((await request(t.app).get('/api/v1/platform/schools?status=bogus').set(sa())).status).toBe(400);
    expect((await request(t.app).get('/api/v1/platform/schools?sort=password').set(sa())).status).toBe(400);
  });

  it('exports CSV', async () => {
    const res = await request(t.app).get('/api/v1/platform/schools?format=csv&q=Greenfield').set(sa());
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const lines = res.text.replace(/^\uFEFF/, '').trim().split(/\r\n/);
    expect(lines[0]).toMatch(/^Code,Name,Type,Status/);
    expect(lines).toHaveLength(3);
  });
});

describe('GET /platform/schools/:id', () => {
  it('returns profile, admins, subscription and counts — never school data rows', async () => {
    const res = await request(t.app).get(`/api/v1/platform/schools/${fx.a.school.id}`).set(sa());
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d).toMatchObject({ id: fx.a.school.id, status: 'active', logoUrl: null });
    expect(d.admins).toEqual([expect.objectContaining({ id: fx.a.admin.id, name: 'Anita Rao', mustChangePassword: false })]);
    expect(d.subscription).toMatchObject({ plan: 'standard', maxBuses: 50 });
    expect(d.usage).toEqual({ buses: 2, students: 2, staff: 3, parents: 2, routes: 2, activeTrips: 2, tripsLast30Days: expect.any(Number), lastActivityAt: expect.any(String) });
    const text = JSON.stringify(res.body);
    for (const secret of ['KA01AB1234', 'Aarav Sharma', 'Ramesh Kumar', 'Priya Sharma', String(fx.a.bus.id), String(fx.a.student.id)]) expect(text).not.toContain(secret);
  });

  it('404 for unknown ids, 400 for malformed ids', async () => {
    expect((await request(t.app).get('/api/v1/platform/schools/00000000-0000-4000-8000-000000000000').set(sa())).status).toBe(404);
    expect((await request(t.app).get('/api/v1/platform/schools/not-a-uuid').set(sa())).status).toBe(400);
  });
});

describe('PATCH /platform/schools/:id', () => {
  it('edits profile, location, timezone, institution type and code; audits the diff', async () => {
    const created = await request(t.app).post('/api/v1/platform/schools').set(sa()).send(newSchool());
    const id = created.body.data.school.id as string;
    const res = await request(t.app)
      .patch(`/api/v1/platform/schools/${id}`)
      .set(sa())
      .send({ name: 'Lakeview Academy (Jubilee Hills)', institutionType: 'university', location: { lat: 17.43, lng: 78.41 }, timezone: 'Asia/Calcutta', code: `lvj-${f.nextSeq()}`, contact: { name: null, phone: '', email: 'new@lakeview.example' }, status: 'suspended' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'Lakeview Academy (Jubilee Hills)', institutionType: 'university', location: { lat: 17.43, lng: 78.41 }, timezone: 'Asia/Calcutta', status: 'active', contact: { name: null, phone: null, email: 'new@lakeview.example' } });
    const audit = await ownerQuery<{ old_values: Record<string, unknown>; new_values: Record<string, unknown> }>("select old_values, new_values from audit_logs where action = 'school.update' and entity_id = $1", [id]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.new_values).toMatchObject({ name: 'Lakeview Academy (Jubilee Hills)', institutionType: 'university' });
    expect(audit.rows[0]!.old_values).toMatchObject({ name: 'Lakeview Academy' });
    const cleared = await request(t.app).patch(`/api/v1/platform/schools/${id}`).set(sa()).send({ location: null });
    expect(cleared.body.data.location).toBeNull();
    expect((await request(t.app).patch(`/api/v1/platform/schools/${id}`).set(sa()).send({})).status).toBe(400);
    expect((await request(t.app).patch(`/api/v1/platform/schools/${id}`).set(sa()).send({ contact: {} })).status).toBe(400);
    expect((await request(t.app).patch(`/api/v1/platform/schools/${id}`).set(sa()).send({ code: String(fx.a.school.code) })).status).toBe(409);
    expect((await request(t.app).patch(`/api/v1/platform/schools/${id}`).set(sa()).send({ tenantMode: 'dedicated', dbConnectionRef: 'NOPE' })).body.error.code).toBe('INVALID_STATE');
  });
});

describe('platform context isolation (BP §4.4)', () => {
  it('a super admin transaction sees zero tenant rows and only platform rows', async () => {
    const counts = await withPlatform({ actorId: fx.superAdmin.id }, (tx) =>
      tx.one<Record<string, number>>(
        `select (select count(*) from buses)::int as buses, (select count(*) from students)::int as students,
                (select count(*) from users)::int as users, (select count(*) from trips)::int as trips,
                (select count(*) from school_settings)::int as settings, (select count(*) from files)::int as files,
                (select count(*) from location_points)::int as points, (select count(*) from school_parents)::int as parents,
                (select count(*) from parent_accounts)::int as parent_accounts, (select count(*) from schools)::int as schools,
                (select count(*) from audit_logs where school_id is not null)::int as school_audit`,
      ),
    );
    expect(counts).toMatchObject({ buses: 0, students: 0, users: 0, trips: 0, settings: 0, files: 0, points: 0, parents: 0, parent_accounts: 0, school_audit: 0 });
    expect(counts.schools).toBeGreaterThanOrEqual(2);
  });
});
