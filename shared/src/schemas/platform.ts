// Super Admin (platform) schemas shared by the backend validators and the web Platform panel
// (BP §2.2, §8.2, §13.2, §20; contract §9). The backend additionally normalises phone numbers to
// E.164 (libphonenumber) on top of these shapes.
import { z } from 'zod';
import { INSTITUTION_TYPES, SCHOOL_STATUSES, TENANT_MODES } from '../enums.js';
import { email, isoDate, latitude, longitude, listQueryShape, optionalText, queryBool, queryEnumList, semver, text, timeZone, uuid } from './common.js';
import { consentVersion, httpsUrl } from './privacy.js';

const emptyToUndefined = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? undefined : v);

// ── schools ───────────────────────────────────────────────────────────────────────────────────
/** School login code, e.g. GWIS-BLR (upper-cased; letters, digits and dashes, 2–32 characters). */
const schoolCode = () =>
  z
    .string()
    .trim()
    .transform((s) => s.toUpperCase())
    .pipe(z.string().regex(/^[A-Z0-9][A-Z0-9-]{1,31}$/, 'Use 2–32 letters, digits or dashes (starting with a letter or digit)'));

/** Loose phone shape for forms; the API normalises it to E.164. */
const phoneInput = () =>
  z
    .string()
    .trim()
    .regex(/^\+?[0-9 ()-]{6,20}$/, 'Must be a valid phone number');

const brandColor = () =>
  z
    .string()
    .trim()
    .regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a colour like #1B7F3B');

const geoPoint = () => z.object({ lat: latitude(), lng: longitude() });

/** Reference of a registered dedicated database (BP §4.7) — a name, never a connection string. */
const dbConnectionRef = () =>
  z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, 'Use 1–64 letters, digits, dashes or underscores');

export const PASSWORD_DELIVERIES = ['show', 'email'] as const;
export type PasswordDelivery = (typeof PASSWORD_DELIVERIES)[number];

const contactShape = z.object({
  name: optionalText(200),
  phone: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), phoneInput().nullable().optional()),
  email: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), email().nullable().optional()),
});

const schoolProfileShape = {
  name: text(200),
  institutionType: z.enum(INSTITUTION_TYPES).optional(),
  address: optionalText(500),
  city: optionalText(100),
  state: optionalText(100),
  pincode: optionalText(12),
  contact: contactShape.optional(),
  brandColor: brandColor().nullable().optional(),
  location: geoPoint().nullable().optional(),
  geofenceRadiusM: z.number().int().min(20).max(5000).optional(),
  timezone: timeZone().optional(),
};

/** Initial school admin (BP App. A): temporary password shown once, or e-mailed as an invitation. */
const initialAdminShape = z.object({
  name: text(200),
  email: email(),
  phone: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), phoneInput().nullable().optional()),
  /** Omit to generate a temporary password. The admin must change it at first sign-in. */
  password: z.string().min(8).max(128).optional(),
  /** 'show' returns a generated password in the response; 'email' sends it with the welcome e-mail. */
  delivery: z.enum(PASSWORD_DELIVERIES).default('show'),
});

// ── subscriptions (BP §20 #1) ─────────────────────────────────────────────────────────────────
export const SUBSCRIPTION_STATUSES = ['active', 'expired', 'cancelled'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** Modules a plan can switch off for a school (missing key = allowed by the plan). */
export const SUBSCRIPTION_MODULES = ['push', 'sms', 'whatsapp', 'email', 'email_digest', 'reports', 'announcements', 'eta_v2', 'route_deviation', 'speeding', 'harsh_driving'] as const;
export type SubscriptionModule = (typeof SUBSCRIPTION_MODULES)[number];

const moduleFlags = z
  .object(Object.fromEntries(SUBSCRIPTION_MODULES.map((m) => [m, z.boolean().optional()])) as Record<SubscriptionModule, z.ZodOptional<z.ZodBoolean>>)
  .strict();

export const subscriptionBody = z
  .object({
    plan: text(60),
    status: z.enum(SUBSCRIPTION_STATUSES).default('active'),
    maxBuses: z.number().int().min(0).max(100000).nullable().default(null),
    maxStudents: z.number().int().min(0).max(1000000).nullable().default(null),
    validFrom: isoDate().optional(),
    validUntil: isoDate().nullable().default(null),
    modules: moduleFlags.default({}),
    notes: optionalText(1000),
  })
  .refine((s) => !s.validFrom || !s.validUntil || s.validUntil >= s.validFrom, { path: ['validUntil'], message: 'Must be on or after validFrom' });
export type SubscriptionBody = z.infer<typeof subscriptionBody>;

/** Plan defaults applied when a school is created without an explicit subscription. */
export const DEFAULT_SUBSCRIPTION = Object.freeze({ plan: 'standard', maxBuses: 25, maxStudents: 1500, validUntil: null as string | null, modules: {} as Partial<Record<SubscriptionModule, boolean>> });

export const createSchoolBody = z.object({
  ...schoolProfileShape,
  code: schoolCode(),
  tenantMode: z.enum(TENANT_MODES).optional(),
  dbConnectionRef: dbConnectionRef().nullable().optional(),
  admin: initialAdminShape,
  subscription: subscriptionBody.optional(),
});
export type CreateSchoolBody = z.infer<typeof createSchoolBody>;

/** PATCH /platform/schools/:id — any subset of the profile and platform-controlled fields. */
export const updateSchoolBody = z
  .object({
    ...schoolProfileShape,
    name: text(200).optional(),
    code: schoolCode().optional(),
    tenantMode: z.enum(TENANT_MODES).optional(),
    dbConnectionRef: dbConnectionRef().nullable().optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'Nothing to update' });
export type UpdateSchoolBody = z.infer<typeof updateSchoolBody>;

export const schoolListQuery = z.object({
  ...listQueryShape,
  format: z.preprocess(emptyToUndefined, z.enum(['json', 'csv']).optional()),
  status: queryEnumList([...SCHOOL_STATUSES]),
  institutionType: queryEnumList([...INSTITUTION_TYPES]),
  includeDeleted: queryBool(),
});
export type SchoolListQuery = z.infer<typeof schoolListQuery>;

export const DEACTIVATION_STATUSES = ['inactive', 'suspended'] as const;
export const deactivateSchoolBody = z.object({
  status: z.enum(DEACTIVATION_STATUSES).default('inactive'),
  reason: optionalText(500),
});
export type DeactivateSchoolBody = z.infer<typeof deactivateSchoolBody>;

export const activateSchoolBody = z.object({ reason: optionalText(500) });

export const resetAdminPasswordBody = z.object({
  /** Which admin (default: the school's first admin). */
  userId: uuid().optional(),
  password: z.string().min(8).max(128).optional(),
  delivery: z.enum(PASSWORD_DELIVERIES).default('show'),
});
export type ResetAdminPasswordBody = z.infer<typeof resetAdminPasswordBody>;

export const usageListQuery = z.object({
  ...listQueryShape,
  format: z.preprocess(emptyToUndefined, z.enum(['json', 'csv']).optional()),
  status: queryEnumList([...SCHOOL_STATUSES]),
});
export type UsageListQuery = z.infer<typeof usageListQuery>;

// ── global settings (BP §13.2 "Global settings"; contract §9 version gating) ────────────────────
const int = (min: number, max: number) => z.number({ invalid_type_error: 'Must be a number' }).int('Must be a whole number').min(min).max(max);
const bool = () => z.boolean({ invalid_type_error: 'Must be true or false' }).optional();

/** Validation of every writable platform setting (keys of platform_settings). */
export const PLATFORM_SETTING_SCHEMAS = {
  'location.moving_interval_s': int(10, 300),
  // BP §9.1: "Stopped interval 60–120 s, value from config (default 90 s)".
  'location.stopped_interval_s': int(60, 120),
  'location.moving_speed_kmh': z.number({ invalid_type_error: 'Must be a number' }).min(0.5).max(30),
  'location.stopped_after_s': int(15, 600),
  'location.stale_after_s': int(15, 900),
  'location.retention_months': int(1, 60),
  'docs.expiry_reminder_days': z
    .array(int(1, 365))
    .min(1)
    .max(10)
    .refine((a) => new Set(a).size === a.length, 'Days must be unique')
    .transform((a) => [...a].sort((x, y) => y - x)),
  'trips.stale_close_hours': int(1, 48),
  'trips.late_points_hours': int(1, 168),
  min_supported_version: z.object({ driver_app: semver().optional(), parent_app: semver().optional(), web_admin: semver().optional() }).strict(),
  modules: z.object({ push: bool(), sms: bool(), whatsapp: bool(), email: bool() }).strict(),
  features: z
    .object({ eta_v2: bool(), route_deviation: bool(), speeding: bool(), harsh_driving: bool(), reports: bool(), announcements: bool() })
    .strict(),
  // BP §16 privacy: links shown in the apps / web (schools may override) and the parent consent version.
  'legal.privacy_url': httpsUrl().nullable(),
  'legal.terms_url': httpsUrl().nullable(),
  'legal.consent_version': consentVersion(),
} as const;
export type PlatformSettingKey = keyof typeof PLATFORM_SETTING_SCHEMAS;
export const PLATFORM_SETTING_KEY_LIST = Object.keys(PLATFORM_SETTING_SCHEMAS) as PlatformSettingKey[];
/** Object-valued settings: a PUT merges the given fields into the stored object. */
export const MERGED_PLATFORM_SETTINGS: readonly PlatformSettingKey[] = ['min_supported_version', 'modules', 'features'];

/** PUT /platform/settings — any subset of the known keys (unknown keys are rejected). */
export const platformSettingsBody = z
  .object(
    Object.fromEntries(PLATFORM_SETTING_KEY_LIST.map((k) => [k, PLATFORM_SETTING_SCHEMAS[k].optional()])) as {
      [K in PlatformSettingKey]: z.ZodOptional<(typeof PLATFORM_SETTING_SCHEMAS)[K]>;
    },
  )
  .strict()
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'Nothing to update' });
export type PlatformSettingsBody = z.infer<typeof platformSettingsBody>;
