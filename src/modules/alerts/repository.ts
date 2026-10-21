// SQL of the alerts inbox (BP §13.3 Alerts): list with counts per status (one round trip), one alert,
// row lock + workflow update. Every statement runs in the caller's tenant transaction (RLS applies;
// school_id comes from the transaction context, never from the request).
import type { AlertListQuery, AlertSeverity, AlertStatus, AlertStatusCounts, AlertType, Direction, TripStatus } from '@wimb/shared';
import type { Tx } from '../../db/tenant.js';
import { escapeLike } from '../../shared/pagination.js';
import type { AlertEntityType } from './service.js';

export interface AlertRow extends Record<string, unknown> {
  id: string;
  alert_type: AlertType;
  severity: AlertSeverity;
  status: AlertStatus;
  title: string;
  entity_type: AlertEntityType | null;
  entity_id: string | null;
  bus_id: string | null;
  bus_code: string | null;
  trip_id: string | null;
  trip_date: string | null;
  trip_direction: Direction | null;
  trip_status: TripStatus | null;
  route_code: string | null;
  staff_id: string | null;
  staff_name: string | null;
  details: Record<string, unknown> | null;
  reviewed_by: string | null;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  escalated_by: string | null;
  escalated_by_name: string | null;
  escalated_at: string | null;
  closed_by: string | null;
  closed_by_name: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

export const SELECT = `a.id, a.alert_type, a.severity, a.status, a.title, a.entity_type, a.entity_id,
  a.bus_id, coalesce(b.code, t.bus_code_snapshot) as bus_code,
  a.trip_id, t.trip_date, t.direction as trip_direction, t.status as trip_status, t.route_code_snapshot as route_code,
  a.staff_id, sp.full_name as staff_name, a.details,
  a.reviewed_by, ru.full_name as reviewed_by_name, a.reviewed_at, a.review_note,
  a.escalated_by, eu.full_name as escalated_by_name, a.escalated_at,
  a.closed_by, cu.full_name as closed_by_name, a.closed_at, a.created_at, a.updated_at`;

export const FROM = `from alerts a
  left join buses b on b.id = a.bus_id
  left join trips t on t.id = a.trip_id
  left join staff_profiles sp on sp.id = a.staff_id
  left join users ru on ru.id = a.reviewed_by
  left join users eu on eu.id = a.escalated_by
  left join users cu on cu.id = a.closed_by`;

const SEVERITY_ORDER = `case a.severity when 'critical' then 3 when 'warning' then 2 else 1 end`;
const STATUS_ORDER = `case a.status when 'open' then 1 when 'escalated' then 2 when 'reviewed' then 3 else 4 end`;

export const SORT = {
  allowed: {
    createdAt: 'a.created_at',
    updatedAt: 'a.updated_at',
    severity: SEVERITY_ORDER,
    status: STATUS_ORDER,
    type: 'a.alert_type',
    busCode: 'coalesce(b.code, t.bus_code_snapshot)',
  },
  defaultSort: '-createdAt',
  tiebreaker: 'a.id',
};

/** Filters except status ($1…$10) and the status filter ($11). Dates are school-local days of `timezone`. */
export function filters(q: AlertListQuery, timezone: string) {
  return {
    base: `($1::text[] is null or a.alert_type = any ($1::text[]))
      and ($2::text[] is null or a.severity = any ($2::text[]))
      and ($3::text[] is null or a.entity_type = any ($3::text[]))
      and ($4::date is null or a.created_at >= ($4::date)::timestamp at time zone $6::text)
      and ($5::date is null or a.created_at < ($5::date + 1)::timestamp at time zone $6::text)
      and ($7::uuid is null or a.bus_id = $7::uuid)
      and ($8::uuid is null or a.trip_id = $8::uuid)
      and ($9::uuid is null or a.staff_id = $9::uuid)
      and ($10::text is null or concat_ws(' ', a.title, b.code, t.bus_code_snapshot, sp.full_name) ilike '%' || $10 || '%')`,
    status: '($11::text[] is null or a.status = any ($11::text[]))',
    params: [
      q.type ?? null, q.severity ?? null, q.entityType ?? null, q.from ?? null, q.to ?? null, timezone,
      q.busId ?? null, q.tripId ?? null, q.staffId ?? null, q.q ? escapeLike(q.q) : null, q.status ?? null,
    ] as unknown[],
  };
}

type CountRow = { c_open: number; c_reviewed: number; c_escalated: number; c_closed: number };

/**
 * One page plus the counts per status of every alert matching the other filters (one round trip).
 * `total` is the sum of the counts of the requested statuses.
 */
export async function page(tx: Tx, q: AlertListQuery, timezone: string, orderBy: string, limit: number, offset: number) {
  const f = filters(q, timezone);
  const rows = await tx.many<Partial<AlertRow> & CountRow>(
    `with c as (
       select (count(*) filter (where a.status = 'open'))::int as c_open,
              (count(*) filter (where a.status = 'reviewed'))::int as c_reviewed,
              (count(*) filter (where a.status = 'escalated'))::int as c_escalated,
              (count(*) filter (where a.status = 'closed'))::int as c_closed
         ${FROM} where ${f.base}
     )
     select c.*, p.* from c
       left join lateral (select ${SELECT} ${FROM} where ${f.base} and ${f.status} ${orderBy} limit $12 offset $13) p on true`,
    [...f.params, limit, offset],
  );
  const first = rows[0];
  const counts: AlertStatusCounts = {
    open: first?.c_open ?? 0,
    reviewed: first?.c_reviewed ?? 0,
    escalated: first?.c_escalated ?? 0,
    closed: first?.c_closed ?? 0,
  };
  const wanted = q.status ?? (Object.keys(counts) as AlertStatus[]);
  const total = wanted.reduce((sum, s) => sum + counts[s], 0);
  const items = rows.filter((r) => r.id != null) as AlertRow[];
  return { items, counts, total };
}

/** CSV export rows (status filter included, capped by the caller). */
export function exportRows(tx: Tx, q: AlertListQuery, timezone: string, orderBy: string, max: number): Promise<AlertRow[]> {
  const f = filters(q, timezone);
  return tx.many<AlertRow>(`select ${SELECT} ${FROM} where ${f.base} and ${f.status} ${orderBy} limit ${Number(max)}`, f.params);
}

export function findById(tx: Tx, id: string): Promise<AlertRow | null> {
  return tx.maybeOne<AlertRow>(`select ${SELECT} ${FROM} where a.id = $1`, [id]);
}

/** Locks the alert row for a workflow change (null when missing / another school). */
export function lockById(tx: Tx, id: string): Promise<{ id: string; status: AlertStatus; alert_type: AlertType; severity: AlertSeverity; details: Record<string, unknown> | null } | null> {
  return tx.maybeOne(`select id, status, alert_type, severity, details from alerts where id = $1 for update`, [id]);
}

/** review: note + reviewer; status → reviewed. */
export async function markReviewed(tx: Tx, id: string, note: string): Promise<void> {
  await tx.query(
    `update alerts set status = 'reviewed', review_note = $2, reviewed_by = nullif(current_setting('app.actor_id', true), '')::uuid,
            reviewed_at = now(), updated_at = now()
      where id = $1`,
    [id, note],
  );
}

/** escalate: status → escalated, escalation snapshot merged into details, optional note. */
export async function markEscalated(tx: Tx, id: string, note: string | null, escalation: Record<string, unknown>): Promise<void> {
  await tx.query(
    `update alerts set status = 'escalated', escalated_by = nullif(current_setting('app.actor_id', true), '')::uuid, escalated_at = now(),
            review_note = coalesce($2, review_note), details = coalesce(details, '{}'::jsonb) || jsonb_build_object('escalation', $3::jsonb),
            updated_at = now()
      where id = $1`,
    [id, note, JSON.stringify(escalation)],
  );
}

/** close: status → closed by the admin, optional note. */
export async function markClosed(tx: Tx, id: string, note: string | null): Promise<void> {
  await tx.query(
    `update alerts set status = 'closed', closed_by = nullif(current_setting('app.actor_id', true), '')::uuid, closed_at = now(),
            review_note = coalesce($2, review_note), updated_at = now()
      where id = $1`,
    [id, note],
  );
}

/** Replaces the escalation snapshot (delivery results written by the escalation job). */
export async function saveEscalation(tx: Tx, id: string, escalation: Record<string, unknown>): Promise<void> {
  await tx.query(
    `update alerts set details = coalesce(details, '{}'::jsonb) || jsonb_build_object('escalation', $2::jsonb), updated_at = now() where id = $1`,
    [id, JSON.stringify(escalation)],
  );
}
