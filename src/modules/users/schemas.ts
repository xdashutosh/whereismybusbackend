// Request schemas of the users module (additional school admins, BP §8.3 Admin users, §13.3
// Users & Roles). Passwords follow the auth module's rules (newPassword).
import { email, exportFormat, listQueryShape, optionalText, text, uuid } from '@wimb/shared';
import { z } from 'zod';
import { phoneE164 } from '../../shared/phone.js';
import { newPassword } from '../auth/index.js';

const emptyToNull = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? null : v);
const emptyToUndefined = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? undefined : v);

export const ADMIN_STATUS_FILTERS = ['active', 'inactive', 'all'] as const;

export const adminListQuery = z.object({
  ...listQueryShape,
  format: exportFormat.refine((f) => f !== 'pdf', 'Supported formats: json, csv'),
  /** active (default: all) | inactive | all */
  status: z.preprocess(emptyToUndefined, z.enum(ADMIN_STATUS_FILTERS).optional()),
});
export type AdminListQuery = z.infer<typeof adminListQuery>;

export const createAdminBody = z.object({
  fullName: text(200),
  /** Sign-in identifier; globally unique among school admin accounts. */
  email: email(),
  phone: z.preprocess(emptyToNull, phoneE164().nullable().optional()),
  /** Initial password; omitted → a temporary password is generated and returned once. */
  password: newPassword.optional(),
});
export type CreateAdminBody = z.infer<typeof createAdminBody>;

export const updateAdminBody = z.object({
  fullName: text(200).optional(),
  email: email().optional(),
  phone: z.preprocess(emptyToNull, phoneE164().nullable().optional()),
});
export type UpdateAdminBody = z.infer<typeof updateAdminBody>;

export const resetAccessBody = z.object({
  /** New temporary password; omitted → generated and returned once. */
  password: newPassword.optional(),
});
export type ResetAccessBody = z.infer<typeof resetAccessBody>;

export const deactivateBody = z.object({
  reason: optionalText(500),
});
export type DeactivateBody = z.infer<typeof deactivateBody>;

export const idParams = z.object({ id: uuid() });
export type IdParams = z.infer<typeof idParams>;
