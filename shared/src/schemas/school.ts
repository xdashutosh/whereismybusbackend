// School profile/settings/calendar/announcement schemas shared by the backend validators and the
// web Settings screens (BP §8.3 Profile/Settings, §13.3 Settings; contract §9). Phone numbers are
// checked here as E.164 only; the backend normalises any spelling with libphonenumber first.
import { z } from 'zod';
import { ALERT_SEVERITIES, ALERT_TYPES, ANNOUNCEMENT_AUDIENCES } from '../enums.js';
import { email, isoDate, isoDateTime, text, uuid } from './common.js';
import { consentVersion, httpsUrl, type LegalTerms } from './privacy.js';

const E164_RE = /^\+[1-9]\d{6,14}$/;

// ── parent visibility matrix (BP §6.2 default, §13.3 editor with live preview) ───────────────
export const PARENT_VISIBILITY_FIELDS = Object.freeze({
  bus: ['capacity', 'images', 'plate', 'insuranceStatus', 'insuranceFile', 'fitnessStatus', 'fitnessFile'],
  driver: ['photo', 'phone', 'email', 'experience', 'licenceValidity', 'licenceFile', 'training', 'characterCertStatus', 'verification'],
  conductor: ['photo', 'phone', 'email', 'experience', 'verification', 'characterCertStatus', 'training'],
} as const);
export type ParentVisibilitySection = keyof typeof PARENT_VISIBILITY_FIELDS;
export type ParentVisibilityField<S extends ParentVisibilitySection> = (typeof PARENT_VISIBILITY_FIELDS)[S][number];
export type ParentVisibility = { [S in ParentVisibilitySection]: Record<ParentVisibilityField<S>, boolean> };
export const PARENT_VISIBILITY_SECTIONS = Object.keys(PARENT_VISIBILITY_FIELDS) as ParentVisibilitySection[];

/** BP §6.2 default matrix (identical to the school_settings.parent_visibility column default). */
export const DEFAULT_PARENT_VISIBILITY: ParentVisibility = Object.freeze({
  bus: { capacity: false, images: true, plate: true, insuranceStatus: true, insuranceFile: false, fitnessStatus: true, fitnessFile: false },
  driver: {
    photo: true, phone: false, email: false, experience: true, licenceValidity: true, licenceFile: false,
    training: true, characterCertStatus: true, verification: true,
  },
  conductor: { photo: true, phone: false, email: false, experience: true, verification: true, characterCertStatus: true, training: true },
}) as ParentVisibility;

/** A document file may be shown only together with its status/validity (file → companion). */
export const PARENT_VISIBILITY_DEPENDENCIES: { [S in ParentVisibilitySection]: Partial<Record<ParentVisibilityField<S>, ParentVisibilityField<S>>> } = {
  bus: { insuranceFile: 'insuranceStatus', fitnessFile: 'fitnessStatus' },
  driver: { licenceFile: 'licenceValidity' },
  conductor: {},
};

const flag = () => z.boolean({ invalid_type_error: 'Must be true or false' }).optional();

/** PUT /school/settings/parent-visibility: any subset of sections/fields (merged over the current matrix). */
export const parentVisibilityBody = z.object({
  bus: z
    .object({ capacity: flag(), images: flag(), plate: flag(), insuranceStatus: flag(), insuranceFile: flag(), fitnessStatus: flag(), fitnessFile: flag() })
    .optional(),
  driver: z
    .object({
      photo: flag(), phone: flag(), email: flag(), experience: flag(), licenceValidity: flag(), licenceFile: flag(),
      training: flag(), characterCertStatus: flag(), verification: flag(),
    })
    .optional(),
  conductor: z
    .object({ photo: flag(), phone: flag(), email: flag(), experience: flag(), verification: flag(), characterCertStatus: flag(), training: flag() })
    .optional(),
});
export type ParentVisibilityBody = z.infer<typeof parentVisibilityBody>;

/** Complete matrix: `patch` over `base`, every unknown key dropped, every missing key from `base`. */
export function mergeParentVisibility(base: ParentVisibility, patch: unknown): ParentVisibility {
  const p = (patch && typeof patch === 'object' ? patch : {}) as Record<string, Record<string, unknown> | undefined>;
  const out = {} as Record<ParentVisibilitySection, Record<string, boolean>>;
  for (const s of PARENT_VISIBILITY_SECTIONS) {
    out[s] = {};
    for (const f of PARENT_VISIBILITY_FIELDS[s]) {
      const v = p[s]?.[f];
      out[s][f] = typeof v === 'boolean' ? v : (base[s] as Record<string, boolean>)[f]!;
    }
  }
  return out as ParentVisibility;
}

/** Consistency rules of a complete matrix → field issues ({ path: 'bus.insuranceFile', … }). */
export function parentVisibilityIssues(m: ParentVisibility): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  for (const s of PARENT_VISIBILITY_SECTIONS) {
    const deps = PARENT_VISIBILITY_DEPENDENCIES[s] as Record<string, string>;
    const values = m[s] as Record<string, boolean>;
    for (const [file, status] of Object.entries(deps)) {
      if (values[file] && !values[status]) issues.push({ path: `${s}.${file}`, message: `Requires ${s}.${status} to be visible as well` });
    }
  }
  return issues;
}

// ── settings (BP §6.2 school_settings, §10, §11.1, §20 #2) ───────────────────────────────────
export const SCHOOL_FEATURE_KEYS = ['sms', 'whatsapp', 'emailDigest', 'etaV2', 'routeDeviation', 'speeding', 'harshDriving', 'reports', 'announcements'] as const;
export type SchoolFeatureKey = (typeof SCHOOL_FEATURE_KEYS)[number];
export type SchoolFeatures = Record<SchoolFeatureKey, boolean>;

export const DEFAULT_SCHOOL_FEATURES: SchoolFeatures = Object.freeze({
  sms: false, whatsapp: false, emailDigest: false, etaV2: false, routeDeviation: true, speeding: true, harshDriving: false, reports: true, announcements: true,
});

export const MAX_ALERT_RECIPIENTS = 20;

/** One alert recipient: a school admin of this school, or an external e-mail / phone contact. */
export const alertRecipient = z
  .object({
    userId: uuid().nullable().optional(),
    name: z.string().trim().max(120).nullable().optional(),
    email: email().nullable().optional(),
    phone: z.string().trim().regex(E164_RE, 'Must be an E.164 phone number like +919845012345').nullable().optional(),
    /** Lowest severity delivered (default warning). */
    minSeverity: z.enum(ALERT_SEVERITIES).default('warning'),
    /** Alert types delivered; null/omitted = all types. */
    alertTypes: z.array(z.enum(ALERT_TYPES)).min(1).max(ALERT_TYPES.length).nullable().optional(),
  })
  .refine((r) => Boolean(r.userId || r.email || r.phone), { path: ['userId'], message: 'Choose a school admin or give an e-mail address or phone number' });
export type AlertRecipient = z.infer<typeof alertRecipient>;

const int = (min: number, max: number) => z.number({ invalid_type_error: 'Must be a number' }).int('Must be a whole number').min(min).max(max);
const num = (min: number, max: number) => z.number({ invalid_type_error: 'Must be a number' }).finite().min(min).max(max);
const bool = () => z.boolean({ invalid_type_error: 'Must be true or false' });

export const schoolFeaturesBody = z.object({
  sms: bool().optional(), whatsapp: bool().optional(), emailDigest: bool().optional(), etaV2: bool().optional(), routeDeviation: bool().optional(),
  speeding: bool().optional(), harshDriving: bool().optional(), reports: bool().optional(), announcements: bool().optional(),
});

/** Hard upper bound of any location-history retention (platform setting and school override). */
export const MAX_LOCATION_RETENTION_MONTHS = 60;

/** PUT /school/settings: every field optional (omitted fields keep their value); null resets an override. */
export const schoolSettingsBody = z.object({
  // trips and odometer (BP §10)
  allowNonSchoolTrips: bool().optional(),
  allowBackupDriverStart: bool().optional(),
  odometerGalleryAllowed: bool().optional(),
  odometerMismatchThresholdKm: num(0, 500).optional(),
  odometerGpsVariancePct: num(0, 100).optional(),
  odometerGpsMinKm: num(0, 100).optional(),
  tripNotStartedGraceMin: int(0, 240).optional(),
  tripDelayThresholdMin: int(1, 240).optional(),
  staleTripCloseHours: int(1, 48).nullable().optional(),
  // alerts (BP §11.1)
  stopDurationAlertMin: int(1, 240).optional(),
  speedLimitKmh: int(10, 150).nullable().optional(),
  enableSpeedingAlert: bool().optional(),
  enableHarshDrivingAlert: bool().optional(),
  enableRouteDeviationAlert: bool().optional(),
  routeDeviationM: int(50, 5000).optional(),
  approachingStopMinutes: int(1, 60).optional(),
  notifyTripNotStarted: bool().optional(),
  alertRecipients: z.array(alertRecipient).max(MAX_ALERT_RECIPIENTS).optional(),
  // location overrides (null = platform default; hard 10-s floor)
  locationMovingIntervalS: int(10, 300).nullable().optional(),
  locationStoppedIntervalS: int(60, 120).nullable().optional(), // BP §9.1: 60–120 s
  movingSpeedKmh: num(0.5, 30).nullable().optional(),
  stoppedAfterS: int(15, 600).nullable().optional(),
  documentReminderDays: z
    .array(int(1, 365))
    .min(1)
    .max(10)
    .refine((a) => new Set(a).size === a.length, 'Days must be unique')
    .nullable()
    .optional(),
  // privacy (BP §12): months of raw location history kept for this school; null = platform value.
  // Never more than the platform maximum (location.retention_months) — checked by schoolSettingsIssues.
  locationRetentionMonths: int(1, MAX_LOCATION_RETENTION_MONTHS).nullable().optional(),
  // privacy (BP §16): the school's own privacy policy / terms links and consent text version
  // (null = the platform value). Changing consentVersion asks every parent of the school to consent again.
  privacyPolicyUrl: httpsUrl().nullable().optional(),
  termsUrl: httpsUrl().nullable().optional(),
  consentVersion: consentVersion().nullable().optional(),
  features: schoolFeaturesBody.optional(),
});
export type SchoolSettingsBody = z.infer<typeof schoolSettingsBody>;

/** Cross-field rules over the EFFECTIVE values (stored values merged with the update and platform defaults). */
export function schoolSettingsIssues(v: {
  movingIntervalS: number;
  stoppedIntervalS: number;
  enableSpeedingAlert: boolean;
  speedLimitKmh: number | null;
  /** Retention override being set (omit when unchanged) and the platform maximum it may not exceed. */
  locationRetentionMonths?: number | null;
  platformRetentionMonths?: number;
}): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  if (v.locationRetentionMonths != null && v.platformRetentionMonths !== undefined && v.locationRetentionMonths > v.platformRetentionMonths) {
    issues.push({ path: 'locationRetentionMonths', message: `Must not exceed the platform maximum of ${v.platformRetentionMonths} months` });
  }
  if (v.stoppedIntervalS < v.movingIntervalS) {
    issues.push({ path: 'locationStoppedIntervalS', message: 'The stopped interval must not be shorter than the moving interval' });
  }
  if (v.enableSpeedingAlert && v.speedLimitKmh === null) issues.push({ path: 'speedLimitKmh', message: 'Set a speed limit to enable speeding alerts' });
  return issues;
}

// ── holiday calendar (contract §8/§9: suppresses trip generation and "not started" alerts) ───
export const HOLIDAY_APPLIES_TO = ['all', 'morning', 'afternoon'] as const;
export type HolidayAppliesTo = (typeof HOLIDAY_APPLIES_TO)[number];
export const MAX_HOLIDAY_DAYS = 366;

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** Range rules shared by create and (merged) update: end ≥ start, at most MAX_HOLIDAY_DAYS days. */
export function holidayRangeIssues(startDate: string, endDate: string): { path: string; message: string }[] {
  const span = daysBetween(startDate, endDate);
  if (span < 0) return [{ path: 'endDate', message: 'Must be on or after the start date' }];
  if (span + 1 > MAX_HOLIDAY_DAYS) return [{ path: 'endDate', message: `A holiday can span at most ${MAX_HOLIDAY_DAYS} days` }];
  return [];
}

const holidayShape = {
  name: text(200),
  startDate: isoDate(),
  /** Inclusive; defaults to startDate. */
  endDate: isoDate().optional(),
  appliesTo: z.enum(HOLIDAY_APPLIES_TO).default('all'),
};

export const createHolidayBody = z.object(holidayShape).superRefine((v, ctx) => {
  for (const i of holidayRangeIssues(v.startDate, v.endDate ?? v.startDate)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i.path], message: i.message });
});
export type CreateHolidayBody = z.infer<typeof createHolidayBody>;

export const updateHolidayBody = z.object({
  name: text(200).optional(),
  startDate: isoDate().optional(),
  endDate: isoDate().optional(),
  appliesTo: z.enum(HOLIDAY_APPLIES_TO).optional(),
});
export type UpdateHolidayBody = z.infer<typeof updateHolidayBody>;

// ── announcements (school → drivers / parents; BP §20 #6) ───────────────────────────────────
export const ANNOUNCEMENT_STATES = ['scheduled', 'active', 'expired'] as const;
export type AnnouncementState = (typeof ANNOUNCEMENT_STATES)[number];

export const createAnnouncementBody = z
  .object({
    title: text(200),
    body: text(5000),
    audience: z.enum(ANNOUNCEMENT_AUDIENCES).default('all'),
    isPinned: z.boolean().default(false),
    /** Publish time (default now; a future time schedules it). */
    publishedAt: isoDateTime().optional(),
    /** End of the publish window (exclusive); null = no end. */
    expiresAt: isoDateTime().nullable().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.expiresAt && v.publishedAt && Date.parse(v.expiresAt) <= Date.parse(v.publishedAt)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['expiresAt'], message: 'Must be after the publish time' });
    }
  });
export type CreateAnnouncementBody = z.infer<typeof createAnnouncementBody>;

export const updateAnnouncementBody = z.object({
  title: text(200).optional(),
  body: text(5000).optional(),
  audience: z.enum(ANNOUNCEMENT_AUDIENCES).optional(),
  isPinned: z.boolean().optional(),
  publishedAt: isoDateTime().optional(),
  expiresAt: isoDateTime().nullable().optional(),
});
export type UpdateAnnouncementBody = z.infer<typeof updateAnnouncementBody>;

// ── response DTOs (JSON, camelCase) ──────────────────────────────────────────────────────────
export interface SchoolProfileDto {
  id: string;
  code: string;
  name: string;
  institutionType: 'school' | 'college' | 'university';
  address: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  logoFileId: string | null;
  logoUrl: string | null;
  brandColor: string | null;
  location: { lat: number; lng: number } | null;
  geofenceRadiusM: number;
  timezone: string;
  status: 'active' | 'suspended' | 'inactive';
  subscription: { plan: string; status: string; maxBuses: number | null; maxStudents: number | null; validFrom: string; validUntil: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

export interface SchoolLocationDefaults {
  movingIntervalS: number;
  stoppedIntervalS: number;
  movingSpeedKmh: number;
  stoppedAfterS: number;
  documentReminderDays: number[];
  staleTripCloseHours: number;
  /**
   * Months of raw location history kept (platform: the maximum; effective: min(school override,
   * platform)). Always present in API responses; optional only so older clients' literals compile.
   */
  locationRetentionMonths?: number;
}

export interface SchoolSettingsDto {
  allowNonSchoolTrips: boolean;
  allowBackupDriverStart: boolean;
  odometerGalleryAllowed: boolean;
  odometerMismatchThresholdKm: number;
  odometerGpsVariancePct: number;
  odometerGpsMinKm: number;
  tripNotStartedGraceMin: number;
  tripDelayThresholdMin: number;
  staleTripCloseHours: number | null;
  stopDurationAlertMin: number;
  speedLimitKmh: number | null;
  enableSpeedingAlert: boolean;
  enableHarshDrivingAlert: boolean;
  enableRouteDeviationAlert: boolean;
  routeDeviationM: number;
  approachingStopMinutes: number;
  notifyTripNotStarted: boolean;
  alertRecipients: AlertRecipient[];
  locationMovingIntervalS: number | null;
  locationStoppedIntervalS: number | null;
  movingSpeedKmh: number | null;
  stoppedAfterS: number | null;
  documentReminderDays: number[] | null;
  /** School override of the location-history retention (null = platform value). Always present in responses. */
  locationRetentionMonths?: number | null;
  /** School overrides of the legal links / consent version (null = platform value). Always present in responses. */
  privacyPolicyUrl?: string | null;
  termsUrl?: string | null;
  consentVersion?: string | null;
  /** Legal links and consent version in force for the school, and the platform values behind them. Always present in responses. */
  legal?: { effective: LegalTerms; platform: LegalTerms };
  features: SchoolFeatures;
  /** Values in force: overrides resolved against the platform defaults, features narrowed by the platform. */
  effective: SchoolLocationDefaults & { features: SchoolFeatures };
  platformDefaults: SchoolLocationDefaults & { features: Partial<SchoolFeatures> };
  updatedAt: string;
  updatedBy: string | null;
}

export interface ParentVisibilityDto {
  matrix: ParentVisibility;
  defaults: ParentVisibility;
  updatedAt: string;
}

export interface HolidayDto {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  appliesTo: HolidayAppliesTo;
  days: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AnnouncementDto {
  id: string;
  title: string;
  body: string;
  audience: 'drivers' | 'parents' | 'all';
  isPinned: boolean;
  publishedAt: string;
  expiresAt: string | null;
  state: AnnouncementState;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SchoolAdminDto {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  isActive: boolean;
  mustChangePassword: boolean;
  locked: boolean;
  lastLoginAt: string | null;
  passwordChangedAt: string | null;
  isSelf: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}
