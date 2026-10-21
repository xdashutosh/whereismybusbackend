// Service due list SQL (BP §7.3 maintenance-due-scan, §13.3 Maintenance due list). Mirrors the scan:
// the LATEST live log of each bus + service type (case-insensitive, by service date, then entry
// time) of a live bus in service (active / maintenance) that carries a next due date or km.
import { SERVICE_DUE_LEAD_DAYS } from '@wimb/shared';
import type { Tx } from '../../db/tenant.js';
import { escapeLike, MAX_EXPORT_ROWS, pagedQuery } from '../../shared/pagination.js';
import { dueStatusSql } from './repository.js';

const LEAD_DAYS = Number(SERVICE_DUE_LEAD_DAYS);

export interface DueRow extends Record<string, unknown> {
  id: string;
  bus_id: string;
  bus_code: string;
  registration_no: string;
  bus_status: string;
  bus_odometer: number | null;
  service_type: string;
  service_date: string;
  odometer: number | null;
  vendor: string | null;
  next_due_date: string | null;
  next_due_km: number | null;
  days_to_due: number | null;
  km_to_due: number | null;
  status: string;
  reason: string | null;
}

const SELECT = `l.id, l.bus_id, b.code as bus_code, b.registration_no, b.status as bus_status, b.last_known_odometer as bus_odometer,
  l.service_type, l.service_date, l.odometer, l.vendor, l.next_due_date, l.next_due_km,
  (l.next_due_date - today.day) as days_to_due, (l.next_due_km - b.last_known_odometer) as km_to_due, s.status, s.reason`;

const FROM = `from (
    select distinct on (ml.bus_id, lower(btrim(ml.service_type)))
           ml.id, ml.bus_id, btrim(ml.service_type) as service_type, ml.service_date, ml.odometer, ml.vendor, ml.next_due_date, ml.next_due_km
      from maintenance_logs ml
     where ml.deleted_at is null
     order by ml.bus_id, lower(btrim(ml.service_type)), ml.service_date desc, ml.created_at desc, ml.id desc
  ) l
  join buses b on b.id = l.bus_id and b.deleted_at is null and b.status in ('active', 'maintenance')
  cross join (select app_local_date() as day) today
  cross join lateral (select ${dueStatusSql('l', 'false')} as status) s0
  cross join lateral (
    select s0.status,
           case when s0.status = 'overdue' then (case when l.next_due_date < today.day then 'date' else 'km' end)
                when s0.status = 'due_soon' then (case when l.next_due_date <= today.day + ${LEAD_DAYS} then 'date' else 'km' end)
           end as reason
  ) s`;

export const DUE_SORT_COLUMNS = {
  status: `array_position(array['overdue', 'due_soon', 'scheduled'], s.status)`,
  nextDueDate: 'l.next_due_date',
  daysToDue: '(l.next_due_date - today.day)',
  nextDueKm: 'l.next_due_km',
  kmToDue: '(l.next_due_km - b.last_known_odometer)',
  busCode: 'b.code',
  serviceType: 'lower(l.service_type)',
  lastServiceDate: 'l.service_date',
} as const;

export interface DueFilter {
  statuses: string[];
  busId?: string;
  q?: string;
}

function where(f: DueFilter): { sql: string; params: unknown[] } {
  return {
    sql: `(l.next_due_date is not null or l.next_due_km is not null) and s.status = any ($1::text[])
      and ($2::uuid is null or l.bus_id = $2)
      and ($3::text is null or l.service_type ilike $3 or l.vendor ilike $3 or b.code ilike $3 or b.registration_no ilike $3)`,
    params: [f.statuses, f.busId ?? null, f.q ? `%${escapeLike(f.q)}%` : null],
  };
}

export function page(tx: Tx, f: DueFilter, o: { orderBy: string; limit: number; offset: number }) {
  const w = where(f);
  return pagedQuery<DueRow>(tx, { select: SELECT, from: FROM, where: w.sql, params: w.params, orderBy: o.orderBy, limit: o.limit, offset: o.offset });
}

export function exportRows(tx: Tx, f: DueFilter, orderBy: string): Promise<DueRow[]> {
  const w = where(f);
  return tx.many<DueRow>(`select ${SELECT} ${FROM} where ${w.sql} ${orderBy} limit ${MAX_EXPORT_ROWS}`, w.params);
}
