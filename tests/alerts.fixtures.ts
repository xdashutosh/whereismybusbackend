// Fixtures of the alerts suites: a school world with two signed-in school admins, a driver (signed in
// on a bound device), bus R1, a trip and alerts of several types, statuses and ages. Two worlds share
// identical codes and names (BP §4.9).
import type { Express } from 'express';
import { DEVICE, loginSchoolAdmin, loginStaff, schoolAdmin, staffUser, type Tokens } from './helpers/authApp.js';
import { ownerQuery } from './helpers/db.js';
import * as f from './helpers/factories.js';

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

export interface AlertsWorld {
  school: f.Row;
  sid: string;
  admin: Tokens;
  adminUser: f.TenantRow;
  admin2User: f.TenantRow;
  driver: Tokens;
  driverProfile: f.TenantRow;
  bus: f.TenantRow;
  otherBus: f.TenantRow;
  trip: f.TenantRow;
  /** open warning doc_expiring on R1 (2 days old) */
  docAlert: f.TenantRow;
  /** open critical odometer_gap on the trip (today) */
  tripAlert: f.TenantRow;
  /** reviewed warning speeding on R2 (5 days old) */
  speedAlert: f.TenantRow;
  /** closed info non_school_trip (10 days old) */
  closedAlert: f.TenantRow;
  /** escalated critical doc_expired of the driver (1 day old) */
  staffAlert: f.TenantRow;
}

const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

export async function alertsWorld(app: Express, deviceId = DEVICE.deviceId): Promise<AlertsWorld> {
  const school = await f.school({ name: 'Greenfield Public School', timezone: 'Asia/Kolkata' });
  const sid = school.id;
  await f.schoolSubscription(sid);
  const adminUser = await schoolAdmin(sid, { full_name: 'Anita Rao' });
  const admin2User = await schoolAdmin(sid, { full_name: 'Meera Iyer' });
  const driverUser = await staffUser(sid, 'driver', { full_name: 'Ramesh Kumar' });
  const driverProfile = await f.staffProfile(sid, { full_name: 'Ramesh Kumar', user_id: driverUser.id });
  const bus = await f.bus(sid, { code: 'R1' });
  const otherBus = await f.bus(sid, { code: 'R2' });
  const route = await f.route(sid, { code: 'R1', name: 'Route 1', direction: 'morning' });
  const trip = await f.trip(sid, bus.id, { route_id: route.id, driver_staff_id: driverProfile.id, bus_code_snapshot: 'R1', route_code_snapshot: 'R1', direction: 'morning' });
  const docAlert = await f.alert(sid, { bus_id: bus.id, entity_type: 'bus', entity_id: bus.id, title: 'Insurance of bus R1 expires in 20 days', created_at: ago(2) });
  const tripAlert = await f.alert(sid, {
    alert_type: 'odometer_gap', severity: 'critical', trip_id: trip.id, bus_id: bus.id, entity_type: 'trip', entity_id: trip.id,
    title: 'Odometer gap of 42 km on R1', dedupe_key: `odometer_gap:${trip.id}`, details: JSON.stringify({ gapKm: 42 }),
  });
  const speedAlert = await f.alert(sid, {
    alert_type: 'speeding', severity: 'warning', status: 'reviewed', bus_id: otherBus.id, title: 'Speeding on R2', dedupe_key: null,
    review_note: 'Spoke to the driver', reviewed_by: adminUser.id, reviewed_at: ago(4), created_at: ago(5),
  });
  const closedAlert = await f.alert(sid, { alert_type: 'non_school_trip', severity: 'info', status: 'closed', title: 'Non-school trip on R1', bus_id: bus.id, dedupe_key: null, closed_at: ago(9), created_at: ago(10) });
  const staffAlert = await f.alert(sid, {
    alert_type: 'doc_expired', severity: 'critical', status: 'escalated', staff_id: driverProfile.id, entity_type: 'staff', entity_id: driverProfile.id,
    title: 'Driving licence of driver Ramesh Kumar expired', dedupe_key: `doc_expired:licence:${driverProfile.id}:2026-01-01`, escalated_by: adminUser.id, escalated_at: ago(1), created_at: ago(1),
  });
  const admin = await loginSchoolAdmin(app, String(adminUser.email));
  const driver = await loginStaff(app, String(school.code), String(driverUser.phone), { ...DEVICE, deviceId });
  return { school, sid, admin, adminUser, admin2User, driver, driverProfile, bus, otherBus, trip, docAlert, tripAlert, speedAlert, closedAlert, staffAlert };
}

export async function auditRows(schoolId: string, action: string) {
  const { rows } = await ownerQuery<{ entity_id: string; old_values: Record<string, unknown> | null; new_values: Record<string, unknown> | null; actor_id: string | null; actor_type: string | null; actor_name: string | null }>(
    `select entity_id, old_values, new_values, actor_id, actor_type, actor_name from audit_logs where school_id = $1 and action = $2 order by created_at, id`,
    [schoolId, action],
  );
  return rows;
}
