// Trips module schemas and DTOs (BP §8.4 driver API, §10 trip lifecycle + odometer validation,
// §13.3 Trips & Audit). Request schemas are shared by the backend validators, the web admin and the
// API docs; the DTO interfaces describe the responses.
import { z } from 'zod';
import { DEVICE_EVENT_TYPES, DEVICE_PLATFORMS, DIRECTIONS, LOCATION_PERMISSION_STATES, TRIP_STATUSES, TRIP_TYPES } from '../enums.js';
import type { AlertSeverity, AlertStatus, AlertType, CaptureSource, DeviceEventType, Direction, LocationPermissionState, PolylineSource, TripStatus, TripType } from '../enums.js';
import { exportFormat, isoDate, isoDateTime, latitude, listQueryShape, longitude, periodShape, queryBool, queryEnumList, semver, text, uuid, withPeriod } from './common.js';
import type { StopDto } from './routes.js';
import type { AnnouncementDto } from './school.js';

const emptyToUndefined = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? undefined : v);

/** Largest odometer value accepted (km, one decimal — trips.start_odometer numeric(10,1)). */
export const MAX_ODOMETER_KM = 9_999_999.9;
/** Hard floor of the location interval (BP §9.1): the app never sends faster than this. */
export const MIN_LOCATION_INTERVAL_S = 10;
/** Late location points are accepted this long after a trip ended (BP §10.3 rule 6). */
export const LATE_POINTS_WINDOW_HOURS = 24;

/** Odometer reading in km, rounded to one decimal. */
export const odometerReading = () =>
  z
    .number({ invalid_type_error: 'Must be a number', required_error: 'Required' })
    .finite()
    .min(0, 'Must not be negative')
    .max(MAX_ODOMETER_KM, `Must be at most ${MAX_ODOMETER_KM}`)
    .transform((n) => Math.round(n * 10) / 10);

const coordinates = {
  latitude: latitude(),
  longitude: longitude(),
  accuracyM: z.number().finite().min(0).max(100000).optional(),
};

// ── driver requests ──────────────────────────────────────────────────────────
export const startTripBody = z
  .object({
    /** Client-generated id of this start attempt (retries replay the same trip). */
    clientStartId: uuid(),
    /** Scheduled trip to start (school trip). Omit for a non-school trip. */
    tripId: z.preprocess(emptyToUndefined, uuid().optional()),
    tripType: z.enum(TRIP_TYPES).optional(),
    busId: uuid(),
    /** Mandatory for non-school trips. */
    purpose: z.preprocess(emptyToUndefined, z.string().trim().min(3, 'Must be at least 3 characters').max(300).optional()),
    odometerReading: odometerReading(),
    /** File id of the odometer photo (POST /files/upload-url, category 'odometer', entity bus or trip). */
    odometerFileId: uuid(),
    ...coordinates,
    deviceTime: isoDateTime(),
  })
  .superRefine((b, ctx) => {
    const type = b.tripType ?? (b.tripId ? 'school' : 'non_school');
    if (type === 'school' && !b.tripId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tripId'], message: 'Required for a school trip' });
    if (type === 'non_school' && b.tripId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tripId'], message: 'A non-school trip has no scheduled trip' });
    if (type === 'non_school' && !b.purpose) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['purpose'], message: 'Required for a non-school trip' });
  })
  .transform((b) => ({ ...b, tripType: b.tripType ?? (b.tripId ? ('school' as const) : ('non_school' as const)) }));
export type StartTripBody = z.infer<typeof startTripBody>;

export const endTripBody = z.object({
  odometerReading: odometerReading(),
  odometerFileId: uuid(),
  ...coordinates,
  deviceTime: isoDateTime(),
  /** Points still waiting in the app's offline queue (informational; they may be sent for 24 h). */
  pendingPoints: z.number().int().min(0).max(1_000_000).optional(),
});
export type EndTripBody = z.infer<typeof endTripBody>;

export const tripDeviceEvent = z.object({
  type: z.enum(DEVICE_EVENT_TYPES),
  occurredAt: isoDateTime(),
  latitude: latitude().optional(),
  longitude: longitude().optional(),
  batteryPct: z.number().int().min(0).max(100).optional(),
  networkType: z.string().trim().max(16).optional(),
  message: z.string().trim().max(500).optional(),
  /** Peak acceleration of a `harsh_*` event in g (phone motion sensors). */
  gForce: z.number().min(0).max(8).optional(),
  /** Speed at the event (km/h). */
  speedKmh: z.number().min(0).max(250).optional(),
  /** location_permission_* events: the permission level the phone reports now. */
  permission: z.enum(LOCATION_PERMISSION_STATES).optional(),
  /** clock_drift events: the app's measured server − device offset (ms). */
  clockOffsetMs: z.number().int().min(-10 * 365 * 86_400_000).max(10 * 365 * 86_400_000).optional(),
});
export type TripDeviceEvent = z.infer<typeof tripDeviceEvent>;

/**
 * Device warnings, batched (the app queues them while offline). `sentAt`: when the batch was sent, on
 * the same clock as `occurredAt` (stamped right before each attempt) — the server corrects
 * `occurredAt` by the measured offset beyond CLOCK_DRIFT_TOLERANCE_MS (BP §14.3).
 */
export const tripEventsBody = z.object({ events: z.array(tripDeviceEvent).min(1).max(50), sentAt: isoDateTime().optional() });
export type TripEventsBody = z.infer<typeof tripEventsBody>;

export const interruptTripBody = z.object({
  reason: text(500, 3),
  latitude: latitude().optional(),
  longitude: longitude().optional(),
});
export type InterruptTripBody = z.infer<typeof interruptTripBody>;

/** POST /driver/devices — refreshes the bound device (FCM token, app/OS versions). */
export const driverDeviceBody = z
  .object({
    fcmToken: z.preprocess(emptyToUndefined, z.string().trim().max(4096).nullable().optional()),
    platform: z.enum(DEVICE_PLATFORMS).optional(),
    model: z.string().trim().max(120).optional(),
    osVersion: z.string().trim().max(60).optional(),
    appVersion: semver().optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'Send at least one field' });
export type DriverDeviceBody = z.infer<typeof driverDeviceBody>;

export const driverTripHistoryQuery = z.object({
  page: listQueryShape.page,
  limit: listQueryShape.limit,
  from: z.preprocess(emptyToUndefined, isoDate().optional()),
  to: z.preprocess(emptyToUndefined, isoDate().optional()),
  status: queryEnumList([...TRIP_STATUSES]),
});
export type DriverTripHistoryQuery = z.infer<typeof driverTripHistoryQuery>;

// ── admin requests ───────────────────────────────────────────────────────────
/** GET /school/trips — `period=<from>..<to>` (the dashboard quick link) or `from` / `to`. */
export const tripListQuery = withPeriod(z.object({
  ...listQueryShape,
  ...periodShape,
  /** csv = every matching row (UTC timestamps); pdf = printable list (school-local times, landscape). */
  format: exportFormat,
  from: z.preprocess(emptyToUndefined, isoDate().optional()),
  to: z.preprocess(emptyToUndefined, isoDate().optional()),
  busId: z.preprocess(emptyToUndefined, uuid().optional()),
  routeId: z.preprocess(emptyToUndefined, uuid().optional()),
  /** staff_profiles id of the driver / conductor. */
  driverId: z.preprocess(emptyToUndefined, uuid().optional()),
  conductorId: z.preprocess(emptyToUndefined, uuid().optional()),
  type: queryEnumList([...TRIP_TYPES]),
  status: queryEnumList([...TRIP_STATUSES]),
  direction: queryEnumList([...DIRECTIONS]),
  /** Only trips with (true) / without (false) alerts. */
  flagged: queryBool(),
}));
export type TripListQuery = z.infer<typeof tripListQuery>;

export const cancelTripBody = z.object({ reason: text(500, 3) });
export type CancelTripBody = z.infer<typeof cancelTripBody>;

export const correctOdometerBody = z.object({
  kind: z.enum(['start', 'end']),
  reading: odometerReading(),
  reason: text(500, 3),
});
export type CorrectOdometerBody = z.infer<typeof correctOdometerBody>;

export const reassignTripBody = z
  .object({
    /** New driver (staff id); null removes the driver of a not-yet-started trip. */
    driverId: uuid().nullable().optional(),
    conductorId: uuid().nullable().optional(),
    reason: text(500, 3),
  })
  .refine((b) => b.driverId !== undefined || b.conductorId !== undefined, { message: 'Send driverId and/or conductorId', path: ['driverId'] });
export type ReassignTripBody = z.infer<typeof reassignTripBody>;

// ── DTOs (API responses) ─────────────────────────────────────────────────────
/** Tracking/odometer configuration the driver app applies to a trip (BP §8.4, §9.1, §10.2 rule 6). */
export interface TripConfig {
  movingIntervalS: number;
  stoppedIntervalS: number;
  movingSpeedKmh: number;
  stoppedAfterS: number;
  /** Hard floor of the location interval (10 s). */
  minIntervalS: number;
  /** Late (offline) points are accepted this many hours after the trip ended. */
  latePointsWindowHours: number;
  odometerGalleryAllowed: boolean;
  allowNonSchoolTrips: boolean;
  allowBackupDriverStart: boolean;
  odometerMismatchThresholdKm: number;
  odometerGpsVariancePct: number;
  odometerGpsMinKm: number;
  tripNotStartedGraceMin: number;
  staleTripCloseHours: number;
  /** The school wants harsh braking / acceleration / cornering reported (`harsh_*` device events → `harsh_driving` alerts). */
  harshDrivingEnabled: boolean;
}

/** An alert linked to a trip (trip flags). */
export interface TripFlag {
  id: string;
  type: AlertType;
  severity: AlertSeverity;
  status: AlertStatus;
  title: string;
  createdAt: string;
}

/** Trip as the driver app sees it (home cards, active trip, history). */
export interface DriverTrip {
  id: string;
  tripType: TripType;
  direction: Direction | null;
  tripDate: string;
  status: TripStatus;
  busId: string;
  busCode: string | null;
  busRegistrationNo: string | null;
  routeId: string | null;
  routeCode: string | null;
  routeName: string | null;
  driverStaffId: string | null;
  driverName: string | null;
  conductorStaffId: string | null;
  conductorName: string | null;
  purpose: string | null;
  plannedStartAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  startOdometer: number | null;
  endOdometer: number | null;
  distanceOdometerKm: number | null;
  distanceGpsKm: number | null;
  interruptedAt: string | null;
  cancelReason: string | null;
  closeReason: string | null;
  /** The trip is bound to the phone making this request (only it may send points or end it). */
  onThisDevice: boolean;
}

/** Scheduled trip card on the driver home screen, with the start eligibility of the caller. */
export interface DriverHomeTrip extends DriverTrip {
  /** Assignment role of the caller on this bus now (null: not assigned). */
  myRole: 'primary_driver' | 'backup_driver' | 'conductor' | 'backup_conductor' | null;
  canStart: boolean;
  /** Why the caller cannot start it (NOT_ASSIGNED, BACKUP_START_NOT_ALLOWED, BUS_BUSY, ALREADY_ON_TRIP, BUS_UNAVAILABLE, NOT_SCHEDULED). */
  blockedReason: string | null;
}

export interface DriverBusAssignment {
  busId: string;
  busCode: string;
  busName: string | null;
  registrationNo: string;
  busStatus: string;
  lastKnownOdometer: number | null;
  role: 'primary_driver' | 'backup_driver' | 'conductor' | 'backup_conductor';
  validFrom: string;
  validTo: string | null;
  /** Routes the bus serves now. */
  routes: { routeId: string; code: string; name: string | null; direction: Direction }[];
}

export interface DriverMe {
  user: { id: string; role: 'driver' | 'conductor'; fullName: string; phone: string | null; username: string | null };
  staff: {
    id: string;
    staffType: 'driver' | 'conductor';
    fullName: string;
    phone: string | null;
    photoUrl: string | null;
    licenceNo: string | null;
    licenceExpiryDate: string | null;
    experienceYears: number | null;
  } | null;
  school: { id: string; code: string; name: string; timezone: string; logoUrl: string | null };
  assignments: DriverBusAssignment[];
}

export interface DriverHome {
  /** School-local date of "today". */
  date: string;
  serverTime: string;
  morning: DriverHomeTrip[];
  afternoon: DriverHomeTrip[];
  /** Non-school trips of today the caller took part in. */
  other: DriverTrip[];
  activeTrip: DriverTrip | null;
  announcements: AnnouncementDto[];
  config: TripConfig;
  buses: DriverBusAssignment[];
}

export interface TripStartResult {
  /** Server clock at the response (ISO) — the driver app measures its clock offset from it (BP §14.3). */
  serverTime: string;
  trip: DriverTrip;
  config: TripConfig;
  /** Odometer flags raised by this start (odometer_gap / odometer_decrease). */
  alerts: { type: AlertType; severity: AlertSeverity; title: string }[];
  /** True when the clientStartId was already used: the original start is returned. */
  replayed: boolean;
}

/** GET /driver/trips/active — resume after an app restart. */
export interface DriverActiveTripResult {
  serverTime: string;
  trip: DriverTrip | null;
  config: TripConfig;
}

export interface TripEndResult {
  serverTime: string;
  trip: DriverTrip;
  alerts: { type: AlertType; severity: AlertSeverity; title: string }[];
  /** Late points of this trip are accepted until this instant. */
  acceptPointsUntil: string;
  replayed: boolean;
}

export interface TripEventsResult {
  serverTime: string;
  accepted: number;
  /** server − device offset (ms) applied to occurredAt (beyond the drift tolerance), else null. */
  clockOffsetMs: number | null;
  alerts: { type: AlertType; severity: AlertSeverity; title: string }[];
}

/** Admin list row (GET /school/trips). */
export interface TripListItem {
  id: string;
  tripDate: string;
  tripType: TripType;
  direction: Direction | null;
  status: TripStatus;
  busId: string;
  busCode: string | null;
  busRegistrationNo: string | null;
  routeId: string | null;
  routeCode: string | null;
  routeName: string | null;
  driverStaffId: string | null;
  driverName: string | null;
  conductorStaffId: string | null;
  conductorName: string | null;
  purpose: string | null;
  plannedStartAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  startOdometer: number | null;
  endOdometer: number | null;
  distanceOdometerKm: number | null;
  distanceGpsKm: number | null;
  odometerCorrected: boolean;
  interrupted: boolean;
  alertCount: number;
  openAlertCount: number;
  alertTypes: AlertType[];
}

export interface OdometerEvidenceDto {
  id: string;
  kind: 'start' | 'end' | 'place';
  reading: number | null;
  fileId: string;
  /** Presigned URLs (≤ 300 s); null when the object is unavailable. */
  photoUrl: string | null;
  thumbnailUrl: string | null;
  capturedAt: string;
  receivedAt: string;
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
  sha256: string | null;
  source: CaptureSource;
  deviceId: string | null;
  recordedBy: string | null;
  recordedByName: string | null;
}

export interface OdometerCorrectionEntry {
  kind: 'start' | 'end';
  from: number | null;
  to: number;
  reason: string;
  by: string | null;
  byName: string | null;
  at: string;
}

export interface OdometerCorrection {
  /** Readings as the driver entered them (never changed). */
  original: { start: number | null; end: number | null };
  history: OdometerCorrectionEntry[];
}

export interface TripDetailStopEvent {
  stopId: string;
  stopName: string;
  sequence: number;
  expectedTime: string | null;
  arrivedAt: string | null;
  departedAt: string | null;
  dwellS: number | null;
  distanceM: number | null;
  source: 'live' | 'finalizer' | 'manual';
}

/**
 * One entry of the trip timeline (GET /school/trips/:id `timeline`, oldest first): the lifecycle
 * (started, interrupted, ended / auto-closed / cancelled) and every device event the driver app
 * reported (GPS off, location permission denied / restored, low battery, clock drift, …). Stop
 * arrivals stay in `stopEvents`. Device event times are on the server clock (corrected when the
 * phone clock was off; `deviceOccurredAt` keeps the phone's value).
 */
export interface TripTimelineEntry {
  at: string;
  kind: 'trip_started' | 'trip_interrupted' | 'trip_ended' | 'trip_auto_closed' | 'trip_cancelled' | 'device_event';
  /** Device event type (kind = device_event), else null. */
  event: DeviceEventType | null;
  severity: AlertSeverity;
  title: string;
  /** Reason of an interruption / cancellation / auto-close, the event's message, else null. */
  note: string | null;
  /** Device events only. */
  deviceOccurredAt: string | null;
  receivedAt: string | null;
  clockOffsetMs: number | null;
  latitude: number | null;
  longitude: number | null;
  batteryPct: number | null;
  permission: LocationPermissionState | null;
  /** Alert raised by the event (open it from the timeline), else null. */
  alertId: string | null;
}

export interface TripDetail extends TripListItem {
  scheduleId: string | null;
  startDeviceTime: string | null;
  endDeviceTime: string | null;
  start: { latitude: number | null; longitude: number | null };
  end: { latitude: number | null; longitude: number | null };
  deviceId: string | null;
  startedBy: { id: string; name: string | null } | null;
  endedBy: { id: string; name: string | null } | null;
  cancelledBy: { id: string; name: string | null } | null;
  cancelReason: string | null;
  closeReason: string | null;
  interruptedAt: string | null;
  lastPointAt: string | null;
  pointsCount: number;
  odometerCorrection: OdometerCorrection | null;
  evidence: OdometerEvidenceDto[];
  flags: TripFlag[];
  stopEvents: TripDetailStopEvent[];
  /** Lifecycle + device events, oldest first. */
  timeline: TripTimelineEntry[];
  route: {
    id: string;
    code: string;
    name: string | null;
    direction: Direction;
    polyline: string | null;
    polylineSource: PolylineSource | null;
    stops: StopDto[];
  } | null;
  summary: Record<string, unknown> | null;
  finalizedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

