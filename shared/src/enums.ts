// Shared enumerations (BP §2, §6, §9–§12; contract §4–§9). Every enum is a readonly tuple so it
// can feed both TypeScript unions and `z.enum(...)`. Database CHECK constraints use the same
// literal values (text + CHECK, BP §6 conventions).

/** Builds a readonly tuple and its union type from string literals. */
function tuple<const T extends readonly string[]>(...values: T): T {
  return values;
}

// ── identities & roles ────────────────────────────────────────────────────────
export const ROLES = tuple('super_admin', 'school_admin', 'driver', 'conductor', 'parent');
export type Role = (typeof ROLES)[number];

/** Roles of rows in `users` (school-scoped logins). */
export const SCHOOL_USER_ROLES = tuple('school_admin', 'driver', 'conductor');
export type SchoolUserRole = (typeof SCHOOL_USER_ROLES)[number];

/** Session/actor owner types (sessions.owner_type, devices.owner_type). */
export const OWNER_TYPES = tuple('platform_user', 'user', 'parent_account');
export type OwnerType = (typeof OWNER_TYPES)[number];

/** Value of app.actor_role for non-human work (jobs, bootstrap lookups). */
export const SYSTEM_ACTOR_ROLE = 'system';
export const ACTOR_ROLES = tuple(...ROLES, SYSTEM_ACTOR_ROLE);
export type ActorRole = (typeof ACTOR_ROLES)[number];

export const STAFF_TYPES = tuple('driver', 'conductor');
export type StaffType = (typeof STAFF_TYPES)[number];

export const ASSIGNMENT_ROLES = tuple('primary_driver', 'backup_driver', 'conductor', 'backup_conductor');
export type AssignmentRole = (typeof ASSIGNMENT_ROLES)[number];

// ── schools / platform ────────────────────────────────────────────────────────
export const SCHOOL_STATUSES = tuple('active', 'suspended', 'inactive');
export type SchoolStatus = (typeof SCHOOL_STATUSES)[number];

export const INSTITUTION_TYPES = tuple('school', 'college', 'university');
export type InstitutionType = (typeof INSTITUTION_TYPES)[number];

export const TENANT_MODES = tuple('shared', 'dedicated');
export type TenantMode = (typeof TENANT_MODES)[number];

/** Client applications (X-App-Name header, version gating). */
export const APP_NAMES = tuple('driver_app', 'parent_app', 'web_admin');
export type AppName = (typeof APP_NAMES)[number];

export const DEVICE_PLATFORMS = tuple('android', 'ios', 'web');
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

// ── fleet ─────────────────────────────────────────────────────────────────────
export const BUS_STATUSES = tuple('active', 'maintenance', 'retired', 'inactive');
export type BusStatus = (typeof BUS_STATUSES)[number];

export const FUEL_TYPES = tuple('diesel', 'petrol', 'cng', 'electric', 'hybrid', 'other');
export type FuelType = (typeof FUEL_TYPES)[number];

export const BUS_DOCUMENT_TYPES = tuple('insurance', 'fitness', 'pollution', 'permit', 'rc', 'safety_inspection', 'other');
export type BusDocumentType = (typeof BUS_DOCUMENT_TYPES)[number];

export const STAFF_DOCUMENT_TYPES = tuple(
  'identity',
  'licence_front',
  'licence_back',
  'character_certificate',
  'police_verification',
  'training',
  'first_aid',
  'child_safety',
  'other',
);
export type StaffDocumentType = (typeof STAFF_DOCUMENT_TYPES)[number];

export const VERIFICATION_STATUSES = tuple('pending', 'verified', 'rejected');
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

// ── routes / trips ────────────────────────────────────────────────────────────
export const DIRECTIONS = tuple('morning', 'afternoon');
export type Direction = (typeof DIRECTIONS)[number];

export const TRIP_TYPES = tuple('school', 'non_school');
export type TripType = (typeof TRIP_TYPES)[number];

export const TRIP_STATUSES = tuple('scheduled', 'in_progress', 'completed', 'missed', 'cancelled', 'auto_closed');
export type TripStatus = (typeof TRIP_STATUSES)[number];

/**
 * Phase of a child's trip for the parent app (ParentTripStatus.phase): no_trip (none today), scheduled,
 * running, interrupted (the driver reported a breakdown; still in progress), completed (incl.
 * auto-closed), cancelled, missed.
 */
export const PARENT_TRIP_PHASES = tuple('no_trip', 'scheduled', 'running', 'interrupted', 'completed', 'cancelled', 'missed');
export type ParentTripPhase = (typeof PARENT_TRIP_PHASES)[number];

/** Parent-facing status derivation (BP §9.4). */
export const LIVE_STATUSES = tuple(
  'not_started',
  'on_route',
  'bus_stopped',
  'delayed',
  'arrived_at_stop',
  'completed',
  'location_unavailable',
);
export type LiveStatus = (typeof LIVE_STATUSES)[number];

export const ODOMETER_EVIDENCE_KINDS = tuple('start', 'end', 'place');
export type OdometerEvidenceKind = (typeof ODOMETER_EVIDENCE_KINDS)[number];

export const CAPTURE_SOURCES = tuple('camera', 'gallery');
export type CaptureSource = (typeof CAPTURE_SOURCES)[number];

/** Origin of a route's planned polyline (contract §2 Routing). */
export const POLYLINE_SOURCES = tuple('google', 'straight');
export type PolylineSource = (typeof POLYLINE_SOURCES)[number];

/**
 * Device warnings of the driver app (POST /driver/trips/:id/events); the `harsh_*` events come from
 * the phone's motion sensors (BP §9.6, §11.1). `location_permission_denied` / `_restored`: the app lost
 * (or got back) the location permission — a different fault from `gps_disabled` (location services
 * switched off), with its own alert type. `clock_drift`: the app found its clock off from the server
 * time by more than CLOCK_DRIFT_TOLERANCE_MS (BP §14.3).
 */
export const DEVICE_EVENT_TYPES = tuple(
  'gps_disabled',
  'low_battery',
  'no_network',
  'mock_location',
  'trip_interrupted',
  'harsh_braking',
  'harsh_acceleration',
  'harsh_cornering',
  'location_permission_denied',
  'location_permission_restored',
  'clock_drift',
);
export const HARSH_DRIVING_EVENT_TYPES = tuple('harsh_braking', 'harsh_acceleration', 'harsh_cornering');
export const LOCATION_PERMISSION_EVENT_TYPES = tuple('location_permission_denied', 'location_permission_restored');
export type DeviceEventType = (typeof DEVICE_EVENT_TYPES)[number];

/** Location permission level the phone reports with a location_permission_* event (optional). */
export const LOCATION_PERMISSION_STATES = tuple('denied', 'denied_forever', 'while_in_use', 'always');
export type LocationPermissionState = (typeof LOCATION_PERMISSION_STATES)[number];

// ── alerts ────────────────────────────────────────────────────────────────────
export const ALERT_TYPES = tuple(
  'trip_not_started',
  'odometer_gap',
  'odometer_decrease',
  'odometer_gps_mismatch',
  'non_school_trip',
  'doc_expiring',
  'doc_expired',
  'doc_missing',
  'service_due',
  'speeding',
  'harsh_driving',
  'route_deviation',
  'long_stop',
  'gps_disabled',
  'low_battery',
  'no_network',
  'trip_auto_closed',
  'location_permission',
  'clock_drift',
);
export type AlertType = (typeof ALERT_TYPES)[number];

export const ALERT_SEVERITIES = tuple('info', 'warning', 'critical');
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const ALERT_STATUSES = tuple('open', 'reviewed', 'escalated', 'closed');
export type AlertStatus = (typeof ALERT_STATUSES)[number];

// ── notifications ─────────────────────────────────────────────────────────────
/** Parent trip-progress notification events (BP §11.2) — notification_preferences columns. */
export const NOTIFICATION_EVENTS = tuple(
  'trip_started',
  'bus_left_school',
  'approaching_stop',
  'arrived_at_stop',
  'trip_delayed',
  'trip_not_started',
);
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

/**
 * Trip disruption notices to parents (BP §10.4 bus breakdown: the driver marked the trip interrupted;
 * the school cancelled a running or same-day trip). Same pipeline, inbox, dedupe and per-direction
 * preferences (notification_preferences columns) as NOTIFICATION_EVENTS.
 */
export const TRIP_NOTICE_EVENTS = tuple('trip_interrupted', 'trip_cancelled');
export type TripNoticeEvent = (typeof TRIP_NOTICE_EVENTS)[number];

/** Every parent trip notification event: notification_events.event_type, parent_notifications.kind. */
export const PARENT_TRIP_EVENTS = tuple(...NOTIFICATION_EVENTS, ...TRIP_NOTICE_EVENTS);
export type ParentTripEvent = (typeof PARENT_TRIP_EVENTS)[number];

export const NOTIFICATION_CHANNELS = tuple('push', 'sms', 'whatsapp', 'email', 'in_app');
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_STATUSES = tuple('queued', 'sent', 'failed', 'skipped');
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export const ANNOUNCEMENT_AUDIENCES = tuple('drivers', 'parents', 'all');
export type AnnouncementAudience = (typeof ANNOUNCEMENT_AUDIENCES)[number];

// ── files ─────────────────────────────────────────────────────────────────────
/** Object-key categories: schools/{school_id}/{category}/{entity_id}/{uuid}.{ext} (BP §12). */
export const FILE_CATEGORIES = tuple(
  'school_logo',
  'bus_image',
  'bus_document',
  'staff_photo',
  'staff_document',
  'student_photo',
  'odometer',
  'fuel_bill',
  'maintenance_invoice',
  'import',
  'report',
);
export type FileCategory = (typeof FILE_CATEGORIES)[number];

export const FILE_STATUSES = tuple('pending', 'uploaded', 'rejected', 'deleted');
export type FileStatus = (typeof FILE_STATUSES)[number];

// ── realtime ──────────────────────────────────────────────────────────────────
export const SOCKET_NAMESPACE = '/rt';
export const SOCKET_EVENTS = Object.freeze({
  LIVE_POSITION: 'live:position',
  LIVE_STATUS: 'live:status',
  TRIP_STATUS: 'trip:status',
  ALERT_NEW: 'alert:new',
  NOTIFICATION_NEW: 'notification:new',
  JOIN: 'join',
  LEAVE: 'leave',
  /** Client → server: `{ token }` (fresh access token after an HTTP refresh); ack `{ ok, sessionId, tokenExpiresAt }`. */
  AUTH_REFRESH: 'auth:refresh',
  /**
   * Server → client: `{ room, reason }` — the socket was removed from a room it may no longer watch
   * (child unlinked or moved to another bus, crew reassigned, school closed). Membership is re-checked
   * after such changes and periodically; the client stops showing that room's live data.
   */
  ROOM_REVOKED: 'room:revoked',
} as const);
export type SocketEvent = (typeof SOCKET_EVENTS)[keyof typeof SOCKET_EVENTS];

// ── API errors (contract §5) ──────────────────────────────────────────────────
export const ERROR_CODES = tuple(
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'TOKEN_EXPIRED',
  'TOTP_REQUIRED',
  'PASSWORD_CHANGE_REQUIRED',
  'FORBIDDEN',
  'SCHOOL_INACTIVE',
  'DEVICE_NOT_BOUND',
  'APP_UPDATE_REQUIRED',
  'NOT_FOUND',
  'CONFLICT',
  'DUPLICATE',
  'INVALID_STATE',
  'TRIP_ALREADY_ACTIVE',
  'ODOMETER_INVALID',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_FILE',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
);
export type ErrorCode = (typeof ERROR_CODES)[number];

/** HTTP status per error code. */
export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = Object.freeze({
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  TOTP_REQUIRED: 401,
  PASSWORD_CHANGE_REQUIRED: 403,
  FORBIDDEN: 403,
  SCHOOL_INACTIVE: 403,
  DEVICE_NOT_BOUND: 403,
  APP_UPDATE_REQUIRED: 426,
  NOT_FOUND: 404,
  CONFLICT: 409,
  DUPLICATE: 409,
  INVALID_STATE: 409,
  TRIP_ALREADY_ACTIVE: 409,
  ODOMETER_INVALID: 422,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_FILE: 415,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
});

// ── request headers ───────────────────────────────────────────────────────────
export const HEADERS = Object.freeze({
  REQUEST_ID: 'X-Request-Id',
  SCHOOL_ID: 'X-School-Id',
  APP_NAME: 'X-App-Name',
  APP_VERSION: 'X-App-Version',
  DEVICE_ID: 'X-Device-Id',
  CLIENT: 'X-WIMB-Client',
  IDEMPOTENCY_KEY: 'Idempotency-Key',
} as const);

/** httpOnly cookie holding the web refresh token (contract §6). */
export const REFRESH_COOKIE_NAME = 'wimb_rt';
