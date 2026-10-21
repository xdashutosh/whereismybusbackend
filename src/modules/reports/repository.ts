// SQL of the bus-level reports (BP §13.3 Reports). ONE aggregate statement per report, run in the
// caller's READ ONLY tenant transaction (RLS scopes every table to the school; school_id never comes
// from the request). Dates are school-local calendar days: trips.trip_date, fuel_logs.fuel_date and
// maintenance_logs.service_date are stored as the school's local date, so ranges compare them directly.
//
// Shared parameters: $1 from (date), $2 to (date), $3 bus filter (uuid | null).
// A trip "ran" when it started and was closed (completed, auto-closed, or cancelled while running);
// its distance is the odometer distance, falling back to the GPS distance.
// Bus-level reports list every non-deleted bus (idle buses show zeros) plus deleted buses that have
// activity in the range.
//
// Fuel and cost per km measure distance from the ODOMETER readings of the fuel logs (fill-to-fill, the
// same method as the Fuel page mileage: modules/fuel/mileage.ts): the fills of the range that have a
// mileage base cover every kilometre driven, depot runs and unrecorded driving included, and the fuel
// burnt over that distance is the litres / cost of their spans. Trip distance is the fallback only when
// no fill of the range has a fill-to-fill distance (fewer than two odometer readings).
import { SERVICE_DUE_LEAD_DAYS, SERVICE_DUE_LEAD_KM, type ReportKind } from '@wimb/shared';
import type { Tx } from '../../db/tenant.js';
import { DISTANCE as FILL_DISTANCE, FUEL_UNIT_SQL, PREVIOUS_JOIN } from '../fuel/repository.js';

export interface RangeFilter {
  from: string | null;
  to: string | null;
  busId: string | null;
  /** School-local today (service-due status). */
  today: string;
  /** Row cap + 1 is fetched to detect truncation. */
  cap: number;
}

const RAN = `t.started_at is not null and t.status in ('completed', 'auto_closed', 'cancelled')`;
const TRIP_KM = 'coalesce(t.distance_odometer_km, t.distance_gps_km)';
const TRIP_RANGE = 't.trip_date between $1::date and $2::date and ($3::uuid is null or t.bus_id = $3::uuid)';
const BUS_COLS = 'b.id as bus_id, b.code as bus_code, b.registration_no, (b.deleted_at is not null) as bus_deleted';
const BUS_FILTER = '($3::uuid is null or b.id = $3::uuid)';

/** Distance per bus over trips that ran in the range. */
const DISTANCE_CTE = `d as (
  select t.bus_id, coalesce(sum(${TRIP_KM}), 0) as km
    from trips t
   where ${RAN} and ${TRIP_RANGE}
   group by t.bus_id
)`;

const FUEL_CTE = `f as (
  select fl.bus_id, count(*)::int as fills, sum(fl.cost) as cost, max(fl.fuel_date) as last_fill_date,
         coalesce(sum(fl.litres) filter (where u.unit = 'L'), 0) as litres, coalesce(sum(fl.cost) filter (where u.unit = 'L'), 0) as litres_cost,
         coalesce(sum(fl.litres) filter (where u.unit = 'kg'), 0) as kg, coalesce(sum(fl.cost) filter (where u.unit = 'kg'), 0) as kg_cost,
         coalesce(sum(fl.litres) filter (where u.unit = 'kWh'), 0) as kwh, coalesce(sum(fl.cost) filter (where u.unit = 'kWh'), 0) as kwh_cost,
         array_agg(distinct u.unit) as units, sum(fl.litres) as quantity_any
    from fuel_logs fl
    join buses fb on fb.id = fl.bus_id
    cross join lateral (select ${FUEL_UNIT_SQL('fl', 'fb')} as unit) u
   where fl.deleted_at is null and fl.fuel_date between $1::date and $2::date and ($3::uuid is null or fl.bus_id = $3::uuid)
   group by fl.bus_id
)`;

/**
 * Odometer distance per bus: Σ fill-to-fill distance of the fills in the range (the mileage base may lie
 * before it) and the quantity / cost of their spans (fuel burnt over that distance). km is null when no
 * fill of the range has a distance.
 */
const ODOMETER_CTE = `o as (
  select fl.bus_id, sum(${FILL_DISTANCE}) as km,
         sum(span.litres) filter (where ${FILL_DISTANCE} is not null) as quantity,
         sum(span.cost) filter (where ${FILL_DISTANCE} is not null) as cost
    from fuel_logs fl
    ${PREVIOUS_JOIN}
   where fl.deleted_at is null and fl.fuel_date between $1::date and $2::date and ($3::uuid is null or fl.bus_id = $3::uuid)
   group by fl.bus_id
)`;

/**
 * Distance columns of the fuel and cost-per-km reports (needs ODOMETER_CTE o, DISTANCE_CTE d, FUEL_CTE f
 * joined per bus): odometer km, trip km, the distance the ratios use (odometer, else trips) and its
 * source, plus km_cost / km_quantity — the fuel burnt over that distance (span of the odometer fills,
 * else every fill of the range); null without a distance, so a bus with fuel but no km never skews the
 * per-km totals (Σ km_cost / Σ distance_km).
 */
const KM = 'coalesce(o.km, d.km, 0)';
const KM_COST = `case when o.km is not null then o.cost when d.km > 0 then f.cost end`;
const KM_QUANTITY = `case when o.km is not null then o.quantity when d.km > 0 then f.quantity_any end`;
const FUEL_DISTANCE_COLS = `round(o.km, 1) as odometer_km, round(coalesce(d.km, 0), 1) as trip_km, round(${KM}, 1) as distance_km,
       case when o.km is not null then 'odometer' when d.km > 0 then 'trips' end as distance_source,
       round(${KM_COST}, 2) as km_cost, round(${KM_QUANTITY}, 2) as km_quantity`;

const MAINT_CTE = `m as (
  select ml.bus_id, count(*)::int as services, coalesce(sum(ml.cost), 0) as total_cost,
         (count(*) filter (where ml.cost is null))::int as unpriced_services,
         array_agg(distinct btrim(ml.service_type) order by btrim(ml.service_type)) as service_types
    from maintenance_logs ml
   where ml.deleted_at is null and ml.service_date between $1::date and $2::date and ($3::uuid is null or ml.bus_id = $3::uuid)
   group by ml.bus_id
)`;

const BUS_DISTANCE = `
with t as (
  select t.bus_id,
         count(*)::int as trips,
         (count(*) filter (where t.trip_type = 'school'))::int as school_trips,
         (count(*) filter (where t.trip_type = 'non_school'))::int as non_school_trips,
         count(distinct t.trip_date)::int as active_days,
         coalesce(sum(t.distance_odometer_km), 0) as odometer_km,
         coalesce(sum(t.distance_gps_km), 0) as gps_km,
         coalesce(sum(${TRIP_KM}), 0) as distance_km,
         min(t.trip_date) as first_trip_date, max(t.trip_date) as last_trip_date
    from trips t
   where ${RAN} and ${TRIP_RANGE}
   group by t.bus_id
)
select ${BUS_COLS}, b.status as bus_status,
       coalesce(t.trips, 0) as trips, coalesce(t.school_trips, 0) as school_trips, coalesce(t.non_school_trips, 0) as non_school_trips,
       coalesce(t.active_days, 0) as active_days,
       round(coalesce(t.odometer_km, 0), 1) as odometer_km, round(coalesce(t.gps_km, 0), 1) as gps_km,
       round(coalesce(t.distance_km, 0), 1) as distance_km,
       round(t.distance_km / nullif(t.trips, 0), 1) as avg_km_per_trip,
       t.first_trip_date, t.last_trip_date
  from buses b
  left join t on t.bus_id = b.id
 where ${BUS_FILTER} and (b.deleted_at is null or t.bus_id is not null)
 order by b.code, b.id
 limit $4`;

const FUEL = `
with ${FUEL_CTE}, ${DISTANCE_CTE}, ${ODOMETER_CTE}
select ${BUS_COLS}, b.fuel_type,
       coalesce(f.fills, 0) as fills,
       (select coalesce(array_agg(x.unit order by x.ord), '{}'::text[])
          from unnest(array['L', 'kg', 'kWh']) with ordinality as x(unit, ord) where x.unit = any (f.units)) as units,
       round(coalesce(f.litres, 0), 2) as litres, round(coalesce(f.kg, 0), 2) as kg, round(coalesce(f.kwh, 0), 2) as kwh,
       round(coalesce(f.litres_cost, 0), 2) as litres_cost, round(coalesce(f.kg_cost, 0), 2) as kg_cost, round(coalesce(f.kwh_cost, 0), 2) as kwh_cost,
       round(coalesce(f.cost, 0), 2) as cost,
       case when cardinality(f.units) = 1 then round(f.cost / nullif(f.quantity_any, 0), 2) end as avg_price_per_unit,
       ${FUEL_DISTANCE_COLS},
       case when cardinality(f.units) = 1 then round(nullif(${KM}, 0) / nullif(${KM_QUANTITY}, 0), 2) end as km_per_unit,
       round(${KM_COST} / nullif(${KM}, 0), 2) as fuel_cost_per_km,
       f.last_fill_date
  from buses b
  left join f on f.bus_id = b.id
  left join d on d.bus_id = b.id
  left join o on o.bus_id = b.id
 where ${BUS_FILTER} and (b.deleted_at is null or f.bus_id is not null or d.bus_id is not null)
 order by b.code, b.id
 limit $4`;

const MAINTENANCE = `
with ${MAINT_CTE},
last_service as (
  select distinct on (ml.bus_id) ml.bus_id, btrim(ml.service_type) as service_type, ml.service_date
    from maintenance_logs ml
   where ml.deleted_at is null and ml.service_date between $1::date and $2::date and ($3::uuid is null or ml.bus_id = $3::uuid)
   order by ml.bus_id, ml.service_date desc, ml.created_at desc, ml.id desc
),
next_due as (
  select x.bus_id, min(x.next_due_date) as next_due_date
    from (select distinct on (ml.bus_id, lower(btrim(ml.service_type))) ml.bus_id, ml.next_due_date
            from maintenance_logs ml
           where ml.deleted_at is null and ($3::uuid is null or ml.bus_id = $3::uuid)
           order by ml.bus_id, lower(btrim(ml.service_type)), ml.service_date desc, ml.created_at desc, ml.id desc) x
   where x.next_due_date is not null
   group by x.bus_id
)
select ${BUS_COLS},
       coalesce(m.services, 0) as services, round(coalesce(m.total_cost, 0), 2) as total_cost,
       round(m.total_cost / nullif(m.services - m.unpriced_services, 0), 2) as avg_cost,
       coalesce(m.unpriced_services, 0) as unpriced_services, coalesce(m.service_types, '{}'::text[]) as service_types,
       ls.service_date as last_service_date, ls.service_type as last_service_type, nd.next_due_date
  from buses b
  left join m on m.bus_id = b.id
  left join last_service ls on ls.bus_id = b.id
  left join next_due nd on nd.bus_id = b.id
 where ${BUS_FILTER} and (b.deleted_at is null or m.bus_id is not null)
 order by b.code, b.id
 limit $4`;

const COST_PER_KM = `
with ${DISTANCE_CTE}, ${FUEL_CTE}, ${ODOMETER_CTE}, ${MAINT_CTE}
select ${BUS_COLS},
       ${FUEL_DISTANCE_COLS},
       round(coalesce(f.cost, 0), 2) as fuel_cost,
       round(coalesce(m.total_cost, 0), 2) as maintenance_cost,
       round(coalesce(f.cost, 0) + coalesce(m.total_cost, 0), 2) as total_cost,
       round(coalesce(${KM_COST}, 0) / nullif(${KM}, 0), 2) as fuel_cost_per_km,
       round(coalesce(m.total_cost, 0) / nullif(${KM}, 0), 2) as maintenance_cost_per_km,
       round((coalesce(${KM_COST}, 0) + coalesce(m.total_cost, 0)) / nullif(${KM}, 0), 2) as cost_per_km
  from buses b
  left join d on d.bus_id = b.id
  left join f on f.bus_id = b.id
  left join o on o.bus_id = b.id
  left join m on m.bus_id = b.id
 where ${BUS_FILTER} and (b.deleted_at is null or d.bus_id is not null or f.bus_id is not null or m.bus_id is not null)
 order by b.code, b.id
 limit $4`;

// Service due: the LATEST non-deleted log per bus and service type (case-insensitive) carries the next
// due date / km — the same rule as the maintenance-due-scan job — for buses in service. Status as of the
// school-local today: overdue (date passed or odometer ≥ due km), due soon (within SERVICE_DUE_LEAD_DAYS
// days or SERVICE_DUE_LEAD_KM km), otherwise scheduled. An explicit date range filters next_due_date
// (km-only schedules have no date and are then left out).
const SERVICE_DUE = `
with latest as (
  select distinct on (ml.bus_id, lower(btrim(ml.service_type)))
         ml.id, ml.bus_id, btrim(ml.service_type) as service_type, ml.service_date, ml.odometer, ml.vendor, ml.next_due_date, ml.next_due_km
    from maintenance_logs ml
   where ml.deleted_at is null and ($3::uuid is null or ml.bus_id = $3::uuid)
   order by ml.bus_id, lower(btrim(ml.service_type)), ml.service_date desc, ml.created_at desc, ml.id desc
),
x as (
  select l.*, b.code as bus_code, b.registration_no, b.last_known_odometer as current_odometer,
         (l.next_due_date - $5::date) as days_to_due,
         case when l.next_due_km is not null and b.last_known_odometer is not null then round(l.next_due_km - b.last_known_odometer, 1) end as km_to_due
    from latest l
    join buses b on b.id = l.bus_id and b.deleted_at is null and b.status in ('active', 'maintenance')
   where l.next_due_date is not null or l.next_due_km is not null
),
y as (
  select x.*,
         case when x.days_to_due < 0 or x.km_to_due <= 0 then 'overdue'
              when x.days_to_due <= $6::int or x.km_to_due <= $7::numeric then 'due_soon'
              else 'scheduled' end as status,
         case when x.days_to_due < 0 then 'date' when x.km_to_due <= 0 then 'km'
              when x.days_to_due <= $6::int then 'date' when x.km_to_due <= $7::numeric then 'km' end as due_by
    from x
   where ($1::date is null or x.next_due_date >= $1::date) and ($2::date is null or x.next_due_date <= $2::date)
)
select y.id as maintenance_log_id, y.bus_id, y.bus_code, y.registration_no, y.service_type,
       y.service_date as last_service_date, y.odometer as last_service_odometer, y.vendor,
       y.next_due_date, y.days_to_due, y.next_due_km, y.current_odometer, y.km_to_due, y.status, y.due_by
  from y
 order by case y.status when 'overdue' then 1 when 'due_soon' then 2 else 3 end,
          y.days_to_due nulls last, y.km_to_due nulls last, y.bus_code, lower(y.service_type), y.id
 limit $4`;

const NON_SCHOOL_USAGE = `
select t.id as trip_id, t.trip_date, t.bus_id,
       coalesce(t.bus_code_snapshot, b.code) as bus_code, coalesce(t.bus_registration_snapshot, b.registration_no) as registration_no,
       coalesce(t.driver_name_snapshot, dp.full_name) as driver_name, coalesce(t.conductor_name_snapshot, cp.full_name) as conductor_name,
       t.purpose, t.status, t.started_at, t.ended_at,
       case when t.started_at is not null and t.ended_at is not null
            then round(extract(epoch from (t.ended_at - t.started_at)) / 60)::int end as duration_min,
       t.start_odometer, t.end_odometer, ${TRIP_KM} as distance_km,
       (select count(*)::int from alerts a where a.trip_id = t.id) as alerts
  from trips t
  left join buses b on b.id = t.bus_id
  left join staff_profiles dp on dp.id = t.driver_staff_id
  left join staff_profiles cp on cp.id = t.conductor_staff_id
 where t.trip_type = 'non_school' and ${TRIP_RANGE}
 order by t.trip_date desc, t.started_at desc nulls last, t.id
 limit $4`;

// Trip summary per bus. School trips are judged against their planned start: on time when started
// within the school's "not started" grace minutes (school_settings.trip_not_started_grace_min), late
// otherwise; the average start delay counts early starts as 0. Completion rate = completed /
// (completed + auto-closed + missed) — cancelled trips are excluded. Alerts = alerts linked to the
// bus's trips of the range.
const TRIP_SUMMARY = `
with g as (select coalesce((select trip_not_started_grace_min from school_settings), 10) as grace),
t as (
  select t.bus_id,
         count(*)::int as trips,
         (count(*) filter (where t.trip_type = 'school'))::int as school_trips,
         (count(*) filter (where t.trip_type = 'school' and t.status = 'completed'))::int as completed,
         (count(*) filter (where t.trip_type = 'school' and t.status = 'auto_closed'))::int as auto_closed,
         (count(*) filter (where t.trip_type = 'school' and t.status = 'missed'))::int as missed,
         (count(*) filter (where t.trip_type = 'school' and t.status = 'cancelled'))::int as cancelled,
         (count(*) filter (where t.trip_type = 'school' and t.status = 'in_progress'))::int as in_progress,
         (count(*) filter (where t.trip_type = 'school' and t.status = 'scheduled'))::int as scheduled,
         (count(*) filter (where t.trip_type = 'non_school'))::int as non_school_trips,
         (count(*) filter (where t.trip_type = 'school' and t.started_at is not null and t.planned_start_at is not null
                            and t.started_at <= t.planned_start_at + make_interval(mins => g.grace)))::int as on_time_starts,
         (count(*) filter (where t.trip_type = 'school' and t.started_at is not null and t.planned_start_at is not null
                            and t.started_at > t.planned_start_at + make_interval(mins => g.grace)))::int as late_starts,
         round((avg(greatest(0, extract(epoch from (t.started_at - t.planned_start_at)) / 60))
                filter (where t.trip_type = 'school' and t.started_at is not null and t.planned_start_at is not null))::numeric, 1) as avg_start_delay_min,
         coalesce(sum(${TRIP_KM}) filter (where ${RAN}), 0) as distance_km
    from trips t cross join g
   where ${TRIP_RANGE}
   group by t.bus_id
),
a as (
  select t.bus_id, count(*)::int as alerts
    from alerts al join trips t on t.id = al.trip_id
   where ${TRIP_RANGE}
   group by t.bus_id
)
select ${BUS_COLS},
       coalesce(t.trips, 0) as trips, coalesce(t.school_trips, 0) as school_trips, coalesce(t.completed, 0) as completed,
       coalesce(t.auto_closed, 0) as auto_closed, coalesce(t.missed, 0) as missed, coalesce(t.cancelled, 0) as cancelled,
       coalesce(t.in_progress, 0) as in_progress, coalesce(t.scheduled, 0) as scheduled, coalesce(t.non_school_trips, 0) as non_school_trips,
       coalesce(t.on_time_starts, 0) as on_time_starts, coalesce(t.late_starts, 0) as late_starts, t.avg_start_delay_min,
       round(100.0 * t.completed / nullif(t.completed + t.auto_closed + t.missed, 0), 1) as completion_rate_pct,
       round(coalesce(t.distance_km, 0), 1) as distance_km, coalesce(a.alerts, 0) as alerts
  from buses b
  left join t on t.bus_id = b.id
  left join a on a.bus_id = b.id
 where ${BUS_FILTER} and (b.deleted_at is null or t.bus_id is not null)
 order by b.code, b.id
 limit $4`;

const SQL: Readonly<Record<ReportKind, string>> = Object.freeze({
  'bus-distance': BUS_DISTANCE,
  fuel: FUEL,
  maintenance: MAINTENANCE,
  'cost-per-km': COST_PER_KM,
  'service-due': SERVICE_DUE,
  'non-school-usage': NON_SCHOOL_USAGE,
  'trip-summary': TRIP_SUMMARY,
});

/** Runs the report's single aggregate statement; rows come back snake_case. */
export function runReport(tx: Tx, kind: ReportKind, f: RangeFilter): Promise<Record<string, unknown>[]> {
  const params: unknown[] = [f.from, f.to, f.busId, f.cap + 1];
  if (kind === 'service-due') params.push(f.today, SERVICE_DUE_LEAD_DAYS, SERVICE_DUE_LEAD_KM);
  return tx.many(SQL[kind], params);
}

export interface ReportContextRow extends Record<string, unknown> {
  school_name: string;
  school_code: string;
  timezone: string;
  today: string;
  logo_key: string | null;
  bus_code: string | null;
  bus_found: boolean | null;
}

/**
 * School header (name, code, logo key of an uploaded logo), the school-local today and — when a bus
 * filter is given — whether that bus exists in this school (deleted buses included: history).
 */
export function loadContext(tx: Tx, timezone: string, busId: string | null): Promise<ReportContextRow> {
  return tx.one<ReportContextRow>(
    `select s.name as school_name, s.code as school_code, s.timezone,
            to_char((now() at time zone $1::text)::date, 'YYYY-MM-DD') as today,
            case when f.status = 'uploaded' then f.key end as logo_key,
            (select b.code from buses b where b.id = $2::uuid) as bus_code,
            case when $2::uuid is null then null else exists (select 1 from buses b where b.id = $2::uuid) end as bus_found
       from schools s
       left join files f on f.id = s.logo_file_id
      where s.id = nullif(current_setting('app.school_id', true), '')::uuid`,
    [timezone, busId],
  );
}
