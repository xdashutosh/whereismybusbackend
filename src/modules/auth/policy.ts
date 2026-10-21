// Authentication policy constants (BP §5.4, contract §2/§6). One place for every limit the auth
// module enforces in addition to the route rate limiters (middleware/rateLimits.ts).
import { API_PREFIX, REFRESH_COOKIE_NAME } from '@wimb/shared';
import type { CookieOptions } from 'express';
import config from '../../config/index.js';

/** Consecutive failed sign-ins before an account is locked (BP §5.4 "lock after N failures"). */
export const MAX_FAILED_LOGINS = 5;
/** Lockout cooldown. */
export const LOCKOUT_MINUTES = 15;

/** Parent OTP (contract §2): 6 digits, hashed; the limits come from env (config.sms.otp). */
export const OTP_DIGITS = 6;
export const OTP_PURPOSE = 'parent_login';
/** Daily OTP caps reset at local midnight in this zone (DLT / Indian operations). */
export const OTP_DAY_TIMEZONE = 'Asia/Kolkata';

/**
 * OTP policy (SMS_OTP_EXPIRY_MIN, SMS_OTP_MAX_ATTEMPTS, SMS_OTP_RESEND_SECONDS, SMS_OTP_DAILY_CAP,
 * SMS_OTP_GLOBAL_DAILY_CAP). Injected into the auth router so tests can vary it.
 */
export interface OtpPolicy {
  readonly expirySeconds: number;
  readonly maxAttempts: number;
  readonly resendSeconds: number;
  readonly dailyCapPerPhone: number;
  readonly globalDailyCap: number;
}

export function otpPolicyFromConfig(otp: OtpPolicy = config.sms.otp): OtpPolicy {
  const { expirySeconds, maxAttempts, resendSeconds, dailyCapPerPhone, globalDailyCap } = otp;
  return { expirySeconds, maxAttempts, resendSeconds, dailyCapPerPhone, globalDailyCap };
}

/**
 * Refresh grace window (migration 900): re-presenting a refresh token that was rotated at most this many
 * seconds ago, from the same client and device, returns the same successor instead of counting as a
 * reuse (concurrent refreshes from two isolates of one app, retries after a lost response). Max 30 s.
 */
export const REFRESH_GRACE_SECONDS = 30;
/** Purpose of the key that encrypts successor tokens at rest (shared/crypto.ts encryptSecret). */
export const REFRESH_GRACE_KEY_PURPOSE = 'refresh-grace';

/** Super Admin TOTP enrolment challenge (issued after a correct password, before enrolment). */
export const TOTP_CHALLENGE_TTL_SECONDS = 600;

/** Password rules (server-side; the web form mirrors them). */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/** Header that switches the refresh token into the httpOnly cookie (web clients). */
export const WEB_CLIENT_VALUE = 'web';

/** Cookie path: the refresh cookie is only ever sent to the auth endpoints. */
export const REFRESH_COOKIE_PATH = `${API_PREFIX}/auth`;

export function refreshCookieOptions(maxAgeMs = config.jwt.refreshTtlSeconds * 1000): CookieOptions {
  return {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'strict',
    path: REFRESH_COOKIE_PATH,
    maxAge: maxAgeMs,
  };
}

export { REFRESH_COOKIE_NAME };
