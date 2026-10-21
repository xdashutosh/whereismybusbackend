// Job definitions of the notifications module (BP §7.3, §11.2; contract §8), listed in
// src/jobs/index.ts. Importing this file also registers the event listeners, so the worker (which
// runs the tracking analytics and the trip-not-started check in production) reacts to their events.
//   notifications-dispatch   queue  parent trip notifications (dispatchTripEvent), retried; the
//                                   notification_events claim makes every retry idempotent
//   announcement-deliver     queue  announcement fan-out / inbox refresh / withdrawal
//   announcement-sweep       cron   every minute: scheduled announcements that became due, and due
//                                   ones whose job was lost (process restart without Redis)
import { defineCronJob, defineQueueJob } from '../../jobs/registry.js';
import type { JobDef } from '../../jobs/types.js';
import { runAnnouncementJob, sweepAnnouncements, type AnnouncementJobPayload } from './announcements.js';
import { ANNOUNCEMENT_JOB, ANNOUNCEMENT_SWEEP_JOB, DISPATCH_JOB } from './constants.js';
import { dispatchTripEvent, type TripDispatchPayload } from './dispatch.js';
import './listeners.js';

export const notificationsDispatchJob = defineQueueJob<TripDispatchPayload>({
  name: DISPATCH_JOB,
  concurrency: 4,
  attempts: 3,
  backoffMs: 2000,
  handler: async (payload, ctx) => {
    await dispatchTripEvent(payload, { log: ctx.logger });
  },
});

export const announcementDeliverJob = defineQueueJob<AnnouncementJobPayload>({
  name: ANNOUNCEMENT_JOB,
  concurrency: 2,
  attempts: 3,
  backoffMs: 5000,
  handler: async (payload, ctx) => {
    const r = await runAnnouncementJob(payload, ctx.logger);
    if (r.skipped) ctx.logger.info({ schoolId: payload.schoolId, announcementId: payload.announcementId, skipped: r.skipped }, 'Announcement job skipped');
  },
});

export const announcementSweepJob = defineCronJob({
  name: ANNOUNCEMENT_SWEEP_JOB,
  cron: '* * * * *',
  timezone: 'UTC',
  handler: async (ctx) => {
    const r = await sweepAnnouncements({ log: ctx.logger });
    if (r.delivered) ctx.logger.info(r, 'Announcements delivered by the sweep');
  },
});

export const NOTIFICATION_JOB_DEFINITIONS: readonly JobDef[] = [notificationsDispatchJob, announcementDeliverJob, announcementSweepJob];
