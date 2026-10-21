// Maintenance logs SQL (BP §6.2 maintenance_logs). Receives `tx` only; school scope from RLS and
// current_setting('app.school_id'). Lists and details are one statement each: bus, invoice file,
// creator name, the due state (same rules as maintenance-due-scan) and the odometer flags.
import { SERVICE_DUE_LEAD_DAYS, SERVICE_DUE_LEAD_KM } from '@wimb/shared';
import type { Tx } from '../../db/tenant.js';
import { escapeLike, MAX_EXPORT_ROWS, pagedQuery } from '../../shared/pagination.js';
import { flaggedSql, odometerCheckJoin } from '../fuel/odometer.js';

const LEAD_DAYS = Number(SERVICE_DUE_LEAD_DAYS);
const LEAD_KM = Number(SERVICE_DUE_LEAD_KM);

export interface MaintenanceLogRow extends Record<string, unknown> {
  id: string;
  bus_id: string;
  bus_code: string;
  bus_registration_no: string;
  bus_odometer: number | null;
  service_type: string;
  service_date: string;
  cost: number | null;
  odometer: number | null;
  vendor: string | null;
  notes: string | null;
  invoice_file_id: string | null;
  invoice_name: string | null;
  invoice_mime: string | null;
  invoice_size: number | null;
  invoice_has_thumb: boolean | null;
  next_due_date: string | null;
  next_due_km: number | null;
  due_status: string;
  days_to_due: number | null;
  km_to_due: number | null;
  prev_reading: number | null;
  next_reading: number | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
  total_cost?: number | null;
}

/**
 * Due state of a log row `l` (columns next_due_date, next_due_km) for bus `b` and `today.day`;
 * `superseded` is a boolean SQL expression (a newer log of the same bus and service type exists).
 */
export function dueStatusSql(l: string, superseded: string): string {
  return `case when ${superseded} then 'completed'
    when ${l}.next_due_date is null and ${l}.next_due_km is null then 'none'
    when ${l}.next_due_date < today.day or (${l}.next_due_km is not null and b.last_known_odometer >= ${l}.next_due_km) then 'overdue'
    when ${l}.next_due_date <= today.day + ${LEAD_DAYS} or (${l}.next_due_km is not null and b.last_known_odometer >= ${l}.next_due_km - ${LEAD_KM}) then 'due_soon'
    else 'scheduled' end`;
}

const NEWER_JOIN = `left join lateral (
    select n.id from maintenance_logs n
     where n.bus_id = ml.bus_id and n.deleted_at is null and lower(btrim(n.service_type)) = lower(btrim(ml.service_type))
       and (n.service_date, n.created_at, n.id) > (ml.service_date, ml.created_at, ml.id)
     limit 1
  ) newer on true`;

export const SELECT = `ml.id, ml.bus_id, b.code as bus_code, b.registration_no as bus_registration_no, b.last_known_odometer as bus_odometer,
  ml.service_type, ml.service_date, ml.cost, ml.odometer, ml.vendor, ml.notes, ml.invoice_file_id,
  inv.original_name as invoice_name, inv.mime as invoice_mime, inv.size_bytes as invoice_size, (inv.thumb_key is not null) as invoice_has_thumb,
  ml.next_due_date, ml.next_due_km, st.due_status, (ml.next_due_date - today.day) as days_to_due, (ml.next_due_km - b.last_known_odometer) as km_to_due,
  chk.prev_reading, chk.next_reading, ml.created_by, u.full_name as created_by_name, ml.created_at, ml.updated_at`;

export const FROM = `from maintenance_logs ml
  join buses b on b.id = ml.bus_id
  cross join (select app_local_date() as day) today
  left join files inv on inv.id = ml.invoice_file_id
  left join users u on u.id = ml.created_by
  ${NEWER_JOIN}
  cross join lateral (select ${dueStatusSql('ml', 'newer.id is not null')} as due_status) st
  ${odometerCheckJoin('ml', 'service_date')}`;

export const SORT_COLUMNS = {
  serviceDate: 'ml.service_date',
  busCode: 'b.code',
  serviceType: 'lower(ml.service_type)',
  cost: 'ml.cost',
  odometer: 'ml.odometer',
  vendor: 'ml.vendor',
  nextDueDate: 'ml.next_due_date',
  nextDueKm: 'ml.next_due_km',
  dueStatus: `array_position(array['overdue', 'due_soon', 'scheduled', 'none', 'completed'], st.due_status)`,
  createdAt: 'ml.created_at',
  updatedAt: 'ml.updated_at',
} as const;

export interface MaintenanceLogFilter {
  busId?: string;
  serviceType?: string;
  dueStatuses?: string[];
  from?: string;
  to?: string;
  flagged?: boolean;
  hasInvoice?: boolean;
  q?: string;
}

function where(f: MaintenanceLogFilter): { sql: string; params: unknown[] } {
  const params: unknown[] = [f.busId ?? null, f.serviceType ?? null, f.dueStatuses ?? null, f.from ?? null, f.to ?? null, f.hasInvoice ?? null, f.q ? `%${escapeLike(f.q)}%` : null];
  const parts = [
    'ml.deleted_at is null',
    '($1::uuid is null or ml.bus_id = $1)',
    '($2::text is null or lower(btrim(ml.service_type)) = lower(btrim($2)))',
    '($3::text[] is null or st.due_status = any ($3))',
    '($4::date is null or ml.service_date >= $4)',
    '($5::date is null or ml.service_date <= $5)',
    '($6::boolean is null or (ml.invoice_file_id is not null) = $6)',
    '($7::text is null or ml.service_type ilike $7 or ml.vendor ilike $7 or ml.notes ilike $7 or b.code ilike $7 or b.registration_no ilike $7)',
  ];
  if (f.flagged === true) parts.push(flaggedSql('ml'));
  if (f.flagged === false) parts.push(`not coalesce(${flaggedSql('ml')}, false)`);
  return { sql: parts.join(' and '), params };
}

/** One page + total + the cost of every match (window sum, same statement). */
export function page(tx: Tx, f: MaintenanceLogFilter, o: { orderBy: string; limit: number; offset: number }) {
  const w = where(f);
  return pagedQuery<MaintenanceLogRow>(tx, {
    select: `${SELECT}, sum(ml.cost) over () as total_cost`,
    from: FROM,
    where: w.sql,
    params: w.params,
    orderBy: o.orderBy,
    limit: o.limit,
    offset: o.offset,
  });
}

export function exportRows(tx: Tx, f: MaintenanceLogFilter, orderBy: string): Promise<MaintenanceLogRow[]> {
  const w = where(f);
  return tx.many<MaintenanceLogRow>(`select ${SELECT} ${FROM} where ${w.sql} ${orderBy} limit ${MAX_EXPORT_ROWS}`, w.params);
}

/** A live log (its bus may be deleted: history stays readable). */
export function find(tx: Tx, id: string): Promise<MaintenanceLogRow | null> {
  return tx.maybeOne<MaintenanceLogRow>(`select ${SELECT} ${FROM} where ml.id = $1 and ml.deleted_at is null`, [id]);
}

export function lock(tx: Tx, id: string): Promise<{ id: string } | null> {
  return tx.maybeOne('select id from maintenance_logs where id = $1 and deleted_at is null for update', [id]);
}

export function findBus(tx: Tx, id: string): Promise<{ id: string; code: string } | null> {
  return tx.maybeOne('select id, code from buses where id = $1 and deleted_at is null', [id]);
}

export const FIELD_COLUMNS = {
  busId: 'bus_id',
  serviceType: 'service_type',
  serviceDate: 'service_date',
  cost: 'cost',
  odometer: 'odometer',
  vendor: 'vendor',
  notes: 'notes',
  invoiceFileId: 'invoice_file_id',
  nextDueDate: 'next_due_date',
  nextDueKm: 'next_due_km',
} as const;
export type MaintenanceField = keyof typeof FIELD_COLUMNS;

export async function insert(tx: Tx, v: Partial<Record<MaintenanceField, unknown>>): Promise<string> {
  const keys = (Object.keys(FIELD_COLUMNS) as MaintenanceField[]).filter((k) => v[k] !== undefined);
  const row = await tx.one<{ id: string }>(
    `insert into maintenance_logs (school_id, created_by, ${keys.map((k) => FIELD_COLUMNS[k]).join(', ')})
     values (nullif(current_setting('app.school_id', true), '')::uuid, nullif(current_setting('app.actor_id', true), '')::uuid,
             ${keys.map((_, i) => `$${i + 1}`).join(', ')})
     returning id`,
    keys.map((k) => v[k]),
  );
  return row.id;
}

export async function update(tx: Tx, id: string, v: Partial<Record<MaintenanceField, unknown>>): Promise<void> {
  const keys = (Object.keys(FIELD_COLUMNS) as MaintenanceField[]).filter((k) => v[k] !== undefined);
  if (!keys.length) return;
  await tx.query(`update maintenance_logs set ${keys.map((k, i) => `${FIELD_COLUMNS[k]} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1`, [id, ...keys.map((k) => v[k])]);
}

export async function softDelete(tx: Tx, id: string): Promise<void> {
  await tx.query('update maintenance_logs set deleted_at = now(), updated_at = now() where id = $1 and deleted_at is null', [id]);
}

/** Another live log of the bus on the same day with the same service type (possible double entry). */
export function findDuplicate(tx: Tx, v: { busId: string; serviceDate: string; serviceType: string; selfId: string }): Promise<{ id: string } | null> {
  return tx.maybeOne(
    `select id from maintenance_logs
      where bus_id = $1 and service_date = $2 and lower(btrim(service_type)) = lower(btrim($3)) and deleted_at is null and id <> $4 limit 1`,
    [v.busId, v.serviceDate, v.serviceType, v.selfId],
  );
}
