// Bus SQL (BP §6.2 buses). Runs in the caller's tenant transaction: RLS limits every statement to
// the current school; school_id is written from the transaction context, never from input.
import type { Tx } from '../../db/tenant.js';
import { escapeLike, MAX_EXPORT_ROWS, pagedQuery } from '../../shared/pagination.js';
import { BUS_DOCUMENT_EXPIRING_DAYS } from '@wimb/shared';

export interface BusRow extends Record<string, unknown> {
  id: string;
  school_id: string;
  code: string;
  display_name: string | null;
  vehicle_type: string | null;
  make_model: string | null;
  manufacture_year: number | null;
  color: string | null;
  capacity: number | null;
  registration_no: string;
  fuel_type: string | null;
  status: string;
  last_known_odometer: number | null;
  odometer_updated_at: string | null;
  notes: string | null;
  deleted_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** List/detail row: the bus plus display names and badges computed in the same statement. */
export interface BusListRow extends BusRow {
  primary_driver_name: string | null;
  conductor_name: string | null;
  image_count: number;
  cover_thumb_key: string | null;
  expired_documents: number;
  expiring_documents: number;
  active_trip_id: string | null;
}

const EXPIRING_DAYS = Number(BUS_DOCUMENT_EXPIRING_DAYS);

const BUS_COLUMNS = `b.id, b.school_id, b.code, b.display_name, b.vehicle_type, b.make_model, b.manufacture_year, b.color, b.capacity,
  b.registration_no, b.fuel_type, b.status, b.last_known_odometer, b.odometer_updated_at, b.notes, b.deleted_at, b.created_by,
  b.created_at, b.updated_at`;

const LIST_SELECT = `${BUS_COLUMNS}, pd.full_name as primary_driver_name, cd.full_name as conductor_name,
  img.image_count, img.cover_thumb_key, doc.expired_documents, doc.expiring_documents, act.id as active_trip_id`;

const currentRole = (alias: string, role: string) => `left join lateral (
    select sp.full_name from bus_staff_assignments a join staff_profiles sp on sp.id = a.staff_id
     where a.bus_id = b.id and a.assignment_role = '${role}' and a.valid_from <= now() and (a.valid_to is null or a.valid_to > now())
     order by a.valid_from desc limit 1) ${alias} on true`;

const LIST_FROM = `from buses b
  cross join (select app_local_date() as d) today
  ${currentRole('pd', 'primary_driver')}
  ${currentRole('cd', 'conductor')}
  left join lateral (
    select count(*)::int as image_count,
           (array_agg(coalesce(f.thumb_key, f.key) order by bi.sort_order, bi.created_at, bi.id))[1] as cover_thumb_key
      from bus_images bi join files f on f.id = bi.file_id
     where bi.bus_id = b.id) img on true
  left join lateral (
    select count(*) filter (where d.expiry_date < today.d)::int as expired_documents,
           count(*) filter (where d.expiry_date >= today.d and d.expiry_date <= today.d + ${EXPIRING_DAYS})::int as expiring_documents
      from bus_documents d
     where d.bus_id = b.id and d.is_current and d.deleted_at is null) doc on true
  left join lateral (select t.id from trips t where t.bus_id = b.id and t.status = 'in_progress' limit 1) act on true`;

export interface BusFilter {
  statuses?: string[];
  fuelTypes?: string[];
  vehicleTypes?: string[];
  hasPrimaryDriver?: boolean;
  documentStatus?: 'expired' | 'expiring';
  q?: string;
}

function where(f: BusFilter): { sql: string; params: unknown[] } {
  const q = f.q?.trim() ? escapeLike(f.q.trim()) : null;
  const plate = f.q ? f.q.toUpperCase().replace(/[\s.-]+/g, '') : '';
  return {
    sql: `b.deleted_at is null
      and ($1::text[] is null or b.status = any ($1))
      and ($2::text[] is null or b.fuel_type = any ($2))
      and ($3::text[] is null or b.vehicle_type = any ($3))
      and ($4::boolean is null or (pd.full_name is not null) = $4)
      and ($5::text is null or ($5 = 'expired' and doc.expired_documents > 0) or ($5 = 'expiring' and doc.expiring_documents > 0))
      and ($6::text is null or b.code ilike '%' || $6 || '%' or b.display_name ilike '%' || $6 || '%'
           or b.make_model ilike '%' || $6 || '%' or ($7::text <> '' and b.registration_no ilike '%' || $7 || '%'))`,
    params: [f.statuses ?? null, f.fuelTypes ?? null, f.vehicleTypes ?? null, f.hasPrimaryDriver ?? null, f.documentStatus ?? null, q, plate ? escapeLike(plate) : ''],
  };
}

export function page(tx: Tx, f: BusFilter, o: { orderBy: string; limit: number; offset: number }) {
  const w = where(f);
  return pagedQuery<BusListRow>(tx, { select: LIST_SELECT, from: LIST_FROM, where: w.sql, params: w.params, ...o });
}

export function exportRows(tx: Tx, f: BusFilter, orderBy: string): Promise<BusListRow[]> {
  const w = where(f);
  return tx.many<BusListRow>(`select ${LIST_SELECT} ${LIST_FROM} where ${w.sql} ${orderBy} limit ${MAX_EXPORT_ROWS}`, w.params);
}

/** One live bus with its list badges (null when missing, deleted or in another school). */
export function findListRow(tx: Tx, id: string): Promise<BusListRow | null> {
  return tx.maybeOne<BusListRow>(`select ${LIST_SELECT} ${LIST_FROM} where b.id = $1 and b.deleted_at is null`, [id]);
}

/** Locks a live bus for a write (serialises status changes, assignments and deletes per bus). */
export function lockBus(tx: Tx, id: string): Promise<BusRow | null> {
  return tx.maybeOne<BusRow>(`select ${BUS_COLUMNS} from buses b where b.id = $1 and b.deleted_at is null for update`, [id]);
}

/** Existence check without a lock (sub-resources of a bus). */
export async function busExists(tx: Tx, id: string): Promise<boolean> {
  return (await tx.maybeOne('select 1 from buses where id = $1 and deleted_at is null', [id])) !== null;
}

/** API field → column (whitelist for inserts and partial updates). */
export const BUS_FIELD_COLUMNS = {
  code: 'code',
  displayName: 'display_name',
  vehicleType: 'vehicle_type',
  makeModel: 'make_model',
  manufactureYear: 'manufacture_year',
  color: 'color',
  capacity: 'capacity',
  registrationNo: 'registration_no',
  fuelType: 'fuel_type',
  status: 'status',
  lastKnownOdometer: 'last_known_odometer',
  notes: 'notes',
} as const;
export type BusField = keyof typeof BUS_FIELD_COLUMNS;

export async function insertBus(tx: Tx, values: Partial<Record<BusField, unknown>>): Promise<BusRow> {
  const entries = (Object.keys(BUS_FIELD_COLUMNS) as BusField[]).filter((k) => values[k] !== undefined).map((k) => [BUS_FIELD_COLUMNS[k], values[k]] as const);
  const cols = entries.map(([c]) => c);
  const odometerSet = values.lastKnownOdometer !== undefined && values.lastKnownOdometer !== null;
  return tx.one<BusRow>(
    `insert into buses (school_id, created_by, ${cols.join(', ')}${odometerSet ? ', odometer_updated_at' : ''})
     values (nullif(current_setting('app.school_id', true), '')::uuid, nullif(current_setting('app.actor_id', true), '')::uuid,
             ${entries.map((_, i) => `$${i + 1}`).join(', ')}${odometerSet ? ', now()' : ''})
     returning *`,
    entries.map(([, v]) => v),
  );
}

export async function updateBus(tx: Tx, id: string, values: Partial<Record<BusField, unknown>>): Promise<BusRow> {
  const entries = (Object.keys(BUS_FIELD_COLUMNS) as BusField[]).filter((k) => values[k] !== undefined).map((k) => [BUS_FIELD_COLUMNS[k], values[k]] as const);
  const sets = entries.map(([c], i) => `${c} = $${i + 2}`);
  if (values.lastKnownOdometer !== undefined) sets.push(`odometer_updated_at = case when $${entries.length + 2}::boolean then now() else null end`);
  const params: unknown[] = [id, ...entries.map(([, v]) => v)];
  if (values.lastKnownOdometer !== undefined) params.push(values.lastKnownOdometer !== null);
  return tx.one<BusRow>(`update buses set ${sets.join(', ')}, updated_at = now() where id = $1 and deleted_at is null returning *`, params);
}

/** Blockers for deleting a bus (in-progress trip, current/future student assignments, live schedules). */
export function deleteBlockers(tx: Tx, id: string) {
  return tx.one<{ active_trip_id: string | null; student_assignments: number; schedules: number }>(
    `select (select t.id from trips t where t.bus_id = $1 and t.status = 'in_progress' limit 1) as active_trip_id,
            (select count(*)::int from student_assignments sa
              where sa.bus_id = $1 and (sa.valid_to is null or sa.valid_to > app_local_date())) as student_assignments,
            (select count(*)::int from trip_schedules ts
              where ts.bus_id = $1 and ts.deleted_at is null and ts.is_active
                and (ts.valid_to is null or ts.valid_to >= app_local_date())) as schedules`,
    [id],
  );
}

/**
 * Soft delete in one statement: marks the bus deleted, closes its open staff and route
 * assignments and cancels its not-yet-started trips. Returns the counts for the audit trail.
 */
export function softDelete(tx: Tx, id: string, reason: string) {
  return tx.one<{ staff_closed: number; routes_closed: number; trips_cancelled: number }>(
    `with del as (
       update buses set deleted_at = now(), updated_at = now() where id = $1 and deleted_at is null returning id
     ), staff as (
       update bus_staff_assignments set valid_to = greatest(now(), valid_from)
        where bus_id in (select id from del) and (valid_to is null or valid_to > now()) returning 1
     ), routes as (
       update bus_route_assignments set valid_to = greatest(now(), valid_from)
        where bus_id in (select id from del) and (valid_to is null or valid_to > now()) returning 1
     ), trips_cancelled as (
       update trips set status = 'cancelled', cancel_reason = $2,
              cancelled_by = nullif(current_setting('app.actor_id', true), '')::uuid, updated_at = now()
        where bus_id in (select id from del) and status = 'scheduled' returning 1
     )
     select (select count(*)::int from staff) as staff_closed, (select count(*)::int from routes) as routes_closed,
            (select count(*)::int from trips_cancelled) as trips_cancelled`,
    [id, reason],
  );
}
