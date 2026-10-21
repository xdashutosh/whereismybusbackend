// Staff profiles (BP §8.3 CRUD /school/staff?type=driver|conductor, §5.4, §13.3 Staff, §16): create
// and edit with experience/joining/licence fields, identity proof type + last 4 only (full
// Aadhaar/PAN refused and never echoed), address internal only, list filters/sort/CSV, detail,
// credentials (create + reset: temporary password/PIN returned once, forced change, lockout
// cleared, sessions revoked + sockets disconnected), activate/deactivate (assignments closed,
// login disabled, refused during a trip), soft delete, roles and cross-school isolation.
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { realtime } from '../src/shared/realtime.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { buildApp, DEVICE, loginParent, loginSchoolAdmin, loginStaff, PASSWORD, passwordHash, type TestApp } from './helpers/authApp.js';

let t: TestApp;
let fx: f.TwoSchoolFixture;
let adminA: string;
let adminB: string;
let driverA: string;
let parentA: string;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const api = (p = '') => `/api/v1/school/staff${p}`;
const TEMP_RE = /^[A-Za-z]{4}-[A-Za-z]{4}-[2-9]{4}$/;
const me = (token: string) => request(t.app).get('/api/v1/auth/me').set(auth(token));
const staffLogin = (body: Record<string, unknown>) => request(t.app).post('/api/v1/auth/staff/login').send({ schoolCode: fx.a.school.code, device: DEVICE, ...body });
const createStaff = (body: Record<string, unknown>, token = adminA) => request(t.app).post(api()).set(auth(token)).send(body);

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  fx = await f.twoSchoolFixture();
  await ownerQuery('update users set password_hash = $1 where id = any ($2)', [await passwordHash(), [fx.a.admin.id, fx.b.admin.id, fx.a.driverUser.id]]);
  adminA = (await loginSchoolAdmin(t.app, String(fx.a.admin.email))).accessToken;
  adminB = (await loginSchoolAdmin(t.app, String(fx.b.admin.email))).accessToken;
  driverA = (await loginStaff(t.app, String(fx.a.school.code), String(fx.a.driverUser.phone))).accessToken;
  parentA = (await loginParent(t, String(fx.a.parent.phone))).accessToken;
});
afterEach(() => vi.restoreAllMocks());
afterAll(closeDb);

describe('create and edit', () => {
  let id: string;

  it('creates a driver with profile and licence fields; school_id in the body is ignored; audited without the address', async () => {
    const res = await createStaff({
      staffType: 'driver', fullName: 'Prakash Rao', phone: '98450 33333', email: 'Prakash@Example.TEST', address: '12 MG Road, Bengaluru',
      joiningDate: '2024-04-01', experienceYears: 12.46, experienceSummary: 'School buses since 2014', emergencyContactName: 'Sita Rao',
      emergencyContactPhone: '+919845044444', idProofType: 'aadhaar', idProofLast4: '1234', licenceNo: 'ka01 2014-0098765', licenceRto: 'KA-01',
      licenceIssueDate: '2014-03-01', licenceExpiryDate: f.isoDay(20), school_id: fx.b.school.id,
    });
    expect(res.status).toBe(201);
    id = res.body.data.id;
    expect(res.body.data).toMatchObject({
      staffType: 'driver', fullName: 'Prakash Rao', phone: '+919845033333', email: 'prakash@example.test', address: '12 MG Road, Bengaluru',
      experienceYears: 12.5, idProofType: 'aadhaar', idProofLast4: '1234', idProofMasked: 'XXXX XXXX 1234', idVerificationStatus: 'pending',
      licenceNo: 'KA0120140098765', licenceStatus: 'expiring', licenceVerificationStatus: 'pending', isActive: true, hasLogin: false,
      login: null, currentBuses: [], currentAssignments: [], documents: [], activeTripId: null, createdBy: fx.a.admin.id,
    });
    expect(res.body.data.licenceDaysToExpiry).toBeGreaterThanOrEqual(19);
    expect((await ownerQuery('select school_id from staff_profiles where id = $1', [id])).rows[0]!.school_id).toBe(fx.a.school.id);
    const log = await ownerQuery<{ new_values: Record<string, unknown> }>("select new_values from audit_logs where action = 'staff.create' and entity_id = $1", [id]);
    expect(log.rows[0]!.new_values).toMatchObject({ fullName: 'Prakash Rao', hasAddress: true, idProofMasked: 'XXXX XXXX 1234' });
    expect(JSON.stringify(log.rows[0]!.new_values)).not.toContain('MG Road');
  });

  it('refuses full Aadhaar/PAN numbers without echoing them, and drops unknown identity keys', async () => {
    for (const value of ['2345 6789 0123', '234567890123', 'ABCDE1234F', '12345']) {
      const res = await createStaff({ staffType: 'conductor', fullName: 'Test Person', idProofType: 'aadhaar', idProofLast4: value });
      expect(res.status).toBe(400);
      expect(res.body.error.details[0].path).toBe('idProofLast4');
      expect(JSON.stringify(res.body)).not.toContain(value);
    }
    const res = await createStaff({ staffType: 'conductor', fullName: 'Meena K', idProofType: 'pan', idProofLast4: '234f', aadhaarNumber: '234567890123', idProofNumber: 'ABCDE1234F' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ idProofLast4: '234F', idProofMasked: 'XXXXXX234F' });
    const row = await ownerQuery('select row_to_json(sp)::text as j from staff_profiles sp where id = $1', [res.body.data.id]);
    expect(row.rows[0]!.j).not.toContain('234567890123');
    expect(row.rows[0]!.j).not.toContain('ABCDE1234F');
  });

  it('validates licence rules: drivers only, dates in order, last 4 needs a type', async () => {
    const conductor = await createStaff({ staffType: 'conductor', fullName: 'Anil', licenceNo: 'KA0120200011111' });
    expect([conductor.status, conductor.body.error.details[0].path]).toEqual([400, 'licenceNo']);
    const dates = await createStaff({ staffType: 'driver', fullName: 'Anil', licenceIssueDate: '2024-01-01', licenceExpiryDate: '2023-01-01' });
    expect([dates.status, dates.body.error.details[0].path]).toEqual([400, 'licenceExpiryDate']);
    const last4 = await createStaff({ staffType: 'driver', fullName: 'Anil', idProofLast4: '9999' });
    expect([last4.status, last4.body.error.details[0].path]).toEqual([400, 'idProofType']);
    const type = await request(t.app).patch(api(`/${id}`)).set(auth(adminA)).send({ staffType: 'conductor' });
    expect([type.status, type.body.error.details[0].path]).toEqual([400, 'staffType']);
    const order = await request(t.app).patch(api(`/${id}`)).set(auth(adminA)).send({ licenceIssueDate: f.isoDay(60) });
    expect([order.status, order.body.error.details[0].path]).toEqual([400, 'licenceExpiryDate']);
  });

  it('edits a profile (partial), keeps the login name in sync and audits the diff', async () => {
    const res = await request(t.app).patch(api(`/${id}`)).set(auth(adminA)).send({ fullName: 'Prakash R. Rao', experienceYears: 13, address: null });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ fullName: 'Prakash R. Rao', experienceYears: 13, address: null, phone: '+919845033333' });
    const log = await ownerQuery<{ old_values: Record<string, unknown>; new_values: Record<string, unknown> }>(
      "select old_values, new_values from audit_logs where action = 'staff.update' and entity_id = $1", [id]);
    expect(log.rows[0]!.new_values).toEqual({ fullName: 'Prakash R. Rao', experienceYears: 13, hasAddress: false });
    expect((await request(t.app).patch(api(`/${id}`)).set(auth(adminA)).send({})).status).toBe(400);
  });

  it('links an uploaded staff_photo (and only one uploaded for this staff member)', async () => {
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#0070f2' } }).png().toBuffer();
    const up = await request(t.app).post('/api/v1/files/upload').set(auth(adminA)).field('category', 'staff_photo').field('entityId', id).attach('file', png, 'me.png');
    expect(up.status).toBe(201);
    const other = await request(t.app).post('/api/v1/files/upload').set(auth(adminA)).field('category', 'staff_photo').field('entityId', fx.a.otherDriver.id).attach('file', png, 'x.png');
    const wrong = await request(t.app).patch(api(`/${id}`)).set(auth(adminA)).send({ photoFileId: other.body.data.id });
    expect([wrong.status, wrong.body.error.details[0].path]).toEqual([400, 'photoFileId']);
    const res = await request(t.app).patch(api(`/${id}`)).set(auth(adminA)).send({ photoFileId: up.body.data.id });
    expect(res.status).toBe(200);
    expect(res.body.data.photo).toMatchObject({ fileId: up.body.data.id });
    expect(res.body.data.photo.url).toContain('/files/local/download');
    expect(res.body.data.photoThumbnailUrl).toBeTruthy();
  });
});

describe('list, detail, CSV', () => {
  it('lists drivers/conductors with filters, sort and pagination', async () => {
    const drivers = await request(t.app).get(api('?type=driver&sort=fullName')).set(auth(adminA));
    expect(drivers.status).toBe(200);
    const names = drivers.body.data.map((s: { fullName: string }) => s.fullName);
    expect(names).toEqual([...names].sort());
    expect(drivers.body.data.every((s: { staffType: string }) => s.staffType === 'driver')).toBe(true);
    const ramesh = drivers.body.data.find((s: { id: string }) => s.id === fx.a.driver.id);
    expect(ramesh).toMatchObject({ hasLogin: true, currentBuses: [{ busId: fx.a.bus.id, busCode: 'R1', role: 'primary_driver' }] });
    expect(ramesh).not.toHaveProperty('address');

    const conductors = await request(t.app).get(api('?type=conductor&limit=1')).set(auth(adminA));
    expect(conductors.body.meta).toMatchObject({ page: 1, limit: 1 });
    expect(conductors.body.meta.total).toBeGreaterThanOrEqual(2);
    const expiring = await request(t.app).get(api('?licenceStatus=expiring')).set(auth(adminA));
    expect(expiring.body.data.map((s: { fullName: string }) => s.fullName)).toEqual(['Prakash R. Rao']);
    const unassigned = await request(t.app).get(api('?assigned=false&hasLogin=false&q=meena')).set(auth(adminA));
    expect(unassigned.body.data.map((s: { fullName: string }) => s.fullName)).toEqual(['Meena K']);
    expect((await request(t.app).get(api('?sort=password')).set(auth(adminA))).status).toBe(400);
  });

  it('exports CSV with masked identity numbers and no address', async () => {
    const res = await request(t.app).get(api('?format=csv')).set(auth(adminA));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('aadhaar XXXX XXXX 1234');
    expect(res.text).not.toContain('MG Road');
  });

  it('shows the detail with login state and current assignments', async () => {
    const res = await request(t.app).get(api(`/${fx.a.driver.id}`)).set(auth(adminA));
    expect(res.status).toBe(200);
    expect(res.body.data.login).toMatchObject({ userId: fx.a.driverUser.id, phone: fx.a.driverUser.phone, hasPin: false, isActive: true });
    expect(res.body.data.login.activeSessions).toBeGreaterThanOrEqual(1);
    expect(res.body.data.currentAssignments[0]).toMatchObject({ busCode: 'R1', role: 'primary_driver', isCurrent: true });
    expect(res.body.data.activeTripId).toBe(fx.a.trip.id);
  });
});

describe('credentials', () => {
  let id: string;
  let tempPassword: string;
  let pin: string;
  const PHONE = '+919845055555';

  beforeAll(async () => {
    id = (await createStaff({ staffType: 'driver', fullName: 'Gopal Shetty', phone: PHONE })).body.data.id;
  });

  it('creates the app login with a generated temporary password and PIN (returned once, never audited)', async () => {
    const res = await request(t.app).post(api(`/${id}/credentials`)).set(auth(adminA)).send({ generatePin: true });
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    ({ temporaryPassword: tempPassword, pin } = res.body.data);
    expect(tempPassword).toMatch(TEMP_RE);
    expect(pin).toMatch(/^\d{6}$/);
    expect(res.body.data).toMatchObject({ created: true, revokedSessions: 0, login: { phone: PHONE, username: null, hasPin: true, mustChangePassword: true, isActive: true } });
    expect(res.body.data.staff).toMatchObject({ id, hasLogin: true, loginPhone: PHONE });
    const user = await ownerQuery<{ role: string; school_id: string; full_name: string }>('select u.role, u.school_id, u.full_name from users u join staff_profiles sp on sp.user_id = u.id where sp.id = $1', [id]);
    expect(user.rows[0]).toEqual({ role: 'driver', school_id: fx.a.school.id, full_name: 'Gopal Shetty' });
    const log = await ownerQuery<{ j: string }>("select row_to_json(a)::text as j from audit_logs a where action = 'staff.credentials_create' and entity_id = $1", [id]);
    expect(JSON.parse(log.rows[0]!.j).new_values).toMatchObject({ signInMethods: ['password', 'pin'], generatedByServer: ['password', 'pin'] });
    expect(log.rows[0]!.j).not.toContain(tempPassword);
    // (ids/timestamps are left out: a random 6-digit PIN could occur in them by chance)
    const { userId: _u, ...values } = JSON.parse(log.rows[0]!.j).new_values as Record<string, unknown>;
    expect(JSON.stringify(values)).not.toContain(pin);

    const withPassword = await staffLogin({ phone: PHONE, password: tempPassword });
    expect([withPassword.status, withPassword.body.data.mustChangePassword]).toEqual([200, true]);
    expect((await staffLogin({ phone: PHONE, pin })).status).toBe(200);
  });

  it('validates PINs and identifiers', async () => {
    for (const weak of ['1111', '1234', '987654', '12a4']) {
      const res = await request(t.app).post(api(`/${id}/credentials`)).set(auth(adminA)).send({ pin: weak });
      expect([res.status, res.body.error.details[0].path]).toEqual([400, 'pin']);
    }
    expect((await request(t.app).post(api(`/${id}/credentials`)).set(auth(adminA)).send({ pin: '4829', generatePin: true })).status).toBe(400);
    const none = await request(t.app).post(api(`/${id}/credentials`)).set(auth(adminA)).send({ phone: null });
    expect([none.status, none.body.error.details[0].path]).toEqual([400, 'phone']);
    const noPhone = (await createStaff({ staffType: 'conductor', fullName: 'Rekha' })).body.data.id;
    const missing = await request(t.app).post(api(`/${noPhone}/credentials`)).set(auth(adminA)).send({});
    expect([missing.status, missing.body.error.details[0].path]).toEqual([400, 'username']);
    const dup = await request(t.app).post(api(`/${noPhone}/credentials`)).set(auth(adminA)).send({ phone: fx.a.driverUser.phone });
    expect([dup.status, dup.body.error.code]).toEqual([409, 'DUPLICATE']);
    // Uniqueness is per school: school B may use the same phone.
    const inB = (await createStaff({ staffType: 'conductor', fullName: 'Rekha B' }, adminB)).body.data.id;
    expect((await request(t.app).post(api(`/${inB}/credentials`)).set(auth(adminB)).send({ phone: fx.a.driverUser.phone, username: 'rekha.b' })).status).toBe(201);
  });

  it('resets every secret, clears the lockout, revokes sessions and disconnects sockets', async () => {
    await ownerQuery("update users set password_hash = $1, must_change_password = false where phone = $2 and school_id = $3", [await passwordHash(), PHONE, fx.a.school.id]);
    const session = await loginStaff(t.app, String(fx.a.school.code), PHONE);
    expect((await me(session.accessToken)).status).toBe(200);
    await ownerQuery("update users set locked_until = now() + interval '10 minutes', failed_login_count = 5 where phone = $1 and school_id = $2", [PHONE, fx.a.school.id]);
    const disconnect = vi.spyOn(realtime, 'disconnectSessions');

    const res = await request(t.app).post(api(`/${id}/credentials`)).set(auth(adminA)).send({ username: 'gopal.s', password: 'Bus#Route2026', mustChangePassword: false });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ created: false, temporaryPassword: null, pin: null, login: { phone: PHONE, username: 'gopal.s', hasPin: false, locked: false, mustChangePassword: false } });
    expect(res.body.data.revokedSessions).toBeGreaterThanOrEqual(1);
    expect(disconnect).toHaveBeenCalledWith(expect.arrayContaining([session.sessionId]));
    expect((await me(session.accessToken)).status).toBe(401);
    expect((await request(t.app).post('/api/v1/auth/refresh').send({ refreshToken: session.refreshToken })).status).toBe(401);
    expect((await staffLogin({ phone: PHONE, password: PASSWORD })).status).toBe(401);
    expect((await staffLogin({ phone: PHONE, pin })).status).toBe(401);
    const fresh = await staffLogin({ username: 'gopal.s', password: 'Bus#Route2026' });
    expect([fresh.status, fresh.body.data.mustChangePassword]).toEqual([200, false]);
    const log = await ownerQuery<{ new_values: Record<string, unknown> }>("select new_values from audit_logs where action = 'staff.credentials_reset' and entity_id = $1", [id]);
    expect(log.rows[0]!.new_values).toMatchObject({ loginUsername: 'gopal.s', signInMethods: ['password'], generatedByServer: [], forcedChangeAtSignIn: false });
    expect(JSON.stringify(log.rows[0]!.new_values)).not.toContain('Bus#Route2026');
  });
});

describe('activate, deactivate, delete', () => {
  let id: string;
  const PHONE = '+919845066666';

  beforeAll(async () => {
    id = (await createStaff({ staffType: 'conductor', fullName: 'Kiran Das', phone: PHONE })).body.data.id;
    await request(t.app).post(api(`/${id}/credentials`)).set(auth(adminA)).send({ password: PASSWORD, mustChangePassword: false });
    await f.busStaffAssignment(fx.a.school.id, fx.a.otherBus.id, id, { assignment_role: 'conductor' });
  });

  it('refuses to deactivate or delete a staff member on a trip in progress', async () => {
    for (const res of [
      await request(t.app).post(api(`/${fx.a.driver.id}/deactivate`)).set(auth(adminA)).send({}),
      await request(t.app).delete(api(`/${fx.a.driver.id}`)).set(auth(adminA)),
    ]) {
      expect([res.status, res.body.error.code, res.body.error.details.reason, res.body.error.details.tripId]).toEqual([409, 'INVALID_STATE', 'ACTIVE_TRIP', fx.a.trip.id]);
    }
  });

  it('deactivates: ends assignments, disables the login, revokes sessions and disconnects sockets', async () => {
    const session = await loginStaff(t.app, String(fx.a.school.code), PHONE);
    const disconnect = vi.spyOn(realtime, 'disconnectSessions');
    const res = await request(t.app).post(api(`/${id}/deactivate`)).set(auth(adminA)).send({ reason: 'Left the job' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id, isActive: false, closedAssignments: 1, currentBuses: [], login: { isActive: false } });
    expect(res.body.data.revokedSessions).toBeGreaterThanOrEqual(1);
    expect(disconnect).toHaveBeenCalledWith(expect.arrayContaining([session.sessionId]));
    expect((await me(session.accessToken)).status).toBe(401);
    expect((await staffLogin({ phone: PHONE, password: PASSWORD })).status).toBe(403);
    const a = await ownerQuery('select valid_to from bus_staff_assignments where staff_id = $1', [id]);
    expect(a.rows[0]!.valid_to).not.toBeNull();
    const again = await request(t.app).post(api(`/${id}/deactivate`)).set(auth(adminA)).send({});
    expect(again.body.data).toMatchObject({ isActive: false, revokedSessions: 0, closedAssignments: 0 });
    expect((await request(t.app).get(api('?status=inactive')).set(auth(adminA))).body.data.map((s: { id: string }) => s.id)).toContain(id);
  });

  it('activates again (login usable, assignments stay closed)', async () => {
    const res = await request(t.app).post(api(`/${id}/activate`)).set(auth(adminA));
    expect(res.body.data).toMatchObject({ isActive: true, currentBuses: [], login: { isActive: true } });
    expect((await staffLogin({ phone: PHONE, password: PASSWORD })).status).toBe(200);
    const hist = await request(t.app).get(api(`/${id}/assignment-history`)).set(auth(adminA));
    expect(hist.body.data).toHaveLength(1);
    expect(hist.body.data[0]).toMatchObject({ busCode: 'R2', role: 'conductor', isCurrent: false });
  });

  it('soft deletes: history kept, login removed (phone freed), sessions revoked', async () => {
    const session = await loginStaff(t.app, String(fx.a.school.code), PHONE);
    const res = await request(t.app).delete(api(`/${id}`)).set(auth(adminA));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id, deleted: true });
    expect(res.body.data.revokedSessions).toBeGreaterThanOrEqual(1);
    expect((await me(session.accessToken)).status).toBe(401);
    expect((await request(t.app).get(api(`/${id}`)).set(auth(adminA))).status).toBe(404);
    expect((await ownerQuery('select count(*)::int as n from bus_staff_assignments where staff_id = $1', [id])).rows[0]!.n).toBe(1);
    const other = (await createStaff({ staffType: 'conductor', fullName: 'Kiran Das (new)', phone: PHONE })).body.data.id;
    expect((await request(t.app).post(api(`/${other}/credentials`)).set(auth(adminA)).send({})).status).toBe(201);
  });
});

describe('roles and isolation', () => {
  it('is for school admins only', async () => {
    expect((await request(t.app).get(api()).set(auth(driverA))).status).toBe(403);
    expect((await request(t.app).get(api()).set(auth(parentA)).set('X-School-Id', fx.a.school.id)).status).toBe(403);
    expect((await request(t.app).get(api())).status).toBe(401);
  });

  it("answers 404 for every endpoint given another school's ids", async () => {
    const sid = fx.a.driver.id;
    const doc = fx.a.driverDocument.id;
    const calls = [
      request(t.app).get(api(`/${sid}`)),
      request(t.app).patch(api(`/${sid}`)).send({ fullName: 'Hacked' }),
      request(t.app).delete(api(`/${fx.a.otherDriver.id}`)),
      request(t.app).post(api(`/${sid}/credentials`)).send({}),
      request(t.app).post(api(`/${sid}/activate`)),
      request(t.app).post(api(`/${fx.a.otherDriver.id}/deactivate`)).send({}),
      request(t.app).get(api(`/${sid}/assignment-history`)),
      request(t.app).get(api(`/${sid}/parent-preview`)),
      request(t.app).get(api(`/${sid}/documents`)),
      request(t.app).post(api(`/${sid}/documents`)).send({ docType: 'training' }),
      request(t.app).get(`/api/v1/school/staff-documents/${doc}`),
      request(t.app).put(`/api/v1/school/staff-documents/${doc}`).send({ title: 'x' }),
      request(t.app).patch(`/api/v1/school/staff-documents/${doc}`).send({ title: 'x' }),
      request(t.app).patch(`/api/v1/school/staff-documents/${doc}/visibility`).send({ visibleToParentsStatus: false }),
      request(t.app).patch(`/api/v1/school/staff-documents/${doc}/verify`).send({ status: 'verified' }),
      request(t.app).delete(`/api/v1/school/staff-documents/${doc}`),
    ];
    for (const call of calls) {
      const res = await call.set(auth(adminB));
      expect([res.status, res.body.error?.code]).toEqual([404, 'NOT_FOUND']);
    }
    const listB = await request(t.app).get(api('?limit=100')).set(auth(adminB));
    expect(listB.body.data.map((s: { id: string }) => s.id)).not.toContain(sid);
    const row = await ownerQuery<{ full_name: string; is_active: boolean }>('select full_name, is_active from staff_profiles where id = $1', [sid]);
    expect(row.rows[0]).toEqual({ full_name: 'Ramesh Kumar', is_active: true });
  });
});
