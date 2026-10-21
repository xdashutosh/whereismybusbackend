// Request schemas of the auth module (contract §6). Unknown keys are stripped by zod.
import { deviceInfo, email } from '@wimb/shared';
import { z } from 'zod';
import { phoneE164 } from '../../shared/phone.js';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './policy.js';

/** Credential as typed at sign-in (never validated for strength: old passwords stay usable). */
const secret = z.string().min(1, 'Required').max(256);
const sixDigits = z.string().trim().regex(/^\d{6}$/, 'Must be a 6-digit code');
const opaqueToken = z.string().trim().min(20).max(256);

/** New password rules: 8–128 characters with at least one letter and one digit. */
export const newPassword = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Must be at most ${PASSWORD_MAX_LENGTH} characters`)
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), 'Must contain at least one letter and one digit')
  .refine((v) => v.trim() === v, 'Must not start or end with spaces');

export const platformLoginBody = z.object({
  email: email(),
  password: secret,
  totpCode: sixDigits.optional(),
});
export type PlatformLoginBody = z.infer<typeof platformLoginBody>;

export const totpSetupBody = z.object({ challengeToken: opaqueToken });
export type TotpSetupBody = z.infer<typeof totpSetupBody>;

export const totpVerifyBody = z.object({ challengeToken: opaqueToken, code: sixDigits });
export type TotpVerifyBody = z.infer<typeof totpVerifyBody>;

export const schoolLoginBody = z.object({ email: email(), password: secret });
export type SchoolLoginBody = z.infer<typeof schoolLoginBody>;

export const staffLoginBody = z
  .object({
    schoolCode: z
      .string()
      .trim()
      .min(2)
      .max(32)
      .transform((s) => s.toUpperCase()),
    phone: phoneE164().optional(),
    username: z.string().trim().min(3).max(40).optional(),
    password: secret.optional(),
    pin: z.string().trim().regex(/^\d{4,6}$/, 'Must be 4–6 digits').optional(),
    device: deviceInfo,
  })
  .superRefine((v, ctx) => {
    if ((v.phone ? 1 : 0) + (v.username ? 1 : 0) !== 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['phone'], message: 'Provide either phone or username' });
    }
    if ((v.password ? 1 : 0) + (v.pin ? 1 : 0) !== 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['password'], message: 'Provide either password or pin' });
    }
  });
export type StaffLoginBody = z.infer<typeof staffLoginBody>;

export const parentOtpRequestBody = z.object({ phone: phoneE164() });
export type ParentOtpRequestBody = z.infer<typeof parentOtpRequestBody>;

export const parentOtpVerifyBody = z.object({ phone: phoneE164(), otp: sixDigits, device: deviceInfo.optional() });
export type ParentOtpVerifyBody = z.infer<typeof parentOtpVerifyBody>;

export const parentPasswordLoginBody = z.object({ phone: phoneE164(), password: secret, device: deviceInfo.optional() });
export type ParentPasswordLoginBody = z.infer<typeof parentPasswordLoginBody>;

/** Mobile clients send the refresh token in the body; web clients use the cookie. */
export const refreshBody = z.object({ refreshToken: opaqueToken.optional() });
export type RefreshBody = z.infer<typeof refreshBody>;

export const changePasswordBody = z
  .object({
    currentPassword: secret.optional(),
    newPassword,
  })
  .refine((v) => v.currentPassword === undefined || v.currentPassword !== v.newPassword, {
    path: ['newPassword'],
    message: 'The new password must differ from the current one',
  });
export type ChangePasswordBody = z.infer<typeof changePasswordBody>;
