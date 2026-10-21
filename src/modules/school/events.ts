// Events of the school module (emitted AFTER commit through shared/events). The notifications
// module fans announcements out to drivers/parents (push + in-app inbox) and other modules drop
// cached settings when they change. Payloads always carry school_id (BP §16).
import type { AnnouncementAudience } from '@wimb/shared';

export interface AnnouncementEventPayload {
  schoolId: string;
  announcementId: string;
  audience: AnnouncementAudience;
  title: string;
  isPinned: boolean;
  publishedAt: string;
  expiresAt: string | null;
  /** publishedAt lies in the future: deliver at publishedAt, not now. */
  scheduled: boolean;
}

declare module '../../shared/events.js' {
  interface AppEvents {
    /** A new announcement was created (deliver now, or at publishedAt when scheduled). */
    'announcement.published': AnnouncementEventPayload;
    /** An announcement was edited or withdrawn (cancel/refresh pending deliveries). */
    'announcement.changed': AnnouncementEventPayload & { change: 'updated' | 'deleted'; changedFields: string[] };
    /** School settings changed (thresholds, intervals, features, alert recipients, parent visibility). */
    'school.settings_changed': { schoolId: string; changedFields: string[] };
    /** School profile changed (branding, location, timezone, contacts). */
    'school.profile_changed': { schoolId: string; changedFields: string[] };
  }
}

export {};
