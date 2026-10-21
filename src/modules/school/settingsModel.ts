// Pure mapping between school_settings rows (snake_case columns and JSON keys) and the API/DTO
// shapes (camelCase), plus platform-default resolution. No I/O — used by the service and by the
// helpers other modules import from ./index.ts.
import {
  DEFAULT_PARENT_VISIBILITY,
  DEFAULT_SCHOOL_FEATURES,
  PARENT_VISIBILITY_FIELDS,
  PARENT_VISIBILITY_SECTIONS,
  SCHOOL_FEATURE_KEYS,
  mergeParentVisibility,
  type AlertRecipient,
  type ParentVisibility,
  type SchoolFeatureKey,
  type SchoolFeatures,
  type SchoolLocationDefaults,
  type SchoolSettingsBody,
  type SchoolSettingsDto,
  type LegalTerms,
} from '@wimb/shared';
import { PLATFORM_SETTING_DEFAULTS, PLATFORM_SETTING_KEYS } from '../../db/platformDefaults.js';
import type { SettingsRow } from './repository.js';

export const toSnake = (s: string): string => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
export const toCamel = (s: string): string => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** API field → school_settings column for every scalar setting (features/recipients are JSON). */
export const SETTING_COLUMNS = Object.freeze({
  allowNonSchoolTrips: 'allow_non_school_trips',
  allowBackupDriverStart: 'allow_backup_driver_start',
  odometerGalleryAllowed: 'odometer_gallery_allowed',
  odometerMismatchThresholdKm: 'odometer_mismatch_threshold_km',
  odometerGpsVariancePct: 'odometer_gps_variance_pct',
  odometerGpsMinKm: 'odometer_gps_min_km',
  tripNotStartedGraceMin: 'trip_not_started_grace_min',
  tripDelayThresholdMin: 'trip_delay_threshold_min',
  staleTripCloseHours: 'stale_trip_close_hours',
  stopDurationAlertMin: 'stop_duration_alert_min',
  speedLimitKmh: 'speed_limit_kmh',
  enableSpeedingAlert: 'enable_speeding_alert',
  enableHarshDrivingAlert: 'enable_harsh_driving_alert',
  enableRouteDeviationAlert: 'enable_route_deviation_alert',
  routeDeviationM: 'route_deviation_m',
  approachingStopMinutes: 'approaching_stop_minutes',
  notifyTripNotStarted: 'notify_trip_not_started',
  locationMovingIntervalS: 'location_moving_interval_s',
  locationStoppedIntervalS: 'location_stopped_interval_s',
  movingSpeedKmh: 'moving_speed_kmh',
  stoppedAfterS: 'stopped_after_s',
  documentReminderDays: 'document_reminder_days',
  locationRetentionMonths: 'location_retention_months',
  privacyPolicyUrl: 'privacy_policy_url',
  termsUrl: 'terms_url',
  consentVersion: 'consent_version',
} satisfies Partial<Record<keyof SchoolSettingsBody, string>>);
export type ScalarSettingField = keyof typeof SETTING_COLUMNS;

/** Platform settings the school falls back to (public rows; others use the built-in defaults). */
export const PLATFORM_KEYS = [
  PLATFORM_SETTING_KEYS.MOVING_INTERVAL_S,
  PLATFORM_SETTING_KEYS.STOPPED_INTERVAL_S,
  PLATFORM_SETTING_KEYS.MOVING_SPEED_KMH,
  PLATFORM_SETTING_KEYS.STOPPED_AFTER_S,
  PLATFORM_SETTING_KEYS.DOC_EXPIRY_REMINDER_DAYS,
  PLATFORM_SETTING_KEYS.STALE_CLOSE_HOURS,
  PLATFORM_SETTING_KEYS.RETENTION_MONTHS,
  PLATFORM_SETTING_KEYS.FEATURES,
  PLATFORM_SETTING_KEYS.MODULES,
  PLATFORM_SETTING_KEYS.PRIVACY_URL,
  PLATFORM_SETTING_KEYS.TERMS_URL,
  PLATFORM_SETTING_KEYS.CONSENT_VERSION,
] as const;

const BUILT_IN = new Map(PLATFORM_SETTING_DEFAULTS.map((d) => [d.key, d.value]));
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function platformValue(platform: Record<string, unknown>, key: string): unknown {
  return key in platform ? platform[key] : BUILT_IN.get(key);
}
function platformNumber(platform: Record<string, unknown>, key: string): number {
  const v = Number(platformValue(platform, key));
  return Number.isFinite(v) ? v : Number(BUILT_IN.get(key));
}
function platformDays(platform: Record<string, unknown>): number[] {
  const v = platformValue(platform, PLATFORM_SETTING_KEYS.DOC_EXPIRY_REMINDER_DAYS);
  return Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
}

/** Platform feature narrowing: features flags + notification modules for the channel features. */
export function platformFeatureFlags(platform: Record<string, unknown>): Partial<SchoolFeatures> {
  const features = platformValue(platform, PLATFORM_SETTING_KEYS.FEATURES);
  const modules = platformValue(platform, PLATFORM_SETTING_KEYS.MODULES);
  const out: Partial<SchoolFeatures> = {};
  if (isRecord(features)) {
    for (const [k, v] of Object.entries(features)) {
      const key = toCamel(k) as SchoolFeatureKey;
      if ((SCHOOL_FEATURE_KEYS as readonly string[]).includes(key) && typeof v === 'boolean') out[key] = v;
    }
  }
  if (isRecord(modules)) {
    if (typeof modules.sms === 'boolean') out.sms = modules.sms && out.sms !== false;
    if (typeof modules.whatsapp === 'boolean') out.whatsapp = modules.whatsapp && out.whatsapp !== false;
    if (typeof modules.email === 'boolean') out.emailDigest = modules.email && out.emailDigest !== false;
  }
  return out;
}

/** Stored school flags (snake JSON) → complete camelCase flags (defaults for missing keys). */
export function readFeatures(raw: unknown): SchoolFeatures {
  const out: SchoolFeatures = { ...DEFAULT_SCHOOL_FEATURES };
  if (isRecord(raw)) {
    for (const key of SCHOOL_FEATURE_KEYS) {
      const v = raw[toSnake(key)];
      if (typeof v === 'boolean') out[key] = v;
    }
  }
  return out;
}

export function featuresToDb(f: SchoolFeatures): Record<string, boolean> {
  return Object.fromEntries(SCHOOL_FEATURE_KEYS.map((k) => [toSnake(k), f[k]]));
}

/**
 * Subscription `modules` (contract §9 "subscription limits … modules") → the features they gate. A module set to
 * `false` in the school's active plan switches the feature off whatever the school or platform says; a missing
 * key allows it. `push` has no school feature (push is the default channel) and is not narrowed here.
 */
export const PLAN_MODULE_FEATURES: Readonly<Record<string, SchoolFeatureKey>> = Object.freeze({
  sms: 'sms',
  whatsapp: 'whatsapp',
  email: 'emailDigest',
  email_digest: 'emailDigest',
  reports: 'reports',
  announcements: 'announcements',
  eta_v2: 'etaV2',
  route_deviation: 'routeDeviation',
  speeding: 'speeding',
  harsh_driving: 'harshDriving',
});

/** Platform flags narrowed further by the school's plan modules. */
export function narrowByPlan(platform: Partial<SchoolFeatures>, planModules: unknown): Partial<SchoolFeatures> {
  if (!isRecord(planModules)) return platform;
  const out: Partial<SchoolFeatures> = { ...platform };
  for (const [module, feature] of Object.entries(PLAN_MODULE_FEATURES)) if (planModules[module] === false) out[feature] = false;
  return out;
}

/** A feature is in force only when the school enables it and the platform does not disable it. */
export function effectiveFeatures(school: SchoolFeatures, platform: Partial<SchoolFeatures>): SchoolFeatures {
  return Object.fromEntries(SCHOOL_FEATURE_KEYS.map((k) => [k, school[k] && platform[k] !== false])) as SchoolFeatures;
}

/** Stored matrix (snake JSON) → complete camelCase matrix (BP defaults for missing keys). */
export function readParentVisibility(raw: unknown): ParentVisibility {
  const camel: Record<string, Record<string, unknown>> = {};
  if (isRecord(raw)) {
    for (const s of PARENT_VISIBILITY_SECTIONS) {
      const section = raw[s];
      if (isRecord(section)) camel[s] = Object.fromEntries(Object.entries(section).map(([k, v]) => [toCamel(k), v]));
    }
  }
  return mergeParentVisibility(DEFAULT_PARENT_VISIBILITY, camel);
}

export function parentVisibilityToDb(m: ParentVisibility): Record<string, Record<string, boolean>> {
  const out: Record<string, Record<string, boolean>> = {};
  for (const s of PARENT_VISIBILITY_SECTIONS) {
    out[s] = Object.fromEntries(PARENT_VISIBILITY_FIELDS[s].map((f) => [toSnake(f), (m[s] as Record<string, boolean>)[f]!]));
  }
  return out;
}

/** Stored recipients (snake JSON) → API recipients. */
export function readRecipients(raw: unknown): AlertRecipient[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).map((r) => ({
    userId: typeof r.user_id === 'string' ? r.user_id : null,
    name: typeof r.name === 'string' ? r.name : null,
    email: typeof r.email === 'string' ? r.email : null,
    phone: typeof r.phone === 'string' ? r.phone : null,
    minSeverity: r.min_severity === 'info' || r.min_severity === 'critical' ? r.min_severity : 'warning',
    alertTypes: Array.isArray(r.alert_types) ? (r.alert_types as AlertRecipient['alertTypes']) : null,
  }));
}

export function recipientsToDb(list: AlertRecipient[]): Record<string, unknown>[] {
  return list.map((r) => ({
    user_id: r.userId ?? null,
    name: r.name ?? null,
    email: r.email ?? null,
    phone: r.phone ?? null,
    min_severity: r.minSeverity,
    alert_types: r.alertTypes ?? null,
  }));
}

export function platformLocationDefaults(platform: Record<string, unknown>): Required<SchoolLocationDefaults> {
  return {
    movingIntervalS: platformNumber(platform, PLATFORM_SETTING_KEYS.MOVING_INTERVAL_S),
    stoppedIntervalS: platformNumber(platform, PLATFORM_SETTING_KEYS.STOPPED_INTERVAL_S),
    movingSpeedKmh: platformNumber(platform, PLATFORM_SETTING_KEYS.MOVING_SPEED_KMH),
    stoppedAfterS: platformNumber(platform, PLATFORM_SETTING_KEYS.STOPPED_AFTER_S),
    documentReminderDays: platformDays(platform),
    staleTripCloseHours: platformNumber(platform, PLATFORM_SETTING_KEYS.STALE_CLOSE_HOURS),
    locationRetentionMonths: platformNumber(platform, PLATFORM_SETTING_KEYS.RETENTION_MONTHS),
  };
}

const stringOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Platform legal links / consent version (BP §16; migration 901). */
export function platformLegal(platform: Record<string, unknown>): LegalTerms {
  return {
    privacyUrl: stringOrNull(platformValue(platform, PLATFORM_SETTING_KEYS.PRIVACY_URL)),
    termsUrl: stringOrNull(platformValue(platform, PLATFORM_SETTING_KEYS.TERMS_URL)),
    consentVersion: stringOrNull(platformValue(platform, PLATFORM_SETTING_KEYS.CONSENT_VERSION)) ?? '1',
  };
}

/** School overrides resolved against the platform values (same rule as SQL school_legal_terms()). */
export function effectiveLegal(row: Pick<SettingsRow, 'platform'> & Record<string, unknown>): LegalTerms {
  const p = platformLegal((row.platform) ?? {});
  return {
    privacyUrl: stringOrNull(row.privacy_policy_url) ?? p.privacyUrl,
    termsUrl: stringOrNull(row.terms_url) ?? p.termsUrl,
    consentVersion: stringOrNull(row.consent_version) ?? p.consentVersion,
  };
}

/** Row → DTO (stored values, effective values and the platform defaults behind them). */
export function settingsDto(row: SettingsRow): SchoolSettingsDto {
  const defaults = platformLocationDefaults(row.platform ?? {});
  const platformFeatures = narrowByPlan(platformFeatureFlags(row.platform ?? {}), row.plan_modules);
  const features = readFeatures(row.features);
  const scalars = Object.fromEntries(Object.entries(SETTING_COLUMNS).map(([field, col]) => [field, row[col] ?? null])) as Pick<SchoolSettingsDto, ScalarSettingField>;
  return {
    ...scalars,
    alertRecipients: readRecipients(row.alert_recipients),
    features,
    effective: {
      movingIntervalS: row.location_moving_interval_s ?? defaults.movingIntervalS,
      stoppedIntervalS: row.location_stopped_interval_s ?? defaults.stoppedIntervalS,
      movingSpeedKmh: row.moving_speed_kmh ?? defaults.movingSpeedKmh,
      stoppedAfterS: row.stopped_after_s ?? defaults.stoppedAfterS,
      documentReminderDays: row.document_reminder_days ?? defaults.documentReminderDays,
      staleTripCloseHours: row.stale_trip_close_hours ?? defaults.staleTripCloseHours,
      // The platform value is the maximum: a school may keep less, never more (the purge job agrees).
      locationRetentionMonths: Math.min(row.location_retention_months ?? defaults.locationRetentionMonths, defaults.locationRetentionMonths),
      features: effectiveFeatures(features, platformFeatures),
    },
    platformDefaults: { ...defaults, features: platformFeatures },
    legal: { effective: effectiveLegal(row), platform: platformLegal(row.platform ?? {}) },
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}
