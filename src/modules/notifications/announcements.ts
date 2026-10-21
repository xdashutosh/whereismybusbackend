// Announcement fan-out (BP §11.2 "school announcements", §20 #6; contract §9). The school module
// emits 'announcement.published' / 'announcement.changed'; the listeners queue
// 'announcement-deliver' jobs for due announcements (scheduled ones are picked up by the per-minute
// sweep once publishedAt is reached) and this module:
//   deliver   parents (audience parents | all): one inbox entry each + push in their language;
//             drivers/conductors (drivers | all): push to their signed-in phones + notification:new
//             in their personal room (the driver app lists notices from GET /driver/home).
//             Exactly once per announcement and audience segment (parents / drivers): advisory lock +
//             the audited 'announcement.deliver' marker listing the segments it delivered, so an
//             audience widened after delivery (drivers → all) reaches the new segment once;
//             withdrawn, expired, not-yet-due announcements and a disabled feature are skipped.
//   refresh   after an edit: rewrites the stored inbox text (no second push); inbox entries are
//             removed when the audience no longer includes parents, and restored (inbox only, the
//             parents were pushed already) when a live announcement whose parents segment was
//             delivered addresses parents again (parents → drivers → all).
//   withdraw  after a delete: removes the parents' inbox entries.
// The per-minute sweep delivers scheduled announcements once due and any due one whose job was lost.
import type { NotificationDeepLink } from '@wimb/shared';
import { withSchoolSystem, withSystem } from '../../db/tenant.js';
import { audit } from '../../shared/audit.js';
import { logger as rootLogger, type Logger } from '../../shared/logger.js';
import { loadSchoolSettings } from '../school/index.js';
import * as repo from './announcementRepository.js';
import { notificationDeps, selectChannels, type ChannelPlan } from './channels.js';
import { deliverToParents, deliverToStaff, type ParentDelivery } from './delivery.js';
import { platformPushEnabled } from './repository.js';
import { languageOf, renderAnnouncement } from './templates.js';

const rootLog = rootLogger.child({ module: 'notifications.announcements' });

/** Sweep window: announcements published this many hours ago or less are still delivered. */
export const SWEEP_WINDOW_HOURS = 24;

export type AnnouncementAction = 'deliver' | 'refresh' | 'withdraw';

export interface AnnouncementJobPayload {
  schoolId: string;
  announcementId: string;
  action: AnnouncementAction;
}

export interface AnnouncementResult {
  action: AnnouncementAction;
  skipped?: 'NOT_FOUND' | 'WITHDRAWN' | 'NOT_DUE' | 'EXPIRED' | 'ALREADY_DELIVERED' | 'FEATURE_DISABLED';
  parents: number;
  drivers: number;
  inboxChanged?: number;
}

const forParents = (audience: string) => audience === 'parents' || audience === 'all';
const forDrivers = (audience: string) => audience === 'drivers' || audience === 'all';
const segmentsOf = (audience: string): repo.AnnouncementSegment[] => [
  ...(forParents(audience) ? (['parents'] as const) : []),
  ...(forDrivers(audience) ? (['drivers'] as const) : []),
];

export function announcementLink(schoolId: string, announcementId: string): NotificationDeepLink {
  return { type: 'announcement', screen: 'announcement', schoolId, announcementId };
}

interface PreparedDelivery {
  row: repo.DeliverableRow;
  plan: ChannelPlan;
  deliveries: ParentDelivery[];
  /** The drivers segment is delivered by this run. */
  drivers: boolean;
}

async function prepareDelivery(schoolId: string, announcementId: string): Promise<PreparedDelivery | AnnouncementResult> {
  const deps = notificationDeps();
  return withSchoolSystem(schoolId, async (tx) => {
    await repo.lockAnnouncement(tx, announcementId);
    const row = await repo.findForDelivery(tx, announcementId);
    const skip = (skipped: NonNullable<AnnouncementResult['skipped']>): AnnouncementResult => ({ action: 'deliver', skipped, parents: 0, drivers: 0 });
    if (!row) return skip('NOT_FOUND');
    if (row.deleted) return skip('WITHDRAWN');
    if (!row.due) return skip('NOT_DUE');
    if (row.expired) return skip('EXPIRED');
    const done = await repo.deliveredSegments(tx, announcementId);
    const segments = segmentsOf(row.audience).filter((seg) => !done.has(seg));
    if (!segments.length) return skip('ALREADY_DELIVERED');
    const settings = await loadSchoolSettings(tx);
    if (!settings.effective.features.announcements) return skip('FEATURE_DISABLED');
    const plan = selectChannels({
      pushAdapterEnabled: deps.push.enabled,
      platformPush: await platformPushEnabled(tx),
      smsFeature: false,
      whatsappFeature: false,
      whatsappAdapterEnabled: deps.whatsapp.enabled,
    });
    const data = announcementLink(schoolId, announcementId);
    const deliveries: ParentDelivery[] = [];
    if (segments.includes('parents')) {
      const parents = await repo.schoolParents(tx);
      const inboxText = renderAnnouncement('en', row).inbox;
      const inserted = await repo.insertAnnouncementInbox(
        tx,
        announcementId,
        parents.map((p) => p.parent_account_id),
        { title: inboxText.title, body: inboxText.body, data: { ...data } },
      );
      const langOf = new Map(parents.map((p) => [p.parent_account_id, languageOf(p.preferred_language)]));
      for (const r of inserted) {
        const lang = langOf.get(r.parent_account_id) ?? 'en';
        const msg = renderAnnouncement(lang, row);
        deliveries.push({ key: announcementId, parentId: r.parent_account_id, inboxId: r.id, createdAt: r.created_at, lang, phone: null, push: msg.push, inbox: msg.inbox, data });
      }
    }
    await audit.log(tx, {
      action: repo.DELIVER_ACTION,
      entityType: 'announcement',
      entityId: announcementId,
      actorName: 'notifications',
      new: { audience: row.audience, segments, parents: deliveries.length, drivers: segments.includes('drivers'), push: plan.push ? 'enabled' : (plan.skipped.push ?? 'disabled') },
    });
    return { row, plan, deliveries, drivers: segments.includes('drivers') };
  });
}

/** Delivers one announcement (idempotent, see the header). */
export async function deliverAnnouncement(schoolId: string, announcementId: string, { log = rootLog }: { log?: Logger } = {}): Promise<AnnouncementResult> {
  const prepared = await prepareDelivery(schoolId, announcementId);
  if (!('plan' in prepared)) return prepared;
  const { row, plan, deliveries } = prepared;
  const parentOutcome = await deliverToParents(schoolId, 'announcement', deliveries, plan, log, { texts: false });
  let drivers = 0;
  if (prepared.drivers) {
    try {
      const msg = renderAnnouncement('en', row);
      const r = await deliverToStaff(schoolId, 'announcement', msg.push, announcementLink(schoolId, announcementId), plan, log);
      drivers = r.users;
      log.info({ schoolId, announcementId, drivers: r.users, push: r.push }, 'Announcement sent to drivers');
    } catch (err) {
      log.error({ err, schoolId, announcementId }, 'Could not notify the drivers of an announcement');
    }
  }
  log.info({ schoolId, announcementId, parents: deliveries.length, channels: parentOutcome.get(announcementId) ?? {} }, 'Announcement delivered');
  return { action: 'deliver', parents: deliveries.length, drivers };
}

/** After an edit: rewrites delivered inbox entries, removes them or restores them (see the header). */
export async function refreshAnnouncement(schoolId: string, announcementId: string): Promise<AnnouncementResult> {
  return withSchoolSystem(schoolId, async (tx) => {
    await repo.lockAnnouncement(tx, announcementId);
    const row = await repo.findForDelivery(tx, announcementId);
    if (!row) return { action: 'refresh', skipped: 'NOT_FOUND', parents: 0, drivers: 0 };
    const removed = row.deleted || !forParents(row.audience);
    let changed: number;
    let restored = 0;
    if (removed) changed = await repo.deleteAnnouncementInbox(tx, announcementId);
    else {
      const text = renderAnnouncement('en', row).inbox;
      changed = await repo.refreshAnnouncementInbox(tx, announcementId, text.title, text.body);
      // Parents addressed again after their entries were removed (parents → drivers → all): the parents
      // segment was delivered (and pushed) before, so the entries come back without a second push. A
      // parents segment never delivered is left to the deliver job (inbox + push).
      if (row.due && !row.expired && (await repo.deliveredSegments(tx, announcementId)).has('parents')) {
        const parents = await repo.schoolParents(tx);
        restored = (
          await repo.insertAnnouncementInbox(tx, announcementId, parents.map((p) => p.parent_account_id), {
            title: text.title,
            body: text.body,
            data: { ...announcementLink(schoolId, announcementId) },
          })
        ).length;
      }
    }
    if (changed || restored) {
      await audit.log(tx, {
        action: 'announcement.inbox_refresh',
        entityType: 'announcement',
        entityId: announcementId,
        actorName: 'notifications',
        new: { entries: changed, removed, restored },
      });
    }
    return { action: 'refresh', parents: restored, drivers: 0, inboxChanged: changed + restored };
  });
}

/** After a delete (withdrawal): removes the parents' inbox entries. */
export async function withdrawAnnouncement(schoolId: string, announcementId: string): Promise<AnnouncementResult> {
  return withSchoolSystem(schoolId, async (tx) => {
    await repo.lockAnnouncement(tx, announcementId);
    const removed = await repo.deleteAnnouncementInbox(tx, announcementId);
    if (removed) await audit.log(tx, { action: 'announcement.inbox_withdraw', entityType: 'announcement', entityId: announcementId, actorName: 'notifications', new: { entries: removed } });
    return { action: 'withdraw', parents: 0, drivers: 0, inboxChanged: removed };
  });
}

export function runAnnouncementJob(p: AnnouncementJobPayload, log?: Logger): Promise<AnnouncementResult> {
  if (p.action === 'withdraw') return withdrawAnnouncement(p.schoolId, p.announcementId);
  if (p.action === 'refresh') return refreshAnnouncement(p.schoolId, p.announcementId);
  return deliverAnnouncement(p.schoolId, p.announcementId, log ? { log } : {});
}

/** Sweep: delivers due announcements whose delayed job never ran, in every active school. */
export async function sweepAnnouncements({ log = rootLog }: { log?: Logger } = {}): Promise<{ schools: number; delivered: number }> {
  const schools = await withSystem((tx) => tx.many<{ id: string }>('select id from active_school_ids() as id'), { readOnly: true });
  let delivered = 0;
  for (const s of schools) {
    try {
      const ids = await withSchoolSystem(s.id, (tx) => repo.undelivered(tx, SWEEP_WINDOW_HOURS), { readOnly: true });
      for (const id of ids) {
        const r = await deliverAnnouncement(s.id, id, { log });
        if (!r.skipped) delivered += 1;
      }
    } catch (err) {
      log.error({ err, schoolId: s.id }, 'Announcement sweep failed for a school');
    }
  }
  return { schools: schools.length, delivered };
}
