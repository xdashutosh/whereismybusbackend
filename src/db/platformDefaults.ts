// Global platform defaults (BP §6.2 platform_settings, §13.2; contract §9). Migrations
// 002_platform_and_schools.sql (and 901_privacy.sql for the legal.* keys) insert exactly these rows
// and the platform seed re-inserts any that are missing; tests/schema.migrations.test.ts keeps them in sync.
// Keys are read by modules through platform_settings (public rows are readable by every
// authenticated context; the rest by super admins only).

export interface PlatformSettingDefault {
  readonly key: string;
  readonly value: unknown;
  readonly description: string;
  readonly isPublic: boolean;
}

export const PLATFORM_SETTING_KEYS = Object.freeze({
  MOVING_INTERVAL_S: 'location.moving_interval_s',
  STOPPED_INTERVAL_S: 'location.stopped_interval_s',
  MOVING_SPEED_KMH: 'location.moving_speed_kmh',
  STOPPED_AFTER_S: 'location.stopped_after_s',
  STALE_AFTER_S: 'location.stale_after_s',
  RETENTION_MONTHS: 'location.retention_months',
  DOC_EXPIRY_REMINDER_DAYS: 'docs.expiry_reminder_days',
  STALE_CLOSE_HOURS: 'trips.stale_close_hours',
  LATE_POINTS_HOURS: 'trips.late_points_hours',
  MIN_SUPPORTED_VERSION: 'min_supported_version',
  MODULES: 'modules',
  FEATURES: 'features',
  PRIVACY_URL: 'legal.privacy_url',
  TERMS_URL: 'legal.terms_url',
  CONSENT_VERSION: 'legal.consent_version',
} as const);

export const PLATFORM_SETTING_DEFAULTS: readonly PlatformSettingDefault[] = Object.freeze([
  { key: 'location.moving_interval_s', value: 10, description: 'Seconds between location updates while moving (hard floor 10)', isPublic: true },
  { key: 'location.stopped_interval_s', value: 90, description: 'Seconds between location updates while stopped (60-120)', isPublic: true },
  { key: 'location.moving_speed_kmh', value: 4, description: 'Speed above which the bus counts as moving', isPublic: true },
  { key: 'location.stopped_after_s', value: 60, description: 'Seconds at or below the moving speed before the bus counts as stopped', isPublic: true },
  { key: 'location.stale_after_s', value: 45, description: 'Age after which a live position shows "Location unavailable"', isPublic: true },
  { key: 'location.retention_months', value: 12, description: 'Months of raw location points kept before partitions are dropped', isPublic: true },
  { key: 'docs.expiry_reminder_days', value: [60, 30, 15, 7, 1], description: 'Days before expiry at which document reminders are raised', isPublic: true },
  { key: 'trips.stale_close_hours', value: 3, description: 'Hours without location data before an in-progress trip is auto-closed', isPublic: false },
  { key: 'trips.late_points_hours', value: 24, description: 'Hours after the end of a trip during which backfilled points are accepted', isPublic: true },
  { key: 'min_supported_version', value: { driver_app: '1.0.0', parent_app: '1.0.0' }, description: 'Minimum app version per client application', isPublic: true },
  { key: 'modules', value: { push: true, sms: false, whatsapp: false, email: true }, description: 'Platform-wide notification modules', isPublic: true },
  {
    key: 'features',
    value: { eta_v2: false, route_deviation: true, speeding: true, harsh_driving: false, reports: true, announcements: true },
    description: 'Platform-wide feature flags (schools can only narrow them)',
    isPublic: true,
  },
  // BP §16 privacy (migration 901): links shown by the apps and the web panel, and the consent text version.
  { key: 'legal.privacy_url', value: null, description: 'Privacy policy URL shown in the apps and the web panel (https; schools may override)', isPublic: true },
  { key: 'legal.terms_url', value: null, description: 'Terms of use URL shown in the apps and the web panel (https; schools may override)', isPublic: true },
  { key: 'legal.consent_version', value: '1', description: 'Version of the parent consent text; changing it asks every parent to consent again', isPublic: true },
]);
