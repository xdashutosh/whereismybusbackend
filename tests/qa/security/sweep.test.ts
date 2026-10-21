// Generic sweep over EVERY route registered in the module routers (not a hand-kept list): role
// bypass for each area and cross-school ids on every :param route of /school/* (BP §4.9).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { modules } from '../../../src/modules/index.js';
import { closeDb, ownerQuery } from '../../helpers/db.js';
import { loginStaff } from '../../helpers/authApp.js';
import { buildWorld, call, fingerprint, type Method, type World } from './world.js';

let w: World;
let driverB: { accessToken: string };
const ROUTES: { method: Method; path: string }[] = [];

function walk(stack: unknown[]) {
  for (const l of stack as { route?: { path: string; methods: Record<string, boolean> }; handle?: { stack?: unknown[] } }[]) {
    if (l.route) for (const m of Object.keys(l.route.methods)) ROUTES.push({ method: m as Method, path: l.route.path });
    else if (l.handle?.stack) walk(l.handle.stack);
  }
}
for (const m of modules) walk((m.router as unknown as { stack: unknown[] }).stack);

const PUBLIC = new Set(['/auth/platform/login', '/auth/platform/totp/setup', '/auth/platform/totp/verify', '/auth/school/login', '/auth/staff/login', '/auth/parent/otp/request', '/auth/parent/otp/verify', '/auth/parent/password-login', '/auth/refresh', '/auth/logout', '/files/local/upload', '/files/local/download', '/auth/legal', '/auth/school/branding']);
const ZERO = '00000000-0000-4000-8000-000000000000';
const fill = (p: string, id = ZERO) => p.replace(/:[A-Za-z]+/g, id);
const TABLES = ['buses', 'bus_documents', 'bus_images', 'staff_profiles', 'staff_documents', 'routes', 'stops', 'trip_schedules', 'students', 'school_parents', 'student_parents', 'student_assignments', 'trips', 'alerts', 'fuel_logs', 'maintenance_logs', 'school_holidays', 'announcements', 'users', 'files', 'school_settings'] as const;

beforeAll(async () => {
  w = await buildWorld();
  driverB = await loginStaff(w.t.app, String(w.fx.b.school.code), String(w.fx.b.driverUser.phone), { deviceId: 'device-bbbb-0001', platform: 'android', model: 'X', appVersion: '1.0.0' });
});
afterAll(closeDb);

describe('route inventory', () => {
  it('found the full API surface', () => {
    expect(ROUTES.length).toBeGreaterThan(180);
  });
});

describe('role bypass on every registered route', () => {
  it('anonymous callers get 401 on every non-public route', async () => {
    const bad: string[] = [];
    for (const r of ROUTES) {
      if (PUBLIC.has(r.path)) continue;
      const res = await call(w.t, r.method, fill(r.path), null, { body: {} });
      if (res.status !== 401) bad.push(`${r.method.toUpperCase()} ${r.path} → ${res.status}`);
    }
    expect(bad).toEqual([]);
  });

  it('each role is refused outside its area (403/401, never 2xx)', async () => {
    const A = String(w.fx.a.school.id);
    const actors: { name: string; token: string; headers?: Record<string, string>; deny: RegExp }[] = [
      { name: 'parent', token: w.parent.accessToken, headers: { 'X-School-Id': A }, deny: /^\/(school|platform|driver)\// },
      { name: 'driver', token: w.driverA.accessToken, headers: { 'X-Device-Id': 'device-aaaa-0001' }, deny: /^\/(school|platform|parent)\// },
      { name: 'conductor', token: w.conductorA.accessToken, headers: { 'X-Device-Id': 'device-cond-0001' }, deny: /^\/(school|platform|parent)\// },
      { name: 'school_admin', token: w.adminA.accessToken, deny: /^\/(platform|driver|parent)\// },
      { name: 'super_admin', token: w.superAdmin.accessToken, headers: { 'X-School-Id': A }, deny: /^\/(school|driver|parent)\// },
    ];
    const bad: string[] = [];
    for (const a of actors) {
      for (const r of ROUTES) {
        if (!a.deny.test(r.path)) continue;
        const res = await call(w.t, r.method, fill(r.path), a.token, { body: {}, headers: a.headers ?? {} });
        if (res.status !== 403 && res.status !== 401) bad.push(`${a.name} ${r.method.toUpperCase()} ${r.path} → ${res.status}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("cross-school ids on every /school/* and /driver/* :param route (B's token, A's ids)", () => {
  async function idsOfA(): Promise<Record<string, string[]>> {
    const a = w.fx.a;
    const holiday = (await ownerQuery<{ id: string }>('select id from school_holidays where school_id = $1 limit 1', [a.school.id])).rows[0]!.id;
    const imageFile = (await ownerQuery<{ file_id: string }>('select file_id from bus_images where id = $1', [a.busImage.id])).rows[0]!.file_id;
    const s = (v: { id: unknown }) => String(v.id);
    return {
      '/school/holidays': [holiday],
      '/school/announcements': [s(a.announcement)],
      '/school/admins': [s(a.admin)],
      '/school/staff': [s(a.driver), s(a.conductor)],
      '/school/staff-documents': [s(a.driverDocument), s(a.identityDocument)],
      '/school/buses': [s(a.bus)],
      'imageId': [s(a.busImage)],
      '/school/bus-documents': [s(a.busDocument), s(a.hiddenBusDocument)],
      '/school/routes': [s(a.route)],
      'stopId': [s(a.stop1)],
      '/school/trip-schedules': [s(a.schedule)],
      '/school/students': [s(a.student)],
      'parentId': [s(a.parent), s(a.schoolParent)],
      '/school/parents': [s(a.schoolParent), s(a.parent)],
      '/school/trips': [s(a.trip), s(a.nonSchoolTrip)],
      '/driver/trips': [s(a.trip)],
      '/school/alerts': [s(a.alert)],
      '/school/fuel-logs': [s(a.fuelLog)],
      '/school/maintenance-logs': [s(a.maintenanceLog)],
      '/files': [imageFile],
    };
  }

  it('no 2xx, no A ids in any response body, and school A unchanged', async () => {
    const ids = await idsOfA();
    const allA = Object.values(ids).flat();
    const before = await fingerprint(String(w.fx.a.school.id), TABLES);
    const bad: string[] = [];
    let probes = 0;
    for (const r of ROUTES) {
      if (!/^\/(school|driver|files)\//.test(r.path) || !r.path.includes('/:') || r.path.startsWith('/files/local')) continue;
      const base = Object.keys(ids).find((k) => k.startsWith('/') && r.path.startsWith(`${k}/:`));
      const firstIds = base ? ids[base]! : [ZERO];
      for (const first of firstIds) {
        let n = 0;
        const path = r.path.replace(/:([A-Za-z]+)/g, (_m, name: string) => (n++ === 0 ? first : (ids[name]?.[0] ?? ZERO)));
        const isDriver = r.path.startsWith('/driver/');
        const token = isDriver ? driverB.accessToken : w.adminB.accessToken;
        const headers: Record<string, string> = isDriver ? { 'X-Device-Id': 'device-bbbb-0001' } : {};
        const body = { reason: 'probe', name: 'probe', notes: 'probe', status: 'inactive', isActive: false, title: 'probe' };
        const res = await call(w.t, r.method, path, token, { body, headers });
        probes += 1;
        const text = res.text ?? '';
        const echoed = allA.filter((id) => text.includes(id) && !path.includes(id));
        if ((res.status >= 200 && res.status < 300) || echoed.length) bad.push(`${r.method.toUpperCase()} ${path.replaceAll(first, '<A>')} → ${res.status} ${echoed.length ? `leaks ${echoed.join(',')}` : text.slice(0, 160)}`);
      }
    }
    expect(probes).toBeGreaterThan(60);
    expect(bad).toEqual([]);
    expect(await fingerprint(String(w.fx.a.school.id), TABLES)).toEqual(before);
  });
});

describe("every /school/* list/report/export with school A's ids as filters (B's token)", () => {
  it('never contains an A id or A-only marker in JSON, CSV or PDF', async () => {
    const a = w.fx.a;
    const MARK = 'ZZA-ONLY-MARK';
    await ownerQuery('update buses set display_name = $1 where id = $2', [MARK, a.bus.id]);
    await ownerQuery('update students set full_name = $1 where id = $2', [MARK, a.student.id]);
    await ownerQuery('update staff_profiles set full_name = $1 where id = $2', [MARK, a.driver.id]);
    const aIds = [a.bus, a.otherBus, a.route, a.stop1, a.student, a.driver, a.trip, a.alert, a.fuelLog, a.maintenanceLog, a.schedule, a.schoolParent, a.parent, a.admin].map((x) => String(x.id));
    const q = `busId=${a.bus.id}&routeId=${a.route.id}&stopId=${a.stop1.id}&studentId=${a.student.id}&staffId=${a.driver.id}&driverId=${a.driver.id}&tripId=${a.trip.id}&parentId=${a.schoolParent.id}&entityId=${a.bus.id}&actorId=${a.admin.id}&schoolId=${a.school.id}&school_id=${a.school.id}`;
    const bad: string[] = [];
    for (const r of ROUTES) {
      if (r.method !== 'get' || !r.path.startsWith('/school/') || r.path.includes('/:') || r.path.includes('template')) continue;
      for (const fmt of ['', '&format=csv', '&format=pdf']) {
        for (const query of [q, `${q}&q=Aarav`, '']) {
          const res = await call(w.t, 'get', `${r.path}?${query}${fmt}`, w.adminB.accessToken);
          const text = res.text ?? (Buffer.isBuffer(res.body) ? res.body.toString('latin1') : '');
          const hits = [...aIds, MARK].filter((id) => text.includes(id) && !query.includes(id));
          if (hits.length) bad.push(`${r.path}?${query.slice(0, 20)}${fmt} → ${res.status} leaks ${hits.join(',')}`);
          if (res.status >= 500) bad.push(`${r.path}${fmt} → ${res.status}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
