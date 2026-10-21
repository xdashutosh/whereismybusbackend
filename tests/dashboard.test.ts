// School dashboard (BP §8.3 Dashboard, §13.3 Dashboard): bus totals, today's trips (school-local day,
// not-started grace), alert tiles (expiry, odometer, safety, trip operations, service), current
// document expiries, people counts, latest alerts and quick links — on a crafted fixture, in far-east
// and far-west timezones, and isolated per school (BP §4.9).
import type { SchoolDashboard } from '@wimb/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, loginSchoolAdmin, schoolAdmin, type TestApp, type Tokens } from './helpers/authApp.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { auth, localDay, outsiders, reportsWorld } from './reports.fixtures.js';

let t: TestApp;
let a: { sid: string; admin: Tokens; ids: Record<string, string>; today: string };
let b: { sid: string; admin: Tokens };

const TZ = 'Asia/Kolkata';
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

async function newSchool(timezone = TZ) {
  const school = await f.school({ timezone });
  await f.schoolSubscription(school.id);
  const admin = await loginSchoolAdmin(t.app, String((await schoolAdmin(school.id)).email));
  return { school, sid: school.id, admin };
}

async function dashboardWorld() {
  const { sid, admin } = await newSchool();
  const today = localDay(TZ);
  const day = (n: number) => localDay(TZ, n);
  const b1 = await f.bus(sid, { code: 'R1' });
  const b2 = await f.bus(sid, { code: 'R2' });
  const b3 = await f.bus(sid, { code: 'R3', status: 'maintenance' });
  const b4 = await f.bus(sid, { code: 'R4', status: 'retired' });
  const b5 = await f.bus(sid, { code: 'R5', status: 'inactive' });
  await f.bus(sid, { code: 'R6', deleted_at: daysAgo(1) });
  const done = { started_at: minutesAgo(180), ended_at: minutesAgo(120) };
  const c1 = await f.trip(sid, b1.id, { trip_date: today, status: 'completed', ...done });
  await f.trip(sid, b2.id, { trip_date: today, status: 'in_progress', started_at: minutesAgo(10) });
  const c3 = await f.trip(sid, b3.id, { trip_date: today, status: 'missed', planned_start_at: minutesAgo(200) });
  await f.trip(sid, b1.id, { trip_date: today, direction: 'afternoon', status: 'scheduled', planned_start_at: minutesAgo(30) });
  await f.trip(sid, b2.id, { trip_date: today, direction: 'afternoon', status: 'scheduled', planned_start_at: new Date(Date.now() + 7_200_000).toISOString() });
  await f.trip(sid, b3.id, { trip_date: today, direction: 'afternoon', status: 'scheduled', planned_start_at: minutesAgo(5) });
  await f.trip(sid, b4.id, { trip_date: today, status: 'cancelled' });
  const c8 = await f.trip(sid, b5.id, { trip_date: today, trip_type: 'non_school', direction: null, purpose: 'Sports meet', status: 'completed', ...done });
  await f.trip(sid, b3.id, { trip_date: day(-1), status: 'in_progress', started_at: daysAgo(1) });
  await f.trip(sid, b1.id, { trip_date: day(1), status: 'scheduled' });

  const alert = (o: f.Values) => f.alert(sid, { dedupe_key: null, ...o });
  const expired = await alert({ alert_type: 'doc_expired', severity: 'critical', title: 'Insurance of R1 expired', bus_id: b1.id, created_at: minutesAgo(1) });
  const gap = await alert({ alert_type: 'odometer_gap', severity: 'critical', title: 'Odometer gap on R1', trip_id: c1.id, bus_id: b1.id, created_at: minutesAgo(2) });
  const service = await alert({ alert_type: 'service_due', severity: 'critical', title: 'Oil change overdue', bus_id: b2.id, created_at: minutesAgo(3) });
  const speeding = await alert({ alert_type: 'speeding', severity: 'warning', title: 'Speeding on R2', bus_id: b2.id, created_at: minutesAgo(4) });
  const notStarted = await alert({ alert_type: 'trip_not_started', severity: 'warning', title: 'R3 morning trip not started', trip_id: c3.id, created_at: minutesAgo(5) });
  await alert({ alert_type: 'doc_expiring', severity: 'warning', status: 'escalated', title: 'Fitness expiring', created_at: daysAgo(2) });
  await alert({ alert_type: 'doc_missing', severity: 'warning', status: 'closed', title: 'Permit missing', created_at: daysAgo(1), closed_at: daysAgo(1) });
  await alert({ alert_type: 'odometer_gps_mismatch', severity: 'warning', status: 'reviewed', title: 'Odo vs GPS', trip_id: c8.id, created_at: daysAgo(3), review_note: 'ok' });
  await alert({ alert_type: 'odometer_decrease', severity: 'critical', status: 'closed', title: 'Odometer decreased', created_at: daysAgo(20), closed_at: daysAgo(19) });
  await alert({ alert_type: 'route_deviation', severity: 'warning', status: 'reviewed', title: 'Deviation', created_at: daysAgo(1), review_note: 'detour' });
  await alert({ alert_type: 'long_stop', severity: 'warning', title: 'Long stop', created_at: daysAgo(10) });
  await alert({ alert_type: 'low_battery', severity: 'warning', status: 'closed', title: 'Low battery', created_at: daysAgo(30), closed_at: daysAgo(30) });

  await f.busDocument(sid, b1.id, { doc_type: 'insurance', expiry_date: day(-1) });
  await f.busDocument(sid, b1.id, { doc_type: 'fitness', expiry_date: today });
  await f.busDocument(sid, b2.id, { doc_type: 'insurance', expiry_date: day(10) });
  await f.busDocument(sid, b2.id, { doc_type: 'fitness', expiry_date: day(60) });
  await f.busDocument(sid, b1.id, { doc_type: 'pollution', expiry_date: day(-30), is_current: false });
  await f.busDocument(sid, b4.id, { doc_type: 'insurance', expiry_date: day(-5) });
  const d1 = await f.staffProfile(sid, { staff_type: 'driver', licence_expiry_date: day(5) });
  await f.staffProfile(sid, { staff_type: 'driver' });
  const gone = await f.staffProfile(sid, { staff_type: 'driver', is_active: false });
  const cond = await f.staffProfile(sid, { staff_type: 'conductor' });
  await f.staffDocument(sid, d1.id, { doc_type: 'licence_front', expiry_date: day(-3) });
  await f.staffDocument(sid, cond.id, { doc_type: 'police_verification', expiry_date: day(-2) });
  await f.staffDocument(sid, gone.id, { doc_type: 'police_verification', expiry_date: day(-2) });

  const route = await f.route(sid, { code: 'R1' });
  const stop = await f.stop(sid, route.id);
  const assign = (studentId: string, o: f.Values) => f.studentAssignment(sid, { studentId, busId: b1.id, routeId: route.id, stopId: stop.id }, o);
  await assign((await f.student(sid)).id, { valid_from: day(-30) });
  await assign((await f.student(sid)).id, { valid_from: day(-30), valid_to: today });
  await f.student(sid);
  await assign((await f.student(sid)).id, { valid_from: day(5) });
  await f.student(sid, { is_active: false });
  await f.student(sid, { deleted_at: daysAgo(1) });
  for (const o of [{}, {}, { is_active: false }, { deleted_at: daysAgo(1) }]) await f.schoolParent(sid, (await f.parentAccount()).id, o);

  return { sid, admin, today, ids: { expired: expired.id, gap: gap.id, service: service.id, speeding: speeding.id, notStarted: notStarted.id, b1: b1.id } };
}

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  a = await dashboardWorld();
  const w = await reportsWorld(t.app, { name: 'Other School', scale: 10 });
  b = { sid: w.sid, admin: w.admin };
});
afterAll(closeDb);

const get = (token: string) => request(t.app).get('/api/v1/school/dashboard').set(auth(token));
async function dash(token: string): Promise<SchoolDashboard> {
  const res = await get(token);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as SchoolDashboard;
}

describe('GET /school/dashboard', () => {
  it('counts buses and today’s trips with the not-started grace', async () => {
    const d = await dash(a.admin.accessToken);
    expect(d.localDate).toBe(a.today);
    expect(d.timezone).toBe(TZ);
    expect(Date.parse(d.generatedAt)).toBeGreaterThan(Date.now() - 60_000);
    expect(d.buses).toEqual({ total: 5, active: 2, maintenance: 1, inactive: 1, retired: 1, onTripNow: 2 });
    expect(d.trips).toEqual({
      activeNow: 2,
      today: { total: 8, upcoming: 2, notStarted: 2, inProgress: 1, completed: 2, autoClosed: 0, cancelled: 1, nonSchool: 1 },
    });
  });

  it('groups unresolved and recent alerts into expiry, odometer, safety, trip and service tiles', async () => {
    const d = await dash(a.admin.accessToken);
    expect(d.alerts.open).toBe(7);
    expect(d.alerts.critical).toBe(3);
    expect(d.alerts.byGroup).toEqual({
      expiry: { open: 2, critical: 1, recent: 3 },
      odometer: { open: 1, critical: 1, recent: 2 },
      safety: { open: 2, critical: 0, recent: 2 },
      tripOps: { open: 1, critical: 0, recent: 1 },
      service: { open: 1, critical: 1, recent: 1 },
    });
    expect(d.odometer).toEqual({ discrepancyTripsRecent: 2, recentDays: 7 });
    expect(d.alerts.latest.map((x) => x.id)).toEqual([a.ids.expired, a.ids.gap, a.ids.service, a.ids.speeding, a.ids.notStarted]);
    expect(d.alerts.latest[0]).toMatchObject({ alertType: 'doc_expired', severity: 'critical', status: 'open', title: 'Insurance of R1 expired', busId: a.ids.b1, busCode: 'R1' });
    expect(d.alerts.latest[0]!.createdAt).toMatch(/Z$/);
  });

  it('counts current document expiries in the scan scope and people', async () => {
    const d = await dash(a.admin.accessToken);
    expect(d.documents).toEqual({ expired: 2, expiringSoon: 3, windowDays: 30 });
    expect(d.people).toEqual({ students: 4, unassignedStudents: 3, drivers: 2, conductors: 1, parents: 2 });
  });

  it('returns quick links with counts and states for the web admin', async () => {
    const d = await dash(a.admin.accessToken);
    const link = (key: string) => d.quickLinks.find((l) => l.key === key)!;
    expect(d.quickLinks.map((l) => l.key)).toEqual(['liveFleet', 'trips', 'alerts', 'buses', 'maintenance', 'students', 'reports']);
    expect(link('liveFleet')).toEqual({ key: 'liveFleet', label: 'Live fleet', path: '/school/live-fleet', count: 2, state: 'positive' });
    expect(link('trips')).toMatchObject({ path: `/school/trips?period=${a.today}..${a.today}`, count: 8, state: 'critical' });
    expect(link('alerts')).toMatchObject({ count: 7, state: 'negative' });
    expect(link('buses')).toMatchObject({ count: 5, state: 'negative' });
    expect(link('maintenance')).toMatchObject({ count: 1, state: 'negative' });
    expect(link('students')).toMatchObject({ count: 3, state: 'critical' });
    expect(link('reports')).toMatchObject({ path: '/school/reports', count: null, state: 'none' });
  });

  it('an empty school gets zeros everywhere', async () => {
    const { admin } = await newSchool();
    const d = await dash(admin.accessToken);
    expect(d.buses.total).toBe(0);
    expect(d.trips.today.total).toBe(0);
    expect(d.alerts).toMatchObject({ open: 0, critical: 0, latest: [] });
    expect(Object.values(d.alerts.byGroup).every((g) => g.open === 0 && g.recent === 0)).toBe(true);
    expect(d.documents).toMatchObject({ expired: 0, expiringSoon: 0 });
    expect(d.people).toEqual({ students: 0, unassignedStudents: 0, drivers: 0, conductors: 0, parents: 0 });
    expect(d.quickLinks.find((l) => l.key === 'alerts')).toMatchObject({ count: 0, state: 'none' });
  });

  it('is not gated by the reports feature flag', async () => {
    const { sid, admin } = await newSchool();
    await ownerQuery(`update school_settings set features = features || '{"reports": false}'::jsonb where school_id = $1`, [sid]);
    expect((await get(admin.accessToken)).status).toBe(200);
  });
});

describe('school-local day', () => {
  for (const tz of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
    it(`counts only trips of the school-local today (${tz})`, async () => {
      const { sid, admin } = await newSchool(tz);
      const bus = await f.bus(sid, { code: 'R1' });
      const other = await f.bus(sid, { code: 'R2' });
      const today = localDay(tz);
      await f.trip(sid, bus.id, { trip_date: today, status: 'completed', started_at: minutesAgo(60), ended_at: minutesAgo(30) });
      await f.trip(sid, bus.id, { trip_date: localDay(tz, -1), status: 'missed' });
      await f.trip(sid, other.id, { trip_date: localDay(tz, 1), status: 'scheduled' });
      const d = await dash(admin.accessToken);
      expect(d.localDate).toBe(today);
      expect(d.timezone).toBe(tz);
      expect(d.trips.today).toMatchObject({ total: 1, completed: 1, notStarted: 0, upcoming: 0 });
    });
  }
});

describe('tenant isolation (BP §4.9)', () => {
  it('each school sees only its own counts', async () => {
    const d = await dash(b.admin.accessToken);
    expect(d.buses).toMatchObject({ total: 2, active: 1, maintenance: 1, onTripNow: 0 });
    expect(d.alerts.open).toBe(1);
    expect(d.alerts.latest.map((x) => x.title)).toEqual(['Odometer vs GPS on R1']);
    expect(d.people.students).toBe(0);
    const again = await dash(a.admin.accessToken);
    expect(again.alerts.open).toBe(7);
    expect(again.buses.total).toBe(5);
  });

  it('drivers, parents, super admins and anonymous callers are refused', async () => {
    const w = await reportsWorld(t.app, { name: 'Third School' });
    const o = await outsiders(t, w, 'dash-driver-0001');
    for (const [who, token] of Object.entries(o)) expect((await get(token)).status, who).toBe(403);
    expect((await request(t.app).get('/api/v1/school/dashboard')).status).toBe(401);
  });
});
