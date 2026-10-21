// Test data factories for EVERY table of the core schema (owner inserts — fixtures bypass RLS so
// tests can then probe RLS as the app role), plus twoSchoolFixture() (BP §4.9: two schools with
// identical entity codes and names — R1, Route 1, Stop 1, same student names — and one parent
// with children in both) and tenant-context builders for withTenant().
//
// Rows come back as the DB returns them (snake_case; timestamptz as ISO strings, numerics as
// numbers). Every factory takes overrides; unique values are generated per call.
import crypto from 'node:crypto';
import type { TenantContext } from '../../src/db/tenant.js';
import { ownerQuery } from './db.js';

export type Row = { id: string } & Record<string, unknown>;
export type TenantRow = Row & { school_id: string };
export type Values = Record<string, unknown>;

let seq = 0;
/** Process-unique counter (prefix + number) for unique codes, emails and phones. */
export function nextSeq(): number {
  seq += 1;
  return seq;
}
const uniq = () => `${process.pid.toString(36)}${nextSeq().toString(36)}`;
/** Unique E.164 Indian mobile number. */
export function uniquePhone(): string {
  return `+919${String(process.pid % 10000).padStart(4, '0')}${String(nextSeq() % 100000).padStart(5, '0')}`;
}
export const sha256Hex = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
/** Local date (YYYY-MM-DD) n days from today in UTC. */
export function isoDay(offsetDays = 0): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

const IDENT = /^[a-z_][a-z0-9_]*$/;

/** INSERT … RETURNING * as the owner. Undefined values are omitted (column defaults apply). */
export async function insertRow<R extends Record<string, unknown> = Row>(table: string, values: Values): Promise<R> {
  if (!IDENT.test(table)) throw new Error(`bad table ${table}`);
  const entries = Object.entries(values).filter(([, v]) => v !== undefined);
  for (const [k] of entries) if (!IDENT.test(k)) throw new Error(`bad column ${k}`);
  const sql = entries.length
    ? `insert into ${table} (${entries.map(([k]) => k).join(', ')}) values (${entries.map((_, i) => `$${i + 1}`).join(', ')}) returning *`
    : `insert into ${table} default values returning *`;
  const { rows } = await ownerQuery<R>(sql, entries.map(([, v]) => v));
  return rows[0]!;
}

// ── platform ──────────────────────────────────────────────────────────────────
export const platformUser = (o: Values = {}) =>
  insertRow<Row>('platform_users', { email: `admin-${uniq()}@platform.test`, name: 'Platform Admin', password_hash: 'test-hash', ...o });

export const platformSetting = (key: string, value: unknown, o: Values = {}) =>
  insertRow<Record<string, unknown>>('platform_settings', { key, value: JSON.stringify(value), is_public: false, ...o });

export const school = (o: Values = {}) =>
  insertRow<Row>('schools', {
    code: `T${uniq().toUpperCase()}`,
    name: 'Test School',
    city: 'Bengaluru',
    state: 'Karnataka',
    latitude: 12.9716,
    longitude: 77.5946,
    ...o,
  });

/** school_settings rows are created by a trigger with the school; this patches one. */
export async function schoolSettings(schoolId: string, patch: Values = {}): Promise<Record<string, unknown>> {
  const entries = Object.entries(patch);
  for (const [k] of entries) if (!IDENT.test(k)) throw new Error(`bad column ${k}`);
  const set = entries.length ? entries.map(([k], i) => `${k} = $${i + 2}`).join(', ') : 'updated_at = now()';
  const { rows } = await ownerQuery(`update school_settings set ${set} where school_id = $1 returning *`, [schoolId, ...entries.map(([, v]) => v)]);
  return rows[0]!;
}

export const schoolSubscription = (schoolId: string, o: Values = {}) =>
  insertRow<TenantRow>('school_subscriptions', { school_id: schoolId, plan: 'standard', max_buses: 50, max_students: 2000, ...o });

export const schoolHoliday = (schoolId: string, o: Values = {}) =>
  insertRow<TenantRow>('school_holidays', { school_id: schoolId, name: 'Holiday', start_date: isoDay(10), end_date: isoDay(11), ...o });

export const announcement = (schoolId: string, o: Values = {}) =>
  insertRow<TenantRow>('announcements', { school_id: schoolId, title: 'Notice', body: 'School closes early today.', audience: 'all', ...o });

export function file(schoolId: string, o: Values = {}): Promise<TenantRow> {
  const category = (o.category as string | undefined) ?? 'bus_image';
  const entityId = (o.entity_id as string | undefined) ?? crypto.randomUUID();
  return insertRow<TenantRow>('files', {
    school_id: schoolId,
    key: `whereismybus-test/schools/${schoolId}/${category}/${entityId}/${crypto.randomUUID()}.jpg`,
    category,
    entity_id: entityId,
    mime: 'image/jpeg',
    size_bytes: 1024,
    sha256: sha256Hex(crypto.randomUUID()),
    status: 'uploaded',
    ...o,
  });
}

// ── identities ────────────────────────────────────────────────────────────────
export function user(schoolId: string, o: Values = {}): Promise<TenantRow> {
  const role = (o.role as string | undefined) ?? 'school_admin';
  const defaults: Values =
    role === 'school_admin' ? { email: `admin-${uniq()}@school.test` } : { phone: uniquePhone(), username: `staff_${uniq()}` };
  return insertRow<TenantRow>('users', { school_id: schoolId, role, full_name: `${role} ${uniq()}`, password_hash: 'test-hash', must_change_password: false, ...defaults, ...o });
}

export const parentAccount = (o: Values = {}) => insertRow<Row>('parent_accounts', { phone: uniquePhone(), ...o });

export const schoolParent = (schoolId: string, parentAccountId: string, o: Values = {}) =>
  insertRow<TenantRow>('school_parents', { school_id: schoolId, parent_account_id: parentAccountId, full_name: 'Priya Sharma', relation: 'mother', ...o });

export const staffProfile = (schoolId: string, o: Values = {}) =>
  insertRow<TenantRow>('staff_profiles', {
    school_id: schoolId,
    staff_type: 'driver',
    full_name: 'Ramesh Kumar',
    phone: uniquePhone(),
    licence_no: `KA01${uniq()}`,
    licence_expiry_date: isoDay(400),
    ...o,
  });

export const staffDocument = (schoolId: string, staffId: string, o: Values = {}) =>
  insertRow<TenantRow>('staff_documents', { school_id: schoolId, staff_id: staffId, doc_type: 'police_verification', expiry_date: isoDay(300), ...o });

export const device = (o: Values & { owner_type: string; owner_id: string }) =>
  insertRow<Row>('devices', { device_uid: `dev-${uniq()}`, platform: 'android', app_name: 'driver_app', app_version: '1.0.0', ...o });

export const session = (o: Values & { owner_type: string; owner_id: string }) =>
  insertRow<Row>('sessions', {
    family_id: crypto.randomUUID(),
    refresh_hash: sha256Hex(crypto.randomUUID()),
    expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    ...o,
  });

export const otpCode = (o: Values = {}) =>
  insertRow<Row>('otp_codes', { phone: uniquePhone(), code_hash: sha256Hex('123456'), expires_at: new Date(Date.now() + 300_000).toISOString(), ...o });

// ── fleet, routes, schedules ──────────────────────────────────────────────────
export const bus = (schoolId: string, o: Values = {}) =>
  insertRow<TenantRow>('buses', { school_id: schoolId, code: `B${uniq()}`, registration_no: `KA01AB${String(nextSeq()).padStart(4, '0')}`, capacity: 40, fuel_type: 'diesel', ...o });

export async function busImage(schoolId: string, busId: string, o: Values = {}): Promise<TenantRow> {
  const fileId = (o.file_id as string | undefined) ?? (await file(schoolId, { category: 'bus_image', entity_type: 'bus', entity_id: busId })).id;
  return insertRow<TenantRow>('bus_images', { school_id: schoolId, bus_id: busId, file_id: fileId, ...o });
}

export const busDocument = (schoolId: string, busId: string, o: Values = {}) =>
  insertRow<TenantRow>('bus_documents', { school_id: schoolId, bus_id: busId, doc_type: 'insurance', expiry_date: isoDay(200), ...o });

export const busStaffAssignment = (schoolId: string, busId: string, staffId: string, o: Values = {}) =>
  insertRow<TenantRow>('bus_staff_assignments', { school_id: schoolId, bus_id: busId, staff_id: staffId, assignment_role: 'primary_driver', ...o });

export const route = (schoolId: string, o: Values = {}) =>
  insertRow<TenantRow>('routes', { school_id: schoolId, code: `R${uniq()}`, name: 'Route', direction: 'morning', ...o });

export const stop = (schoolId: string, routeId: string, o: Values = {}) =>
  insertRow<TenantRow>('stops', { school_id: schoolId, route_id: routeId, name: 'Stop', sequence: nextSeq(), latitude: 12.9352, longitude: 77.6245, expected_time: '07:30:00', ...o });

export const busRouteAssignment = (schoolId: string, busId: string, routeId: string, o: Values = {}) =>
  insertRow<TenantRow>('bus_route_assignments', { school_id: schoolId, bus_id: busId, route_id: routeId, ...o });

export const tripSchedule = (schoolId: string, busId: string, routeId: string, o: Values = {}) =>
  insertRow<TenantRow>('trip_schedules', { school_id: schoolId, bus_id: busId, route_id: routeId, direction: 'morning', planned_start_time: '07:00:00', ...o });

// ── students and parents ──────────────────────────────────────────────────────
export const student = (schoolId: string, o: Values = {}) =>
  insertRow<TenantRow>('students', { school_id: schoolId, admission_no: `ADM-${uniq()}`, full_name: 'Aarav Sharma', class_name: '5', section: 'A', ...o });

export const studentParent = (schoolId: string, studentId: string, parentAccountId: string, o: Values = {}) =>
  insertRow<Record<string, unknown>>('student_parents', { school_id: schoolId, student_id: studentId, parent_account_id: parentAccountId, is_primary: true, ...o });

export const studentAssignment = (
  schoolId: string,
  a: { studentId: string; busId: string; routeId: string; stopId: string; direction?: string },
  o: Values = {},
) =>
  insertRow<TenantRow>('student_assignments', {
    school_id: schoolId,
    student_id: a.studentId,
    bus_id: a.busId,
    route_id: a.routeId,
    stop_id: a.stopId,
    trip_direction: a.direction ?? 'morning',
    valid_from: isoDay(-30),
    ...o,
  });

// ── trips and tracking ────────────────────────────────────────────────────────
export const trip = (schoolId: string, busId: string, o: Values = {}) =>
  insertRow<TenantRow>('trips', { school_id: schoolId, bus_id: busId, trip_type: 'school', direction: 'morning', trip_date: isoDay(0), ...o });

/** A trip in progress (started now) — satisfies the status/time checks. */
export const activeTrip = (schoolId: string, busId: string, o: Values = {}) =>
  trip(schoolId, busId, { status: 'in_progress', started_at: new Date().toISOString(), start_odometer: 1000, ...o });

export async function tripOdometerEvidence(schoolId: string, tripId: string, o: Values = {}): Promise<TenantRow> {
  const fileId = (o.file_id as string | undefined) ?? (await file(schoolId, { category: 'odometer', entity_type: 'trip', entity_id: tripId })).id;
  return insertRow<TenantRow>('trip_odometer_evidence', {
    school_id: schoolId,
    trip_id: tripId,
    kind: 'start',
    reading: 1000,
    file_id: fileId,
    captured_at: new Date().toISOString(),
    latitude: 12.97,
    longitude: 77.59,
    sha256: sha256Hex(fileId),
    ...o,
  });
}

/** Inserts n location points one minute apart, ending now. */
export async function locationPoints(schoolId: string, tripId: string, n = 3, o: Values = {}): Promise<number> {
  const { rowCount } = await ownerQuery(
    `insert into location_points (school_id, trip_id, recorded_at, latitude, longitude, speed_kmh, heading, accuracy_m, battery_pct, network_type, is_moving, is_backfilled)
     select $1, $2, now() - make_interval(mins => g), 12.97 + g * 0.001, 77.59 + g * 0.001, 25, 90, 8, 80, '4g', true, $4
     from generate_series(1, $3::int) g`,
    [schoolId, tripId, n, Boolean(o.is_backfilled)],
  );
  return rowCount ?? 0;
}

export const tripStopEvent = (schoolId: string, tripId: string, stopId: string, o: Values = {}) =>
  insertRow<TenantRow>('trip_stop_events', { school_id: schoolId, trip_id: tripId, stop_id: stopId, arrived_at: new Date().toISOString(), ...o });

/** A device event of a trip (trip timeline, migration 925). */
export const tripDeviceEvent = (schoolId: string, tripId: string, o: Values = {}) => {
  const at = new Date().toISOString();
  return insertRow<TenantRow>('trip_device_events', { school_id: schoolId, trip_id: tripId, event_type: 'gps_disabled', occurred_at: at, device_occurred_at: at, ...o });
};

// ── alerts, logs, notifications ───────────────────────────────────────────────
export const alert = (schoolId: string, o: Values = {}) =>
  insertRow<TenantRow>('alerts', { school_id: schoolId, alert_type: 'doc_expiring', severity: 'warning', title: 'Insurance expiring', dedupe_key: `doc_expiring:${uniq()}:30`, ...o });

export const fuelLog = (schoolId: string, busId: string, o: Values = {}) =>
  insertRow<TenantRow>('fuel_logs', { school_id: schoolId, bus_id: busId, fuel_date: isoDay(-1), odometer: 990, litres: 40, cost: 3800, ...o });

export const maintenanceLog = (schoolId: string, busId: string, o: Values = {}) =>
  insertRow<TenantRow>('maintenance_logs', { school_id: schoolId, bus_id: busId, service_type: 'Oil change', service_date: isoDay(-5), cost: 2500, next_due_date: isoDay(85), ...o });

export const notificationPreference = (schoolId: string, parentAccountId: string, studentId: string, o: Values = {}) =>
  insertRow<Record<string, unknown>>('notification_preferences', { school_id: schoolId, parent_account_id: parentAccountId, student_id: studentId, direction: 'morning', ...o });

export const notificationEvent = (schoolId: string, tripId: string, o: Values = {}) =>
  insertRow<TenantRow>('notification_events', { school_id: schoolId, trip_id: tripId, event_type: 'trip_started', status: 'sent', sent_at: new Date().toISOString(), ...o });

export const parentNotification = (schoolId: string, parentAccountId: string, o: Values = {}) =>
  insertRow<TenantRow>('parent_notifications', { school_id: schoolId, parent_account_id: parentAccountId, kind: 'trip_started', title: 'Bus R1 started', body: 'The morning trip has started.', ...o });

/** Consent record (owner insert; the app writes them only through parent_accept_consent()). */
export const parentConsent = (schoolId: string, parentAccountId: string, o: Values = {}) =>
  insertRow<TenantRow>('parent_consents', { school_id: schoolId, parent_account_id: parentAccountId, version: '1', app_name: 'parent_app', app_version: '1.0.0', ...o });

export const auditLog = (o: Values = {}) =>
  insertRow<Record<string, unknown> & { id: number }>('audit_logs', { actor_type: 'system', action: 'test.create', ...o });

export const idempotencyKey = (o: Values & { actor_id: string }) =>
  insertRow<Row>('idempotency_keys', { idem_key: `key-${uniq()}-padding`, method: 'POST', path: '/api/v1/test', request_hash: sha256Hex(uniq()), ...o });

// ── tenant contexts ───────────────────────────────────────────────────────────
export const contexts = {
  schoolAdmin: (schoolId: string, actorId: string | null = null): TenantContext => ({ schoolId, actorId, role: 'school_admin' }),
  driver: (schoolId: string, actorId: string): TenantContext => ({ schoolId, actorId, role: 'driver' }),
  conductor: (schoolId: string, actorId: string): TenantContext => ({ schoolId, actorId, role: 'conductor' }),
  parent: (parentAccountId: string, schoolId: string | null): TenantContext => ({ schoolId, actorId: parentAccountId, role: 'parent' }),
  superAdmin: (actorId: string | null = null): TenantContext => ({ schoolId: null, actorId, role: 'super_admin' }),
  system: (schoolId: string | null = null): TenantContext => ({ schoolId, actorId: null, role: 'system' }),
} as const;

// ── two-school fixture (BP §4.9) ──────────────────────────────────────────────
export interface SchoolFixture {
  school: Row;
  admin: TenantRow;
  driverUser: TenantRow;
  driver: TenantRow;
  conductorUser: TenantRow;
  conductor: TenantRow;
  /** Bus R1 (the linked child's bus) and its documents/images/assignments. */
  bus: TenantRow;
  busDocument: TenantRow;
  hiddenBusDocument: TenantRow;
  busImage: TenantRow;
  route: TenantRow;
  stop1: TenantRow;
  stop2: TenantRow;
  schedule: TenantRow;
  /** Linked child (Aarav Sharma) and an unrelated student (Diya Patel). */
  student: TenantRow;
  otherStudent: TenantRow;
  /** School-local parent of the linked child. */
  parent: Row;
  schoolParent: TenantRow;
  assignment: TenantRow;
  trip: TenantRow;
  nonSchoolTrip: TenantRow;
  /** Bus R2 with its own route, driver and trip — not related to the parent. */
  otherBus: TenantRow;
  otherRoute: TenantRow;
  otherDriver: TenantRow;
  otherTrip: TenantRow;
  driverDocument: TenantRow;
  identityDocument: TenantRow;
  alert: TenantRow;
  fuelLog: TenantRow;
  maintenanceLog: TenantRow;
  notificationEvent: TenantRow;
  parentNotification: TenantRow;
  announcement: TenantRow;
  driverDevice: Row;
  driverSession: Row;
}

export interface TwoSchoolFixture {
  a: SchoolFixture;
  b: SchoolFixture;
  /** Parent with a child in both schools. */
  sharedParent: Row;
  superAdmin: Row;
}

async function schoolWorld(sharedParentId: string): Promise<SchoolFixture> {
  const s = await school({ name: 'Greenfield Public School' });
  const sid = s.id;
  await schoolSubscription(sid);
  await schoolHoliday(sid, { name: 'Diwali' });
  const admin = await user(sid, { role: 'school_admin', full_name: 'Anita Rao' });
  const driverUser = await user(sid, { role: 'driver', full_name: 'Ramesh Kumar' });
  const driver = await staffProfile(sid, { staff_type: 'driver', full_name: 'Ramesh Kumar', user_id: driverUser.id });
  const conductorUser = await user(sid, { role: 'conductor', full_name: 'Suresh Babu' });
  const conductor = await staffProfile(sid, { staff_type: 'conductor', full_name: 'Suresh Babu', user_id: conductorUser.id });
  const otherDriver = await staffProfile(sid, { staff_type: 'driver', full_name: 'Mahesh Gowda' });

  const b1 = await bus(sid, { code: 'R1', registration_no: 'KA01AB1234' });
  const busDoc = await busDocument(sid, b1.id, { doc_type: 'insurance', visible_to_parents_status: true });
  const hiddenDoc = await busDocument(sid, b1.id, { doc_type: 'permit', visible_to_parents_status: false, visible_to_parents_file: false });
  const img = await busImage(sid, b1.id);
  await busStaffAssignment(sid, b1.id, driver.id, { assignment_role: 'primary_driver' });
  await busStaffAssignment(sid, b1.id, conductor.id, { assignment_role: 'conductor' });
  const r1 = await route(sid, { code: 'R1', name: 'Route 1', direction: 'morning' });
  const stop1 = await stop(sid, r1.id, { name: 'Stop 1', code: 'S1', sequence: 1 });
  const stop2 = await stop(sid, r1.id, { name: 'Stop 2', code: 'S2', sequence: 2, latitude: 12.94, longitude: 77.63 });
  await busRouteAssignment(sid, b1.id, r1.id);
  const schedule = await tripSchedule(sid, b1.id, r1.id);

  const b2 = await bus(sid, { code: 'R2', registration_no: 'KA01AB5678' });
  await busStaffAssignment(sid, b2.id, otherDriver.id, { assignment_role: 'primary_driver' });
  const r2 = await route(sid, { code: 'R2', name: 'Route 2', direction: 'morning' });
  await stop(sid, r2.id, { name: 'Stop 1', sequence: 1 });

  const child = await student(sid, { full_name: 'Aarav Sharma', admission_no: 'ADM-001' });
  const other = await student(sid, { full_name: 'Diya Patel', admission_no: 'ADM-002' });
  const parent = await parentAccount();
  const sp = await schoolParent(sid, parent.id, { full_name: 'Priya Sharma' });
  await studentParent(sid, child.id, parent.id);
  await schoolParent(sid, sharedParentId, { full_name: 'Vikram Mehta' });
  await studentParent(sid, child.id, sharedParentId, { is_primary: false });
  const assignment = await studentAssignment(sid, { studentId: child.id, busId: b1.id, routeId: r1.id, stopId: stop1.id });
  const otherStop = await ownerQuery<{ id: string }>('select id from stops where route_id = $1', [r2.id]);
  await studentAssignment(sid, { studentId: other.id, busId: b2.id, routeId: r2.id, stopId: otherStop.rows[0]!.id });
  await notificationPreference(sid, parent.id, child.id);
  await parentConsent(sid, parent.id);

  const driverDevice = await device({ owner_type: 'user', owner_id: driverUser.id, school_id: sid });
  const driverSession = await session({ owner_type: 'user', owner_id: driverUser.id, school_id: sid, device_id: driverDevice.id });
  const t = await activeTrip(sid, b1.id, {
    route_id: r1.id, schedule_id: schedule.id, driver_staff_id: driver.id, conductor_staff_id: conductor.id,
    bus_code_snapshot: 'R1', route_code_snapshot: 'R1', device_id: driverDevice.id, started_by: driverUser.id,
  });
  await tripOdometerEvidence(sid, t.id);
  await locationPoints(sid, t.id, 3);
  await tripStopEvent(sid, t.id, stop1.id);
  await tripDeviceEvent(sid, t.id);
  const nonSchool = await trip(sid, b1.id, { trip_type: 'non_school', direction: null, purpose: 'Workshop visit', trip_date: isoDay(-1) });
  const otherTrip = await activeTrip(sid, b2.id, { route_id: r2.id, driver_staff_id: otherDriver.id });
  await locationPoints(sid, otherTrip.id, 2);

  const driverDoc = await staffDocument(sid, driver.id, { doc_type: 'police_verification', visible_to_parents_status: true });
  const identityDoc = await staffDocument(sid, driver.id, { doc_type: 'identity', visible_to_parents_status: false });
  const ne = await notificationEvent(sid, t.id, { student_id: child.id });
  return {
    school: s, admin, driverUser, driver, conductorUser, conductor, bus: b1, busDocument: busDoc, hiddenBusDocument: hiddenDoc,
    busImage: img, route: r1, stop1, stop2, schedule, student: child, otherStudent: other, parent, schoolParent: sp, assignment,
    trip: t, nonSchoolTrip: nonSchool, otherBus: b2, otherRoute: r2, otherDriver, otherTrip,
    driverDocument: driverDoc, identityDocument: identityDoc,
    alert: await alert(sid, { bus_id: b1.id, entity_type: 'bus', entity_id: b1.id }),
    fuelLog: await fuelLog(sid, b1.id),
    maintenanceLog: await maintenanceLog(sid, b1.id),
    notificationEvent: ne,
    parentNotification: await parentNotification(sid, parent.id, { student_id: child.id, trip_id: t.id, notification_event_id: ne.id }),
    announcement: await announcement(sid, { audience: 'parents' }),
    driverDevice, driverSession,
  };
}

/** Two fully populated schools with identical codes/names and a parent linked in both. */
export async function twoSchoolFixture(): Promise<TwoSchoolFixture> {
  const sharedParent = await parentAccount({ display_name: 'Vikram Mehta' });
  const a = await schoolWorld(sharedParent.id);
  const b = await schoolWorld(sharedParent.id);
  const superAdmin = await platformUser({ name: 'Super Admin' });
  await auditLog({ school_id: a.school.id, action: 'bus.create', entity_type: 'bus', entity_id: a.bus.id });
  await auditLog({ school_id: b.school.id, action: 'bus.create', entity_type: 'bus', entity_id: b.bus.id });
  await auditLog({ action: 'school.create', actor_type: 'platform_user', actor_id: superAdmin.id, entity_type: 'school', entity_id: a.school.id });
  await idempotencyKey({ school_id: a.school.id, actor_id: a.admin.id });
  await idempotencyKey({ school_id: b.school.id, actor_id: b.admin.id });
  return { a, b, sharedParent, superAdmin };
}
