// Students module schemas (BP §4.6, §6.2 students/parents/assignments, §8.3 Students, Parents,
// Assignments, §13.3 Students/Parents). Shared by the backend validators and the web admin forms.
// Unknown keys (e.g. school_id) are stripped. Phone numbers are accepted in any common spelling
// here; the backend normalises them to E.164 with libphonenumber (the web shows its message).
import { z } from 'zod';
import { DIRECTIONS } from '../enums.js';
import { email, exportFormat, isoDate, listQueryShape, optionalText, queryBool, queryString, text, uuid } from './common.js';

const emptyToUndefined = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const csvOnly = exportFormat.refine((f) => f !== 'pdf', 'Supported formats: json, csv');
const queryUuid = () => z.preprocess(emptyToUndefined, uuid().optional());
const someField = (b: Record<string, unknown>) => Object.values(b).some((v) => v !== undefined);
const SOME_FIELD = { message: 'Provide at least one field to change' };

/** Suggested relation values (free text is accepted; the web offers these). */
export const PARENT_RELATIONS = ['mother', 'father', 'guardian', 'grandparent', 'sibling', 'other'] as const;

/** Rows per import file (CSV/XLSX, 5 MB upload limit). */
export const IMPORT_MAX_ROWS = 5000;
/** Students per bulk assignment request. */
export const BULK_ASSIGNMENT_MAX = 500;
/** Parent columns per student row of the student import (parent1_*, parent2_*). */
export const IMPORT_PARENT_SLOTS = 2;

/** Raw phone input (6–32 characters); normalised to E.164 by the server. */
export const phoneInput = () => z.string({ required_error: 'Required', invalid_type_error: 'Must be text' }).trim().min(6, 'Must be a valid mobile number').max(32);
const optionalPhone = () => z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), phoneInput().nullable().optional());
const optionalEmail = () => z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), email().nullable().optional());

// ── students ─────────────────────────────────────────────────────────────────
const studentFields = {
  /** Unique per school among live students (case-sensitive as entered, trimmed). */
  admissionNo: optionalText(40),
  fullName: text(200),
  className: optionalText(40),
  section: optionalText(20),
  rollNo: optionalText(20),
  /** Internal note, never shown to parents. */
  notes: optionalText(2000),
  isActive: z.boolean({ invalid_type_error: 'Must be true or false' }).optional(),
};

export const createStudentBody = z.object(studentFields);
export type CreateStudentBody = z.infer<typeof createStudentBody>;

export const updateStudentBody = z
  .object({
    ...studentFields,
    /** File id of an uploaded `student_photo` of this student (POST /files/upload); null removes it. */
    photoFileId: uuid().nullable().optional(),
  })
  .partial()
  .refine(someField, SOME_FIELD);
export type UpdateStudentBody = z.infer<typeof updateStudentBody>;

export const studentListQuery = z.object({
  ...listQueryShape,
  format: csvOnly,
  className: queryString(40),
  section: queryString(20),
  /** Students with a current or upcoming assignment to this bus / route / stop. */
  busId: queryUuid(),
  routeId: queryUuid(),
  stopId: queryUuid(),
  /** Narrows busId/routeId/stopId/unassigned to one direction (both when omitted). */
  direction: z.preprocess(emptyToUndefined, z.enum(DIRECTIONS).optional()),
  /** true → no current or upcoming assignment (in `direction`, or in at least one direction). */
  unassigned: queryBool(),
  isActive: queryBool(),
  /** true → at least one linked parent; false → none. */
  hasParents: queryBool(),
});
export type StudentListQuery = z.infer<typeof studentListQuery>;

// ── assignments (bus → route → stop per direction) ───────────────────────────
export const assignmentTarget = z.object({ busId: uuid(), routeId: uuid(), stopId: uuid() });
export type AssignmentTarget = z.infer<typeof assignmentTarget>;

const assignmentShape = {
  /** First school-local day of the change (default today; never in the past, at most a year ahead). */
  effectiveFrom: isoDate().optional(),
  /** A target assigns, null ends the assignment, omitted leaves the direction unchanged. */
  morning: assignmentTarget.nullable().optional(),
  afternoon: assignmentTarget.nullable().optional(),
};
const someDirection = (b: { morning?: unknown; afternoon?: unknown }) => b.morning !== undefined || b.afternoon !== undefined;
const SOME_DIRECTION = { message: 'Provide morning and/or afternoon (null ends an assignment)', path: ['morning'] };

export const studentAssignmentBody = z.object(assignmentShape).refine(someDirection, SOME_DIRECTION);
export type StudentAssignmentBody = z.infer<typeof studentAssignmentBody>;

export const bulkAssignmentBody = z
  .object({
    studentIds: z
      .array(uuid())
      .min(1, 'Select at least one student')
      .max(BULK_ASSIGNMENT_MAX, `At most ${BULK_ASSIGNMENT_MAX} students per request`)
      .transform((ids) => [...new Set(ids)]),
    ...assignmentShape,
  })
  .refine(someDirection, SOME_DIRECTION);
export type BulkAssignmentBody = z.infer<typeof bulkAssignmentBody>;

export const studentAssignmentHistoryQuery = z.object({
  page: listQueryShape.page,
  limit: listQueryShape.limit,
  direction: z.preprocess(emptyToUndefined, z.enum(DIRECTIONS).optional()),
});
export type StudentAssignmentHistoryQuery = z.infer<typeof studentAssignmentHistoryQuery>;

// ── parents ──────────────────────────────────────────────────────────────────
const parentFields = {
  /** Mobile number = the parent's global sign-in identity (OTP). */
  phone: phoneInput(),
  fullName: text(200),
  email: optionalEmail(),
  relation: optionalText(40),
  alternatePhone: optionalPhone(),
};

export const createParentBody = z.object({ ...parentFields, isActive: z.boolean().optional() });
export type CreateParentBody = z.infer<typeof createParentBody>;

export const updateParentBody = z
  .object({ ...parentFields, isActive: z.boolean({ invalid_type_error: 'Must be true or false' }) })
  .partial()
  .refine(someField, SOME_FIELD);
export type UpdateParentBody = z.infer<typeof updateParentBody>;

export const parentListQuery = z.object({
  ...listQueryShape,
  format: csvOnly,
  isActive: queryBool(),
  /** true → linked to at least one live student; false → no children linked. */
  hasChildren: queryBool(),
  /** Parents linked to this student. */
  studentId: queryUuid(),
});
export type ParentListQuery = z.infer<typeof parentListQuery>;

/** POST /school/students/:id/parents — link (existing parent or create-or-reuse by phone) or unlink. */
export const studentParentLinkBody = z
  .object({
    action: z.enum(['link', 'unlink']).default('link'),
    parentId: uuid().optional(),
    parent: z.object(parentFields).optional(),
    /** Relation for this child (defaults to the parent's relation). */
    relation: optionalText(40),
    /** The primary contact of the child (one per child; the first parent becomes primary). */
    isPrimary: z.boolean().optional(),
  })
  .superRefine((b, ctx) => {
    if (b.action === 'unlink' && !b.parentId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['parentId'], message: 'Required to unlink' });
    if (b.action === 'link' && !b.parentId === !b.parent) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['parentId'], message: 'Provide either parentId or parent' });
    }
  });
export type StudentParentLinkBody = z.infer<typeof studentParentLinkBody>;

export const resetParentAccessBody = z.object({ reason: optionalText(300) });
export type ResetParentAccessBody = z.infer<typeof resetParentAccessBody>;

// ── imports ──────────────────────────────────────────────────────────────────
export const IMPORT_ON_EXISTING = ['update', 'skip'] as const;
export type ImportOnExisting = (typeof IMPORT_ON_EXISTING)[number];

/** Body of POST /school/students/import and /school/parents/import. */
export const importBody = z.object({
  /** Id of a CSV/XLSX file uploaded with POST /files/upload (category `import`). */
  fileId: uuid(),
  /** true (default) → validate and preview only; false → commit everything in one transaction. */
  dryRun: z.boolean({ invalid_type_error: 'Must be true or false' }).default(true),
  /** Rows matching an existing record (admission no / phone): update it (default) or leave it. */
  onExisting: z.enum(IMPORT_ON_EXISTING).default('update'),
});
export type ImportBody = z.infer<typeof importBody>;

export const importTemplateQuery = z.object({ format: z.preprocess(emptyToUndefined, z.enum(['csv', 'xlsx']).default('csv')) });
export type ImportTemplateQuery = z.infer<typeof importTemplateQuery>;

/** Student import columns (header names are case/space-insensitive; aliases are accepted). */
export const STUDENT_IMPORT_COLUMNS = [
  'admission_no', 'full_name', 'class_name', 'section', 'roll_no', 'notes',
  'parent1_name', 'parent1_phone', 'parent1_email', 'parent1_relation',
  'parent2_name', 'parent2_phone', 'parent2_email', 'parent2_relation',
] as const;
/** Parent import columns; student_admission_nos is a ';'-separated list of children to link. */
export const PARENT_IMPORT_COLUMNS = ['phone', 'full_name', 'email', 'relation', 'alternate_phone', 'student_admission_nos'] as const;

export type * from './studentsDto.js';
