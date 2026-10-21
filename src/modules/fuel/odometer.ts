// Odometer plausibility for fuel and maintenance logs (task "odometer monotonic per bus warnings").
// A bus's readings come from three places — fuel logs, maintenance logs and the trip odometer
// evidence (trips.start_odometer / end_odometer) — and must not decrease over time. Log entries are
// typed by hand and often back-dated, so a violation never blocks the write: the response carries
// `warnings` and lists show `odometerFlags`. Days are compared as calendar days (same-day readings
// are not ordered against each other: a morning fill and an evening trip end are both plausible).
// Each reading is compared with its NEAREST neighbours only — the previous reading (latest earlier
// day; the highest of that day) and the next one (earliest later day; the lowest of that day) — so a
// single mistyped entry flags itself and one neighbour, never the whole history of the bus.
import type { LogWarning, OdometerFlag } from '@wimb/shared';
import type { Tx } from '../../db/tenant.js';

/**
 * Readings of bus `bus` except the log `self` (SQL expressions; `guard` short-circuits the scan,
 * e.g. 'fl.odometer is not null'). Columns: day (date), reading (numeric), source (text).
 */
export function busReadingsSql(bus: string, self: string, guard = 'true'): string {
  return `select f.fuel_date as day, f.odometer as reading, 'fuel_log'::text as source from fuel_logs f
           where ${guard} and f.bus_id = ${bus} and f.deleted_at is null and f.odometer is not null and f.id is distinct from ${self}
         union all
         select m.service_date, m.odometer, 'maintenance_log' from maintenance_logs m
           where ${guard} and m.bus_id = ${bus} and m.deleted_at is null and m.odometer is not null and m.id is distinct from ${self}
         union all
         select t.trip_date, r.reading, 'trip' from trips t cross join lateral (values (t.start_odometer), (t.end_odometer)) r (reading)
           where ${guard} and t.bus_id = ${bus} and r.reading is not null`;
}

/**
 * LEFT JOIN LATERAL adding `<alias>.prev_reading` (the reading of the latest earlier day) and
 * `<alias>.next_reading` (the reading of the earliest later day) for the log row `row` (table alias)
 * whose date column is `dayCol`.
 */
export function odometerCheckJoin(row: string, dayCol: string, alias = 'chk'): string {
  const readings = busReadingsSql(`${row}.bus_id`, `${row}.id`, `${row}.odometer is not null`);
  return `left join lateral (
      select (select r.reading from (${readings}) r where r.day < ${row}.${dayCol} order by r.day desc, r.reading desc limit 1) as prev_reading,
             (select r.reading from (${readings}) r where r.day > ${row}.${dayCol} order by r.day asc, r.reading asc limit 1) as next_reading
    ) ${alias} on true`;
}

/** SQL predicate: the row has an odometer flag (uses odometerCheckJoin's alias). */
export function flaggedSql(row: string, alias = 'chk'): string {
  return `(${row}.odometer < ${alias}.prev_reading or ${row}.odometer > ${alias}.next_reading)`;
}

const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** List flags from the prev_reading / next_reading columns. */
export function odometerFlags(odometer: unknown, prevReading: unknown, nextReading: unknown): OdometerFlag[] {
  const odo = n(odometer);
  if (odo === null) return [];
  const out: OdometerFlag[] = [];
  const p = n(prevReading);
  const x = n(nextReading);
  if (p !== null && odo < p) out.push('below_previous');
  if (x !== null && odo > x) out.push('above_next');
  return out;
}

export const formatKm = (v: number) => `${v.toLocaleString('en-IN', { maximumFractionDigits: 1 })} km`;

interface CheckRow extends Record<string, unknown> {
  prev_reading: number | null;
  prev_day: string | null;
  prev_source: string | null;
  next_reading: number | null;
  next_day: string | null;
  next_source: string | null;
  bus_odometer: number | null;
  bus_reading_day: string | null;
}

const SOURCE_LABEL: Record<string, string> = { fuel_log: 'a fuel log', maintenance_log: 'a maintenance log', trip: 'a trip' };

/**
 * Non-blocking odometer warnings for a log of `busId` dated `day` with `odometer` (self = the log
 * being updated, excluded from the comparison). One statement.
 */
export async function odometerWarnings(tx: Tx, { busId, day, odometer, selfId }: { busId: string; day: string; odometer: number | null | undefined; selfId: string | null }): Promise<LogWarning[]> {
  if (odometer === null || odometer === undefined) return [];
  const row = await tx.maybeOne<CheckRow>(
    `with r as (${busReadingsSql('$1::uuid', '$2::uuid')}),
          before as (select day, reading, source from r where day < $3::date order by day desc, reading desc limit 1),
          after as (select day, reading, source from r where day > $3::date order by day asc, reading asc limit 1)
     select (select reading from before) as prev_reading, (select day from before) as prev_day, (select source from before) as prev_source,
            (select reading from after) as next_reading, (select day from after) as next_day, (select source from after) as next_source,
            b.last_known_odometer as bus_odometer, (b.odometer_updated_at at time zone s.timezone)::date as bus_reading_day
       from buses b join schools s on s.id = b.school_id
      where b.id = $1`,
    [busId, selfId, day],
  );
  if (!row) return [];
  const out: LogWarning[] = [];
  const prev = n(row.prev_reading);
  const next = n(row.next_reading);
  const bus = n(row.bus_odometer);
  if (prev !== null && odometer < prev) {
    out.push({
      code: 'ODOMETER_BELOW_PREVIOUS',
      message: `The odometer reading ${formatKm(odometer)} is lower than ${formatKm(prev)} recorded on ${row.prev_day} (${SOURCE_LABEL[row.prev_source ?? ''] ?? 'another record'}).`,
      details: { odometer, previousReading: prev, previousDate: row.prev_day, previousSource: row.prev_source },
    });
  }
  if (next !== null && odometer > next) {
    out.push({
      code: 'ODOMETER_ABOVE_NEXT',
      message: `The odometer reading ${formatKm(odometer)} is higher than ${formatKm(next)} recorded later on ${row.next_day} (${SOURCE_LABEL[row.next_source ?? ''] ?? 'another record'}).`,
      details: { odometer, nextReading: next, nextDate: row.next_day, nextSource: row.next_source },
    });
  }
  if (bus !== null && row.bus_reading_day !== null && day > row.bus_reading_day && odometer < bus && (prev === null || bus > prev)) {
    out.push({
      code: 'ODOMETER_BELOW_BUS',
      message: `The odometer reading ${formatKm(odometer)} is lower than the bus's last known odometer ${formatKm(bus)} (recorded on ${row.bus_reading_day}).`,
      details: { odometer, busOdometer: bus, busReadingDate: row.bus_reading_day },
    });
  }
  return out;
}
