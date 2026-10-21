// Announcement delivery SQL (BP §20 #6, contract §9). School system context (tenant RLS). The
// delivery markers are audit rows 'announcement.deliver' (audit_logs is insert/select-only for the
// app role and indexed by (school_id, entity_type, entity_id)), one per delivered audience segment set:
// new_values.segments lists the segments ('parents', 'drivers') that run delivered (rows written before
// segments existed count the segments of their new_values.audience). An audience widened later (drivers →
// all) therefore still reaches the new segment exactly once. Runs are serialised per announcement with a
// transaction-scoped advisory lock (PgBouncer-safe).
import type { AnnouncementAudience } from '@wimb/shared';
import type { Tx } from '../../db/tenant.js';

const SCHOOL = "nullif(current_setting('app.school_id', true), '')::uuid";
export const DELIVER_ACTION = 'announcement.deliver';

export interface DeliverableRow extends Record<string, unknown> {
  id: string;
  title: string;
  body: string;
  audience: AnnouncementAudience;
  published_at: string;
  expires_at: string | null;
  deleted: boolean;
  due: boolean;
  expired: boolean;
}

export async function lockAnnouncement(tx: Tx, id: string): Promise<void> {
  await tx.query("select pg_advisory_xact_lock(hashtextextended('announcement-deliver:' || $1::text, 0))", [id]);
}

/** The announcement with its window flags (`due` allows a few seconds of timer skew). */
export function findForDelivery(tx: Tx, id: string): Promise<DeliverableRow | null> {
  return tx.maybeOne<DeliverableRow>(
    `select a.id, a.title, a.body, a.audience, a.published_at, a.expires_at,
            a.deleted_at is not null as deleted,
            a.published_at <= now() + interval '5 seconds' as due,
            a.expires_at is not null and a.expires_at <= now() as expired
       from announcements a where a.id = $1`,
    [id],
  );
}

export type AnnouncementSegment = 'parents' | 'drivers';

/** SQL: does the deliver marker `l` cover segment `seg`? */
const covers = (seg: AnnouncementSegment) =>
  `coalesce(l.new_values->'segments' ? '${seg}', l.new_values->>'audience' in ('${seg}', 'all'))`;

/** Segments of the announcement that a previous run already delivered. */
export async function deliveredSegments(tx: Tx, id: string): Promise<Set<AnnouncementSegment>> {
  const row = await tx.one<{ parents: boolean; drivers: boolean }>(
    `select coalesce(bool_or(${covers('parents')}), false) as parents, coalesce(bool_or(${covers('drivers')}), false) as drivers
       from audit_logs l
      where l.school_id = ${SCHOOL} and l.entity_type = 'announcement' and l.entity_id = $1 and l.action = '${DELIVER_ACTION}'`,
    [id],
  );
  const out = new Set<AnnouncementSegment>();
  if (row.parents) out.add('parents');
  if (row.drivers) out.add('drivers');
  return out;
}

/** Published, unexpired announcements of the last `hours` with an audience segment not yet delivered (sweep). */
export async function undelivered(tx: Tx, hours: number): Promise<string[]> {
  const rows = await tx.many<{ id: string }>(
    `select a.id from announcements a
       cross join lateral (
         select coalesce(bool_or(${covers('parents')}), false) as parents, coalesce(bool_or(${covers('drivers')}), false) as drivers
           from audit_logs l
          where l.school_id = a.school_id and l.entity_type = 'announcement' and l.entity_id = a.id and l.action = '${DELIVER_ACTION}'
       ) done
      where a.deleted_at is null and a.published_at <= now() and a.published_at > now() - make_interval(hours => $1)
        and (a.expires_at is null or a.expires_at > now())
        and ((a.audience in ('parents', 'all') and not done.parents) or (a.audience in ('drivers', 'all') and not done.drivers))
      order by a.published_at`,
    [hours],
  );
  return rows.map((r) => r.id);
}

export interface ParentTargetRow extends Record<string, unknown> {
  parent_account_id: string;
  preferred_language: string | null;
  phone: string | null;
}

/**
 * Active parents of the school with at least one active linked student. Scoped to the context's school
 * explicitly as well as by RLS, so seed sessions (owner + actor_role 'system', definer_access) stay in one school.
 */
export function schoolParents(tx: Tx): Promise<ParentTargetRow[]> {
  return tx.many<ParentTargetRow>(
    `select scp.parent_account_id, pa.preferred_language, pa.phone
       from school_parents scp
       join parent_accounts pa on pa.id = scp.parent_account_id and pa.is_active
      where scp.school_id = ${SCHOOL} and scp.is_active and scp.deleted_at is null
        and exists (select 1 from student_parents sp
                      join students s on s.id = sp.student_id and s.is_active and s.deleted_at is null
                     where sp.school_id = scp.school_id and sp.parent_account_id = scp.parent_account_id)
      order by scp.parent_account_id`,
  );
}

/** One inbox entry per parent for the announcement (parents that already have one are skipped). */
export function insertAnnouncementInbox(
  tx: Tx,
  announcementId: string,
  parentIds: string[],
  entry: { title: string; body: string; data: Record<string, unknown> },
): Promise<{ id: string; parent_account_id: string; created_at: string }[]> {
  if (!parentIds.length) return Promise.resolve([]);
  return tx.many(
    `insert into parent_notifications (school_id, parent_account_id, kind, title, body, data)
     select ${SCHOOL}, p.id, 'announcement', $2, $3, $4::jsonb
       from unnest($1::uuid[]) as p(id)
      where not exists (select 1 from parent_notifications pn
                         where pn.parent_account_id = p.id and pn.school_id = ${SCHOOL}
                           and pn.kind = 'announcement' and pn.data->>'announcementId' = $5)
     returning id, parent_account_id, created_at`,
    [parentIds, entry.title, entry.body, JSON.stringify(entry.data), announcementId],
  );
}

/** Rewrites the stored inbox text after an edit (no new push). */
export async function refreshAnnouncementInbox(tx: Tx, announcementId: string, title: string, body: string): Promise<number> {
  const r = await tx.query(
    `update parent_notifications set title = $2, body = $3
      where school_id = ${SCHOOL} and kind = 'announcement' and data->>'announcementId' = $1`,
    [announcementId, title, body],
  );
  return r.rowCount ?? 0;
}

/** Removes the inbox entries of a withdrawn announcement (or one no longer meant for parents). */
export async function deleteAnnouncementInbox(tx: Tx, announcementId: string): Promise<number> {
  const r = await tx.query(`delete from parent_notifications where school_id = ${SCHOOL} and kind = 'announcement' and data->>'announcementId' = $1`, [announcementId]);
  return r.rowCount ?? 0;
}
