// Privacy schemas (BP §16 "Privacy law" / "Store policies"; docs/PRIVACY.md, docs/api/privacy.md):
// legal links (privacy policy + terms, platform value with a per-school override), the parent consent
// version, public school branding for sign-in screens, per-person export and erasure.
import { z } from 'zod';

/** https:// URL (max 500 characters, no spaces) for the privacy policy / terms links. */
export const httpsUrl = () =>
  z
    .string({ invalid_type_error: 'Must be a URL' })
    .trim()
    .max(500)
    .url('Must be a valid URL')
    .refine((u) => /^https:\/\/[^\s]+$/i.test(u), 'Must be an https:// URL');

/** Consent text version: 1–32 letters, digits, dots, dashes or underscores ('1', '2026-10', 'v2.1'). */
export const CONSENT_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
export const consentVersion = () => z.string({ invalid_type_error: 'Must be a version string' }).trim().regex(CONSENT_VERSION_RE, 'Must be 1–32 letters, digits, dots, dashes or underscores');

/** Legal links and consent version (effective for a school, or the platform values). */
export interface LegalTerms {
  privacyUrl: string | null;
  termsUrl: string | null;
  consentVersion: string;
}

/** GET /auth/legal (public): the platform's legal links and consent version. */
export type PublicLegalDto = LegalTerms;

/** GET /auth/school/branding?code= (public): branding of an ACTIVE school for its sign-in screens. */
export const schoolBrandingQuery = z.object({
  code: z
    .string({ required_error: 'Required' })
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9-]{1,31}$/, 'Must be a school code such as GWIS-BLR'),
});
export type SchoolBrandingQuery = z.infer<typeof schoolBrandingQuery>;

export interface SchoolBrandingDto {
  name: string;
  code: string;
  /** Short-lived signed URL of the logo (null without a logo). */
  logoUrl: string | null;
  brandColor: string | null;
  institutionType: 'school' | 'college' | 'university';
  privacyUrl: string | null;
  termsUrl: string | null;
}

// ── parent consent ────────────────────────────────────────────────────────────
/** POST /parent/consent (X-School-Id): the version the parent saw and accepted. */
export const parentConsentBody = z.object({ version: consentVersion() }).strict();
export type ParentConsentBody = z.infer<typeof parentConsentBody>;

export interface ParentConsentRecordDto {
  version: string;
  acceptedAt: string;
}

export interface ParentSchoolConsentDto {
  schoolId: string;
  schoolName: string;
  /** Version the parent must accept (school override or platform value). */
  requiredVersion: string;
  /** Latest version the parent accepted in this school (null = never). */
  acceptedVersion: string | null;
  acceptedAt: string | null;
  /** true when acceptedVersion differs from requiredVersion (first sign-in or a version bump). */
  consentRequired: boolean;
  privacyUrl: string | null;
  termsUrl: string | null;
}

/** GET /parent/consent: every school the parent has an active child link in. */
export interface ParentConsentStatusDto {
  /** true when at least one school needs (re-)consent. */
  consentRequired: boolean;
  schools: ParentSchoolConsentDto[];
}

// ── export / erase (school admins) ───────────────────────────────────────────
export const PRIVACY_EXPORT_FORMAT = 'wimb.privacy-export' as const;
export const PRIVACY_EXPORT_FORMAT_VERSION = 1 as const;
export const PRIVACY_SUBJECT_TYPES = ['student', 'parent'] as const;
export type PrivacySubjectType = (typeof PRIVACY_SUBJECT_TYPES)[number];

/** POST /school/privacy/{students|parents}/:id/erase — irreversible, so the literal word is required. */
export const privacyEraseBody = z
  .object({
    confirm: z.literal('ERASE', { errorMap: () => ({ message: 'Type ERASE to confirm the irreversible erasure' }) }),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();
export type PrivacyEraseBody = z.infer<typeof privacyEraseBody>;

export interface PrivacyEraseResult {
  subjectType: PrivacySubjectType;
  id: string;
  erasedAt: string;
  /** Files (photos) removed from storage. */
  filesDeleted: number;
}
