// Parent in-app notification inbox (contract §2 Push, §9; BP §11.2). The notifications module stores
// every parent notification in parent_notifications (so everything works without FCM) and emits
// notification:new to the parent's actor room; this file serves the inbox. It spans all schools: no
// X-School-Id, the RLS policy own_rows lets a parent SELECT its own rows in every school, and marking
// as read goes through parent_notifications_mark_read() (SECURITY DEFINER, parent context, own rows
// only). Payloads hold only a child's first name and the bus code (BP §11.2).
import type { ParentNotificationDto, ParentNotificationKind, ParentNotificationsQuery } from '@wimb/shared';
import type { Request } from 'express';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { audit } from '../../shared/audit.js';
import { notFound } from '../../shared/errors.js';
import { listMeta, parsePagination } from '../../shared/pagination.js';

interface InboxRow extends Record<string, unknown> {
  id: string;
  school_id: string;
  student_id: string | null;
  trip_id: string | null;
  kind: ParentNotificationKind;
  title: string;
  body: string;
  data: Record<string, unknown> | null;
  read_at: string | null;
  created_at: string;
}

const OWN = `n.parent_account_id = nullif(current_setting('app.actor_id', true), '')::uuid`;
const SELECT = 'n.id, n.school_id, n.student_id, n.trip_id, n.kind, n.title, n.body, n.data, n.read_at, n.created_at';

function toDto(r: InboxRow): ParentNotificationDto {
  return {
    id: r.id,
    schoolId: r.school_id,
    studentId: r.student_id,
    tripId: r.trip_id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    data: r.data ?? {},
    readAt: r.read_at,
    createdAt: r.created_at,
  };
}

export async function listNotifications(req: Request, q: ParentNotificationsQuery) {
  const { page, limit, offset } = parsePagination(q);
  return withRequestTenant(req, async (tx) => {
    const rows = await tx.many<InboxRow & { total: number; unread_total: number }>(
      `with mine as (select ${SELECT} from parent_notifications n where ${OWN})
       select m.*, count(*) over () as total,
              (select count(*) from mine u where u.read_at is null) as unread_total
         from mine m
        where ($1::boolean is null or ($1 and m.read_at is null) or (not $1 and m.read_at is not null))
          and ($2::uuid is null or m.student_id = $2)
        order by m.created_at desc, m.id desc
        limit $3 offset $4`,
      [q.unread ?? null, q.studentId ?? null, limit, offset],
    );
    let total = rows[0]?.total ?? 0;
    let unread = rows[0]?.unread_total;
    if (!rows.length) {
      // Page past the end (or nothing matches): totals from one count query.
      const c = await tx.one<{ total: number; unread: number }>(
        `select count(*) filter (where ($1::boolean is null or ($1 and n.read_at is null) or (not $1 and n.read_at is not null))
                                   and ($2::uuid is null or n.student_id = $2)) as total,
                count(*) filter (where n.read_at is null) as unread
           from parent_notifications n where ${OWN}`,
        [q.unread ?? null, q.studentId ?? null],
      );
      total = c.total;
      unread = c.unread;
    }
    return { items: rows.map(toDto), meta: { ...listMeta({ page, limit, total }), unreadCount: unread ?? 0 } };
  });
}

/** POST /parent/notifications/:id/read — idempotent; 404 for another parent's (or unknown) id. */
export async function markRead(req: Request, id: string): Promise<ParentNotificationDto> {
  return withRequestTenant(req, async (tx) => {
    const marked = await tx.one<{ n: number }>('select parent_notifications_mark_read(array[$1::uuid]) as n', [id]);
    const row = await tx.maybeOne<InboxRow>(`select ${SELECT} from parent_notifications n where n.id = $1 and ${OWN}`, [id]);
    if (!row) throw notFound('Notification not found.');
    if (marked.n > 0) await audit.log(tx, { action: 'parent_notification.read', entityType: 'parent_notification', entityId: id, new: { readAt: row.read_at } });
    return toDto(row);
  });
}

/** POST /parent/notifications/read-all → number of notifications marked. */
export async function markAllRead(req: Request): Promise<{ updated: number }> {
  return withRequestTenant(req, async (tx) => {
    const { n } = await tx.one<{ n: number }>('select parent_notifications_mark_read(null) as n');
    if (n > 0) await audit.log(tx, { action: 'parent_notification.read_all', entityType: 'parent_account', entityId: req.auth!.actorId, new: { updated: n } });
    return { updated: n };
  });
}
