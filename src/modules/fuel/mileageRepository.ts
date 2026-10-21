// Mileage SQL (BP §13.3 Fuel: per-bus mileage trends). Fill-to-fill method (the tank is refilled to
// full): the distance of a fill is its odometer minus its mileage base — the earlier fuel log of the bus
// with the highest reading, before the period too — and its mileage is that distance divided by the
// litres of every fill since the base (see repository.ts PREVIOUS_JOIN).
import type { Tx } from '../../db/tenant.js';
import { escapeLike, MAX_EXPORT_ROWS } from '../../shared/pagination.js';
import { flaggedSql } from './odometer.js';
import { FROM, SELECT, type FuelLogRow } from './repository.js';

export interface MileageBusRow extends Record<string, unknown> {
  id: string;
  code: string;
  registration_no: string;
  fuel_type: string | null;
  last_known_odometer: number | null;
}

/** A bus of the school, deleted ones included (their history stays readable). */
export function findBus(tx: Tx, id: string): Promise<MileageBusRow | null> {
  return tx.maybeOne<MileageBusRow>('select id, code, registration_no, fuel_type, last_known_odometer from buses where id = $1', [id]);
}

/** Fills of one bus in the period, oldest first, with their fill-to-fill distance and flags. */
export function trendRows(tx: Tx, busId: string, from: string | null, to: string | null): Promise<FuelLogRow[]> {
  return tx.many<FuelLogRow>(
    `select ${SELECT} ${FROM}
      where fl.deleted_at is null and fl.bus_id = $1 and ($2::date is null or fl.fuel_date >= $2) and ($3::date is null or fl.fuel_date <= $3)
      order by fl.fuel_date, fl.created_at, fl.id
      limit ${MAX_EXPORT_ROWS}`,
    [busId, from, to],
  );
}

export interface SummaryRow extends Record<string, unknown> {
  bus_id: string;
  bus_code: string;
  registration_no: string;
  fuel_type: string | null;
  fills: number;
  litres: number;
  cost: number;
  distance_km: number | null;
  litres_with_distance: number | null;
  cost_with_distance: number | null;
  first_fuel_date: string;
  last_fuel_date: string;
  flagged_logs: number;
}

/** One row per bus with fuel logs in the period (one statement). */
export function summaryRows(tx: Tx, f: { from: string | null; to: string | null; q?: string }): Promise<SummaryRow[]> {
  return tx.many<SummaryRow>(
    `with x as (
       select fl.bus_id, fl.fuel_date, fl.litres, fl.cost, span.litres as span_litres, span.cost as span_cost,
              case when fl.odometer > prev.odometer then fl.odometer - prev.odometer end as distance_km, coalesce(${flaggedSql('fl')}, false) as flagged
         ${FROM}
        where fl.deleted_at is null and ($1::date is null or fl.fuel_date >= $1) and ($2::date is null or fl.fuel_date <= $2)
          and ($3::text is null or b.code ilike $3 or b.registration_no ilike $3)
     )
     select b.id as bus_id, b.code as bus_code, b.registration_no, b.fuel_type,
            count(*)::int as fills, sum(x.litres) as litres, sum(x.cost) as cost, sum(x.distance_km) as distance_km,
            sum(x.span_litres) filter (where x.distance_km is not null) as litres_with_distance,
            sum(x.span_cost) filter (where x.distance_km is not null) as cost_with_distance,
            min(x.fuel_date) as first_fuel_date, max(x.fuel_date) as last_fuel_date,
            (count(*) filter (where x.flagged))::int as flagged_logs
       from x join buses b on b.id = x.bus_id
      group by b.id, b.code, b.registration_no, b.fuel_type
      order by b.code, b.id`,
    [f.from, f.to, f.q ? `%${escapeLike(f.q)}%` : null],
  );
}
