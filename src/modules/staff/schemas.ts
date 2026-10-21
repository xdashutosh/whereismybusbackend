// Request schemas of the staff module. List/document/verification schemas are shared with the web
// admin (@wimb/shared → shared/src/schemas/staff.ts); the profile and credential bodies
// live here because phone numbers are normalised with libphonenumber (shared/phone.ts).
// Unknown keys (school_id, full identity numbers under other names, …) are stripped by zod.
import { email, ID_PROOF_TYPES, idProofLast4, isoDate, optionalText, STAFF_TYPES, text, uuid } from '@wimb/shared';
import { z } from 'zod';
import { phoneE164 } from '../../shared/phone.js';
import { newPassword } from '../auth/index.js';

export {
  createStaffDocumentBody,
  replaceStaffDocumentBody,
  staffAssignmentHistoryQuery,
  staffDocumentsQuery,
  staffDocumentVisibilityBody,
  staffListQuery,
  updateStaffDocumentBody,
  verifyStaffDocumentBody,
  type CreateStaffDocumentBody,
  type ReplaceStaffDocumentBody,
  type StaffAssignmentHistoryQuery,
  type StaffDocumentsQuery,
  type StaffDocumentVisibilityBody,
  type StaffListQuery,
  type UpdateStaffDocumentBody,
  type VerifyStaffDocumentBody,
} from '@wimb/shared';

const emptyToNull = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? null : v);
const nullable = <T extends z.ZodTypeAny>(s: T) => z.preprocess(emptyToNull, s.nullable().optional());

/** Driving licence number: upper-cased, spaces/hyphens removed ('KA01 2019-0012345' → 'KA0120190012345'). */
const licenceNo = () =>
  z
    .string({ invalid_type_error: 'Must be text' })
    .transform((s) => s.toUpperCase().replace(/[\s.\-/]+/g, ''))
    .pipe(z.string().regex(/^[A-Z0-9]{6,20}$/, 'Must be 6–20 letters or digits (spaces and hyphens are ignored)'));

const experienceYears = () =>
  z
    .number({ invalid_type_error: 'Must be a number' })
    .finite()
    .min(0)
    .max(60)
    .transform((n) => Math.round(n * 10) / 10);

/** Licence fields exist for drivers only. */
export const LICENCE_FIELDS = ['licenceNo', 'licenceRto', 'licenceIssueDate', 'licenceExpiryDate'] as const;

const profileFields = {
  fullName: text(200),
  /** Contact phone (shown to parents only with the matrix flag `phone`). The login phone is set with /credentials. */
  phone: nullable(phoneE164()),
  email: nullable(email()),
  /** Internal only — never parent-visible. */
  address: optionalText(500),
  joiningDate: nullable(isoDate()),
  experienceYears: nullable(experienceYears()),
  experienceSummary: optionalText(1000),
  emergencyContactName: optionalText(200),
  emergencyContactPhone: nullable(phoneE164()),
  idProofType: nullable(z.enum(ID_PROOF_TYPES)),
  /** Last 4 characters only — full Aadhaar/PAN numbers are refused. */
  idProofLast4: idProofLast4(),
  licenceNo: nullable(licenceNo()),
  licenceRto: optionalText(120),
  licenceIssueDate: nullable(isoDate()),
  licenceExpiryDate: nullable(isoDate()),
};

type ProfileShape = { [K in keyof typeof profileFields]?: z.infer<(typeof profileFields)[K]> };

function profileRules(b: ProfileShape, ctx: z.RefinementCtx): void {
  if (b.licenceIssueDate && b.licenceExpiryDate && b.licenceExpiryDate < b.licenceIssueDate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['licenceExpiryDate'], message: 'The expiry date cannot be before the issue date' });
  }
  if (b.idProofLast4 && b.idProofType === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['idProofType'], message: 'Select the identity proof type for the last 4 characters' });
  }
}

export const createStaffBody = z
  .object({ staffType: z.enum(STAFF_TYPES), ...profileFields })
  .superRefine((b, ctx) => {
    profileRules(b, ctx);
    if (b.idProofLast4 && !b.idProofType) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['idProofType'], message: 'Select the identity proof type for the last 4 characters' });
    }
    if (b.staffType === 'conductor') {
      for (const k of LICENCE_FIELDS) {
        if (b[k] !== undefined && b[k] !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [k], message: 'Licence details apply to drivers only' });
      }
    }
  });
export type CreateStaffBody = z.infer<typeof createStaffBody>;

export const updateStaffBody = z
  .object({
    ...profileFields,
    fullName: profileFields.fullName.optional(),
    /** File id of an uploaded staff_photo for this staff member (POST /files/upload); null removes the photo. */
    photoFileId: z.preprocess(emptyToNull, uuid().nullable().optional()),
    /** Present only to give a clear error: the staff type never changes after creation. */
    staffType: z.unknown().optional(),
  })
  .superRefine((b, ctx) => {
    if (b.staffType !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['staffType'], message: 'The staff type cannot be changed' });
    const { staffType: _ignored, ...rest } = b;
    if (!Object.values(rest).some((v) => v !== undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide at least one field to change' });
    profileRules(b, ctx);
  });
export type UpdateStaffBody = z.infer<typeof updateStaffBody>;

const SEQUENCES = '0123456789012345';
/** 4–6 digits, not one repeated digit and not an ascending/descending run (1234, 9876…). */
export const pinCode = () =>
  z
    .string({ invalid_type_error: 'Must be text' })
    .trim()
    .regex(/^\d{4,6}$/, 'Must be 4–6 digits')
    .refine((p) => !/^(\d)\1+$/.test(p), 'Too easy to guess: do not repeat one digit')
    .refine((p) => !SEQUENCES.includes(p) && !SEQUENCES.split('').reverse().join('').includes(p), 'Too easy to guess: do not use a digit sequence');

export const credentialsBody = z
  .object({
    /** Login phone (E.164). Omitted: the profile phone for a new login, unchanged on a reset. null: no phone login. */
    phone: nullable(phoneE164()),
    /** Login username (3–40 letters, digits, . _ -). Omitted: unchanged (none for a new login). null: removes it. */
    username: nullable(z.string().trim().regex(/^[A-Za-z0-9._-]{3,40}$/, 'Must be 3–40 letters, digits, dots, hyphens or underscores')),
    /** Temporary password; omitted → generated and returned once. */
    password: newPassword.optional(),
    /** PIN for the driver app; omitted → none (a reset replaces every secret). */
    pin: nullable(pinCode()),
    /** Generate a 6-digit PIN and return it once (instead of `pin`). */
    generatePin: z.boolean().optional(),
    /** Force a password change at the next sign-in (default true). */
    mustChangePassword: z.boolean().optional(),
  })
  .superRefine((b, ctx) => {
    if (b.generatePin && b.pin) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pin'], message: 'Provide pin or generatePin, not both' });
  });
export type CredentialsBody = z.infer<typeof credentialsBody>;

export const deactivateBody = z.object({ reason: optionalText(500) });
export type DeactivateBody = z.infer<typeof deactivateBody>;

export const staffParams = z.object({ id: uuid() });
export type StaffParams = z.infer<typeof staffParams>;

export const staffDocumentParams = z.object({ docId: uuid() });
export type StaffDocumentParams = z.infer<typeof staffDocumentParams>;
