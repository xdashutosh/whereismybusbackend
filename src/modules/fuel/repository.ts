// Fuel logs SQL (BP §6.2 fuel_logs). Receives `tx` only; school scope comes from RLS and
// current_setting('app.school_id'). Each list/detail read is one statement: bus code, bill file,
// creator name, the previous reading of the bus (fill-to-fill distance) and the odometer flags are
// joined in.
import type { Tx } from '../../db/tenant.js';
import { escapeLike, MAX_EXPORT_ROWS, pagedQuery } from '../../shared/pagination.js';
import { flaggedSql, odometerCheckJoin } from './odometer.js';

export interface FuelLogRow extends Record<string, unknown> {
  id: string;
  bus_id: string;
  bus_code: string;
  bus_registration_no: string;
  fuel_date: string;
  odometer: number | null;
  litres: number;
  cost: number;
  fuel_type: string | null;
  /** Quantity unit (FUEL_UNIT_SQL): 'L' | 'kg' | 'kWh'. */
  unit: string;
  station: string | null;
  notes: string | null;
  bill_file_id: string | null;
  bill_name: string | null;
  bill_mime: string | null;
  bill_size: number | null;
  bill_has_thumb: boolean | null;
  distance_km: number | null;
  span_litres: number | null;
  span_cost: number | null;
  prev_reading: number | null;
  next_reading: number | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
  total_cost?: number | null;
  /** Per-unit totals of every match (window sums): fills, quantity and cost per FUEL_UNIT. */
  total_fills_l?: number | null;
  total_qty_l?: number | null;
  total_cost_l?: number | null;
  total_fills_kg?: number | null;
  total_qty_kg?: number | null;
  total_cost_kg?: number | null;
  total_fills_kwh?: number | null;
  total_qty_kwh?: number | null;
  total_cost_kwh?: number | null;
}

/**
 * Quantity unit of a fuel log (shared/ fuelUnitOf): kg for CNG, kWh for electric, litres
 * otherwise — from the log's fuel type, else its bus's. Quantities are only ever summed per unit.
 */
export const FUEL_UNIT_SQL = (log: string, bus: string): string =>
  `(case coalesce(${log}.fuel_type, ${bus}.fuel_type) when 'cng' then 'kg' when 'electric' then 'kWh' else 'L' end)`;

/** Window sums per unit over every match (row keys total_{fills,qty,cost}_{l,kg,kwh}). */
const UNIT_TOTALS = ([['L', 'l'], ['kg', 'kg'], ['kWh', 'kwh']] as const)
  .map(([unit, k]) => {
    const when = `filter (where ${FUEL_UNIT_SQL('fl', 'b')} = '${unit}') over ()`;
    return `count(*) ${when} as total_fills_${k}, sum(fl.litres) ${when} as total_qty_${k}, sum(fl.cost) ${when} as total_cost_${k}`;
  })
  .join(', ');

/**
 * Mileage base of a fill: the earlier fuel log of the bus with the HIGHEST reading (a later fill
 * without a reading, or with a mistyped lower one, never becomes the base), and every fill after that
 * base up to this one (their fuel was burnt over the span). Ordering = (fuel_date, created_at, id).
 */
export const PREVIOUS_JOIN = `left join lateral (
    select p.odometer, p.fuel_date, p.created_at, p.id from fuel_logs p
     where fl.odometer is not null and p.bus_id = fl.bus_id and p.deleted_at is null and p.odometer is not null
       and (p.fuel_date, p.created_at, p.id) < (fl.fuel_date, fl.created_at, fl.id)
     order by p.odometer desc, p.fuel_date desc, p.created_at desc, p.id desc limit 1
  ) prev on true
  left join lateral (
    select sum(s.litres) as litres, sum(s.cost) as cost from fuel_logs s
     where fl.odometer > prev.odometer and s.bus_id = fl.bus_id and s.deleted_at is null
       and (s.fuel_date, s.created_at, s.id) > (prev.fuel_date, prev.created_at, prev.id)
       and (s.fuel_date, s.created_at, s.id) <= (fl.fuel_date, fl.created_at, fl.id)
  ) span on true`;

/** Fill-to-fill distance of `fl` (needs PREVIOUS_JOIN); null without a higher earlier reading. */
export const DISTANCE = 'case when fl.odometer > prev.odometer then fl.odometer - prev.odometer end';

export const SELECT = `fl.id, fl.bus_id, b.code as bus_code, b.registration_no as bus_registration_no, fl.fuel_date, fl.odometer, fl.litres, fl.cost,
  fl.fuel_type, ${FUEL_UNIT_SQL('fl', 'b')} as unit, fl.station, fl.notes, fl.bill_file_id, bf.original_name as bill_name, bf.mime as bill_mime, bf.size_bytes as bill_size,
  (bf.thumb_key is not null) as bill_has_thumb, ${DISTANCE} as distance_km, span.litres as span_litres, span.cost as span_cost,
  chk.prev_reading, chk.next_reading, fl.created_by, u.full_name as created_by_name, fl.created_at, fl.updated_at`;

export const FROM = `from fuel_logs fl
  join buses b on b.id = fl.bus_id
  left join files bf on bf.id = fl.bill_file_id
  left join users u on u.id = fl.created_by
  ${PREVIOUS_JOIN}
  ${odometerCheckJoin('fl', 'fuel_date')}`;

/** Sortable API fields → trusted SQL. */
export const SORT_COLUMNS = {
  fuelDate: 'fl.fuel_date',
  busCode: 'b.code',
  odometer: 'fl.odometer',
  litres: 'fl.litres',
  cost: 'fl.cost',
  pricePerLitre: '(fl.cost / fl.litres)',
  kmPerLitre: `(${DISTANCE}) / nullif(span.litres, 0)`,
  station: 'fl.station',
  createdAt: 'fl.created_at',
  updatedAt: 'fl.updated_at',
} as const;

export interface FuelLogFilter {
  busId?: string;
  fuelTypes?: string[];
  from?: string;
  to?: string;
  flagged?: boolean;
  hasBill?: boolean;
  q?: string;
}

function where(f: FuelLogFilter): { sql: string; params: unknown[] } {
  const params: unknown[] = [f.busId ?? null, f.fuelTypes ?? null, f.from ?? null, f.to ?? null, f.hasBill ?? null, f.q ? `%${escapeLike(f.q)}%` : null];
  const parts = [
    'fl.deleted_at is null',
    '($1::uuid is null or fl.bus_id = $1)',
    '($2::text[] is null or fl.fuel_type = any ($2))',
    '($3::date is null or fl.fuel_date >= $3)',
    '($4::date is null or fl.fuel_date <= $4)',
    '($5::boolean is null or (fl.bill_file_id is not null) = $5)',
    `($6::text is null or b.code ilike $6 or b.registration_no ilike $6 or fl.station ilike $6 or fl.notes ilike $6)`,
  ];
  if (f.flagged === true) parts.push(flaggedSql('fl'));
  if (f.flagged === false) parts.push(`not coalesce(${flaggedSql('fl')}, false)`);
  return { sql: parts.join(' and '), params };
}

/** One page + total + cost and per-unit quantity totals of every match (window sums, same statement). */
export function page(tx: Tx, f: FuelLogFilter, o: { orderBy: string; limit: number; offset: number }) {
  const w = where(f);
  return pagedQuery<FuelLogRow>(tx, {
    select: `${SELECT}, sum(fl.cost) over () as total_cost, ${UNIT_TOTALS}`,
    from: FROM,
    where: w.sql,
    params: w.params,
    orderBy: o.orderBy,
    limit: o.limit,
    offset: o.offset,
  });
}

export function exportRows(tx: Tx, f: FuelLogFilter, orderBy: string): Promise<FuelLogRow[]> {
  const w = where(f);
  return tx.many<FuelLogRow>(`select ${SELECT} ${FROM} where ${w.sql} ${orderBy} limit ${MAX_EXPORT_ROWS}`, w.params);
}

/** A live fuel log (its bus may be deleted: history stays readable). */
export function find(tx: Tx, id: string): Promise<FuelLogRow | null> {
  return tx.maybeOne<FuelLogRow>(`select ${SELECT} ${FROM} where fl.id = $1 and fl.deleted_at is null`, [id]);
}

/** Locks a live fuel log for a write. */
export function lock(tx: Tx, id: string): Promise<{ id: string; bus_id: string } | null> {
  return tx.maybeOne('select id, bus_id from fuel_logs where id = $1 and deleted_at is null for update', [id]);
}

/** A live bus (null when missing, deleted or in another school). */
export function findBus(tx: Tx, id: string): Promise<{ id: string; code: string; fuel_type: string | null } | null> {
  return tx.maybeOne('select id, code, fuel_type from buses where id = $1 and deleted_at is null', [id]);
}

/** API field → column (whitelist for inserts and partial updates). */
export const FIELD_COLUMNS = {
  busId: 'bus_id',
  fuelDate: 'fuel_date',
  odometer: 'odometer',
  litres: 'litres',
  cost: 'cost',
  fuelType: 'fuel_type',
  station: 'station',
  billFileId: 'bill_file_id',
  notes: 'notes',
} as const;
export type FuelField = keyof typeof FIELD_COLUMNS;

export async function insert(tx: Tx, v: Partial<Record<FuelField, unknown>>): Promise<string> {
  const keys = (Object.keys(FIELD_COLUMNS) as FuelField[]).filter((k) => v[k] !== undefined);
  const row = await tx.one<{ id: string }>(
    `insert into fuel_logs (school_id, created_by, ${keys.map((k) => FIELD_COLUMNS[k]).join(', ')})
     values (nullif(current_setting('app.school_id', true), '')::uuid, nullif(current_setting('app.actor_id', true), '')::uuid,
             ${keys.map((_, i) => `$${i + 1}`).join(', ')})
     returning id`,
    keys.map((k) => v[k]),
  );
  return row.id;
}

export async function update(tx: Tx, id: string, v: Partial<Record<FuelField, unknown>>): Promise<void> {
  const keys = (Object.keys(FIELD_COLUMNS) as FuelField[]).filter((k) => v[k] !== undefined);
  if (!keys.length) return;
  await tx.query(`update fuel_logs set ${keys.map((k, i) => `${FIELD_COLUMNS[k]} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1`, [id, ...keys.map((k) => v[k])]);
}

export async function softDelete(tx: Tx, id: string): Promise<void> {
  await tx.query('update fuel_logs set deleted_at = now(), updated_at = now() where id = $1 and deleted_at is null', [id]);
}

/** Another live log of the bus on the same day with the same litres (possible double entry). */
export function findDuplicate(tx: Tx, v: { busId: string; fuelDate: string; litres: number; selfId: string | null }): Promise<{ id: string } | null> {
  return tx.maybeOne(
    'select id from fuel_logs where bus_id = $1 and fuel_date = $2 and litres = round($3::numeric, 2) and deleted_at is null and id is distinct from $4::uuid limit 1',
    [v.busId, v.fuelDate, v.litres, v.selfId],
  );
}
