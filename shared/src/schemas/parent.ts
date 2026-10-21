// Parent app API (BP §4.6, §8.5, §9.3, §9.4, §15; contract §4, §7, §9 in-app inbox). Every per-child
// call carries X-School-Id (validated against an active child link before the tenant context is set);
// GET /parent/children and the inbox span all of the parent's schools. Responses are read-only DTOs
// filtered by the school's parent_visibility matrix — never raw rows (BP §7.2, §16).
import { z } from 'zod';
import {
  DEVICE_PLATFORMS,
  DIRECTIONS,
  PARENT_TRIP_EVENTS,
  type AssignmentRole,
  type BusDocumentType,
  type Direction,
  type LiveStatus,
  type ParentTripEvent,
  type ParentTripPhase,
  type TripStatus,
} from '../enums.js';
import { semver, uuid } from './common.js';
import type { BusDocumentExpiryStatus } from './buses.js';
import type { ParentStaffCard } from './staff.js';
import type { Freshness, MotionState, ParentTripStatus, StopEta } from './tracking.js';

const emptyToUndefined = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? undefined : v);

// ── requests ─────────────────────────────────────────────────────────────────
export const parentStudentParams = z.object({ studentId: uuid() });
export type ParentStudentParams = z.infer<typeof parentStudentParams>;

export const parentFileParams = z.object({ fileId: uuid() });
export type ParentFileParams = z.infer<typeof parentFileParams>;

export const parentNotificationParams = z.object({ id: uuid() });
export type ParentNotificationParams = z.infer<typeof parentNotificationParams>;

/** GET /parent/children/:studentId/tracking — optional direction (default: the trip that matters now). */
export const parentTrackingQuery = z.object({
  direction: z.preprocess(emptyToUndefined, z.enum(DIRECTIONS).optional()),
});
export type ParentTrackingQuery = z.infer<typeof parentTrackingQuery>;

const toggle = () => z.boolean({ invalid_type_error: 'Must be true or false' }).optional();

/** One direction's toggles (BP §11.2 events + §10.4 trip notices = notification_preferences columns). */
export const notificationToggles = z
  .object({
    tripStarted: toggle(),
    busLeftSchool: toggle(),
    approachingStop: toggle(),
    arrivedAtStop: toggle(),
    tripDelayed: toggle(),
    tripNotStarted: toggle(),
    tripInterrupted: toggle(),
    tripCancelled: toggle(),
  });

/**
 * PUT /parent/children/:studentId/notification-preferences: any subset, merged over the current values.
 * Unknown keys (schoolId, parentAccountId, studentId, typos) are stripped like everywhere else (contract §2,
 * §4); a body left without any known toggle is rejected.
 */
export const notificationPreferencesBody = z
  .object({ morning: notificationToggles.optional(), afternoon: notificationToggles.optional() })
  .refine((b) => Object.values(b).some((d) => d && Object.values(d).some((v) => v !== undefined)), { message: 'Send at least one toggle' });
export type NotificationPreferencesBody = z.infer<typeof notificationPreferencesBody>;

/** POST /parent/devices — the parent app's device (FCM token for push). */
export const parentDeviceBody = z.object({
  deviceId: z.string().trim().min(8).max(128),
  platform: z.enum(DEVICE_PLATFORMS),
  /** null clears the token (push disabled on this phone); omitted keeps it. */
  fcmToken: z.preprocess(emptyToUndefined, z.string().trim().max(4096).nullable().optional()),
  model: z.string().trim().max(120).optional(),
  osVersion: z.string().trim().max(60).optional(),
  appVersion: semver().optional(),
});
export type ParentDeviceBody = z.infer<typeof parentDeviceBody>;

/** GET /parent/notifications */
export const parentNotificationsQuery = z.object({
  page: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(100000).optional()),
  limit: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(100).optional()),
  unread: z.preprocess((v) => {
    const s = emptyToUndefined(v);
    if (s === undefined || typeof s === 'boolean') return s;
    const t = String(s).toLowerCase();
    return t === 'true' || t === '1' ? true : t === 'false' || t === '0' ? false : s;
  }, z.boolean({ invalid_type_error: 'Must be true or false' }).optional()),
  studentId: z.preprocess(emptyToUndefined, uuid().optional()),
});
export type ParentNotificationsQuery = z.infer<typeof parentNotificationsQuery>;

// ── GET /parent/children ─────────────────────────────────────────────────────
export interface ParentStopRef {
  id: string;
  name: string;
  sequence: number;
  lat: number;
  lng: number;
  /** Timetable time at the stop ('HH:MM:SS', school-local) when set. */
  expectedTime: string | null;
}

/** The child's bus for one direction today, with the trip that matters next. */
export interface ParentChildDirection {
  direction: Direction;
  busId: string;
  busCode: string;
  routeId: string;
  routeCode: string;
  routeName: string | null;
  stop: ParentStopRef;
  /** Next pickup (morning) / drop (afternoon) instant at the child's stop (ISO), when known. */
  nextAt: string | null;
  /** School-local date of nextAt. */
  nextDate: string | null;
  /** Today's trip of this bus and direction (null when none was generated, e.g. a holiday). */
  trip: { id: string; status: TripStatus; plannedStartAt: string | null; startedAt: string | null; endedAt: string | null } | null;
  /** BP §9.4 status of today's trip for this child (null without a trip today). */
  status: LiveStatus | null;
  /** Phase of today's trip (no_trip without one; interrupted = breakdown reported) and its reason. */
  phase: ParentTripPhase;
  phaseReason: string | null;
}

export interface ParentChildCard {
  studentId: string;
  fullName: string;
  className: string | null;
  section: string | null;
  /** Signed URL of the child's photo (short-lived) or null. */
  photoUrl: string | null;
  /** Morning first, then afternoon; empty when no bus is assigned. */
  directions: ParentChildDirection[];
}

export interface ParentSchoolGroup {
  schoolId: string;
  schoolName: string;
  institutionType: string;
  logoUrl: string | null;
  brandColor: string | null;
  timezone: string;
  children: ParentChildCard[];
}

export interface ParentChildrenResponse {
  generatedAt: string;
  schools: ParentSchoolGroup[];
}

// ── GET /parent/children/:studentId/tracking ─────────────────────────────────
export interface ParentTrackingPosition {
  lat: number;
  lng: number;
  /** Heading (deg) and speed (km/h) of the fix, when the phone reported them. */
  hdg: number | null;
  spd: number | null;
  /** Fix time (ISO) — "Last updated". */
  t: string;
}

export interface ParentTrackingSnapshot {
  serverTime: string;
  studentId: string;
  firstName: string;
  school: { id: string; name: string; lat: number | null; lng: number | null };
  direction: Direction;
  bus: { id: string; code: string };
  route: { id: string; code: string; name: string | null };
  stop: ParentStopRef & { arrivalRadiusM: number };
  trip: { id: string; status: TripStatus; tripDate: string; plannedStartAt: string | null; startedAt: string | null; endedAt: string | null } | null;
  status: ParentTripStatus;
  /** Newest received fix of the running trip (never interpolated) or null. */
  position: ParentTrackingPosition | null;
  motion: MotionState | null;
  freshness: Freshness;
  lastUpdatedAt: string | null;
  /** ETA to the child's stop and to the next stop (quality-gated, BP §9.5). */
  eta: { quality: 'good' | 'degraded' | 'unavailable'; childStop: StopEta | null; nextStop: StopEta | null; destinationEtaAt: string | null } | null;
  planned: {
    polyline: string | null;
    polylineSource: 'google' | 'straight' | null;
    stops: { id: string; sequence: number; name: string; lat: number; lng: number }[];
  };
  /** Socket room for live updates and the fallback polling interval (BP §9.3). */
  room: string;
  pollAfterS: number;
}

// ── GET /parent/children/:studentId/bus and /staff ───────────────────────────
export interface ParentBusDetails {
  school: { id: string; name: string };
  studentId: string;
  direction: Direction;
  bus: {
    id: string;
    code: string;
    displayName: string | null;
    vehicleType: string | null;
    makeModel: string | null;
    color: string | null;
    capacity: number | null;
    registrationNo: string | null;
    images: { fileId: string; caption: string | null; url: string | null; thumbnailUrl: string | null }[];
    documents: { docType: BusDocumentType; title: string | null; expiryDate: string | null; expiryStatus: BusDocumentExpiryStatus; fileId: string | null }[];
  };
  route: { id: string; code: string; name: string | null };
}

export interface ParentBusStaff {
  busId: string;
  busCode: string;
  direction: Direction;
  /** Primary driver, conductor, then backups (cards filtered by the visibility matrix). */
  staff: (ParentStaffCard & { role: AssignmentRole })[];
}

export interface ParentStaffResponse {
  school: { id: string; name: string };
  studentId: string;
  /** One entry per distinct bus of the child's directions today. */
  buses: ParentBusStaff[];
}

// ── notification preferences, devices, inbox ─────────────────────────────────
export type NotificationToggles = Record<
  'tripStarted' | 'busLeftSchool' | 'approachingStop' | 'arrivedAtStop' | 'tripDelayed' | 'tripNotStarted' | 'tripInterrupted' | 'tripCancelled',
  boolean
>;

export interface NotificationPreferencesDto {
  studentId: string;
  morning: NotificationToggles;
  afternoon: NotificationToggles;
  updatedAt: string | null;
}

/** notification_preferences column → camelCase toggle. */
export const NOTIFICATION_TOGGLE_OF: Readonly<Record<ParentTripEvent, keyof NotificationToggles>> = Object.freeze({
  trip_started: 'tripStarted',
  bus_left_school: 'busLeftSchool',
  approaching_stop: 'approachingStop',
  arrived_at_stop: 'arrivedAtStop',
  trip_delayed: 'tripDelayed',
  trip_not_started: 'tripNotStarted',
  trip_interrupted: 'tripInterrupted',
  trip_cancelled: 'tripCancelled',
});
export const PARENT_NOTIFICATION_EVENTS = PARENT_TRIP_EVENTS;

export interface ParentDeviceDto {
  id: string;
  deviceId: string;
  platform: string;
  model: string | null;
  osVersion: string | null;
  appVersion: string | null;
  hasFcmToken: boolean;
  lastSeenAt: string | null;
}

export type ParentNotificationKind = ParentTripEvent | 'announcement' | 'system';

export interface ParentNotificationDto {
  id: string;
  schoolId: string;
  studentId: string | null;
  tripId: string | null;
  kind: ParentNotificationKind;
  title: string;
  body: string;
  /** Deep-link payload (e.g. { screen: 'track', studentId }). */
  data: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

// ── Socket room child:{studentId}:live ───────────────────────────────────────
export const PARENT_SOCKET_EVENTS = Object.freeze({
  /** Server → client in child:{studentId}:live: ChildLiveEvent. */
  CHILD_LIVE: 'child:live',
} as const);

export interface ChildLiveEvent {
  studentId: string;
  schoolId: string;
  tripId: string;
  busId: string;
  direction: Direction | null;
  /** position = new fix; status = stop/ETA/motion/location change; trip = trip status change. */
  kind: 'position' | 'status' | 'trip';
  change: string | null;
  tripStatus: TripStatus;
  status: ParentTripStatus;
  position: ParentTrackingPosition | null;
  motion: MotionState | null;
  freshness: Freshness;
  eta: ParentTrackingSnapshot['eta'];
  at: string;
}

