// SQL of the school's notification log (GET /school/notifications): notification_events with the
// trip (date, direction, bus code) and student name — one query per page / export.
import type { Tx } from '../../db/tenant.js';
import { escapeLike, MAX_EXPORT_ROWS, pagedQuery } from '../../shared/pagination.js';

export interface LogFilter {
  tripId?: string;
  studentId?: string;
  eventTypes?: string[];
  statuses?: string[];
  direction?: string;
  from?: string;
  to?: string;
  q?: string;
}

export interface LogRow extends Record<string, unknown> {
  id: string;
  trip_id: string;
  trip_date: string | null;
  direction: 'morning' | 'afternoon' | null;
  bus_code: string | null;
  student_id: string | null;
  student_name: string | null;
  event_type: string;
  channel: string;
  status: string;
  payload: Record<string, unknown> | null;
  error: string | null;
  sent_at: string | null;
  created_at: string;
}

const COLUMNS = `n.id, n.trip_id, t.trip_date, t.direction, coalesce(t.bus_code_snapshot, b.code) as bus_code,
  n.student_id, s.full_name as student_name, n.event_type, n.channel, n.status, n.payload, n.error, n.sent_at, n.created_at`;
const FROM = `from notification_events n
  join trips t on t.id = n.trip_id
  join buses b on b.id = t.bus_id
  left join students s on s.id = n.student_id`;

export const SORT = {
  allowed: { createdAt: 'n.created_at', tripDate: 't.trip_date', eventType: 'n.event_type', status: 'n.status', studentName: 's.full_name' },
  defaultSort: '-createdAt',
  tiebreaker: 'n.id',
};

function where(f: LogFilter) {
  return {
    sql: `($1::uuid is null or n.trip_id = $1)
      and ($2::uuid is null or n.student_id = $2)
      and ($3::text[] is null or n.event_type = any ($3::text[]))
      and ($4::text[] is null or n.status = any ($4::text[]))
      and ($5::text is null or t.direction = $5)
      and ($6::date is null or t.trip_date >= $6::date)
      and ($7::date is null or t.trip_date <= $7::date)
      and ($8::text is null or s.full_name ilike '%' || $8 || '%' or coalesce(t.bus_code_snapshot, b.code) ilike '%' || $8 || '%')`,
    params: [
      f.tripId ?? null,
      f.studentId ?? null,
      f.eventTypes?.length ? f.eventTypes : null,
      f.statuses?.length ? f.statuses : null,
      f.direction ?? null,
      f.from ?? null,
      f.to ?? null,
      f.q ? escapeLike(f.q) : null,
    ],
  };
}

export function page(tx: Tx, f: LogFilter, o: { orderBy: string; limit: number; offset: number }) {
  const w = where(f);
  return pagedQuery<LogRow>(tx, { select: COLUMNS, from: FROM, where: w.sql, params: w.params, ...o });
}

export function exportRows(tx: Tx, f: LogFilter, orderBy: string): Promise<LogRow[]> {
  const w = where(f);
  return tx.many<LogRow>(`select ${COLUMNS} ${FROM} where ${w.sql} ${orderBy} limit ${MAX_EXPORT_ROWS}`, w.params);
}
