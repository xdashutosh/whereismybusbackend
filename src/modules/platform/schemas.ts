// Request validators of the platform module: the shared schemas (@wimb/shared, also used by the web
// Platform panel) plus server-side phone normalisation to E.164 (libphonenumber, default country IN).
import {
  activateSchoolBody,
  createSchoolBody as sharedCreateSchoolBody,
  deactivateSchoolBody,
  idParams,
  platformSettingsBody,
  resetAdminPasswordBody,
  schoolListQuery,
  subscriptionBody,
  updateSchoolBody as sharedUpdateSchoolBody,
  usageListQuery,
} from '@wimb/shared';
import { z } from 'zod';
import { normalizePhone } from '../../shared/phone.js';

/** Normalises an optional phone in place; adds a field issue when it is not a valid number. */
function phoneAt(ctx: z.RefinementCtx, value: string | null | undefined, path: (string | number)[]): string | null | undefined {
  if (value === null || value === undefined) return value;
  const n = normalizePhone(value);
  if (!n) ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: 'Must be a valid phone number' });
  return n ?? value;
}

export const createSchoolBody = sharedCreateSchoolBody.transform((b, ctx) => ({
  ...b,
  contact: b.contact ? { ...b.contact, phone: phoneAt(ctx, b.contact.phone, ['contact', 'phone']) } : undefined,
  admin: { ...b.admin, phone: phoneAt(ctx, b.admin.phone, ['admin', 'phone']) },
}));
export type CreateSchool = z.output<typeof createSchoolBody>;

export const updateSchoolBody = sharedUpdateSchoolBody.transform((b, ctx) => ({
  ...b,
  contact: b.contact ? { ...b.contact, phone: phoneAt(ctx, b.contact.phone, ['contact', 'phone']) } : undefined,
}));
export type UpdateSchool = z.output<typeof updateSchoolBody>;

export { activateSchoolBody, deactivateSchoolBody, idParams, platformSettingsBody, resetAdminPasswordBody, schoolListQuery, subscriptionBody, usageListQuery };
export type {
  DeactivateSchoolBody,
  PlatformSettingsBody,
  ResetAdminPasswordBody,
  SchoolListQuery,
  SubscriptionBody,
  UsageListQuery,
} from '@wimb/shared';
export type ActivateSchoolBody = z.output<typeof activateSchoolBody>;
