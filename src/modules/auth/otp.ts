// Parent OTP sign-in (contract §2/§6, BP §5.1, §4.6). Only phones registered by an active school
// (school_parents) receive a code. Responses for unknown or unregistered numbers are identical in
// status and shape: the resend cooldown (SMS_OTP_RESEND_SECONDS), the per-phone daily cap
// (SMS_OTP_DAILY_CAP, Asia/Kolkata calendar day) and the global circuit breaker are all checked in
// the KV store before the database is consulted, so the endpoint cannot be used to enumerate parents.
// Codes: 6 digits, stored only as an HMAC bound to the phone, SMS_OTP_EXPIRY_MIN expiry,
// SMS_OTP_MAX_ATTEMPTS attempts (otp_request / otp_verify SECURITY DEFINER functions,
// advisory-locked per phone). The SMS is sent asynchronously so the response time and status never
// depend on whether a code was issued or delivered (failures are logged, never returned).
// Global daily circuit breaker (SMS_OTP_GLOBAL_DAILY_CAP): counts real provider sends (atomic KV
// increment); once reached, every request gets the same 503 until local midnight. Checks that only
// apply to registered numbers (the DB cooldown inside otp_request, losing the breaker race) never
// change the answer: they resolve the normal 202 without sending.
import { DateTime } from 'luxon';
import { generateNumericOtp, hashOtp, sha256Hex } from '../../shared/crypto.js';
import { rateLimited, serviceUnavailable, unauthenticated } from '../../shared/errors.js';
import { kvKey, type KvStore } from '../../shared/kv.js';
import { logger as rootLogger } from '../../shared/logger.js';
import type { SmsChannel } from '../../shared/notifications/sms.js';
import { maskPhone } from '../../shared/phone.js';
import { OTP_DAY_TIMEZONE, OTP_DIGITS, OTP_PURPOSE, otpPolicyFromConfig, type OtpPolicy } from './policy.js';
import * as repo from './repository.js';
import type { ParentOtpVerifyBody } from './schemas.js';
import { startParentSession, type LoginResult } from './service.js';
import type { ClientInfo } from './sessions.js';

const log = rootLogger.child({ module: 'auth.otp' });

export interface OtpDeps {
  kv: KvStore;
  sms: SmsChannel;
  /** Defaults to config.sms.otp. */
  policy?: OtpPolicy;
  /** Clock (tests). */
  now?: () => Date;
}

export interface OtpRequestResult {
  status: 'sent';
  expiresInSeconds: number;
  resendAfterSeconds: number;
  codeLength: number;
}

const phoneId = (phone: string) => sha256Hex(phone).slice(0, 40);
const cooldownKey = (phone: string) => kvKey('auth', 'otp-cooldown', phoneId(phone));
const dailyKey = (day: string, phone: string) => kvKey('auth', 'otp-daily', day, phoneId(phone));
export const globalSendsKey = (day: string) => kvKey('sms', 'otp-global-sends', day);
export const globalTrippedKey = (day: string) => kvKey('sms', 'otp-global-tripped', day);

const cooldownError = (seconds: number) =>
  rateLimited(seconds, 'Please wait before requesting another code.', { reason: 'OTP_COOLDOWN', retryAfterSeconds: Math.max(1, Math.ceil(seconds)) });
const dailyCapError = (seconds: number) =>
  rateLimited(seconds, 'Too many codes requested for this number today. Please try again tomorrow.', { reason: 'OTP_DAILY_CAP', retryAfterSeconds: Math.max(1, Math.ceil(seconds)) });
const unavailableError = (seconds: number) =>
  serviceUnavailable('Sign-in codes cannot be sent right now. Please try again later.', undefined, { headers: { 'Retry-After': String(Math.max(1, Math.ceil(seconds))) } });
const invalidCode = () => unauthenticated('The code is invalid or has expired. Request a new code and try again.', { reason: 'OTP_INVALID' });

/** Local calendar day (Asia/Kolkata) and the seconds left until its midnight. */
export function otpDay(now: Date = new Date()): { day: string; secondsToMidnight: number } {
  const local = DateTime.fromJSDate(now).setZone(OTP_DAY_TIMEZONE);
  const midnight = local.startOf('day').plus({ days: 1 });
  return { day: local.toISODate()!, secondsToMidnight: Math.max(1, Math.ceil(midnight.diff(local, 'seconds').seconds)) };
}

/** Logs the global-breaker trip once per local day (across instances). */
async function logBreakerTrip(kv: KvStore, policy: OtpPolicy, day: string, secondsToMidnight: number): Promise<void> {
  if (await kv.setIfAbsent(globalTrippedKey(day), '1', secondsToMidnight + 3600)) {
    log.error({ cap: policy.globalDailyCap, day }, 'OTP SMS global daily cap reached (SMS_OTP_GLOBAL_DAILY_CAP): no more OTP SMS until local midnight (Asia/Kolkata)');
  }
}

/** Global breaker tripped (checked before any per-number work): the generic 503 for every number. */
async function breakerTripped(kv: KvStore, policy: OtpPolicy, day: string, secondsToMidnight: number): Promise<never> {
  await logBreakerTrip(kv, policy, day, secondsToMidnight);
  throw unavailableError(secondsToMidnight);
}

function result(policy: OtpPolicy): OtpRequestResult {
  return { status: 'sent', expiresInSeconds: policy.expirySeconds, resendAfterSeconds: policy.resendSeconds, codeLength: OTP_DIGITS };
}

/** POST /auth/parent/otp/request. */
export async function requestOtp(deps: OtpDeps, phone: string, ip: string | null): Promise<OtpRequestResult> {
  const { kv, sms } = deps;
  const policy = deps.policy ?? otpPolicyFromConfig();
  const { day, secondsToMidnight } = otpDay(deps.now?.() ?? new Date());

  // 1. Global circuit breaker (same answer for every number).
  if (Number((await kv.get(globalSendsKey(day))) ?? 0) >= policy.globalDailyCap) await breakerTripped(kv, policy, day, secondsToMidnight);
  // 2. Per-phone daily cap, registered or not.
  const daily = dailyKey(day, phone);
  if (Number((await kv.get(daily)) ?? 0) >= policy.dailyCapPerPhone) throw dailyCapError(secondsToMidnight);
  // 3. Resend cooldown, registered or not.
  const key = cooldownKey(phone);
  if (!(await kv.setIfAbsent(key, '1', policy.resendSeconds))) {
    const ttl = await kv.ttlMs(key);
    throw cooldownError(ttl > 0 ? ttl / 1000 : policy.resendSeconds);
  }
  if ((await kv.incr(daily, secondsToMidnight + 60)).count > policy.dailyCapPerPhone) throw dailyCapError(secondsToMidnight);

  const parent = await repo.findParent(phone);
  if (!parent || !parent.is_active || !parent.has_active_link) {
    log.info({ phone: maskPhone(phone) }, 'OTP requested for a number without an eligible parent account (no code sent)');
    return result(policy);
  }

  // 4. Count the real provider send before issuing the code (atomic across instances). Losing the race
  //    at the trip moment must look exactly like an unknown number (202, nothing sent): only step 1,
  //    which runs before the registration lookup, may answer 503.
  const countsTowardCap = sms.sendsRealSms(phone);
  if (countsTowardCap && (await kv.incr(globalSendsKey(day), secondsToMidnight + 3600)).count > policy.globalDailyCap) {
    await kv.decr(globalSendsKey(day)); // nothing is sent; the counter stays at the cap, so step 1 trips
    await logBreakerTrip(kv, policy, day, secondsToMidnight);
    log.warn({ phone: maskPhone(phone) }, 'OTP not sent: global daily SMS cap reached while this request was in flight');
    return result(policy);
  }

  const code = generateNumericOtp(OTP_DIGITS);
  const refundSend = async () => {
    if (countsTowardCap) await kv.decr(globalSendsKey(day)); // nothing was sent
  };
  let r: Awaited<ReturnType<typeof repo.otpRequest>>;
  try {
    r = await repo.otpRequest({
      phone,
      purpose: OTP_PURPOSE,
      codeHash: hashOtp(code, phone),
      ttlSeconds: policy.expirySeconds,
      cooldownSeconds: policy.resendSeconds,
      maxAttempts: policy.maxAttempts,
      ip,
    });
  } catch (err) {
    await refundSend();
    throw err;
  }
  if (!r || r.status === 'cooldown') {
    // The DB cooldown exists only for registered parents, so it must never surface as a 429 (that
    // would reveal registration whenever the KV cooldown, the uniform gate, was lost or expired
    // first). Answer like an unknown number: 202, no new code, nothing sent.
    await refundSend();
    log.info({ phone: maskPhone(phone), retryAfterSeconds: r?.retry_after_s ?? null }, 'OTP not re-issued: the previous code is still inside the resend cooldown (no SMS sent)');
    return result(policy);
  }
  void sms.sendOtp(phone, code).then(
    (res) => {
      if (!res.delivered) log.error({ phone: maskPhone(phone), provider: res.provider, error: res.error }, 'OTP SMS delivery failed');
    },
    (err: unknown) => log.error({ phone: maskPhone(phone), err: { message: (err as Error).message } }, 'OTP SMS delivery failed'),
  );
  return result(policy);
}

/** POST /auth/parent/otp/verify → parent session. */
export async function verifyOtp(body: ParentOtpVerifyBody, client: ClientInfo): Promise<LoginResult> {
  if ((await repo.otpVerify(body.phone, OTP_PURPOSE, hashOtp(body.otp, body.phone))) !== 'ok') throw invalidCode();
  const parent = await repo.findParent(body.phone);
  if (!parent || !parent.is_active || !parent.has_active_link) throw invalidCode();
  log.info({ parent: maskPhone(body.phone) }, 'Parent signed in with OTP');
  return startParentSession(parent.id, client, body.device, 'otp');
}
