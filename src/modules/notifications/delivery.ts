// After-commit delivery of stored notifications (BP §11.2): the inbox rows already exist (written in
// the claiming transaction), so this step only fans out to the external channels and the sockets.
// Delivery never throws: every channel failure is caught, logged and reported in the outcome map,
// which the caller records on notification_events. Pushes are at-most-once (a crash after the claim
// commit leaves the event 'queued' with its inbox entries stored, never a duplicate lock-screen alert).
//
// Parent FCM tokens: parents' devices and sessions are school-less rows that RLS (own_rows) shows
// only to the parent itself; the school's system context reads them in ONE statement through the
// SECURITY DEFINER function notification_parent_push_tokens (migration 600: system role, parents
// linked to this school, trusted devices with a live session only), and prunes invalid tokens the same way.
import { SOCKET_EVENTS, type ChannelOutcome, type NotificationChannel, type NotificationDeepLink, type NotificationKind, type NotificationLanguage, type NotificationNewEvent } from '@wimb/shared';
import { withSchoolSystem } from '../../db/tenant.js';
import { logger as rootLogger, type Logger } from '../../shared/logger.js';
import { rooms } from '../../shared/realtime.js';
import { notificationDeps, type ChannelPlan } from './channels.js';
import * as repo from './repository.js';
import type { RenderedMessage } from './templates.js';

const rootLog = rootLogger.child({ module: 'notifications.delivery' });

export interface ParentDelivery {
  /** Outcome bucket (notification_events.id for trip events, the announcement id otherwise). */
  key: string;
  parentId: string;
  inboxId: string | null;
  createdAt: string;
  lang: NotificationLanguage;
  phone: string | null;
  /** Lock-screen text (push / SMS). */
  push: RenderedMessage;
  /** Inbox text (socket payload). */
  inbox: RenderedMessage;
  data: NotificationDeepLink;
}

export type Outcomes = Map<string, Partial<Record<NotificationChannel, ChannelOutcome>>>;

/** FCM data payloads carry strings only. */
export function pushData(data: NotificationDeepLink): Record<string, string> {
  return Object.fromEntries(Object.entries(data).filter(([, v]) => typeof v === 'string' && v !== ''));
}

function bump(outcomes: Outcomes, key: string, channel: NotificationChannel, targets: number, delivered: number, error?: string): void {
  const byChannel = outcomes.get(key) ?? {};
  const prev = byChannel[channel] ?? { status: 'skipped', targets: 0, delivered: 0 };
  const t = prev.targets + targets;
  const d = prev.delivered + delivered;
  const status: ChannelOutcome['status'] = d > 0 ? 'sent' : t > 0 ? 'failed' : 'skipped';
  const err = d > 0 ? undefined : (error ?? prev.error);
  byChannel[channel] = { status, targets: t, delivered: d, ...(err ? { error: err } : {}) };
  outcomes.set(key, byChannel);
}

function markSkipped(outcomes: Outcomes, keys: Iterable<string>, channel: NotificationChannel, error: string): void {
  for (const key of keys) {
    const byChannel = outcomes.get(key) ?? {};
    byChannel[channel] ??= { status: 'skipped', targets: 0, delivered: 0, error };
    outcomes.set(key, byChannel);
  }
}

/** FCM tokens of each parent (one school-system statement). A failure means no push (logged), never a throw. */
export async function loadParentTokens(schoolId: string, parentIds: readonly string[], log: Logger = rootLog): Promise<Map<string, string[]>> {
  const unique = [...new Set(parentIds)];
  try {
    return await withSchoolSystem(schoolId, (tx) => repo.parentPushTokens(tx, unique), { readOnly: true });
  } catch (err) {
    log.warn({ err, schoolId, parents: unique.length }, 'Could not read the push tokens of the parents');
    return new Map();
  }
}

async function pruneParentTokens(schoolId: string, invalid: readonly string[], log: Logger): Promise<void> {
  try {
    await withSchoolSystem(schoolId, (tx) => repo.clearParentTokens(tx, invalid));
  } catch (err) {
    log.warn({ err, schoolId }, 'Could not remove invalid push tokens');
  }
}

/** Socket notification:new to each parent's personal room (inbox entries only). */
async function emitSockets(schoolId: string, kind: NotificationKind, deliveries: readonly ParentDelivery[], log: Logger): Promise<void> {
  const { realtime } = notificationDeps();
  await Promise.all(
    deliveries
      .filter((d) => d.inboxId)
      .map(async (d) => {
        const payload: NotificationNewEvent = { id: d.inboxId, schoolId, kind, title: d.inbox.title, body: d.inbox.body, data: d.data, createdAt: d.createdAt };
        try {
          await realtime.emit(rooms.actor(d.parentId), SOCKET_EVENTS.NOTIFICATION_NEW, payload);
        } catch (err) {
          log.warn({ err, schoolId }, 'Could not emit notification:new');
        }
      }),
  );
}

async function sendPush(schoolId: string, deliveries: readonly ParentDelivery[], outcomes: Outcomes, log: Logger): Promise<void> {
  const { push } = notificationDeps();
  const tokens = await loadParentTokens(schoolId, deliveries.map((d) => d.parentId), log);
  // Parents of one bucket in one language receive the same text → one multicast per (bucket, language).
  const groups = new Map<string, { key: string; msg: RenderedMessage; data: NotificationDeepLink; tokenOwner: Map<string, string> }>();
  for (const d of deliveries) {
    const gk = `${d.key}|${d.lang}`;
    const g = groups.get(gk) ?? { key: d.key, msg: d.push, data: d.data, tokenOwner: new Map<string, string>() };
    for (const t of tokens.get(d.parentId) ?? []) g.tokenOwner.set(t, d.parentId);
    groups.set(gk, g);
  }
  const invalid = new Set<string>();
  for (const g of groups.values()) {
    const list = [...g.tokenOwner.keys()];
    if (!list.length) {
      bump(outcomes, g.key, 'push', 0, 0, 'NO_DEVICES');
      continue;
    }
    try {
      const r = await push.send({ tokens: list, title: g.msg.title, body: g.msg.body, data: pushData(g.data) });
      bump(outcomes, g.key, 'push', list.length, r.successCount, r.successCount ? undefined : r.skipped ? 'PUSH_DISABLED' : 'PUSH_FAILED');
      for (const t of r.invalidTokens) if (g.tokenOwner.has(t)) invalid.add(t);
    } catch (err) {
      log.error({ err }, 'Push delivery failed');
      bump(outcomes, g.key, 'push', list.length, 0, 'PUSH_FAILED');
    }
  }
  if (invalid.size) await pruneParentTokens(schoolId, [...invalid], log);
}

async function sendTexts(channel: 'sms' | 'whatsapp', kind: NotificationKind, deliveries: readonly ParentDelivery[], outcomes: Outcomes, log: Logger): Promise<void> {
  const deps = notificationDeps();
  for (const d of deliveries) {
    if (!d.phone) {
      bump(outcomes, d.key, channel, 0, 0, 'NO_PHONE');
      continue;
    }
    const text = `${d.push.title}: ${d.push.body}`;
    try {
      if (channel === 'sms') {
        const templateId = deps.smsTemplateId(kind, d.lang);
        const r = await deps.sms.sendText(d.phone, text, templateId ? { templateId } : {});
        bump(outcomes, d.key, 'sms', 1, r.delivered ? 1 : 0, r.error);
      } else {
        const r = await deps.whatsapp.sendText(d.phone, text);
        bump(outcomes, d.key, 'whatsapp', 1, r.delivered ? 1 : 0, r.error);
      }
    } catch (err) {
      log.error({ err, channel }, 'Text notification failed');
      bump(outcomes, d.key, channel, 1, 0, 'SEND_FAILED');
    }
  }
}

/**
 * Delivers stored parent notifications over the planned channels. Returns the per-bucket outcomes
 * (in_app always reported for buckets with inbox entries).
 */
export async function deliverToParents(
  schoolId: string,
  kind: NotificationKind,
  deliveries: readonly ParentDelivery[],
  plan: ChannelPlan,
  log: Logger = rootLog,
  { texts = true }: { texts?: boolean } = {},
): Promise<Outcomes> {
  const outcomes: Outcomes = new Map();
  for (const d of deliveries) bump(outcomes, d.key, 'in_app', d.inboxId ? 1 : 0, d.inboxId ? 1 : 0);
  if (!deliveries.length) return outcomes;
  await emitSockets(schoolId, kind, deliveries, log);
  const keys = new Set(deliveries.map((d) => d.key));
  if (plan.push) await sendPush(schoolId, deliveries, outcomes, log);
  else markSkipped(outcomes, keys, 'push', plan.skipped.push ?? 'PUSH_DISABLED');
  if (texts) {
    if (plan.sms) await sendTexts('sms', kind, deliveries, outcomes, log);
    else markSkipped(outcomes, keys, 'sms', plan.skipped.sms ?? 'FEATURE_DISABLED');
    if (plan.whatsapp) await sendTexts('whatsapp', kind, deliveries, outcomes, log);
    else markSkipped(outcomes, keys, 'whatsapp', plan.skipped.whatsapp ?? 'FEATURE_DISABLED');
  }
  return outcomes;
}

/** Push to the school's signed-in drivers/conductors + notification:new to their personal rooms. */
export async function deliverToStaff(
  schoolId: string,
  kind: NotificationKind,
  msg: RenderedMessage,
  data: NotificationDeepLink,
  plan: ChannelPlan,
  log: Logger = rootLog,
): Promise<{ users: number; push: ChannelOutcome }> {
  const deps = notificationDeps();
  const targets = await withSchoolSystem(schoolId, (tx) => repo.staffPushTargets(tx), { readOnly: true });
  const users = [...new Set(targets.map((t) => t.user_id))];
  const createdAt = new Date().toISOString();
  await Promise.all(
    users.map(async (userId) => {
      const payload: NotificationNewEvent = { id: null, schoolId, kind, title: msg.title, body: msg.body, data, createdAt };
      try {
        await deps.realtime.emit(rooms.actor(userId), SOCKET_EVENTS.NOTIFICATION_NEW, payload);
      } catch (err) {
        log.warn({ err, schoolId }, 'Could not emit a driver notice');
      }
    }),
  );
  if (!plan.push) return { users: users.length, push: { status: 'skipped', targets: 0, delivered: 0, error: plan.skipped.push ?? 'PUSH_DISABLED' } };
  const tokens = [...new Set(targets.map((t) => t.fcm_token).filter((t): t is string => Boolean(t)))];
  if (!tokens.length) return { users: users.length, push: { status: 'skipped', targets: 0, delivered: 0, error: 'NO_DEVICES' } };
  try {
    const r = await deps.push.send({ tokens, title: msg.title, body: msg.body, data: pushData(data) });
    if (r.invalidTokens.length) await withSchoolSystem(schoolId, (tx) => repo.clearStaffTokens(tx, r.invalidTokens));
    return { users: users.length, push: { status: r.successCount ? 'sent' : 'failed', targets: tokens.length, delivered: r.successCount, ...(r.successCount ? {} : { error: r.skipped ? 'PUSH_DISABLED' : 'PUSH_FAILED' }) } };
  } catch (err) {
    log.error({ err, schoolId }, 'Driver push failed');
    return { users: users.length, push: { status: 'failed', targets: tokens.length, delivered: 0, error: 'PUSH_FAILED' } };
  }
}
