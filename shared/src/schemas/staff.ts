// Staff module schemas (BP §6.2 staff_profiles / staff_documents, §8.3 Staff, §12, §13.3 Staff,
// §16 data minimisation). Shared by the backend validators and the web admin forms. Profile and
// credential bodies (phone numbers normalised with libphonenumber) live in the backend module;
// everything else is here. Unknown keys (e.g. school_id) are stripped.
import { z } from 'zod';
import {
  ASSIGNMENT_ROLES,
  STAFF_DOCUMENT_TYPES,
  STAFF_TYPES,
  VERIFICATION_STATUSES,
  type AssignmentRole,
  type StaffDocumentType,
  type StaffType,
  type VerificationStatus,
} from '../enums.js';
import type { BusDocumentExpiryStatus } from './buses.js';
import { exportFormat, isoDate, listQueryShape, optionalText, queryBool, queryEnumList, uuid } from './common.js';

const emptyToUndefined = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const csvOnly = exportFormat.refine((f) => f !== 'pdf', 'Supported formats: json, csv');

/** Identity proof kinds (staff_profiles.id_proof_type). Only the last 4 characters are ever stored. */
export const ID_PROOF_TYPES = ['aadhaar', 'pan', 'voter_id', 'passport', 'driving_licence', 'other'] as const;
export type IdProofType = (typeof ID_PROOF_TYPES)[number];

/** Expiry badge of licences/documents: `expiring` = within STAFF_DOCUMENT_EXPIRING_DAYS (school-local). */
export type StaffExpiryStatus = BusDocumentExpiryStatus;
export const STAFF_DOCUMENT_EXPIRING_DAYS = 30;

/** Document types that may have several current versions (all others: one current per staff member). */
export const STAFF_MULTI_DOCUMENT_TYPES: readonly StaffDocumentType[] = ['training', 'other'];

/** Licence documents exist for drivers only. */
export const DRIVER_ONLY_DOCUMENT_TYPES: readonly StaffDocumentType[] = ['licence_front', 'licence_back'];

export const STAFF_STATUS_FILTERS = ['active', 'inactive', 'all'] as const;
export type StaffStatusFilter = (typeof STAFF_STATUS_FILTERS)[number];

/** Masked display of an identity number from its last 4 characters ('XXXX XXXX 1234'). */
export function maskIdProof(type: IdProofType | null, last4: string | null): string | null {
  if (!last4) return null;
  switch (type) {
    case 'aadhaar':
      return `XXXX XXXX ${last4}`;
    case 'pan':
      return `XXXXXX${last4}`;
    default:
      return `••••${last4}`;
  }
}

// Full Aadhaar (12 digits, optional separators) and PAN numbers must never be stored (BP §12, §16).
const AADHAAR_RE = /^[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}$/;
const PAN_RE = /^[A-Za-z]{5}\d{4}[A-Za-z]$/;
/** True when a value looks like a full Aadhaar or PAN number. */
export function looksLikeFullIdNumber(v: string): boolean {
  const s = v.trim();
  return AADHAAR_RE.test(s) || PAN_RE.test(s);
}
export const FULL_ID_MESSAGE = 'Do not enter full Aadhaar/PAN numbers. Store only the last 4 characters.';

/** Last 4 characters of an identity number (letters/digits). */
export const idProofLast4 = () =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
    z
      .string({ invalid_type_error: 'Must be text' })
      .trim()
      .refine((s) => !looksLikeFullIdNumber(s), FULL_ID_MESSAGE)
      .refine((s) => /^[A-Za-z0-9]{4}$/.test(s), 'Enter exactly the last 4 letters or digits')
      .transform((s) => s.toUpperCase())
      .nullable()
      .optional(),
  );

// ── list ─────────────────────────────────────────────────────────────────────
export const staffListQuery = z.object({
  ...listQueryShape,
  format: csvOnly,
  /** driver | conductor (comma separated). */
  type: queryEnumList([...STAFF_TYPES]),
  /** active (default: all) | inactive | all */
  status: z.preprocess(emptyToUndefined, z.enum(STAFF_STATUS_FILTERS).optional()),
  /** Drivers whose licence is expired / expires within 30 days. */
  licenceStatus: z.preprocess(emptyToUndefined, z.enum(['expired', 'expiring', 'missing']).optional()),
  /** Staff with at least one current document in that expiry state. */
  documentStatus: z.preprocess(emptyToUndefined, z.enum(['expired', 'expiring']).optional()),
  /** true → has an app login; false → none yet. */
  hasLogin: queryBool(),
  /** true → currently assigned to a bus; false → unassigned. */
  assigned: queryBool(),
});
export type StaffListQuery = z.infer<typeof staffListQuery>;

export const staffAssignmentHistoryQuery = z.object({
  page: listQueryShape.page,
  limit: listQueryShape.limit,
  sort: listQueryShape.sort,
  format: csvOnly,
  role: queryEnumList([...ASSIGNMENT_ROLES]),
  busId: z.preprocess(emptyToUndefined, uuid().optional()),
  /** true → open assignments only; false → closed ones only. */
  current: queryBool(),
});
export type StaffAssignmentHistoryQuery = z.infer<typeof staffAssignmentHistoryQuery>;

// ── documents ────────────────────────────────────────────────────────────────
const nullableDate = () => z.preprocess((v) => (v === '' ? null : v), isoDate().nullable().optional());
const datesInOrder = (b: { issueDate?: string | null; expiryDate?: string | null }) => !b.issueDate || !b.expiryDate || b.expiryDate >= b.issueDate;
const DATES_MESSAGE = { message: 'The expiry date cannot be before the issue date', path: ['expiryDate'] };

/** Document number: never a full Aadhaar/PAN (identity documents keep only the last 4, see the service). */
const docNumber = () =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
    z.string().trim().max(100).refine((s) => !looksLikeFullIdNumber(s), FULL_ID_MESSAGE).nullable().optional(),
  );

const documentFields = {
  title: optionalText(200),
  issuer: optionalText(200),
  docNumber: docNumber(),
  issueDate: nullableDate(),
  expiryDate: nullableDate(),
  /** A file uploaded with category staff_document for this staff member (POST /files/upload or /files/upload-url). */
  fileId: z.preprocess((v) => (v === '' ? null : v), uuid().nullable().optional()),
  /** Parents may see the status/validity (subject to the school matrix). Default true (identity: always false). */
  visibleToParentsStatus: z.boolean().optional(),
  /** Parents may open the file (subject to the school matrix). Default false; never for identity documents. */
  visibleToParentsFile: z.boolean().optional(),
};

export const createStaffDocumentBody = z.object({ docType: z.enum(STAFF_DOCUMENT_TYPES), ...documentFields }).refine(datesInOrder, DATES_MESSAGE);
export type CreateStaffDocumentBody = z.infer<typeof createStaffDocumentBody>;

/** PUT /school/staff-documents/:docId — a new current version; the old one stays as history. */
export const replaceStaffDocumentBody = z.object(documentFields).refine(datesInOrder, DATES_MESSAGE);
export type ReplaceStaffDocumentBody = z.infer<typeof replaceStaffDocumentBody>;

/** PATCH /school/staff-documents/:docId — corrects metadata of the same version (no new file). */
export const updateStaffDocumentBody = z
  .object({ title: documentFields.title, issuer: documentFields.issuer, docNumber: documentFields.docNumber, issueDate: documentFields.issueDate, expiryDate: documentFields.expiryDate })
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'Provide at least one field to change' })
  .refine(datesInOrder, DATES_MESSAGE);
export type UpdateStaffDocumentBody = z.infer<typeof updateStaffDocumentBody>;

export const staffDocumentVisibilityBody = z
  .object({ visibleToParentsStatus: z.boolean().optional(), visibleToParentsFile: z.boolean().optional() })
  .refine((b) => b.visibleToParentsStatus !== undefined || b.visibleToParentsFile !== undefined, { message: 'Provide visibleToParentsStatus or visibleToParentsFile' });
export type StaffDocumentVisibilityBody = z.infer<typeof staffDocumentVisibilityBody>;

export const verifyStaffDocumentBody = z
  .object({ status: z.enum(VERIFICATION_STATUSES), note: optionalText(500) })
  .refine((b) => b.status !== 'rejected' || Boolean(b.note), { message: 'A note is required when rejecting a document', path: ['note'] });
export type VerifyStaffDocumentBody = z.infer<typeof verifyStaffDocumentBody>;

export const staffDocumentsQuery = z.object({
  docType: queryEnumList([...STAFF_DOCUMENT_TYPES]),
  /** Include replaced (non-current) versions. */
  includeHistory: queryBool(),
});
export type StaffDocumentsQuery = z.infer<typeof staffDocumentsQuery>;

// ── response DTOs ────────────────────────────────────────────────────────────
export interface StaffBusRef {
  busId: string;
  busCode: string;
  role: AssignmentRole;
}

export interface StaffListItem {
  id: string;
  staffType: StaffType;
  fullName: string;
  phone: string | null;
  email: string | null;
  photoFileId: string | null;
  photoThumbnailUrl: string | null;
  joiningDate: string | null;
  experienceYears: number | null;
  idProofType: IdProofType | null;
  /** Masked identity number built from the stored last 4 characters (never the full number). */
  idProofMasked: string | null;
  idVerificationStatus: VerificationStatus;
  licenceNo: string | null;
  licenceExpiryDate: string | null;
  licenceStatus: StaffExpiryStatus;
  licenceDaysToExpiry: number | null;
  licenceVerificationStatus: VerificationStatus;
  isActive: boolean;
  hasLogin: boolean;
  loginPhone: string | null;
  loginUsername: string | null;
  currentBuses: StaffBusRef[];
  expiredDocuments: number;
  expiringDocuments: number;
  createdAt: string;
  updatedAt: string;
}

export interface StaffLoginDto {
  userId: string;
  phone: string | null;
  username: string | null;
  hasPin: boolean;
  isActive: boolean;
  mustChangePassword: boolean;
  locked: boolean;
  lastLoginAt: string | null;
  passwordChangedAt: string | null;
  activeSessions: number;
}

export interface StaffPhotoDto {
  fileId: string;
  url: string | null;
  thumbnailUrl: string | null;
}

export interface StaffDocumentDto {
  id: string;
  staffId: string;
  docType: StaffDocumentType;
  title: string | null;
  issuer: string | null;
  docNumber: string | null;
  issueDate: string | null;
  expiryDate: string | null;
  expiryStatus: StaffExpiryStatus;
  daysToExpiry: number | null;
  file: { id: string; fileName: string | null; contentType: string; sizeBytes: number | null; hasThumbnail: boolean } | null;
  verificationStatus: VerificationStatus;
  verifiedBy: string | null;
  verifiedByName: string | null;
  verifiedAt: string | null;
  verificationNote: string | null;
  visibleToParentsStatus: boolean;
  visibleToParentsFile: boolean;
  isCurrent: boolean;
  replacedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StaffAssignmentItem {
  id: string;
  busId: string;
  busCode: string;
  busName: string | null;
  registrationNo: string;
  role: AssignmentRole;
  validFrom: string;
  validTo: string | null;
  isCurrent: boolean;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
}

export interface StaffDetail extends StaffListItem {
  /** Internal only — never shown to parents. */
  address: string | null;
  experienceSummary: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  idProofLast4: string | null;
  licenceRto: string | null;
  licenceIssueDate: string | null;
  photo: StaffPhotoDto | null;
  login: StaffLoginDto | null;
  currentAssignments: StaffAssignmentItem[];
  documents: StaffDocumentDto[];
  activeTripId: string | null;
  createdBy: string | null;
}

export interface StaffCredentialsResult {
  staff: StaffDetail;
  login: StaffLoginDto;
  /** true when this call created the login, false when it reset an existing one. */
  created: boolean;
  /** Present only when the server generated it (shown once; share it securely). */
  temporaryPassword: string | null;
  /** Present only when the server generated it (shown once). */
  pin: string | null;
  revokedSessions: number;
}

// ── parent view (BP §15 driver/conductor cards, §13.3 parent-visibility preview) ──────────────
export interface ParentStaffDocument {
  docType: StaffDocumentType;
  title: string | null;
  verificationStatus: VerificationStatus | null;
  expiryDate: string | null;
  expiryStatus: StaffExpiryStatus;
  /** Present only when the school and the document allow parents to open the file. */
  fileId: string | null;
}

export interface ParentStaffCard {
  id: string;
  staffType: StaffType;
  fullName: string;
  /** Present only with the matrix flag `photo`. */
  photo: StaffPhotoDto | null;
  phone: string | null;
  email: string | null;
  experience: { years: number | null; summary: string | null; joiningDate: string | null } | null;
  /** Drivers with `licenceValidity`: validity only (never the licence number). */
  licence: { expiryDate: string | null; expiryStatus: StaffExpiryStatus; verificationStatus: VerificationStatus } | null;
  /** With `verification`: identity check result and police verification status. */
  verification: { identity: VerificationStatus; policeVerification: VerificationStatus | null } | null;
  documents: ParentStaffDocument[];
}

export type ParentStaffHiddenReason = 'INACTIVE' | 'NOT_ASSIGNED';

/**
 * Why a current document is missing from the parent card: IDENTITY (never shown), SCHOOL_SETTING
 * (the matrix hides it), DOCUMENT_FLAGS (its own switches hide it), NOT_VERIFIED (it offers only
 * its file, which parents get once the document is verified).
 */
export type ParentStaffDocumentHiddenReason = 'IDENTITY' | 'SCHOOL_SETTING' | 'DOCUMENT_FLAGS' | 'NOT_VERIFIED';

export interface ParentStaffPreview {
  staffId: string;
  staffType: StaffType;
  /** Whether parents of children on this staff member's buses see the card right now. */
  visibleToParents: boolean;
  hiddenReasons: ParentStaffHiddenReason[];
  buses: StaffBusRef[];
  /** The school's matrix section applied (driver or conductor). */
  matrix: Record<string, boolean>;
  /** Fields of the card hidden by the matrix (e.g. 'phone', 'licenceFile'). */
  hiddenFields: string[];
  /** Current documents parents do not see, and why. */
  hiddenDocuments: { documentId: string; docType: StaffDocumentType; reason: ParentStaffDocumentHiddenReason }[];
  card: ParentStaffCard;
}
