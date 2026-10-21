// Fixtures for the tracking suites: a school with a synthetic straight north-bound morning route
// (4 stops ≈ 1 km apart, the school 1 km after the last stop), a real driver + conductor who sign in
// through the API (device-bound sessions), an in-progress trip bound to the driver's device and a
// signed-in school admin. Points are generated along the route with t = base + i × step.
import { HEADERS } from '@wimb/shared';
import type { Express } from 'express';
import request from 'supertest';
import { getJobs } from '../../src/jobs/index.js';
import { ownerQuery } from './db.js';
import * as f from './factories.js';
import { DEVICE, loginSchoolAdmin, loginStaff, schoolAdmin, staffUser, type Tokens } from './authApp.js';

/** ≈ 1 km of latitude. */
export const KM_LAT = 1 / 111.195;
export const ORIGIN = { lat: 12.9, lng: 77.6 };
export const stopLat = (i: number) => ORIGIN.lat + i * KM_LAT;

export interface TrackingWorld {
  school: f.Row & { code?: unknown };
  admin: Tokens;
  driver: Tokens;
  conductor: Tokens;
  driverUser: f.TenantRow;
  conductorUser: f.TenantRow;
  driverProfile: f.TenantRow;
  conductorProfile: f.TenantRow;
  deviceId: string;
  bus: f.TenantRow;
  route: f.TenantRow;
  stops: f.TenantRow[];
  trip: f.TenantRow;
}

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

export async function sessionDevice(sessionId: string): Promise<string> {
  const { rows } = await ownerQuery<{ device_id: string }>('select device_id from sessions where id = $1', [sessionId]);
  return rows[0]!.device_id;
}

/** Builds one school world. `settings` patches school_settings. */
export async function trackingWorld(app: Express, { settings = {}, startedMinAgo = 60, device = DEVICE }: { settings?: f.Values; startedMinAgo?: number; device?: typeof DEVICE } = {}): Promise<TrackingWorld> {
  const school = await f.school({ name: 'Tracking Test School', latitude: stopLat(4), longitude: ORIGIN.lng, timezone: 'Asia/Kolkata' });
  await f.schoolSubscription(school.id);
  if (Object.keys(settings).length) await f.schoolSettings(school.id, settings);
  const adminUser = await schoolAdmin(school.id);
  const driverUser = await staffUser(school.id, 'driver');
  const conductorUser = await staffUser(school.id, 'conductor');
  const driverProfile = await f.staffProfile(school.id, { staff_type: 'driver', full_name: 'Ramesh Kumar', user_id: driverUser.id });
  const conductorProfile = await f.staffProfile(school.id, { staff_type: 'conductor', full_name: 'Suresh Babu', user_id: conductorUser.id });
  const bus = await f.bus(school.id, { code: 'R1' });
  await f.busStaffAssignment(school.id, bus.id, driverProfile.id, { assignment_role: 'primary_driver' });
  await f.busStaffAssignment(school.id, bus.id, conductorProfile.id, { assignment_role: 'conductor' });
  const route = await f.route(school.id, { code: 'R1', name: 'Route 1', direction: 'morning' });
  const stops: f.TenantRow[] = [];
  for (let i = 0; i < 4; i += 1) {
    stops.push(await f.stop(school.id, route.id, { name: `Stop ${i + 1}`, sequence: i + 1, latitude: stopLat(i), longitude: ORIGIN.lng, arrival_radius_m: 100, expected_time: `07:${String(10 + i * 5).padStart(2, '0')}:00` }));
  }
  const admin = await loginSchoolAdmin(app, String(adminUser.email));
  const driver = await loginStaff(app, String(school.code), String(driverUser.phone), device);
  const conductor = await loginStaff(app, String(school.code), String(conductorUser.phone), { ...device, deviceId: `${device.deviceId}-c` });
  const deviceId = await sessionDevice(driver.sessionId);
  const trip = await f.activeTrip(school.id, bus.id, {
    route_id: route.id,
    driver_staff_id: driverProfile.id,
    conductor_staff_id: conductorProfile.id,
    device_id: deviceId,
    started_by: driverUser.id,
    started_at: new Date(Date.now() - startedMinAgo * 60_000).toISOString(),
    bus_code_snapshot: 'R1',
    route_code_snapshot: 'R1',
  });
  return { school, admin, driver, conductor, driverUser, conductorUser, driverProfile, conductorProfile, deviceId, bus, route, stops, trip };
}

export interface GenPoint {
  t: string;
  lat: number;
  lng: number;
  spd?: number | null;
  hdg?: number | null;
  acc?: number | null;
  bat?: number | null;
  net?: string | null;
  mv?: boolean | null;
}

/** Points moving north from `fromKm` at `kmh`, one every `stepS` seconds starting at baseMs. */
export function northbound({ baseMs, fromKm = 0, kmh = 30, stepS = 10, count, acc = 8 }: { baseMs: number; fromKm?: number; kmh?: number; stepS?: number; count: number; acc?: number }): GenPoint[] {
  const out: GenPoint[] = [];
  for (let i = 0; i < count; i += 1) {
    const km = fromKm + (kmh * stepS * i) / 3600;
    out.push({ t: new Date(baseMs + i * stepS * 1000).toISOString(), lat: ORIGIN.lat + km * KM_LAT, lng: ORIGIN.lng, spd: kmh, hdg: 0, acc, bat: 80, net: '4g', mv: kmh > 4 });
  }
  return out;
}

/** Stationary points at `km` (speed 0) every stepS seconds. */
export function parked({ baseMs, km, stepS = 90, count, lngOffset = 0 }: { baseMs: number; km: number; stepS?: number; count: number; lngOffset?: number }): GenPoint[] {
  return Array.from({ length: count }, (_, i) => ({ t: new Date(baseMs + i * stepS * 1000).toISOString(), lat: ORIGIN.lat + km * KM_LAT, lng: ORIGIN.lng + lngOffset, spd: 0, hdg: 0, acc: 6, bat: 80, net: '4g', mv: false }));
}

export function postPoints(app: Express, w: Pick<TrackingWorld, 'driver' | 'trip'>, points: GenPoint[], { token = w.driver.accessToken, deviceUid = DEVICE.deviceId, tripId = w.trip.id, body = {} }: { token?: string; deviceUid?: string; tripId?: string; body?: Record<string, unknown> } = {}) {
  return request(app)
    .post(`/api/v1/driver/trips/${tripId}/locations`)
    .set(auth(token))
    .set(HEADERS.DEVICE_ID, deviceUid)
    .send({ device_id: deviceUid, points, ...body });
}

/** Waits for queued jobs (points-persist and analytics) of the in-process runner. */
export function drainJobs(): Promise<void> {
  return getJobs().drain();
}

export async function storedPoints(tripId: string) {
  const { rows } = await ownerQuery<{ recorded_at: string; is_backfilled: boolean }>('select recorded_at, is_backfilled from location_points where trip_id = $1 order by recorded_at', [tripId]);
  return rows;
}
