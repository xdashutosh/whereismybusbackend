// Job names of the notifications module (listed in src/jobs/index.ts through jobs.ts).
/** queue: one parent trip-notification run { schoolId, tripId, event, stopIds?, minutesByStop?, at }. */
export const DISPATCH_JOB = 'notifications-dispatch';
/** queue: deliver / refresh / withdraw one announcement { schoolId, announcementId, action }. */
export const ANNOUNCEMENT_JOB = 'announcement-deliver';
/** cron: every minute, delivers scheduled announcements once due (and due ones whose job was lost). */
export const ANNOUNCEMENT_SWEEP_JOB = 'announcement-sweep';
