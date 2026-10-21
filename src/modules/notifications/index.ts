// Public surface of the notifications module (BP §11.2) for other modules, scripts and tests:
//   dispatchTripEvent(payload)            one parent trip-notification run (idempotent per trip/student/event)
//   deliverAnnouncement(schoolId, id)     announcement fan-out (exactly once, audited marker)
//   configureNotificationDeps(patch)      swap channel adapters (WhatsApp provider, DLT template ids, tests)
//   renderTripMessage / renderAnnouncement lock-screen-safe templates (en, hi)
//   NOTIFICATION_JOB_DEFINITIONS          job definitions (listed in src/jobs/index.ts)
// Events consumed (see ./listeners.ts): trip.status_changed, trip.not_started, tracking.left_school,
// tracking.stop_arrived, tracking.eta_updated, announcement.published, announcement.changed.
// Socket: notification:new { id, schoolId, kind, title, body, data, createdAt } to actor:{id}.
export { dispatchTripEvent, gateReason, MAX_SIGNAL_AGE_MS, type DispatchResult, type TripDispatchPayload } from './dispatch.js';
export { deliverAnnouncement, refreshAnnouncement, withdrawAnnouncement, sweepAnnouncements, type AnnouncementResult } from './announcements.js';
export { configureNotificationDeps, notificationDeps, selectChannels, createUnavailableWhatsApp, type NotificationDeps, type WhatsAppChannel, type SmsTemplateResolver } from './channels.js';
export { renderTripMessage, renderAnnouncement, firstNameOf } from './templates.js';
export { etaCandidates, registerNotificationListeners } from './listeners.js';
export { NOTIFICATION_JOB_DEFINITIONS } from './jobs.js';
export { DISPATCH_JOB, ANNOUNCEMENT_JOB, ANNOUNCEMENT_SWEEP_JOB } from './constants.js';
