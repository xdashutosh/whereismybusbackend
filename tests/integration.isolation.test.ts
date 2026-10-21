// Integrator adversarial suite for wave 1 (BP §4.9, contract §4/§12) across platform, school, users,
// buses, staff, routes and students:
//   1. role bypass  — every /school/* endpoint refuses drivers, conductors, parents (even with a valid
//      X-School-Id), super admins and anonymous callers; every /platform/* endpoint refuses every
//      school principal;
//   2. cross-school — school B's admin gets 404 for EVERY endpoint addressed with school A's ids (valid
//      bodies, so the refusal is the tenancy check and not validation), B's lists never contain A's
//      rows, and nothing of school A changed or was audited by B afterwards.
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { buildApp, loginParent, loginSchoolAdmin, loginStaff, passwordHash, PASSWORD, type TestApp } from './helpers/authApp.js';
import { encryptSecret } from '../src/shared/crypto.js';
import { generate, generateSecret } from 'otplib';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
interface Call {
  method: Method;
  path: string;
  body?: Record<string, unknown>;
}

let t: TestApp;
let fx: f.TwoSchoolFixture;
const tok: Record<'adminA' | 'adminB' | 'driverA' | 'conductorA' | 'parent' | 'superAdmin', string> = {} as never;
const ids: Record<string, string> = {};
const api = (p: string) => `/api/v1${p}`;

function send(c: Call, token: string | null, headers: Record<string, string> = {}) {
  let r = request(t.app)[c.method](api(c.path));
  if (token) r = r.set('Authorization', `Bearer ${token}`);
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  return c.body && c.method !== 'get' ? r.send(c.body) : r;
}

async function superAdminToken(superAdmin: f.Row): Promise<string> {
  const secret = generateSecret();
  await ownerQuery('update platform_users set password_hash = $1, totp_enabled = true, totp_secret_enc = $2 where id = $3', [await passwordHash(), encryptSecret(secret, { purpose: 'totp' }), superAdmin.id]);
  const res = await request(t.app).post(api('/auth/platform/login')).send({ email: superAdmin.email, password: PASSWORD, totpCode: await generate({ secret }) });
  if (res.status !== 200) throw new Error(`platform login failed ${res.status}`);
  return res.body.data.accessToken as string;
}

/** Every wave-1 school endpoint addressed with school A's ids and a body valid for it. */
function schoolCalls(): Call[] {
  const i = ids;
  const today = new Date().toISOString().slice(0, 10);
  return [
    // school module
    { method: 'get', path: `/school/holidays/${i.holiday}` },
    { method: 'patch', path: `/school/holidays/${i.holiday}`, body: { name: 'Leaked' } },
    { method: 'delete', path: `/school/holidays/${i.holiday}` },
    { method: 'get', path: `/school/announcements/${i.announcement}` },
    { method: 'patch', path: `/school/announcements/${i.announcement}`, body: { title: 'Leaked' } },
    { method: 'delete', path: `/school/announcements/${i.announcement}` },
    // users module
    { method: 'get', path: `/school/admins/${i.admin}` },
    { method: 'patch', path: `/school/admins/${i.admin}`, body: { fullName: 'Leaked' } },
    { method: 'post', path: `/school/admins/${i.admin}/activate`, body: {} },
    { method: 'post', path: `/school/admins/${i.admin}/deactivate`, body: {} },
    { method: 'post', path: `/school/admins/${i.admin}/reset-access`, body: {} },
    { method: 'delete', path: `/school/admins/${i.admin}` },
    // buses module
    { method: 'get', path: `/school/buses/${i.bus}` },
    { method: 'patch', path: `/school/buses/${i.bus}`, body: { displayName: 'Leaked' } },
    { method: 'patch', path: `/school/buses/${i.bus}/status`, body: { status: 'maintenance' } },
    { method: 'get', path: `/school/buses/${i.bus}/assignment-history` },
    { method: 'post', path: `/school/buses/${i.bus}/assign-staff`, body: { backupDriverId: i.otherDriver } },
    { method: 'get', path: `/school/buses/${i.bus}/images` },
    { method: 'post', path: `/school/buses/${i.bus}/images`, body: { fileId: i.busImageFile } },
    { method: 'put', path: `/school/buses/${i.bus}/images/order`, body: { imageIds: [i.busImage] } },
    { method: 'patch', path: `/school/buses/${i.bus}/images/${i.busImage}`, body: { caption: 'Leaked' } },
    { method: 'delete', path: `/school/buses/${i.bus}/images/${i.busImage}` },
    { method: 'get', path: `/school/buses/${i.bus}/documents` },
    { method: 'post', path: `/school/buses/${i.bus}/documents`, body: { docType: 'pollution', title: 'Leaked' } },
    { method: 'get', path: `/school/bus-documents/${i.busDocument}` },
    { method: 'patch', path: `/school/bus-documents/${i.busDocument}`, body: { title: 'Leaked' } },
    { method: 'put', path: `/school/bus-documents/${i.busDocument}`, body: { title: 'Leaked' } },
    { method: 'patch', path: `/school/bus-documents/${i.busDocument}/visibility`, body: { visibleToParentsFile: true } },
    { method: 'patch', path: `/school/bus-documents/${i.busDocument}/verify`, body: { status: 'verified' } },
    { method: 'delete', path: `/school/bus-documents/${i.busDocument}` },
    { method: 'delete', path: `/school/buses/${i.otherBus}` },
    // staff module
    { method: 'get', path: `/school/staff/${i.driver}` },
    { method: 'patch', path: `/school/staff/${i.driver}`, body: { fullName: 'Leaked' } },
    { method: 'post', path: `/school/staff/${i.driver}/credentials`, body: { username: 'leaked.user' } },
    { method: 'post', path: `/school/staff/${i.driver}/activate`, body: {} },
    { method: 'post', path: `/school/staff/${i.driver}/deactivate`, body: {} },
    { method: 'get', path: `/school/staff/${i.driver}/assignment-history` },
    { method: 'get', path: `/school/staff/${i.driver}/parent-preview` },
    { method: 'get', path: `/school/staff/${i.driver}/documents` },
    { method: 'post', path: `/school/staff/${i.driver}/documents`, body: { docType: 'first_aid', title: 'Leaked' } },
    { method: 'get', path: `/school/staff-documents/${i.driverDocument}` },
    { method: 'patch', path: `/school/staff-documents/${i.driverDocument}`, body: { title: 'Leaked' } },
    { method: 'put', path: `/school/staff-documents/${i.driverDocument}`, body: { title: 'Leaked' } },
    { method: 'patch', path: `/school/staff-documents/${i.driverDocument}/visibility`, body: { visibleToParentsFile: true } },
    { method: 'patch', path: `/school/staff-documents/${i.driverDocument}/verify`, body: { status: 'verified' } },
    { method: 'delete', path: `/school/staff-documents/${i.driverDocument}` },
    { method: 'delete', path: `/school/staff/${i.otherDriver}` },
    // routes module
    { method: 'get', path: `/school/routes/${i.route}` },
    { method: 'patch', path: `/school/routes/${i.route}`, body: { name: 'Leaked' } },
    { method: 'get', path: `/school/routes/${i.route}/stops` },
    { method: 'post', path: `/school/routes/${i.route}/stops`, body: { name: 'Leaked', latitude: 12.9, longitude: 77.6 } },
    { method: 'get', path: `/school/routes/${i.route}/stops/${i.stop}` },
    { method: 'patch', path: `/school/routes/${i.route}/stops/${i.stop}`, body: { name: 'Leaked' } },
    { method: 'put', path: `/school/routes/${i.route}/stops/reorder`, body: { stopIds: [i.stop2, i.stop] } },
    { method: 'delete', path: `/school/routes/${i.route}/stops/${i.stop2}` },
    { method: 'post', path: `/school/routes/${i.route}/recompute-polyline`, body: {} },
    { method: 'get', path: `/school/routes/${i.route}/bus-assignments` },
    { method: 'post', path: `/school/routes/${i.route}/assign-bus`, body: { busId: i.otherBus } },
    { method: 'post', path: `/school/routes/${i.route}/unassign-bus`, body: { busId: i.bus } },
    { method: 'delete', path: `/school/routes/${i.otherRoute}` },
    { method: 'get', path: `/school/trip-schedules/${i.schedule}` },
    { method: 'patch', path: `/school/trip-schedules/${i.schedule}`, body: { name: 'Leaked' } },
    { method: 'delete', path: `/school/trip-schedules/${i.schedule}` },
    { method: 'post', path: '/school/trip-schedules', body: { busId: i.otherBus, routeId: i.route, plannedStartTime: '06:00', daysOfWeek: [7] } },
    // students module
    { method: 'get', path: `/school/students/${i.student}` },
    { method: 'patch', path: `/school/students/${i.student}`, body: { fullName: 'Leaked' } },
    { method: 'get', path: `/school/students/${i.student}/assignment-history` },
    { method: 'put', path: `/school/students/${i.student}/assignment`, body: { effectiveFrom: today, morning: null } },
    { method: 'post', path: `/school/students/${i.student}/parents`, body: { parentId: i.schoolParent } },
    { method: 'delete', path: `/school/students/${i.student}/parents/${i.schoolParent}` },
    { method: 'post', path: '/school/assignments/bulk', body: { studentIds: [i.student], morning: null } },
    { method: 'delete', path: `/school/students/${i.otherStudent}` },
    { method: 'get', path: `/school/parents/${i.schoolParent}` },
    { method: 'patch', path: `/school/parents/${i.schoolParent}`, body: { fullName: 'Leaked' } },
    { method: 'post', path: `/school/parents/${i.schoolParent}/reset-access`, body: {} },
    { method: 'delete', path: `/school/parents/${i.schoolParent}` },
    { method: 'post', path: '/school/students/import', body: { fileId: i.importFile, dryRun: true } },
    { method: 'post', path: '/school/parents/import', body: { fileId: i.importFile, dryRun: true } },
    // B's own resources referencing A's ids (bodies never grant authority)
    { method: 'post', path: `/school/buses/${i.busB}/assign-staff`, body: { backupDriverId: i.otherDriver } },
    { method: 'put', path: `/school/students/${i.studentB}/assignment`, body: { morning: { busId: i.bus, routeId: i.route, stopId: i.stop } } },
    { method: 'post', path: `/school/routes/${i.routeB}/assign-bus`, body: { busId: i.otherBus } },
    { method: 'post', path: `/school/students/${i.studentB}/parents`, body: { parentId: i.schoolParent } },
    { method: 'patch', path: `/school/staff/${i.driverB}`, body: { photoFileId: i.busImageFile } },
  ];
}

/** Endpoints without ids (lists, creates, settings): role gate only. */
const COLLECTION_CALLS: Call[] = [
  'school/profile', 'school/settings', 'school/settings/parent-visibility', 'school/holidays', 'school/announcements', 'school/admins',
  'school/buses', 'school/staff?type=driver', 'school/routes', 'school/trip-schedules', 'school/bus-route-assignments', 'school/students',
  'school/parents', 'school/students/import/template', 'school/parents/import/template',
].map((p) => ({ method: 'get' as const, path: `/${p}` }));

const PLATFORM_CALLS = (schoolId: string): Call[] => [
  { method: 'get', path: '/platform/schools' },
  { method: 'post', path: '/platform/schools', body: {} },
  { method: 'get', path: `/platform/schools/${schoolId}` },
  { method: 'patch', path: `/platform/schools/${schoolId}`, body: { name: 'Leaked' } },
  { method: 'delete', path: `/platform/schools/${schoolId}` },
  { method: 'post', path: `/platform/schools/${schoolId}/logo`, body: {} },
  { method: 'delete', path: `/platform/schools/${schoolId}/logo` },
  { method: 'post', path: `/platform/schools/${schoolId}/activate`, body: {} },
  { method: 'post', path: `/platform/schools/${schoolId}/deactivate`, body: { status: 'suspended' } },
  { method: 'post', path: `/platform/schools/${schoolId}/admin/reset-password`, body: {} },
  { method: 'get', path: `/platform/schools/${schoolId}/subscription` },
  { method: 'put', path: `/platform/schools/${schoolId}/subscription`, body: {} },
  { method: 'get', path: '/platform/settings' },
  { method: 'put', path: '/platform/settings', body: {} },
  { method: 'get', path: '/platform/health' },
  { method: 'get', path: '/platform/usage' },
];

const SNAPSHOT_TABLES = [
  'schools', 'school_settings', 'school_holidays', 'announcements', 'users', 'staff_profiles', 'staff_documents', 'buses', 'bus_images',
  'bus_documents', 'bus_staff_assignments', 'routes', 'stops', 'bus_route_assignments', 'trip_schedules', 'trips', 'students',
  'school_parents', 'student_parents', 'student_assignments', 'files', 'sessions',
];
/** Fingerprint of everything school A owns (owner connection, RLS bypassed). */
async function fingerprint(schoolId: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of SNAPSHOT_TABLES) {
    const col = table === 'schools' ? 'id' : 'school_id';
    const { rows } = await ownerQuery<{ h: string | null }>(`select md5(string_agg(t::text, '|' order by t::text)) as h from ${table} t where ${col} = $1`, [schoolId]);
    out[table] = rows[0]?.h ?? 'empty';
  }
  return out;
}

let before: Record<string, string>;

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  fx = await f.twoSchoolFixture();
  const { a, b } = fx;
  await ownerQuery('update users set password_hash = $1 where id = any ($2)', [await passwordHash(), [a.admin.id, b.admin.id, a.driverUser.id, a.conductorUser.id]]);
  await ownerQuery('update users set pin_hash = $1 where id = $2', [await passwordHash(), a.driverUser.id]); // for the DTO scan
  tok.adminA = (await loginSchoolAdmin(t.app, String(a.admin.email))).accessToken;
  tok.adminB = (await loginSchoolAdmin(t.app, String(b.admin.email))).accessToken;
  tok.driverA = (await loginStaff(t.app, String(a.school.code), String(a.driverUser.phone))).accessToken;
  tok.conductorA = (await loginStaff(t.app, String(a.school.code), String(a.conductorUser.phone), { deviceId: 'device-cond-0001', platform: 'android', model: 'Pixel', appVersion: '1.0.0' })).accessToken;
  tok.parent = (await loginParent(t, String(fx.sharedParent.phone))).accessToken;
  tok.superAdmin = await superAdminToken(fx.superAdmin);
  const holiday = await ownerQuery<{ id: string }>('select id from school_holidays where school_id = $1 limit 1', [a.school.id]);
  Object.assign(ids, {
    holiday: holiday.rows[0]!.id, announcement: a.announcement.id, admin: a.admin.id, bus: a.bus.id, otherBus: a.otherBus.id,
    busImage: a.busImage.id, busDocument: a.busDocument.id, driver: a.driver.id, otherDriver: a.otherDriver.id,
    driverDocument: a.driverDocument.id, route: a.route.id, otherRoute: a.otherRoute.id, stop: a.stop1.id, stop2: a.stop2.id,
    schedule: a.schedule.id, student: a.student.id, otherStudent: a.otherStudent.id, schoolParent: a.schoolParent.id,
    busB: b.bus.id, studentB: b.student.id, routeB: b.route.id, driverB: b.driver.id,
    busImageFile: (await f.file(a.school.id, { category: 'bus_image', entity_type: 'bus', entity_id: a.bus.id })).id,
    importFile: (await f.file(a.school.id, { category: 'import', mime: 'text/csv', entity_type: 'import' })).id,
  });
  before = await fingerprint(a.school.id);
});
afterAll(closeDb);

describe('role bypass (every wave-1 endpoint)', () => {
  it('school endpoints refuse anonymous callers (401)', async () => {
    for (const c of [...schoolCalls(), ...COLLECTION_CALLS]) {
      const res = await send(c, null);
      expect([res.status, res.body.error?.code], `${c.method} ${c.path}`).toEqual([401, 'UNAUTHENTICATED']);
    }
  });

  it('school endpoints refuse drivers, conductors, parents (with X-School-Id) and super admins (403)', async () => {
    const callers: [string, string, Record<string, string>][] = [
      ['driver', tok.driverA, {}],
      ['conductor', tok.conductorA, {}],
      ['parent', tok.parent, { 'X-School-Id': fx.a.school.id }],
      ['super admin', tok.superAdmin, {}],
    ];
    for (const c of [...schoolCalls(), ...COLLECTION_CALLS]) {
      for (const [who, token, headers] of callers) {
        const res = await send(c, token, headers);
        expect([res.status, res.body.error?.code], `${who}: ${c.method} ${c.path}`).toEqual([403, 'FORBIDDEN']);
      }
    }
  });

  it('platform endpoints refuse every school principal (403) and anonymous callers (401)', async () => {
    for (const c of PLATFORM_CALLS(fx.a.school.id)) {
      expect((await send(c, null)).status, `anon ${c.method} ${c.path}`).toBe(401);
      for (const [who, token] of [['admin', tok.adminA], ['driver', tok.driverA], ['conductor', tok.conductorA], ['parent', tok.parent]] as const) {
        const res = await send(c, token, who === 'parent' ? { 'X-School-Id': fx.a.school.id } : {});
        expect([res.status, res.body.error?.code], `${who}: ${c.method} ${c.path}`).toEqual([403, 'FORBIDDEN']);
      }
    }
  });
});

describe('cross-school access (school B admin, school A ids)', () => {
  it('positive control: school A admin reaches every addressed GET', async () => {
    for (const c of schoolCalls().filter((x) => x.method === 'get')) {
      const res = await send(c, tok.adminA);
      expect(res.status, `${c.method} ${c.path}`).toBe(200);
    }
  });

  it('answers 404 NOT_FOUND for every endpoint', async () => {
    const leaks: string[] = [];
    for (const c of schoolCalls()) {
      const res = await send(c, tok.adminB);
      if (res.status !== 404 || res.body.error?.code !== 'NOT_FOUND') leaks.push(`${c.method} ${c.path} → ${res.status} ${JSON.stringify(res.body.error ?? res.body.data).slice(0, 200)}`);
    }
    expect(leaks).toEqual([]);
  });

  it("B's lists and exports never contain school A rows", async () => {
    const aIds = Object.entries(ids).filter(([k]) => !k.endsWith('B')).map(([, v]) => v);
    for (const c of COLLECTION_CALLS) {
      for (const suffix of ['', c.path.includes('?') ? '&format=csv' : '?format=csv']) {
        if (suffix && c.path.includes('template')) continue;
        const res = await send({ ...c, path: `${c.path}${suffix}` }, tok.adminB);
        if (suffix && res.status === 400) continue; // endpoint without CSV export
        expect(res.status, `${c.path}${suffix}`).toBe(200);
        const text = res.text;
        for (const id of aIds) expect(text.includes(id), `${c.path}${suffix} leaks ${id}`).toBe(false);
      }
    }
  });

});

describe('file URLs across schools and roles', () => {
  const url = (id: string, token: string, headers: Record<string, string> = {}) => send({ method: 'get', path: `/files/${id}/url` }, token, headers);
  it('refuses another school, hidden documents and identity documents', async () => {
    const aImage = (await ownerQuery<{ file_id: string }>('select file_id from bus_images where id = $1', [fx.a.busImage.id])).rows[0]!.file_id;
    const bImage = (await ownerQuery<{ file_id: string }>('select file_id from bus_images where id = $1', [fx.b.busImage.id])).rows[0]!.file_id;
    expect((await url(aImage, tok.adminA)).status).toBe(200);
    expect((await url(aImage, tok.adminB)).status).toBe(404);
    expect((await url(bImage, tok.driverA)).status).toBe(404);
    // The shared parent may look at school A's bus image only inside school A.
    expect((await url(aImage, tok.parent, { 'X-School-Id': fx.b.school.id })).status).toBe(404);
    expect((await url(aImage, tok.parent)).status).toBe(400); // X-School-Id is required for parents
    for (const doc of [fx.a.hiddenBusDocument, fx.a.identityDocument]) {
      const table = doc === fx.a.identityDocument ? 'staff_documents' : 'bus_documents';
      const file = await f.file(fx.a.school.id, { category: table === 'bus_documents' ? 'bus_document' : 'staff_document', mime: 'application/pdf' });
      const prev = (await ownerQuery<{ file_id: string | null; updated_at: string }>(`select file_id, updated_at::text as updated_at from ${table} where id = $1`, [doc.id])).rows[0]!;
      await ownerQuery(`update ${table} set file_id = $1 where id = $2`, [file.id, doc.id]);
      expect((await url(file.id, tok.parent, { 'X-School-Id': fx.a.school.id })).status, table).toBe(404);
      // Restore the exact row (the fingerprint check below compares school A before/after).
      await ownerQuery(`alter table ${table} disable trigger user`);
      await ownerQuery(`update ${table} set file_id = $1, updated_at = $2::timestamptz where id = $3`, [prev.file_id, prev.updated_at, doc.id]);
      await ownerQuery(`alter table ${table} enable trigger user`);
      await ownerQuery('delete from files where id = $1', [file.id]);
    }
  });
});

describe('invalid state transitions are refused without side effects', () => {
  const as = (c: Call) => send(c, tok.adminA);
  it('bus, route and staff on an in-progress trip; the last/own admin; an active school', async () => {
    const expectCode = async (c: Call, status: number, code: string) => {
      const res = await as(c);
      expect([res.status, res.body.error?.code], `${c.method} ${c.path}`).toEqual([status, code]);
    };
    await expectCode({ method: 'delete', path: `/school/buses/${ids.bus}` }, 409, 'INVALID_STATE');
    await expectCode({ method: 'patch', path: `/school/buses/${ids.bus}/status`, body: { status: 'maintenance' } }, 409, 'INVALID_STATE');
    await expectCode({ method: 'delete', path: `/school/routes/${ids.route}` }, 409, 'INVALID_STATE');
    await expectCode({ method: 'patch', path: `/school/routes/${ids.route}`, body: { isActive: false } }, 409, 'INVALID_STATE');
    await expectCode({ method: 'post', path: `/school/staff/${ids.driver}/deactivate`, body: {} }, 409, 'INVALID_STATE');
    await expectCode({ method: 'delete', path: `/school/staff/${ids.driver}` }, 409, 'INVALID_STATE');
    await expectCode({ method: 'post', path: `/school/admins/${ids.admin}/deactivate`, body: {} }, 403, 'FORBIDDEN');
    await expectCode({ method: 'delete', path: `/school/admins/${ids.admin}` }, 403, 'FORBIDDEN');
    const res = await send({ method: 'delete', path: `/platform/schools/${fx.a.school.id}` }, tok.superAdmin);
    expect([res.status, res.body.error?.code]).toEqual([409, 'INVALID_STATE']);
  });
});

describe('DTO safety (every wave-1 GET of the school admin, JSON and CSV)', () => {
  it('never exposes secrets, storage keys or global parent account ids', async () => {
    const forbidden = ['$argon2', 'password_hash', 'passwordHash', 'pin_hash', 'pinHash', 'totp', 'refresh_hash', 'whereismybus-test/schools',
      'parent_account_id', 'parentAccountId', String(fx.sharedParent.id), String(fx.a.parent.id)];
    const gets = [...schoolCalls().filter((c) => c.method === 'get'), ...COLLECTION_CALLS];
    for (const c of gets) {
      for (const suffix of ['', c.path.includes('?') ? '&format=csv' : '?format=csv']) {
        const res = await send({ ...c, path: `${c.path}${suffix}` }, tok.adminA);
        if (suffix && res.status === 400) continue;
        expect(res.status, `${c.path}${suffix}`).toBe(200);
        for (const word of forbidden) expect(res.text.includes(word), `${c.path}${suffix} contains ${word}`).toBe(false);
      }
    }
  });
});

describe('no trace', () => {
  it('left no trace in school A: data unchanged and no audit rows by B', async () => {
    expect(await fingerprint(fx.a.school.id)).toEqual(before);
    const audits = await ownerQuery<{ n: number }>('select count(*)::int as n from audit_logs where school_id = $1 and actor_id = $2', [fx.a.school.id, fx.b.admin.id]);
    expect(audits.rows[0]!.n).toBe(0);
  });
});
