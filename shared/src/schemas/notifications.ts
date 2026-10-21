// Notifications engine schemas and DTOs (BP §11.2; contract §2 push/sms adapters, §9 announcements).
// The parent-facing endpoints (notification preferences, devices, inbox) live in ./parent.ts; this
// file covers the engine's own surface: the school's notification log, the socket payload of
// `notification:new` and the deep-link payload carried by inbox entries and push messages.
import { z } from 'zod';
import { DIRECTIONS, NOTIFICATION_STATUSES, PARENT_TRIP_EVENTS } from '../enums.js';
import type { Direction, NotificationChannel, NotificationStatus, ParentTripEvent } from '../enums.js';
import { exportFormat, isoDate, listQueryShape, queryEnumList, uuid } from './common.js';

const emptyToUndefined = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? undefined : v);

/** Languages of the notification templates (parent_accounts.preferred_language). */
export const NOTIFICATION_LANGUAGES = ['en', 'hi'] as const;
export type NotificationLanguage = (typeof NOTIFICATION_LANGUAGES)[number];

/** Kinds of inbox entries / `notification:new` events: the parent trip events, announcements, system notices. */
export const NOTIFICATION_KINDS = [...PARENT_TRIP_EVENTS, 'announcement', 'system'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** App screen a notification opens (deep link). */
export type NotificationScreen = 'track' | 'announcement' | 'home';

// ── admin requests ───────────────────────────────────────────────────────────
/** GET /school/notifications — the school's parent notification log (notification_events). */
export const schoolNotificationListQuery = z.object({
  ...listQueryShape,
  tripId: z.preprocess(emptyToUndefined, uuid().optional()),
  studentId: z.preprocess(emptyToUndefined, uuid().optional()),
  eventType: queryEnumList([...PARENT_TRIP_EVENTS]),
  status: queryEnumList([...NOTIFICATION_STATUSES]),
  direction: z.preprocess(emptyToUndefined, z.enum(DIRECTIONS).optional()),
  /** Trip dates (school-local, inclusive). */
  from: z.preprocess(emptyToUndefined, isoDate().optional()),
  to: z.preprocess(emptyToUndefined, isoDate().optional()),
  format: exportFormat.refine((f) => f !== 'pdf', 'Supported formats: json, csv'),
});
export type SchoolNotificationListQuery = z.infer<typeof schoolNotificationListQuery>;

// ── DTOs ─────────────────────────────────────────────────────────────────────
/**
 * Deep-link payload of an inbox entry / push message. String values only (FCM data payload) and
 * nothing sensitive: ids the app already knows plus the screen to open.
 */
export interface NotificationDeepLink {
  type: NotificationKind;
  screen: NotificationScreen;
  schoolId: string;
  studentId?: string;
  tripId?: string;
  direction?: Direction;
  announcementId?: string;
}

/** Outcome of one delivery channel for a notification event. */
export interface ChannelOutcome {
  /** 'sent' (delivered to ≥ 1 target), 'failed' (attempted, nothing delivered), 'skipped' (not attempted). */
  status: 'sent' | 'failed' | 'skipped';
  /** Devices / phones / inbox entries targeted. */
  targets: number;
  delivered: number;
  /** Error code when failed or skipped (PUSH_DISABLED, NO_DEVICES, FEATURE_DISABLED, TEMPLATE_REQUIRED, …). */
  error?: string;
}

/** One row of the school's notification log (GET /school/notifications). */
export interface NotificationEventDto {
  id: string;
  tripId: string;
  tripDate: string | null;
  direction: Direction | null;
  busCode: string | null;
  studentId: string | null;
  studentName: string | null;
  eventType: ParentTripEvent;
  /** Main channel: 'push' when push delivery was attempted, otherwise 'in_app'. */
  channel: NotificationChannel;
  status: NotificationStatus;
  /** Parents whose preferences allowed this event. */
  recipients: number;
  channels: Partial<Record<NotificationChannel, ChannelOutcome>>;
  error: string | null;
  sentAt: string | null;
  createdAt: string;
}

/** Socket `notification:new` payload (room actor:{parentAccountId | userId}). */
export interface NotificationNewEvent {
  /** Inbox entry id (parents); null for driver notices, which have no inbox row. */
  id: string | null;
  schoolId: string;
  kind: NotificationKind;
  title: string;
  body: string;
  data: NotificationDeepLink;
  createdAt: string;
}
