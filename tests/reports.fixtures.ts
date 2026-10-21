// Fixtures of the reports / dashboard suites: a school world with crafted trips, fuel and maintenance
// logs and alerts whose report numbers are known in advance. Two worlds share identical bus codes and
// names (BP §4.9); `scale` multiplies school B's quantities so a leak would change A's numbers.
import type { Express } from 'express';
import { generate, generateSecret } from 'otplib';
import request from 'supertest';
import { encryptSecret } from '../src/shared/crypto.js';
import { DEVICE, loginParent, loginSchoolAdmin, loginStaff, PASSWORD, passwordHash, schoolAdmin, staffUser, type TestApp, type Tokens } from './helpers/authApp.js';
import * as f from './helpers/factories.js';

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** School-local calendar day `offset` days from now in `timezone`. */
export function localDay(timezone: string, offset = 0): string {
  return new Date(Date.now() + offset * 86_400_000).toLocaleDateString('en-CA', { timeZone: timezone });
}

export interface ReportsWorld {
  school: f.Row;
  sid: string;
  admin: Tokens;
  today: string;
  r1: f.TenantRow;
  r2: f.TenantRow;
  r8Deleted: f.TenantRow;
  driver: f.TenantRow;
  trips: { t1: f.TenantRow; t2: f.TenantRow; t3: f.TenantRow; t4: f.TenantRow; t5: f.TenantRow; old: f.TenantRow; r8: f.TenantRow };
  maintenance: { oil: f.TenantRow; oilOld: f.TenantRow; brake: f.TenantRow; tyre: f.TenantRow };
}

const at = (day: string, hhmm: string) => `${day}T${hhmm}:00Z`;

/**
 * Bus R1 (odometer 50 100 km) in range [today-10, today]:
 *   t1 school morning, completed, odo 20.0 / gps 19.0, planned 01:30Z started 01:35Z (on time)   day -5
 *   t2 school afternoon, completed, gps 15.5 only, planned 08:30Z started 08:55Z (25 min late)    day -5
 *   t3 non-school, completed, odo 30.0, 2 h, purpose 'Picnic'                                     day -4
 *   t4 school morning, missed                                                                      day -4
 *   t5 school morning, auto_closed, gps 5.0, no planned start                                      day -3
 *   old: completed odo 100 at day -60 (outside the range)
 * Fuel R1: 40 L / 3800 (odo 49 000) + 20 L / 2000 (odo 49 500) in range → 500 odometer km over 20 L, a
 *   deleted fill and an old fill without a reading outside it. R2: 10 L / 1000, no mileage base.
 * Maintenance R1: Oil change 2500 (day -2, next due today+3), Brake check no cost (day -1, next due
 *   today+60), Tyre rotation (day -200, next due 50 000 km → overdue), an older 'oil change' log
 *   (day -100, next due day -10) superseded by the newer one.
 * R8 deleted with one completed trip (odo 12.0) in range; R9 deleted and idle.
 */
export async function reportsWorld(app: Express, { scale = 1, name = 'Greenfield Public School' }: { scale?: number; name?: string } = {}): Promise<ReportsWorld> {
  const tz = 'Asia/Kolkata';
  const school = await f.school({ name, timezone: tz });
  const sid = school.id;
  await f.schoolSubscription(sid);
  const adminUser = await schoolAdmin(sid, { full_name: 'Anita Rao' });
  const today = localDay(tz);
  const day = (n: number) => localDay(tz, n);
  const r1 = await f.bus(sid, { code: 'R1', registration_no: 'KA01AB1001', last_known_odometer: 50100, fuel_type: 'diesel' });
  const r2 = await f.bus(sid, { code: 'R2', registration_no: 'KA01AB1002', status: 'maintenance' });
  const r8Deleted = await f.bus(sid, { code: 'R8', registration_no: 'KA01AB1008', deleted_at: new Date().toISOString() });
  await f.bus(sid, { code: 'R9', registration_no: 'KA01AB1009', deleted_at: new Date().toISOString() });
  const driver = await f.staffProfile(sid, { full_name: 'Ramesh Kumar', staff_type: 'driver' });
  const snap = { bus_code_snapshot: 'R1', bus_registration_snapshot: 'KA01AB1001', driver_staff_id: driver.id, driver_name_snapshot: 'Ramesh Kumar' };
  const d5 = day(-5);
  const d4 = day(-4);
  const d3 = day(-3);
  const t1 = await f.trip(sid, r1.id, {
    ...snap, trip_date: d5, direction: 'morning', status: 'completed', planned_start_at: at(d5, '01:30'), started_at: at(d5, '01:35'), ended_at: at(d5, '02:35'),
    start_odometer: 1000, end_odometer: 1000 + 20 * scale, distance_odometer_km: 20 * scale, distance_gps_km: 19 * scale,
  });
  const t2 = await f.trip(sid, r1.id, {
    ...snap, trip_date: d5, direction: 'afternoon', status: 'completed', planned_start_at: at(d5, '08:30'), started_at: at(d5, '08:55'), ended_at: at(d5, '09:40'),
    distance_gps_km: 15.5 * scale,
  });
  const t3 = await f.trip(sid, r1.id, {
    ...snap, trip_type: 'non_school', direction: null, purpose: 'Picnic', trip_date: d4, status: 'completed', started_at: at(d4, '04:00'), ended_at: at(d4, '06:00'),
    start_odometer: 2000, end_odometer: 2000 + 30 * scale, distance_odometer_km: 30 * scale,
  });
  const t4 = await f.trip(sid, r1.id, { ...snap, trip_date: d4, direction: 'morning', status: 'missed', planned_start_at: at(d4, '01:30') });
  const t5 = await f.trip(sid, r1.id, { ...snap, trip_date: d3, direction: 'morning', status: 'auto_closed', started_at: at(d3, '01:30'), ended_at: at(d3, '02:00'), distance_gps_km: 5 * scale });
  const old = await f.trip(sid, r1.id, { ...snap, trip_date: day(-60), status: 'completed', started_at: at(day(-60), '01:30'), ended_at: at(day(-60), '02:30'), distance_odometer_km: 100 });
  const r8 = await f.trip(sid, r8Deleted.id, { bus_code_snapshot: 'R8', trip_date: d3, status: 'completed', started_at: at(d3, '01:30'), ended_at: at(d3, '02:30'), distance_odometer_km: 12 * scale });
  await f.alert(sid, { alert_type: 'odometer_gps_mismatch', trip_id: t2.id, bus_id: r1.id, title: 'Odometer vs GPS on R1', dedupe_key: `odometer_gps_mismatch:${t2.id}` });

  await f.fuelLog(sid, r1.id, { fuel_date: day(-6), litres: 40 * scale, cost: 3800 * scale, odometer: 49000 });
  await f.fuelLog(sid, r1.id, { fuel_date: day(-2), litres: 20 * scale, cost: 2000 * scale, odometer: 49500 });
  await f.fuelLog(sid, r1.id, { fuel_date: day(-1), litres: 99, cost: 9999, deleted_at: new Date().toISOString() });
  await f.fuelLog(sid, r1.id, { fuel_date: day(-40), litres: 77, cost: 7777, odometer: null });
  await f.fuelLog(sid, r2.id, { fuel_date: day(-3), litres: 10 * scale, cost: 1000 * scale });

  const oilOld = await f.maintenanceLog(sid, r1.id, { service_type: 'oil change', service_date: day(-100), cost: 2000, next_due_date: day(-10) });
  const oil = await f.maintenanceLog(sid, r1.id, { service_type: 'Oil change', service_date: day(-2), cost: 2500 * scale, odometer: 50000, vendor: 'City Motors', next_due_date: day(3) });
  const brake = await f.maintenanceLog(sid, r1.id, { service_type: 'Brake check', service_date: day(-1), cost: null, next_due_date: day(60) });
  const tyre = await f.maintenanceLog(sid, r1.id, { service_type: 'Tyre rotation', service_date: day(-200), cost: 1500, next_due_date: null, next_due_km: 50000 });

  const admin = await loginSchoolAdmin(app, String(adminUser.email));
  return { school, sid, admin, today, r1, r2, r8Deleted, driver, trips: { t1, t2, t3, t4, t5, old, r8 }, maintenance: { oil, oilOld, brake, tyre } };
}

/** Signed-in principals that must never reach /school/reports or /school/dashboard of `w`. */
export async function outsiders(t: TestApp, w: ReportsWorld, deviceId: string): Promise<{ driver: string; parent: string; superAdmin: string }> {
  const driverUser = await staffUser(w.sid, 'driver');
  const driver = await loginStaff(t.app, String(w.school.code), String(driverUser.phone), { ...DEVICE, deviceId });
  const child = await f.student(w.sid);
  const p = await f.parentAccount();
  await f.schoolParent(w.sid, p.id);
  await f.studentParent(w.sid, child.id, p.id);
  const parent = await loginParent(t, String(p.phone));
  const secret = generateSecret();
  const su = await f.platformUser({ password_hash: await passwordHash(), totp_enabled: true, totp_secret_enc: encryptSecret(secret, { purpose: 'totp' }) });
  const login = await request(t.app).post('/api/v1/auth/platform/login').send({ email: su.email, password: PASSWORD, totpCode: await generate({ secret }) });
  if (login.status !== 200) throw new Error(`platform login failed ${login.status}`);
  return { driver: driver.accessToken, parent: parent.accessToken, superAdmin: login.body.data.accessToken as string };
}
