// announcements SQL (school → drivers / parents, BP §20 #6). Soft delete via deleted_at. The
// publish window is half-open: visible while published_at <= now() < expires_at (NULL = open).
// Parents read published rows through the parent_scope policy; staff through this module's helpers.
import type { Tx } from '../../db/tenant.js';
import { escapeLike, MAX_EXPORT_ROWS, pagedQuery } from '../../shared/pagination.js';

const SCHOOL = "nullif(current_setting('app.school_id', true), '')::uuid";

export interface AnnouncementRow extends Record<string, unknown> {
  id: string;
  title: string;
  body: string;
  audience: 'drivers' | 'parents' | 'all';
  is_pinned: boolean;
  published_at: string;
  expires_at: string | null;
  state: 'scheduled' | 'active' | 'expired';
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface AnnouncementFilter {
  audience?: string;
  states?: string[];
  pinned?: boolean;
  q?: string;
}

const STATE = `case when a.published_at > now() then 'scheduled'
                    when a.expires_at is not null and a.expires_at <= now() then 'expired'
                    else 'active' end`;
const COLUMNS = `a.id, a.title, a.body, a.audience, a.is_pinned, a.published_at, a.expires_at, ${STATE} as state,
  a.created_by, u.full_name as created_by_name, a.created_at, a.updated_at`;
const FROM = 'from announcements a left join users u on u.id = a.created_by';

function where(f: AnnouncementFilter) {
  return {
    sql: `a.deleted_at is null
      and ($1::text is null or a.audience = $1)
      and ($2::text[] is null or (${STATE}) = any ($2::text[]))
      and ($3::boolean is null or a.is_pinned = $3)
      and ($4::text is null or a.title ilike '%' || $4 || '%' or a.body ilike '%' || $4 || '%')`,
    params: [f.audience ?? null, f.states?.length ? f.states : null, f.pinned ?? null, f.q ? escapeLike(f.q) : null],
  };
}

export function page(tx: Tx, f: AnnouncementFilter, o: { orderBy: string; limit: number; offset: number }) {
  const w = where(f);
  return pagedQuery<AnnouncementRow>(tx, { select: COLUMNS, from: FROM, where: w.sql, params: w.params, ...o });
}

export function exportRows(tx: Tx, f: AnnouncementFilter, orderBy: string): Promise<AnnouncementRow[]> {
  const w = where(f);
  return tx.many<AnnouncementRow>(`select ${COLUMNS} ${FROM} where ${w.sql} ${orderBy} limit ${MAX_EXPORT_ROWS}`, w.params);
}

export function find(tx: Tx, id: string, { lock = false } = {}): Promise<AnnouncementRow | null> {
  return tx.maybeOne<AnnouncementRow>(`select ${COLUMNS} ${FROM} where a.id = $1 and a.deleted_at is null${lock ? ' for update of a' : ''}`, [id]);
}

export interface AnnouncementValues {
  title: string;
  body: string;
  audience: string;
  isPinned: boolean;
  publishedAt: string | null;
  expiresAt: string | null;
}

/** Inserts and returns the id (published_at defaults to now()). */
export async function insert(tx: Tx, v: AnnouncementValues): Promise<string> {
  const row = await tx.one<{ id: string }>(
    `insert into announcements (school_id, title, body, audience, is_pinned, published_at, expires_at, created_by)
     values (${SCHOOL}, $1, $2, $3, $4, coalesce($5::timestamptz, now()), $6, $7)
     returning id`,
    [v.title, v.body, v.audience, v.isPinned, v.publishedAt, v.expiresAt, tx.ctx.actorId],
  );
  return row.id;
}

export async function update(tx: Tx, id: string, v: AnnouncementValues): Promise<void> {
  await tx.query(
    `update announcements
        set title = $2, body = $3, audience = $4, is_pinned = $5, published_at = $6::timestamptz, expires_at = $7, updated_at = now()
      where id = $1 and deleted_at is null`,
    [id, v.title, v.body, v.audience, v.isPinned, v.publishedAt, v.expiresAt],
  );
}

export async function softDelete(tx: Tx, id: string): Promise<boolean> {
  return ((await tx.query('update announcements set deleted_at = now(), updated_at = now() where id = $1 and deleted_at is null', [id])).rowCount ?? 0) > 0;
}

/**
 * Announcements currently visible to an audience ('drivers' | 'parents'): published, not expired,
 * targeted at that audience or 'all'; pinned first, newest first.
 */
export function visibleFor(tx: Tx, audience: 'drivers' | 'parents', limit = 20): Promise<AnnouncementRow[]> {
  return tx.many<AnnouncementRow>(
    `select ${COLUMNS} ${FROM}
      where a.deleted_at is null and a.audience in ($1, 'all')
        and a.published_at <= now() and (a.expires_at is null or a.expires_at > now())
      order by a.is_pinned desc, a.published_at desc, a.id desc
      limit $2`,
    [audience, Math.min(Math.max(1, limit), 100)],
  );
}
