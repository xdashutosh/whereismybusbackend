// Trip state transitions (BP §10.1). Each statement is guarded by the expected current status, so a
// concurrent transition makes it return null instead of overwriting another outcome.
import type { Tx } from '../../db/tenant.js';
import { SCHOOL, TRIP_COLUMNS, type TripRow } from './repository.js';

export interface StartWrite {
  startedBy: string;
  deviceId: string;
  clientStartId: string;
  deviceTime: string;
  latitude: number;
  longitude: number;
  odometer: number;
  driver: { id: string; name: string } | null;
  conductor: { id: string; name: string } | null;
  busCode: string;
  busRegistration: string;
}

const START_COLUMNS = [
  'start_device_time', 'start_lat', 'start_lng', 'start_odometer', 'device_id', 'started_by', 'client_start_id',
  'driver_staff_id', 'driver_name_snapshot', 'conductor_staff_id', 'conductor_name_snapshot', 'bus_code_snapshot', 'bus_registration_snapshot',
] as const;

/** `col = $n` list of the start columns, parameters numbered from `first`. */
const startSet = (first: number) => START_COLUMNS.map((c, i) => `${c} = $${first + i}`).join(', ');

function startParams(s: StartWrite): unknown[] {
  return [
    s.deviceTime, s.latitude, s.longitude, s.odometer, s.deviceId, s.startedBy, s.clientStartId,
    s.driver?.id ?? null, s.driver?.name ?? null, s.conductor?.id ?? null, s.conductor?.name ?? null, s.busCode, s.busRegistration,
  ];
}

/** scheduled → in_progress (school trip). */
export function startScheduled(tx: Tx, tripId: string, s: StartWrite): Promise<TripRow | null> {
  return tx.maybeOne<TripRow>(
    `update trips t set status = 'in_progress', started_at = now(), interrupted_at = null, updated_at = now(), ${startSet(2)}
      where t.id = $1 and t.status = 'scheduled' returning ${TRIP_COLUMNS}`,
    [tripId, ...startParams(s)],
  );
}

/** New non-school trip, created in progress (BP §10.1). */
export function insertNonSchool(tx: Tx, busId: string, purpose: string, s: StartWrite): Promise<TripRow> {
  return tx.one<TripRow>(
    `insert into trips as t (school_id, trip_type, direction, trip_date, bus_id, purpose, status, started_at, ${START_COLUMNS.join(', ')})
     values (${SCHOOL}, 'non_school', null, app_local_date(), $1, $2, 'in_progress', now(), ${START_COLUMNS.map((_, i) => `$${i + 3}`).join(', ')})
     returning ${TRIP_COLUMNS}`,
    [busId, purpose, ...startParams(s)],
  );
}

export interface EndWrite {
  endedBy: string;
  deviceTime: string;
  latitude: number;
  longitude: number;
  odometer: number;
  distanceOdometerKm: number;
  distanceGpsKm: number | null;
}

/** in_progress → completed. */
export function complete(tx: Tx, tripId: string, e: EndWrite): Promise<TripRow | null> {
  return tx.maybeOne<TripRow>(
    `update trips t set status = 'completed', ended_at = greatest(now(), t.started_at), closed_at = greatest(now(), t.started_at), end_device_time = $2, end_lat = $3, end_lng = $4,
            end_odometer = $5, distance_odometer_km = $6, distance_gps_km = $7, ended_by = $8, updated_at = now()
      where t.id = $1 and t.status = 'in_progress'
      returning ${TRIP_COLUMNS}`,
    [tripId, e.deviceTime, e.latitude, e.longitude, e.odometer, e.distanceOdometerKm, e.distanceGpsKm, e.endedBy],
  );
}

/** Driver reports a breakdown: the trip stays in progress until it is ended or cancelled. */
export function markInterrupted(tx: Tx, tripId: string, reason: string): Promise<TripRow | null> {
  return tx.maybeOne<TripRow>(
    `update trips t set interrupted_at = coalesce(t.interrupted_at, now()), close_reason = $2, updated_at = now()
      where t.id = $1 and t.status = 'in_progress'
      returning ${TRIP_COLUMNS}`,
    [tripId, reason],
  );
}

/** Admin cancellation of a scheduled or running trip. */
export function cancel(tx: Tx, tripId: string, reason: string, by: string | null): Promise<TripRow | null> {
  return tx.maybeOne<TripRow>(
    `update trips t set status = 'cancelled', cancel_reason = $2, cancelled_by = $3,
            ended_at = case when t.status = 'in_progress' then greatest(now(), t.started_at) else t.ended_at end,
            closed_at = case when t.status = 'in_progress' then greatest(now(), t.started_at) else t.closed_at end, updated_at = now()
      where t.id = $1 and t.status in ('scheduled', 'in_progress')
      returning ${TRIP_COLUMNS}`,
    [tripId, reason, by],
  );
}

export function applyOdometerCorrection(
  tx: Tx,
  tripId: string,
  c: { start: number | null; end: number | null; distanceOdometerKm: number | null; correction: Record<string, unknown> },
): Promise<TripRow> {
  return tx.one<TripRow>(
    `update trips t set start_odometer = $2, end_odometer = $3, distance_odometer_km = $4, odometer_correction = $5::jsonb, updated_at = now()
      where t.id = $1 returning ${TRIP_COLUMNS}`,
    [tripId, c.start, c.end, c.distanceOdometerKm, JSON.stringify(c.correction)],
  );
}

export function reassign(
  tx: Tx,
  tripId: string,
  r: { driver: { id: string; name: string } | null; conductor: { id: string; name: string } | null; setDriver: boolean; setConductor: boolean },
): Promise<TripRow> {
  return tx.one<TripRow>(
    `update trips t set
            driver_staff_id = case when $2::boolean then $3::uuid else t.driver_staff_id end,
            driver_name_snapshot = case when $2::boolean then $4::text else t.driver_name_snapshot end,
            conductor_staff_id = case when $5::boolean then $6::uuid else t.conductor_staff_id end,
            conductor_name_snapshot = case when $5::boolean then $7::text else t.conductor_name_snapshot end,
            updated_at = now()
      where t.id = $1 returning ${TRIP_COLUMNS}`,
    [tripId, r.setDriver, r.driver?.id ?? null, r.driver?.name ?? null, r.setConductor, r.conductor?.id ?? null, r.conductor?.name ?? null],
  );
}
