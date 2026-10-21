// Fixtures of the trips suites: a school with a bus served by a primary driver, a conductor and a
// backup driver (each signed in through the real staff login on its own device), a morning route with
// stops, a schedule and today's scheduled trip, plus helpers for odometer photos and driver requests.
import crypto from 'node:crypto';
import request from 'supertest';
import { buildApp, loginSchoolAdmin, loginStaff, schoolAdmin, staffUser, type TestApp } from './helpers/authApp.js';
import { ownerQuery } from './helpers/db.js';
import * as f from './helpers/factories.js';

export const api = (path: string) => `/api/v1${path}`;

export interface StaffActor {
  user: f.TenantRow;
  staff: f.TenantRow;
  token: string;
  deviceId: string;
  /** devices.id of the bound device. */
  deviceRowId: string;
}

export interface TripWorld {
  t: TestApp;
  school: f.Row;
  sid: string;
  adminToken: string;
  admin: f.TenantRow;
  driver: StaffActor;
  conductor: StaffActor;
  backup: StaffActor;
  bus: f.TenantRow;
  route: f.TenantRow;
  stops: f.TenantRow[];
  schedule: f.TenantRow;
  /** Today's scheduled trip of the schedule. */
  trip: f.TenantRow;
  today: string;
}

export async function localDate(timezone = 'Asia/Kolkata', offsetDays = 0): Promise<string> {
  const { rows } = await ownerQuery<{ d: string }>(`select ((now() at time zone $1)::date + $2::int)::text as d`, [timezone, offsetDays]);
  return rows[0]!.d;
}

export async function staffActor(t: TestApp, school: f.Row, type: 'driver' | 'conductor', name: string): Promise<StaffActor> {
  const user = await staffUser(school.id, type, { full_name: name });
  const staff = await f.staffProfile(school.id, { staff_type: type, full_name: name, user_id: user.id });
  const deviceId = `dev-${crypto.randomUUID()}`;
  const tokens = await loginStaff(t.app, String(school.code), String(user.phone), { deviceId, platform: 'android', model: 'Pixel 8', appVersion: '1.0.0' });
  const { rows } = await ownerQuery<{ id: string }>('select id from devices where owner_id = $1 and device_uid = $2', [user.id, deviceId]);
  return { user, staff, token: tokens.accessToken, deviceId, deviceRowId: rows[0]!.id };
}

export async function tripWorld(t: TestApp = buildApp(), o: { settings?: f.Values } = {}): Promise<TripWorld> {
  const school = await f.school({ name: 'Greenfield Public School' });
  const sid = school.id;
  if (o.settings) await f.schoolSettings(sid, o.settings);
  const admin = await schoolAdmin(sid);
  const adminToken = (await loginSchoolAdmin(t.app, String(admin.email))).accessToken;
  const driver = await staffActor(t, school, 'driver', 'Ramesh Kumar');
  const conductor = await staffActor(t, school, 'conductor', 'Suresh Babu');
  const backup = await staffActor(t, school, 'driver', 'Mahesh Gowda');
  const bus = await f.bus(sid, { code: 'R1', registration_no: `KA01AB${String(f.nextSeq()).padStart(4, '0')}`, last_known_odometer: 1000 });
  await f.busStaffAssignment(sid, bus.id, driver.staff.id, { assignment_role: 'primary_driver', valid_from: new Date(Date.now() - 86_400_000).toISOString() });
  await f.busStaffAssignment(sid, bus.id, conductor.staff.id, { assignment_role: 'conductor', valid_from: new Date(Date.now() - 86_400_000).toISOString() });
  await f.busStaffAssignment(sid, bus.id, backup.staff.id, { assignment_role: 'backup_driver', valid_from: new Date(Date.now() - 86_400_000).toISOString() });
  const route = await f.route(sid, { code: 'R1', name: 'Route 1', direction: 'morning' });
  const stops = [
    await f.stop(sid, route.id, { name: 'Stop 1', sequence: 1, expected_time: '07:10:00' }),
    await f.stop(sid, route.id, { name: 'Stop 2', sequence: 2, latitude: 12.94, longitude: 77.63, expected_time: '07:20:00' }),
  ];
  await f.busRouteAssignment(sid, bus.id, route.id, { valid_from: new Date(Date.now() - 86_400_000).toISOString() });
  const schedule = await f.tripSchedule(sid, bus.id, route.id, { planned_start_time: '07:00:00', days_of_week: [1, 2, 3, 4, 5, 6, 7] });
  const today = await localDate();
  const trip = await f.trip(sid, bus.id, {
    schedule_id: schedule.id, route_id: route.id, trip_date: today, status: 'scheduled', direction: 'morning',
    driver_staff_id: driver.staff.id, driver_name_snapshot: 'Ramesh Kumar', conductor_staff_id: conductor.staff.id, conductor_name_snapshot: 'Suresh Babu',
    bus_code_snapshot: 'R1', route_code_snapshot: 'R1', route_name_snapshot: 'Route 1', planned_start_at: new Date(Date.now() + 3_600_000).toISOString(),
  });
  return { t, school, sid, adminToken, admin, driver, conductor, backup, bus, route, stops, schedule, trip, today };
}

/** An uploaded odometer photo of `uploader`, attached to a bus or trip. */
export function odometerPhoto(
  sid: string,
  uploaderId: string,
  entity: { type: 'bus' | 'trip'; id: string },
  o: { source?: 'camera' | 'gallery' | null; status?: string } = {},
): Promise<f.TenantRow> {
  const source = o.source === undefined ? 'camera' : o.source;
  const capture: Record<string, unknown> = { capturedAt: new Date().toISOString(), latitude: 12.9716, longitude: 77.5946, accuracyM: 6 };
  if (source) capture.source = source;
  return f.file(sid, { category: 'odometer', entity_type: entity.type, entity_id: entity.id, uploaded_by: uploaderId, uploader_type: 'user', status: o.status ?? 'uploaded', metadata: { capture } });
}

/** Authenticated driver-app requests (bearer + X-Device-Id of the bound device). */
export function as(t: TestApp, actor: Pick<StaffActor, 'token' | 'deviceId'>) {
  const h = { Authorization: `Bearer ${actor.token}`, 'X-Device-Id': actor.deviceId };
  return {
    get: (path: string) => request(t.app).get(api(path)).set(h),
    post: (path: string, body: object = {}) => request(t.app).post(api(path)).set(h).send(body),
  };
}

export function asAdmin(t: TestApp, token: string) {
  const h = { Authorization: `Bearer ${token}` };
  return {
    get: (path: string) => request(t.app).get(api(path)).set(h),
    post: (path: string, body: object = {}) => request(t.app).post(api(path)).set(h).send(body),
  };
}

export const coords = { latitude: 12.9716, longitude: 77.5946, accuracyM: 8 };

export function startBody(o: Record<string, unknown>): Record<string, unknown> {
  return { clientStartId: crypto.randomUUID(), ...coords, deviceTime: new Date().toISOString(), ...o };
}

export function endBody(o: Record<string, unknown>): Record<string, unknown> {
  return { ...coords, deviceTime: new Date().toISOString(), ...o };
}

/** Starts the world's scheduled trip as the primary driver (photo attached to the bus). */
export async function startScheduled(w: TripWorld, reading = 1000): Promise<request.Response> {
  const photo = await odometerPhoto(w.sid, w.driver.user.id, { type: 'bus', id: w.bus.id });
  return as(w.t, w.driver).post('/driver/trips/start', startBody({ tripId: w.trip.id, busId: w.bus.id, odometerReading: reading, odometerFileId: photo.id }));
}

export async function alertsOf(tripId: string): Promise<{ alert_type: string; severity: string; dedupe_key: string; status: string; details: Record<string, unknown> }[]> {
  const { rows } = await ownerQuery<{ alert_type: string; severity: string; dedupe_key: string; status: string; details: Record<string, unknown> }>(
    'select alert_type, severity, dedupe_key, status, details from alerts where trip_id = $1 order by created_at, id',
    [tripId],
  );
  return rows;
}
