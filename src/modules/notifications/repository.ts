// Notifications SQL (BP §11.2). Receives `tx` only. School-scoped statements run in the school's
// system context (tenant RLS); the parent push-target statements run in the PARENT's own context
// (devices/sessions of parents are school-less rows visible only to their owner — RLS own_rows).
import type { Direction, NotificationChannel, ParentTripEvent, NotificationStatus } from '@wimb/shared';
import { PARENT_TRIP_EVENTS } from '@wimb/shared';
import type { Tx } from '../../db/tenant.js';

const SCHOOL = "nullif(current_setting('app.school_id', true), '')::uuid";

export interface DispatchTripRow extends Record<string, unknown> {
  id: string;
  status: string;
  trip_type: string;
  direction: Direction | null;
  bus_id: string;
  route_id: string | null;
  trip_date: string;
  bus_code: string | null;
}

export function findTrip(tx: Tx, tripId: string): Promise<DispatchTripRow | null> {
  return tx.maybeOne<DispatchTripRow>(
    `select t.id, t.status, t.trip_type, t.direction, t.bus_id, t.route_id, t.trip_date,
            coalesce(t.bus_code_snapshot, b.code) as bus_code
       from trips t join buses b on b.id = t.bus_id
      where t.id = $1`,
    [tripId],
  );
}

/** platform_settings 'modules' (public row): the platform-wide push switch. */
export async function platformPushEnabled(tx: Tx): Promise<boolean> {
  const row = await tx.maybeOne<{ value: unknown }>("select value from platform_settings where key = 'modules'");
  const v = row?.value as { push?: unknown } | null | undefined;
  return typeof v?.push === 'boolean' ? v.push : true;
}

export interface RecipientRow extends Record<string, unknown> {
  student_id: string;
  full_name: string;
  stop_id: string;
  parent_account_id: string | null;
  preferred_language: string | null;
  phone: string | null;
  enabled: boolean | null;
}

/**
 * Students assigned on the trip date to the bus + direction (optionally only at `stopIds`) with
 * every active parent link and that parent's preference for `event` (missing row = enabled).
 * One row per (student, parent); a student without an active parent yields one row with nulls.
 */
export function recipients(tx: Tx, a: { busId: string; direction: Direction; tripDate: string; stopIds: string[] | null; event: ParentTripEvent }): Promise<RecipientRow[]> {
  if (!PARENT_TRIP_EVENTS.includes(a.event)) throw new TypeError(`Unknown notification event ${String(a.event)}`);
  // The event name is the preference column (validated against the enum above).
  return tx.many<RecipientRow>(
    `select s.id as student_id, s.full_name, sa.stop_id,
            p.parent_account_id, p.preferred_language, p.phone, p.enabled
       from student_assignments sa
       join students s on s.id = sa.student_id and s.is_active and s.deleted_at is null
       left join lateral (
         select sp.parent_account_id, pa.preferred_language, pa.phone, coalesce(np.${a.event}, true) as enabled
           from student_parents sp
           join school_parents scp on scp.school_id = sp.school_id and scp.parent_account_id = sp.parent_account_id
                                  and scp.is_active and scp.deleted_at is null
           join parent_accounts pa on pa.id = sp.parent_account_id and pa.is_active
           left join notification_preferences np on np.student_id = sp.student_id and np.parent_account_id = sp.parent_account_id
                                                and np.direction = sa.trip_direction
          where sp.student_id = s.id
       ) p on true
      where sa.bus_id = $1 and sa.trip_direction = $2
        and sa.valid_from <= $3::date and (sa.valid_to is null or sa.valid_to > $3::date)
        and ($4::uuid[] is null or sa.stop_id = any ($4::uuid[]))
      order by s.id, p.parent_account_id`,
    [a.busId, a.direction, a.tripDate, a.stopIds],
  );
}

export interface ClaimInput {
  studentId: string;
  status: NotificationStatus;
  channel: NotificationChannel;
  error: string | null;
  payload: Record<string, unknown>;
}

/**
 * Claims (trip, student, event) rows; rows that already exist (an earlier or concurrent run) are
 * left untouched and not returned — notification_events_dedupe is the dedupe authority.
 */
export function claimEvents(tx: Tx, tripId: string, event: ParentTripEvent, rows: ClaimInput[]): Promise<{ id: string; student_id: string }[]> {
  if (!rows.length) return Promise.resolve([]);
  return tx.many<{ id: string; student_id: string }>(
    `insert into notification_events (school_id, trip_id, student_id, event_type, channel, status, error, payload, sent_at)
     select ${SCHOOL}, $1, r.student_id, $2, r.channel, r.status, r.error, coalesce(r.payload, '{}'::jsonb), null
       from jsonb_to_recordset($3::jsonb) as r(student_id uuid, channel text, status text, error text, payload jsonb)
     on conflict on constraint notification_events_dedupe do nothing
     returning id, student_id`,
    [tripId, event, JSON.stringify(rows.map((r) => ({ student_id: r.studentId, channel: r.channel, status: r.status, error: r.error, payload: r.payload })))],
  );
}

export interface InboxInput {
  parentAccountId: string;
  studentId: string | null;
  tripId: string | null;
  eventId: string | null;
  title: string;
  body: string;
  data: Record<string, unknown>;
}

export interface InboxRow extends Record<string, unknown> {
  id: string;
  parent_account_id: string;
  student_id: string | null;
  notification_event_id: string | null;
  created_at: string;
}

/** Inbox rows of one kind (one statement); (event, parent) duplicates are ignored. */
export function insertInbox(tx: Tx, kind: string, rows: InboxInput[]): Promise<InboxRow[]> {
  if (!rows.length) return Promise.resolve([]);
  return tx.many<InboxRow>(
    `insert into parent_notifications (school_id, parent_account_id, student_id, trip_id, notification_event_id, kind, title, body, data)
     select ${SCHOOL}, r.parent_account_id, r.student_id, r.trip_id, r.event_id, $1, r.title, r.body, coalesce(r.data, '{}'::jsonb)
       from jsonb_to_recordset($2::jsonb) as r(parent_account_id uuid, student_id uuid, trip_id uuid, event_id uuid, title text, body text, data jsonb)
     on conflict on constraint parent_notifications_event_uq do nothing
     returning id, parent_account_id, student_id, notification_event_id, created_at`,
    [kind, JSON.stringify(rows.map((r) => ({ parent_account_id: r.parentAccountId, student_id: r.studentId, trip_id: r.tripId, event_id: r.eventId, title: r.title, body: r.body, data: r.data })))],
  );
}

export interface EventUpdate {
  id: string;
  status: NotificationStatus;
  channel: NotificationChannel;
  error: string | null;
  payload: Record<string, unknown>;
}

/** Records the delivery outcome of claimed events (one statement). */
export async function finishEvents(tx: Tx, rows: EventUpdate[]): Promise<void> {
  if (!rows.length) return;
  await tx.query(
    `update notification_events n
        set status = r.status, channel = r.channel, error = r.error,
            payload = n.payload || coalesce(r.payload, '{}'::jsonb),
            sent_at = case when r.status = 'sent' then now() else n.sent_at end
       from jsonb_to_recordset($1::jsonb) as r(id uuid, status text, channel text, error text, payload jsonb)
      where n.id = r.id`,
    [JSON.stringify(rows.map((r) => ({ id: r.id, status: r.status, channel: r.channel, error: r.error, payload: r.payload })))],
  );
}

// ── push targets ─────────────────────────────────────────────────────────────
/**
 * School system context: FCM tokens of the given parents' signed-in phones (trusted, unrevoked device with a
 * live session; parent active and linked to this school) — one statement through the SECURITY DEFINER
 * function of migration 600 (parents' devices are school-less rows that RLS shows only to the parent).
 */
export async function parentPushTokens(tx: Tx, parentIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!parentIds.length) return out;
  const rows = await tx.many<{ parent_account_id: string; fcm_token: string }>(
    'select parent_account_id, fcm_token from notification_parent_push_tokens($1::uuid[])',
    [parentIds],
  );
  for (const r of rows) out.set(r.parent_account_id, [...(out.get(r.parent_account_id) ?? []), r.fcm_token]);
  return out;
}

/** School system context: drops parent tokens FCM reported as unregistered (parents linked here only). */
export async function clearParentTokens(tx: Tx, tokens: readonly string[]): Promise<number> {
  if (!tokens.length) return 0;
  const r = await tx.one<{ n: number }>('select notification_clear_parent_tokens($1::text[]) as n', [tokens]);
  return r.n;
}

export interface StaffTargetRow extends Record<string, unknown> {
  user_id: string;
  fcm_token: string | null;
}

/**
 * A school user's device that may receive push (shared by announcements and alert escalation): token set,
 * not revoked, trusted, in the user's school and bound to a live (unrevoked, unexpired) session of that
 * user. Device rows keep their FCM token after logout, so the live session is what stops pushes to a
 * phone or PC the user signed out of. `d` = devices, `${owner}` = the user id expression.
 */
export const liveUserDevice = (owner: string) =>
  `d.owner_type = 'user' and d.owner_id = ${owner} and d.school_id = ${SCHOOL}
   and d.fcm_token is not null and d.revoked_at is null and d.is_trusted
   and exists (select 1 from sessions s
                where s.device_id = d.id and s.owner_type = 'user' and s.owner_id = ${owner}
                  and s.revoked_at is null and s.expires_at > now())`;

/** School context: active drivers/conductors with the FCM tokens of their signed-in phones (null = none). */
export function staffPushTargets(tx: Tx): Promise<StaffTargetRow[]> {
  return tx.many<StaffTargetRow>(
    `select u.id as user_id, d.fcm_token
       from users u
       left join devices d on ${liveUserDevice('u.id')}
      where u.role in ('driver', 'conductor') and u.is_active and u.deleted_at is null
      order by u.id`,
  );
}

/**
 * School context: live push tokens of the given users that are still active school admins of this school
 * (alert escalation). Users that are inactive, deleted, of another role or another school are absent.
 */
export async function adminPushTokens(tx: Tx, userIds: readonly string[]): Promise<Map<string, string[]>> {
  if (!userIds.length) return new Map();
  const rows = await tx.many<{ user_id: string; tokens: string[] }>(
    `select u.id as user_id, array_agg(distinct d.fcm_token) as tokens
       from users u
       join devices d on ${liveUserDevice('u.id')}
      where u.id = any ($1::uuid[]) and u.role = 'school_admin' and u.is_active and u.deleted_at is null
      group by u.id`,
    [userIds],
  );
  return new Map(rows.map((r) => [r.user_id, r.tokens]));
}

/** School context: drops staff tokens FCM reported as unregistered. */
export async function clearStaffTokens(tx: Tx, tokens: string[]): Promise<number> {
  if (!tokens.length) return 0;
  const r = await tx.query(
    `update devices set fcm_token = null, updated_at = now()
      where owner_type = 'user' and school_id = ${SCHOOL} and fcm_token = any ($1::text[])`,
    [tokens],
  );
  return r.rowCount ?? 0;
}
