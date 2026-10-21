// Parent trip notifications (BP §11.2): one run per (trip, event[, stops]) — called by the
// 'notifications-dispatch' job, which the listeners enqueue from trip/tracking events.
//   1. one transaction in the school's system context: gate the trip (school trip with a direction,
//      status valid for the event, signal not stale — trip_interrupted / trip_cancelled, BP §10.4, need
//      a running/cancelled resp. cancelled trip), read the school settings, find the students
//      assigned to the bus + direction on the trip date (optionally at given stops) with their
//      active parents and each parent's preference for the event, CLAIM one notification_events row
//      per student (UNIQUE (trip_id, student_id, event_type) — a retry or a concurrent run claims
//      nothing) and write the inbox entries of the claimed students' opted-in parents;
//   2. after commit: socket + push (+ SMS / WhatsApp when the school's feature is on);
//   3. record each claimed event's outcome (status, main channel, per-channel counts).
// Students whose parents all opted out (or who have no active parent) are claimed as 'skipped', so
// re-enabling a toggle mid-trip never replays an old event. A run that claims anything writes one
// compact 'notification.dispatch' audit row (trip, event, counts) in the claiming transaction; the
// per-student record is notification_events (GET /school/notifications).
import type { Direction, NotificationChannel, NotificationDeepLink, ParentTripEvent, NotificationStatus } from '@wimb/shared';
import { withSchoolSystem } from '../../db/tenant.js';
import { audit } from '../../shared/audit.js';
import { logger as rootLogger, type Logger } from '../../shared/logger.js';
import { loadSchoolSettings } from '../school/index.js';
import { notificationDeps, selectChannels, type ChannelPlan } from './channels.js';
import { deliverToParents, type Outcomes, type ParentDelivery } from './delivery.js';
import * as repo from './repository.js';
import { firstNameOf, languageOf, renderTripMessage } from './templates.js';

const rootLog = rootLogger.child({ module: 'notifications.dispatch' });

export interface TripDispatchPayload {
  schoolId: string;
  tripId: string;
  event: ParentTripEvent;
  /** Only students assigned at these stops (stop-specific events). */
  stopIds?: string[] | null;
  /** approaching_stop: minutes to each stop; trip_delayed: minutes late at each stop. */
  minutesByStop?: Record<string, number> | null;
  /** When the triggering signal happened (ISO). */
  at: string;
}

export interface DispatchResult {
  /** Students newly claimed (queued or skipped). */
  claimed: number;
  /** Claimed students with at least one opted-in parent. */
  notified: number;
  inbox: number;
  /** Why nothing was claimed (gate). */
  reason?: string;
}

/** A signal older than this is not worth a lock-screen alert any more (late jobs drop it). */
export const MAX_SIGNAL_AGE_MS: Readonly<Record<ParentTripEvent, number>> = Object.freeze({
  trip_started: 30 * 60_000,
  bus_left_school: 15 * 60_000,
  approaching_stop: 5 * 60_000,
  arrived_at_stop: 10 * 60_000,
  trip_delayed: 10 * 60_000,
  trip_not_started: 30 * 60_000,
  trip_interrupted: 60 * 60_000,
  trip_cancelled: 60 * 60_000,
});

const LIVE_STATUSES = new Set(['in_progress', 'completed', 'auto_closed']);

/** Why a trip cannot produce `event` now (null = OK). Pure. */
export function gateReason(trip: repo.DispatchTripRow | null, p: Pick<TripDispatchPayload, 'event' | 'at'>, nowMs: number): string | null {
  if (!trip) return 'TRIP_NOT_FOUND';
  if (trip.trip_type !== 'school' || !trip.direction) return 'NOT_A_SCHOOL_TRIP';
  const at = Date.parse(p.at);
  if (Number.isFinite(at) && nowMs - at > MAX_SIGNAL_AGE_MS[p.event]) return 'STALE_SIGNAL';
  if (p.event === 'trip_not_started') return trip.status === 'scheduled' || trip.status === 'missed' ? null : 'TRIP_STARTED';
  // Breakdown notices (BP §10.4): interrupted while running (or cancelled right after); cancelled only.
  if (p.event === 'trip_interrupted') return trip.status === 'in_progress' || trip.status === 'cancelled' ? null : 'TRIP_NOT_RUNNING';
  if (p.event === 'trip_cancelled') return trip.status === 'cancelled' ? null : 'TRIP_NOT_CANCELLED';
  // trip_started must come from a running trip; stop/school events may be processed just after the end.
  if (p.event === 'trip_started') return trip.status === 'in_progress' ? null : 'TRIP_NOT_RUNNING';
  return LIVE_STATUSES.has(trip.status) ? null : 'TRIP_NOT_RUNNING';
}

interface StudentGroup {
  studentId: string;
  fullName: string;
  stopId: string;
  parents: { parentId: string; lang: 'en' | 'hi'; phone: string | null }[];
  hasParents: boolean;
}

function groupByStudent(rows: repo.RecipientRow[]): StudentGroup[] {
  const map = new Map<string, StudentGroup>();
  for (const r of rows) {
    const g = map.get(r.student_id) ?? { studentId: r.student_id, fullName: r.full_name, stopId: r.stop_id, parents: [], hasParents: false };
    if (r.parent_account_id) {
      g.hasParents = true;
      if (r.enabled !== false && !g.parents.some((p) => p.parentId === r.parent_account_id)) {
        g.parents.push({ parentId: r.parent_account_id, lang: languageOf(r.preferred_language), phone: r.phone });
      }
    }
    map.set(r.student_id, g);
  }
  return [...map.values()];
}

export function deepLink(schoolId: string, event: ParentTripEvent, studentId: string, tripId: string, direction: Direction): NotificationDeepLink {
  return { type: event, screen: 'track', schoolId, studentId, tripId, direction };
}

interface Prepared {
  plan: ChannelPlan;
  mainChannel: NotificationChannel;
  deliveries: ParentDelivery[];
  /** Claimed event ids with recipients → recipient count. */
  queued: Map<string, number>;
  result: DispatchResult;
}

async function prepare(p: TripDispatchPayload, nowMs: number): Promise<Prepared | DispatchResult> {
  const deps = notificationDeps();
  return withSchoolSystem(p.schoolId, async (tx) => {
    const trip = await repo.findTrip(tx, p.tripId);
    const reason = gateReason(trip, p, nowMs);
    if (reason || !trip?.direction) return { claimed: 0, notified: 0, inbox: 0, reason: reason ?? 'NOT_A_SCHOOL_TRIP' };
    const direction = trip.direction;
    const settings = await loadSchoolSettings(tx);
    if (p.event === 'trip_not_started' && !settings.notifyTripNotStarted) return { claimed: 0, notified: 0, inbox: 0, reason: 'DISABLED_BY_SCHOOL' };
    const plan = selectChannels({
      pushAdapterEnabled: deps.push.enabled,
      platformPush: await repo.platformPushEnabled(tx),
      smsFeature: settings.effective.features.sms,
      whatsappFeature: settings.effective.features.whatsapp,
      whatsappAdapterEnabled: deps.whatsapp.enabled,
    });
    const mainChannel: NotificationChannel = plan.push ? 'push' : 'in_app';
    const stopIds = p.stopIds?.length ? p.stopIds : null;
    const students = groupByStudent(await repo.recipients(tx, { busId: trip.bus_id, direction, tripDate: trip.trip_date, stopIds, event: p.event }));
    if (!students.length) return { claimed: 0, notified: 0, inbox: 0, reason: 'NO_STUDENTS' };

    const claims: repo.ClaimInput[] = students.map((s) => {
      const minutes = p.minutesByStop?.[s.stopId] ?? null;
      const base = { event: p.event, direction, stopId: s.stopId, recipients: s.parents.length, ...(minutes !== null ? { minutes } : {}) };
      if (s.parents.length) return { studentId: s.studentId, status: 'queued' as NotificationStatus, channel: mainChannel, error: null, payload: base };
      return { studentId: s.studentId, status: 'skipped' as NotificationStatus, channel: 'in_app' as NotificationChannel, error: s.hasParents ? 'PREFERENCES_OFF' : 'NO_PARENTS', payload: base };
    });
    const claimed = await repo.claimEvents(tx, trip.id, p.event, claims);
    const eventOf = new Map(claimed.map((c) => [c.student_id, c.id]));

    const pending: { s: StudentGroup; eventId: string; parent: StudentGroup['parents'][number]; msg: ReturnType<typeof renderTripMessage>; data: NotificationDeepLink }[] = [];
    for (const s of students) {
      const eventId = eventOf.get(s.studentId);
      if (!eventId || !s.parents.length) continue;
      const data = deepLink(p.schoolId, p.event, s.studentId, trip.id, direction);
      for (const parent of s.parents) {
        const msg = renderTripMessage(p.event, parent.lang, { childFirstName: firstNameOf(s.fullName), busCode: trip.bus_code ?? '', direction, minutes: p.minutesByStop?.[s.stopId] ?? null });
        pending.push({ s, eventId, parent, msg, data });
      }
    }
    const inbox = await repo.insertInbox(
      tx,
      p.event,
      pending.map((x) => ({ parentAccountId: x.parent.parentId, studentId: x.s.studentId, tripId: trip.id, eventId: x.eventId, title: x.msg.title, body: x.msg.body, data: { ...x.data } })),
    );
    const inboxOf = new Map(inbox.map((r) => [`${r.notification_event_id}|${r.parent_account_id}`, r]));
    const deliveries: ParentDelivery[] = pending.map((x) => {
      const row = inboxOf.get(`${x.eventId}|${x.parent.parentId}`);
      return { key: x.eventId, parentId: x.parent.parentId, inboxId: row?.id ?? null, createdAt: row?.created_at ?? new Date(nowMs).toISOString(), lang: x.parent.lang, phone: x.parent.phone, push: x.msg, inbox: x.msg, data: x.data };
    });
    const queued = new Map<string, number>();
    for (const s of students) {
      const id = eventOf.get(s.studentId);
      if (id && s.parents.length) queued.set(id, s.parents.length);
    }
    if (claimed.length) {
      await audit.log(tx, {
        action: 'notification.dispatch',
        entityType: 'trip',
        entityId: trip.id,
        actorName: 'notifications',
        new: { event: p.event, stopIds, claimed: claimed.length, notified: queued.size, skipped: claimed.length - queued.size, inbox: inbox.length, channel: mainChannel },
      });
    }
    return { plan, mainChannel, deliveries, queued, result: { claimed: claimed.length, notified: queued.size, inbox: inbox.length } };
  });
}

function eventUpdates(prepared: Prepared, outcomes: Outcomes): repo.EventUpdate[] {
  return [...prepared.queued].map(([id, recipients]) => ({
    id,
    status: 'sent',
    channel: prepared.mainChannel,
    error: null,
    payload: { recipients, channels: outcomes.get(id) ?? {} },
  }));
}

/** Runs one dispatch (see the header). Idempotent: a re-run claims nothing new. */
export async function dispatchTripEvent(p: TripDispatchPayload, { nowMs = Date.now(), log = rootLog }: { nowMs?: number; log?: Logger } = {}): Promise<DispatchResult> {
  const prepared = await prepare(p, nowMs);
  if (!('plan' in prepared)) {
    if (prepared.reason) log.debug({ schoolId: p.schoolId, tripId: p.tripId, event: p.event, reason: prepared.reason }, 'Notification not dispatched');
    return prepared;
  }
  if (!prepared.queued.size) return prepared.result;
  const outcomes = await deliverToParents(p.schoolId, p.event, prepared.deliveries, prepared.plan, log);
  try {
    await withSchoolSystem(p.schoolId, (tx) => repo.finishEvents(tx, eventUpdates(prepared, outcomes)));
  } catch (err) {
    log.error({ err, schoolId: p.schoolId, tripId: p.tripId, event: p.event }, 'Could not record notification outcomes (events stay queued)');
  }
  log.info({ schoolId: p.schoolId, tripId: p.tripId, event: p.event, ...prepared.result }, 'Parent notifications dispatched');
  return prepared.result;
}
