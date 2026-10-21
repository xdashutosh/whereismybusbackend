// Request schemas of the students module. Bodies and queries are shared with the web admin
// (@wimb/shared → shared/src/schemas/students.ts); here the parent phone numbers are
// normalised to E.164 with libphonenumber (any spelling: '98450 12345', '+91-98450-12345', …) and
// the path params are declared.
import {
  createParentBody as sharedCreateParentBody,
  studentParentLinkBody as sharedLinkBody,
  updateParentBody as sharedUpdateParentBody,
  uuid,
} from '@wimb/shared';
import { z } from 'zod';
import { normalizePhone } from '../../shared/phone.js';

export {
  bulkAssignmentBody,
  createStudentBody,
  importBody,
  importTemplateQuery,
  parentListQuery,
  resetParentAccessBody,
  studentAssignmentBody,
  studentAssignmentHistoryQuery,
  studentListQuery,
  updateStudentBody,
  type AssignmentTarget,
  type BulkAssignmentBody,
  type CreateStudentBody,
  type ImportBody,
  type ImportTemplateQuery,
  type ParentListQuery,
  type ResetParentAccessBody,
  type StudentAssignmentBody,
  type StudentAssignmentHistoryQuery,
  type StudentListQuery,
  type UpdateStudentBody,
} from '@wimb/shared';

const PHONE_MESSAGE = 'Must be a valid mobile number';

/** Normalises `phone` / `alternatePhone` of a parent object in place; adds issues under `path`. */
function normalizeParentPhones<T extends { phone?: string; alternatePhone?: string | null }>(v: T, ctx: z.RefinementCtx, path: (string | number)[] = []): T {
  const out = { ...v };
  if (typeof v.phone === 'string') {
    const n = normalizePhone(v.phone);
    if (n) out.phone = n;
    else ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, 'phone'], message: PHONE_MESSAGE });
  }
  if (typeof v.alternatePhone === 'string') {
    const n = normalizePhone(v.alternatePhone);
    if (n) out.alternatePhone = n;
    else ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path, 'alternatePhone'], message: PHONE_MESSAGE });
  }
  return out;
}

export const createParentBody = sharedCreateParentBody.transform((v, ctx) => normalizeParentPhones(v, ctx));
export type CreateParentBody = z.output<typeof createParentBody>;

export const updateParentBody = sharedUpdateParentBody.transform((v, ctx) => normalizeParentPhones(v, ctx));
export type UpdateParentBody = z.output<typeof updateParentBody>;

export const studentParentLinkBody = sharedLinkBody.transform((v, ctx) => (v.parent ? { ...v, parent: normalizeParentPhones(v.parent, ctx, ['parent']) } : v));
export type StudentParentLinkBody = z.output<typeof studentParentLinkBody>;

export type ParentInput = CreateParentBody;

export const studentParams = z.object({ id: uuid() });
export type StudentParams = z.infer<typeof studentParams>;

export const studentParentParams = z.object({ id: uuid(), parentId: uuid() });
export type StudentParentParams = z.infer<typeof studentParentParams>;

export const parentParams = z.object({ id: uuid() });
export type ParentParams = z.infer<typeof parentParams>;
