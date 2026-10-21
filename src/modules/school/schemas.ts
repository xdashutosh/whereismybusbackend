// Backend-only request schemas of the school module. Bodies shared with the web forms
// (settings, parent visibility, holidays, announcements) live in @wimb/shared (schemas/school.ts);
// the profile body is here because phone numbers are normalised with libphonenumber.
import {
  ANNOUNCEMENT_AUDIENCES,
  ANNOUNCEMENT_STATES,
  HOLIDAY_APPLIES_TO,
  email,
  exportFormat,
  isoDate,
  latitude,
  listQueryShape,
  longitude,
  optionalText,
  queryBool,
  queryEnumList,
  queryInt,
  text,
  timeZone,
  uuid,
} from '@wimb/shared';
import { z } from 'zod';
import { phoneE164 } from '../../shared/phone.js';

const emptyToNull = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? null : v);
const emptyToUndefined = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const nullable = <T extends z.ZodTypeAny>(s: T) => z.preprocess(emptyToNull, s.nullable().optional());

/** PATCH /school/profile — the school code (login identifier) and platform fields are immutable here. */
export const updateProfileBody = z
  .object({
    name: text(200).optional(),
    address: optionalText(500),
    city: optionalText(100),
    state: optionalText(100),
    pincode: nullable(z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9 -]{2,11}$/, 'Must be a valid postal code')),
    contactName: optionalText(200),
    contactPhone: nullable(phoneE164()),
    contactEmail: nullable(email()),
    /** File id of an uploaded `school_logo` (POST /files/upload); null removes the logo. */
    logoFileId: uuid().nullable().optional(),
    brandColor: nullable(z.string().trim().regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a colour like #0070F2')),
    location: z.object({ lat: latitude(), lng: longitude() }).nullable().optional(),
    geofenceRadiusM: z.number({ invalid_type_error: 'Must be a number' }).int().min(20).max(5000).optional(),
    timezone: timeZone().optional(),
    /** Present only to give a clear error: the school code never changes after creation. */
    code: z.unknown().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.code !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['code'], message: 'The school code cannot be changed' });
  });
export type UpdateProfileBody = z.infer<typeof updateProfileBody>;

const csvOnly = exportFormat.refine((f) => f !== 'pdf', 'Supported formats: json, csv');

export const holidayListQuery = z.object({
  ...listQueryShape,
  format: csvOnly,
  /** Holidays overlapping [from, to] (inclusive days). */
  from: z.preprocess(emptyToUndefined, isoDate().optional()),
  to: z.preprocess(emptyToUndefined, isoDate().optional()),
  /** Calendar year shortcut (Jan 1 – Dec 31); combined with from/to by intersection. */
  year: queryInt(2000, 2100),
  appliesTo: z.preprocess(emptyToUndefined, z.enum(HOLIDAY_APPLIES_TO).optional()),
});
export type HolidayListQuery = z.infer<typeof holidayListQuery>;

export const announcementListQuery = z.object({
  ...listQueryShape,
  format: csvOnly,
  audience: z.preprocess(emptyToUndefined, z.enum(ANNOUNCEMENT_AUDIENCES).optional()),
  /** scheduled | active | expired (comma-separated). */
  state: queryEnumList([...ANNOUNCEMENT_STATES] as [string, ...string[]]),
  pinned: queryBool(),
});
export type AnnouncementListQuery = z.infer<typeof announcementListQuery>;

export const idParams = z.object({ id: uuid() });
export type IdParams = z.infer<typeof idParams>;
