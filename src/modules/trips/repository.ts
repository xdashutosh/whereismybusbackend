// SQL of the trips module (BP §6.2 TRIPS / TRIP_ODOMETER_EVIDENCE, §10). Every statement runs in the
// caller's tenant transaction: RLS (tenant_isolation) limits it to the current school, so another
// school's ids simply find nothing. school_id is always taken from the transaction context.
import type { Tx } from '../../db/tenant.js';

export const SCHOOL = "nullif(current_setting('app.school_id', true), '')::uuid";

export interface TripRow extends Record<string, unknown> {
  id: string;
  school_id: string;
  schedule_id: string | null;
  trip_type: 'school' | 'non_school';
  direction: 'morning' | 'afternoon' | null;
  trip_date: string;
  bus_id: string;
  route_id: string | null;
  driver_staff_id: string | null;
  conductor_staff_id: string | null;
  bus_code_snapshot: string | null;
  bus_registration_snapshot: string | null;
  route_code_snapshot: string | null;
  route_name_snapshot: string | null;
  driver_name_snapshot: string | null;
  conductor_name_snapshot: string | null;
  status: 'scheduled' | 'in_progress' | 'completed' | 'missed' | 'cancelled' | 'auto_closed';
  planned_start_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  /** Server instant a running trip was completed / auto-closed / cancelled (migration 500). */
  closed_at: string | null;
  start_device_time: string | null;
  end_device_time: string | null;
  start_lat: number | null;
  start_lng: number | null;
  end_lat: number | null;
  end_lng: number | null;
  start_odometer: number | null;
  end_odometer: number | null;
  distance_odometer_km: number | null;
  distance_gps_km: number | null;
  odometer_correction: Record<string, unknown> | null;
  purpose: string | null;
  device_id: string | null;
  started_by: string | null;
  ended_by: string | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  close_reason: string | null;
  interrupted_at: string | null;
  last_point_at: string | null;
  points_count: number;
  client_start_id: string | null;
  summary: Record<string, unknown> | null;
  finalized_at: string | null;
  created_at: string;
  updated_at: string;
}

export const TRIP_COLUMNS = `t.id, t.school_id, t.schedule_id, t.trip_type, t.direction, t.trip_date, t.bus_id, t.route_id,
  t.driver_staff_id, t.conductor_staff_id, t.bus_code_snapshot, t.bus_registration_snapshot, t.route_code_snapshot,
  t.route_name_snapshot, t.driver_name_snapshot, t.conductor_name_snapshot, t.status, t.planned_start_at, t.started_at,
  t.ended_at, t.closed_at, t.start_device_time, t.end_device_time, t.start_lat, t.start_lng, t.end_lat, t.end_lng, t.start_odometer,
  t.end_odometer, t.distance_odometer_km, t.distance_gps_km, t.odometer_correction, t.purpose, t.device_id, t.started_by,
  t.ended_by, t.cancelled_by, t.cancel_reason, t.close_reason, t.interrupted_at, t.last_point_at, t.points_count,
  t.client_start_id, t.summary, t.finalized_at, t.created_at, t.updated_at`;

export function findTrip(tx: Tx, id: string, { lock = false } = {}): Promise<TripRow | null> {
  return tx.maybeOne<TripRow>(`select ${TRIP_COLUMNS} from trips t where t.id = $1${lock ? ' for update' : ''}`, [id]);
}

/**
 * Transaction-scoped advisory lock on a start's clientStartId (released at commit/rollback, so it is
 * safe through PgBouncer transaction pooling). Serialises concurrent retries of one start.
 */
export async function lockClientStartId(tx: Tx, clientStartId: string): Promise<void> {
  await tx.query(`select pg_advisory_xact_lock(hashtextextended('trip-start:' || $1::text, 0))`, [clientStartId]);
}

export function findByClientStartId(tx: Tx, clientStartId: string): Promise<TripRow | null> {
  return tx.maybeOne<TripRow>(`select ${TRIP_COLUMNS} from trips t where t.client_start_id = $1`, [clientStartId]);
}

// ── staff / assignments ──────────────────────────────────────────────────────
export interface StaffRow extends Record<string, unknown> {
  id: string;
  staff_type: 'driver' | 'conductor';
  full_name: string;
  phone: string | null;
  photo_file_id: string | null;
  licence_no: string | null;
  licence_expiry_date: string | null;
  experience_years: number | null;
  is_active: boolean;
}

/** Staff profile of a driver/conductor user (null when none or deleted). */
export function staffOfUser(tx: Tx, userId: string): Promise<StaffRow | null> {
  return tx.maybeOne<StaffRow>(
    `select id, staff_type, full_name, phone, photo_file_id, licence_no, licence_expiry_date, experience_years, is_active
       from staff_profiles where user_id = $1 and deleted_at is null`,
    [userId],
  );
}

/** Login user ids of staff profiles (those that have an app login). */
export async function userIdsOfStaff(tx: Tx, staffIds: readonly string[]): Promise<string[]> {
  if (!staffIds.length) return [];
  const rows = await tx.many<{ user_id: string }>('select user_id from staff_profiles where id = any($1::uuid[]) and user_id is not null', [staffIds]);
  return rows.map((r) => r.user_id);
}

export type AssignmentRole = 'primary_driver' | 'backup_driver' | 'conductor' | 'backup_conductor';

export interface AssignmentRow extends Record<string, unknown> {
  bus_id: string;
  bus_code: string;
  bus_name: string | null;
  registration_no: string;
  bus_status: string;
  last_known_odometer: number | null;
  role: AssignmentRole;
  valid_from: string;
  valid_to: string | null;
  routes: { routeId: string; code: string; name: string | null; direction: 'morning' | 'afternoon' }[];
}

/** Buses a staff member is assigned to right now (half-open windows), with the routes each serves now. */
export function currentAssignments(tx: Tx, staffId: string): Promise<AssignmentRow[]> {
  return tx.many<AssignmentRow>(
    `select a.bus_id, b.code as bus_code, b.display_name as bus_name, b.registration_no, b.status as bus_status,
            b.last_known_odometer, a.assignment_role as role, a.valid_from, a.valid_to,
            coalesce((select jsonb_agg(jsonb_build_object('routeId', r.id, 'code', r.code, 'name', r.name, 'direction', r.direction)
                                       order by r.direction, r.code)
                        from bus_route_assignments bra join routes r on r.id = bra.route_id
                       where bra.bus_id = a.bus_id and bra.valid_from <= now() and (bra.valid_to is null or bra.valid_to > now())
                         and r.deleted_at is null and r.is_active), '[]'::jsonb) as routes
       from bus_staff_assignments a
       join buses b on b.id = a.bus_id and b.deleted_at is null
      where a.staff_id = $1 and a.valid_from <= now() and (a.valid_to is null or a.valid_to > now())
      order by b.code, a.assignment_role`,
    [staffId],
  );
}

/** Current assignment role of a staff member on a bus (strongest role first), null when not assigned. */
export async function assignmentRole(tx: Tx, busId: string, staffId: string): Promise<AssignmentRole | null> {
  const row = await tx.maybeOne<{ role: AssignmentRole }>(
    `select assignment_role as role from bus_staff_assignments
      where bus_id = $1 and staff_id = $2 and valid_from <= now() and (valid_to is null or valid_to > now())
      order by array_position(array['primary_driver', 'conductor', 'backup_driver', 'backup_conductor'], assignment_role)
      limit 1`,
    [busId, staffId],
  );
  return row?.role ?? null;
}

/** Staff currently holding a role on a bus (planned driver / conductor of non-school trips). */
export async function currentStaffOfBus(tx: Tx, busId: string, role: 'primary_driver' | 'conductor'): Promise<{ id: string; full_name: string } | null> {
  return tx.maybeOne<{ id: string; full_name: string }>(
    `select sp.id, sp.full_name from bus_staff_assignments a join staff_profiles sp on sp.id = a.staff_id and sp.deleted_at is null
      where a.bus_id = $1 and a.assignment_role = $2 and a.valid_from <= now() and (a.valid_to is null or a.valid_to > now())
      order by a.valid_from desc limit 1`,
    [busId, role],
  );
}

export interface BusRow extends Record<string, unknown> {
  id: string;
  code: string;
  registration_no: string;
  status: string;
  last_known_odometer: number | null;
}

export function findBus(tx: Tx, busId: string, { lock = false } = {}): Promise<BusRow | null> {
  return tx.maybeOne<BusRow>(
    `select id, code, registration_no, status, last_known_odometer from buses where id = $1 and deleted_at is null${lock ? ' for update' : ''}`,
    [busId],
  );
}

export async function updateBusOdometer(tx: Tx, busId: string, reading: number): Promise<void> {
  await tx.query('update buses set last_known_odometer = $2, odometer_updated_at = now(), updated_at = now() where id = $1', [busId, reading]);
}

/** In-progress trips that block a start: same bus, or the caller (starter / driver / conductor). */
export function activeConflicts(tx: Tx, busId: string, userId: string, staffId: string): Promise<{ id: string; bus_id: string }[]> {
  return tx.many<{ id: string; bus_id: string }>(
    `select id, bus_id from trips
      where status = 'in_progress' and (bus_id = $1 or started_by = $2 or driver_staff_id = $3 or conductor_staff_id = $3)`,
    [busId, userId, staffId],
  );
}

/** True when a staff member is on another trip in progress. */
export async function staffBusy(tx: Tx, staffId: string, exceptTripId: string | null): Promise<boolean> {
  const row = await tx.maybeOne(
    `select 1 from trips where status = 'in_progress' and (driver_staff_id = $1 or conductor_staff_id = $1)
        and ($2::uuid is null or id <> $2::uuid) limit 1`,
    [staffId, exceptTripId],
  );
  return row !== null;
}

/** Latest closed trip of the bus with an end reading (BP §10.3 rule 4), excluding `exceptTripId`. */
export function previousClosedTrip(tx: Tx, busId: string, exceptTripId: string | null): Promise<{ id: string; end_odometer: number; ended_at: string } | null> {
  return tx.maybeOne<{ id: string; end_odometer: number; ended_at: string }>(
    `select id, end_odometer, ended_at from trips
      where bus_id = $1 and status in ('completed', 'auto_closed') and end_odometer is not null
        and ($2::uuid is null or id <> $2::uuid)
      order by ended_at desc, id desc limit 1`,
    [busId, exceptTripId],
  );
}

/**
 * Highest odometer reading recorded on another started trip of the bus (start or end reading of
 * in-progress, completed and auto-closed trips). An auto-closed trip has a start reading but no end
 * reading, so buses.last_known_odometer alone would miss it. Cancelled trips are left out: only the
 * school cancels, and their readings cannot be corrected (a typo would flag every later start).
 */
export function highestRecordedReading(tx: Tx, busId: string, exceptTripId: string): Promise<{ trip_id: string; reading: number } | null> {
  return tx.maybeOne<{ trip_id: string; reading: number }>(
    `select id as trip_id, greatest(start_odometer, coalesce(end_odometer, start_odometer)) as reading
       from trips
      where bus_id = $1 and id <> $2 and status in ('in_progress', 'completed', 'auto_closed') and start_odometer is not null
      order by greatest(start_odometer, coalesce(end_odometer, start_odometer)) desc, started_at desc
      limit 1`,
    [busId, exceptTripId],
  );
}

/** True when no closed trip of the bus ended after this one (its end reading is the bus's latest). */
export async function isLatestClosedTrip(tx: Tx, busId: string, tripId: string, endedAt: string): Promise<boolean> {
  const row = await tx.maybeOne(
    `select 1 from trips where bus_id = $1 and id <> $2 and status in ('completed', 'auto_closed') and end_odometer is not null
        and ended_at > $3::timestamptz limit 1`,
    [busId, tripId, endedAt],
  );
  return row === null;
}

// ── odometer evidence ────────────────────────────────────────────────────────
export interface OdometerFileRow extends Record<string, unknown> {
  id: string;
  category: string;
  entity_type: string | null;
  entity_id: string | null;
  status: string;
  sha256: string | null;
  uploaded_by: string | null;
  metadata: Record<string, unknown>;
  used: boolean;
}

export function findOdometerFile(tx: Tx, fileId: string): Promise<OdometerFileRow | null> {
  return tx.maybeOne<OdometerFileRow>(
    `select f.id, f.category, f.entity_type, f.entity_id, f.status, f.sha256, f.uploaded_by, f.metadata,
            exists (select 1 from trip_odometer_evidence e where e.file_id = f.id) as used
       from files f where f.id = $1`,
    [fileId],
  );
}

export interface NewEvidence {
  tripId: string;
  kind: 'start' | 'end';
  reading: number;
  fileId: string;
  capturedAt: string;
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
  sha256: string | null;
  source: 'camera' | 'gallery';
  deviceId: string | null;
  recordedBy: string | null;
}

export async function insertEvidence(tx: Tx, e: NewEvidence): Promise<void> {
  await tx.query(
    `insert into trip_odometer_evidence (school_id, trip_id, kind, reading, file_id, captured_at, latitude, longitude, accuracy_m, sha256, source, device_id, recorded_by)
     values (${SCHOOL}, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [e.tripId, e.kind, e.reading, e.fileId, e.capturedAt, e.latitude, e.longitude, e.accuracyM, e.sha256, e.source, e.deviceId, e.recordedBy],
  );
}

export function evidenceFileId(tx: Tx, tripId: string, kind: 'start' | 'end'): Promise<{ file_id: string } | null> {
  return tx.maybeOne<{ file_id: string }>('select file_id from trip_odometer_evidence where trip_id = $1 and kind = $2', [tripId, kind]);
}
