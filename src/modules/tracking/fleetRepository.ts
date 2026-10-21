// Read models of the live fleet and trip path views (one statement each; RLS = own school).
import type { Direction, TripStatus, TripType } from '@wimb/shared';
import type { Tx } from '../../db/tenant.js';

export interface FleetRow extends Record<string, unknown> {
  bus_id: string;
  bus_code: string;
  display_name: string | null;
  registration_no: string;
  bus_status: string;
  driver: { staffId: string; name: string } | null;
  conductor: { staffId: string; name: string } | null;
  trip_id: string | null;
  trip_type: TripType | null;
  direction: Direction | null;
  trip_status: TripStatus | null;
  route_id: string | null;
  route_code: string | null;
  route_name: string | null;
  started_at: string | null;
  planned_start_at: string | null;
  points_count: number | null;
  trip_driver: { staffId: string; name: string } | null;
  trip_conductor: { staffId: string; name: string } | null;
  next_trip: { id: string; direction: Direction | null; plannedStartAt: string | null; routeCode: string | null } | null;
  last_known: { lat: number; lng: number; at: string; tripId: string } | null;
}

const assigned = (role: string) => `(
  select json_build_object('staffId', sp.id, 'name', sp.full_name)
    from bus_staff_assignments a join staff_profiles sp on sp.id = a.staff_id and sp.deleted_at is null
   where a.bus_id = b.id and a.assignment_role = '${role}' and a.valid_from <= now() and (a.valid_to is null or a.valid_to > now())
   order by a.valid_from desc limit 1)`;

/** Every non-deleted bus with its current crew, running trip, today's next trip and last known position. */
export function fleet(tx: Tx, timezone: string): Promise<FleetRow[]> {
  return tx.many<FleetRow>(
    `select b.id as bus_id, b.code as bus_code, b.display_name, b.registration_no, b.status as bus_status,
            ${assigned('primary_driver')} as driver,
            ${assigned('conductor')} as conductor,
            t.id as trip_id, t.trip_type, t.direction, t.status as trip_status, t.route_id,
            coalesce(r.code, t.route_code_snapshot) as route_code, coalesce(r.name, t.route_name_snapshot) as route_name,
            t.started_at, t.planned_start_at, t.points_count,
            case when t.driver_staff_id is null then null
                 else json_build_object('staffId', t.driver_staff_id, 'name', coalesce(t.driver_name_snapshot, dsp.full_name)) end as trip_driver,
            case when t.conductor_staff_id is null then null
                 else json_build_object('staffId', t.conductor_staff_id, 'name', coalesce(t.conductor_name_snapshot, csp.full_name)) end as trip_conductor,
            (select json_build_object('id', n.id, 'direction', n.direction, 'plannedStartAt', n.planned_start_at,
                                      'routeCode', coalesce(nr.code, n.route_code_snapshot))
               from trips n left join routes nr on nr.id = n.route_id
              where n.bus_id = b.id and n.status = 'scheduled' and n.trip_date = (now() at time zone $1)::date
              order by n.planned_start_at nulls last limit 1) as next_trip,
            (select json_build_object('lat', l.end_lat::float8, 'lng', l.end_lng::float8, 'at', l.ended_at, 'tripId', l.id)
               from trips l
              where l.bus_id = b.id and l.status in ('completed', 'auto_closed') and l.end_lat is not null
              order by l.ended_at desc limit 1) as last_known
       from buses b
       left join trips t on t.bus_id = b.id and t.status = 'in_progress'
       left join routes r on r.id = t.route_id
       left join staff_profiles dsp on dsp.id = t.driver_staff_id
       left join staff_profiles csp on csp.id = t.conductor_staff_id
      where b.deleted_at is null
      order by b.code, b.id`,
    [timezone],
  );
}

export interface PathTripRow extends Record<string, unknown> {
  id: string;
  status: TripStatus;
  trip_type: TripType;
  direction: Direction | null;
  trip_date: string;
  bus_id: string;
  bus_code: string | null;
  route_id: string | null;
  route_code: string | null;
  route_name: string | null;
  started_at: string | null;
  ended_at: string | null;
  distance_gps_km: number | null;
  distance_odometer_km: number | null;
  finalized_at: string | null;
  summary: Record<string, unknown> | null;
  first_point: { lat: number; lng: number; at: string } | null;
  last_point: { lat: number; lng: number; at: string } | null;
}

export function pathTrip(tx: Tx, tripId: string): Promise<PathTripRow | null> {
  const edge = (dir: 'asc' | 'desc') => `(
    select json_build_object('lat', p.latitude, 'lng', p.longitude, 'at', p.recorded_at)
      from location_points p
     where p.trip_id = t.id
       and (t.started_at is null or p.recorded_at >= t.started_at - interval '1 day')
       and p.recorded_at <= coalesce(t.ended_at, now()) + interval '1 day'
     order by p.recorded_at ${dir} limit 1)`;
  return tx.maybeOne<PathTripRow>(
    `select t.id, t.status, t.trip_type, t.direction, t.trip_date, t.bus_id, coalesce(t.bus_code_snapshot, b.code) as bus_code,
            t.route_id, coalesce(t.route_code_snapshot, r.code) as route_code, coalesce(t.route_name_snapshot, r.name) as route_name,
            t.started_at, t.ended_at, t.distance_gps_km, t.distance_odometer_km, t.finalized_at, t.summary,
            ${edge('asc')} as first_point, ${edge('desc')} as last_point
       from trips t
       join buses b on b.id = t.bus_id
       left join routes r on r.id = t.route_id
      where t.id = $1`,
    [tripId],
  );
}
