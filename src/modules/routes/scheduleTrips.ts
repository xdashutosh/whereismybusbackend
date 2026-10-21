// Keeps not-yet-started trips generated from a schedule consistent with it (BP §7.3 generate-daily-trips
// creates one 'scheduled' trip per schedule and school-local date). Only trips still 'scheduled' and dated
// today or later (school-local) are touched; trips in progress and history are never changed.
//   cancelPendingTrips — schedule deleted or deactivated
//   syncPendingTrips   — schedule edited: trips whose date no longer matches the weekdays/validity are
//                        cancelled, the others take the new bus, route, direction, planned start and
//                        snapshots (driver/conductor snapshots follow a bus change).
import type { Tx } from '../../db/tenant.js';

export async function cancelPendingTrips(tx: Tx, scheduleId: string, reason: string): Promise<number> {
  const res = await tx.query(
    `update trips set status = 'cancelled', cancel_reason = $2,
            cancelled_by = nullif(current_setting('app.actor_id', true), '')::uuid, updated_at = now()
      where schedule_id = $1 and status = 'scheduled' and trip_date >= app_local_date()`,
    [scheduleId, reason],
  );
  return res.rowCount ?? 0;
}

const currentStaff = (role: string) => `(select a.staff_id from bus_staff_assignments a
    where a.bus_id = ts.bus_id and a.assignment_role = '${role}' and a.valid_from <= now() and (a.valid_to is null or a.valid_to > now())
    order by a.valid_from desc limit 1)`;

export async function syncPendingTrips(tx: Tx, scheduleId: string, reason: string): Promise<{ cancelled: number; updated: number }> {
  return tx.one<{ cancelled: number; updated: number }>(
    `with s as (
       select ts.id, ts.bus_id, ts.route_id, ts.direction, ts.planned_start_time, ts.days_of_week, ts.valid_from, ts.valid_to,
              b.code as bus_code, b.registration_no, r.code as route_code, r.name as route_name, sc.timezone,
              ${currentStaff('primary_driver')} as driver_id, ${currentStaff('conductor')} as conductor_id
         from trip_schedules ts
         join buses b on b.id = ts.bus_id
         join routes r on r.id = ts.route_id
         join schools sc on sc.id = ts.school_id
        where ts.id = $1
     ), pending as (
       select t.id, t.trip_date, t.bus_id from trips t join s on t.schedule_id = s.id
        where t.status = 'scheduled' and t.trip_date >= app_local_date()
     ), cancelled as (
       update trips t set status = 'cancelled', cancel_reason = $2,
              cancelled_by = nullif(current_setting('app.actor_id', true), '')::uuid, updated_at = now()
         from s
        where t.id in (select id from pending)
          and (not (extract(isodow from t.trip_date)::smallint = any (s.days_of_week))
               or (s.valid_from is not null and t.trip_date < s.valid_from)
               or (s.valid_to is not null and t.trip_date > s.valid_to))
       returning t.id
     ), updated as (
       update trips t set
              bus_id = s.bus_id, route_id = s.route_id, direction = s.direction,
              planned_start_at = (t.trip_date + s.planned_start_time) at time zone s.timezone,
              bus_code_snapshot = s.bus_code, bus_registration_snapshot = s.registration_no,
              route_code_snapshot = s.route_code, route_name_snapshot = s.route_name,
              driver_staff_id = case when t.bus_id <> s.bus_id then s.driver_id else t.driver_staff_id end,
              driver_name_snapshot = case when t.bus_id <> s.bus_id then (select full_name from staff_profiles where id = s.driver_id) else t.driver_name_snapshot end,
              conductor_staff_id = case when t.bus_id <> s.bus_id then s.conductor_id else t.conductor_staff_id end,
              conductor_name_snapshot = case when t.bus_id <> s.bus_id then (select full_name from staff_profiles where id = s.conductor_id) else t.conductor_name_snapshot end,
              updated_at = now()
         from s
        where t.id in (select id from pending) and t.id not in (select id from cancelled)
          and (t.bus_id, t.route_id, t.direction, t.planned_start_at, t.route_code_snapshot, t.route_name_snapshot, t.bus_code_snapshot)
              is distinct from (s.bus_id, s.route_id, s.direction, (t.trip_date + s.planned_start_time) at time zone s.timezone,
                                s.route_code, s.route_name, s.bus_code)
       returning t.id
     )
     select (select count(*)::int from cancelled) as cancelled, (select count(*)::int from updated) as updated`,
    [scheduleId, reason],
  );
}
