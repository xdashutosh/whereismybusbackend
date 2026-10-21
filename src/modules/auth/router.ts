// 'auth' module router (BP §8.1, contract §6). Mounted at /api/v1.
//   POST /auth/platform/login · /auth/platform/totp/setup · /auth/platform/totp/verify
//   POST /auth/school/login · /auth/staff/login
//   POST /auth/parent/otp/request · /auth/parent/otp/verify · /auth/parent/password-login
//   POST /auth/refresh · /auth/logout · /auth/logout-all · /auth/change-password
//   GET  /auth/me · /auth/device (driver/conductor: verifies the device binding)
// createAuthRouter(deps) lets tests inject the KV store, SMS channel, OTP policy, clock and rate limiters.
// Expected next steps of a sign-in (enrolment challenge, lockout.ts nextStep() errors) are marked as
// non-failures for the failuresOnly route limiters (rateLimits.ts markNotFailure).
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { createGuards, type GuardOptions } from '../../middleware/guards.js';
import { rateLimits as defaultRateLimits, markNotFailure, type RateLimits } from '../../middleware/rateLimits.js';
import { resolveTenant } from '../../middleware/resolveTenant.js';
import { ok } from '../../shared/envelope.js';
import { isAppError, unauthenticated } from '../../shared/errors.js';
import { kv as defaultKv, type KvStore } from '../../shared/kv.js';
import { channels } from '../../shared/notifications/index.js';
import type { SmsChannel } from '../../shared/notifications/sms.js';
import { validate, validated } from '../../shared/validate.js';
import { changePassword, logoutAll } from './account.js';
import { clearRefreshCookie, clientInfo, logout, refreshTokenOf, sendLogin, tokenPayload } from './controller.js';
import { requireBoundDevice } from './device.js';
import { isNextStep } from './lockout.js';
import { requestOtp, verifyOtp } from './otp.js';
import type { OtpPolicy } from './policy.js';
import { buildProfile } from './profile.js';
import * as s from './schemas.js';
import { parentPasswordLogin, schoolAdminLogin, staffLogin } from './service.js';
import { rotateRefreshToken } from './sessions.js';
import { platformLogin, totpSetup, totpVerify } from './totp.js';

/** Refresh failures after which the refresh cookie is useless (revoked/expired/reused token, closed school). */
const DEFINITIVE_REFRESH_CODES: ReadonlySet<string> = new Set(['UNAUTHENTICATED', 'FORBIDDEN', 'SCHOOL_INACTIVE']);
export function isDefinitiveRefreshFailure(err: unknown): boolean {
  return isAppError(err) && (err.status === 401 || err.status === 403 || DEFINITIVE_REFRESH_CODES.has(err.code));
}

export interface AuthRouterDeps {
  kv?: KvStore;
  sms?: SmsChannel;
  /** OTP limits; defaults to config.sms.otp (SMS_OTP_*). */
  otpPolicy?: OtpPolicy;
  /** Clock for the OTP daily caps (tests). */
  now?: () => Date;
  rateLimits?: RateLimits;
  guards?: GuardOptions;
}

const SCHOOL_SCOPED = new Set(['school_admin', 'driver', 'conductor']);

export function createAuthRouter({ kv = defaultKv, sms = channels.sms, otpPolicy, now, rateLimits = defaultRateLimits, guards: guardOptions = {} }: AuthRouterDeps = {}): Router {
  const r = Router();
  const rl = rateLimits;
  const g = createGuards(guardOptions);
  const authed = authenticate({ ...guardOptions.authenticate, allowPasswordChange: true });
  const tenant = resolveTenant(guardOptions.tenant);
  /** School users must belong to an active school even on /auth/me (BP App. C). */
  const schoolStateForStaff = (req: Request, res: Response, next: NextFunction) => (req.auth && SCHOOL_SCOPED.has(req.auth.role) ? tenant(req, res, next) : next());

  // ── Super Admin ────────────────────────────────────────────────────────────
  r.post('/auth/platform/login', rl.loginIp, rl.login, validate({ body: s.platformLoginBody }), async (req, res) => {
    const outcome = await platformLogin(kv, validated(req, 'body'), clientInfo(req));
    if (outcome.status === 'totp_enrollment_required') {
      markNotFailure(res); // a challenge (next step), never a failure — independent of its status
      res.setHeader('Cache-Control', 'no-store');
      return ok(res, outcome);
    }
    return sendLogin(req, res, outcome);
  });
  r.post('/auth/platform/totp/setup', rl.totpVerify, validate({ body: s.totpSetupBody }), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    ok(res, await totpSetup(kv, validated(req, 'body')));
  });
  r.post('/auth/platform/totp/verify', rl.totpVerify, validate({ body: s.totpVerifyBody }), async (req, res) => {
    await sendLogin(req, res, await totpVerify(kv, validated(req, 'body'), clientInfo(req)));
  });

  // ── School admin, staff ────────────────────────────────────────────────────
  r.post('/auth/school/login', rl.loginIp, rl.login, validate({ body: s.schoolLoginBody }), async (req, res) => {
    await sendLogin(req, res, await schoolAdminLogin({ kv }, validated(req, 'body'), clientInfo(req)));
  });
  r.post('/auth/staff/login', rl.loginIp, rl.login, validate({ body: s.staffLoginBody }), async (req, res) => {
    await sendLogin(req, res, await staffLogin({ kv }, validated(req, 'body'), clientInfo(req)));
  });

  // ── Parents ────────────────────────────────────────────────────────────────
  r.post('/auth/parent/otp/request', rl.otpRequestIp, rl.otpRequestPhone, validate({ body: s.parentOtpRequestBody }), async (req, res) => {
    const { phone } = validated<s.ParentOtpRequestBody>(req, 'body');
    res.setHeader('Cache-Control', 'no-store');
    ok(res, await requestOtp({ kv, sms, ...(otpPolicy ? { policy: otpPolicy } : {}), ...(now ? { now } : {}) }, phone, clientInfo(req).ip), { status: 202 });
  });
  r.post('/auth/parent/otp/verify', rl.otpVerify, validate({ body: s.parentOtpVerifyBody }), async (req, res) => {
    await sendLogin(req, res, await verifyOtp(validated(req, 'body'), clientInfo(req)));
  });
  r.post('/auth/parent/password-login', rl.loginIp, rl.login, validate({ body: s.parentPasswordLoginBody }), async (req, res) => {
    await sendLogin(req, res, await parentPasswordLogin({ kv }, validated(req, 'body'), clientInfo(req)));
  });

  // ── Sessions ───────────────────────────────────────────────────────────────
  r.post('/auth/refresh', rl.refreshIp, rl.refresh, validate({ body: s.refreshBody }), async (req, res) => {
    const token = refreshTokenOf(req);
    if (!token) throw unauthenticated('A refresh token is required.', { reason: 'MISSING_TOKEN' });
    try {
      const { session } = await rotateRefreshToken(token, clientInfo(req));
      ok(res, tokenPayload(res, session));
    } catch (err) {
      // Only a token that can never work again loses its cookie; a 5xx / unexpected failure keeps it, so
      // the client's temporary-failure retry can still restore the session (no sign-out of every tab).
      if (isDefinitiveRefreshFailure(err)) clearRefreshCookie(res);
      throw err;
    }
  });
  r.post('/auth/logout', validate({ body: s.refreshBody }), logout);
  r.post('/auth/logout-all', authed, async (req, res) => {
    const result = await logoutAll(req.auth!);
    clearRefreshCookie(res);
    ok(res, result);
  });
  r.post('/auth/change-password', authed, rl.passwordChange, validate({ body: s.changePasswordBody }), async (req, res) => {
    ok(res, await changePassword(req.auth!, validated(req, 'body')));
  });
  r.get('/auth/me', authed, schoolStateForStaff, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    ok(res, await buildProfile(req, req.auth!));
  });
  r.get('/auth/device', ...g.staff(), requireBoundDevice(), (req, res) => {
    ok(res, { bound: true, device: req.boundDevice });
  });

  // An expected next step thrown by a flow (lockout.ts nextStep(): 401 TOTP_REQUIRED while the TOTP
  // code is still missing) is not a failure: the failuresOnly route limiters refund it, in agreement
  // with the account lockout. The central errorHandler then renders the error as usual.
  r.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (isNextStep(err)) markNotFailure(res);
    next(err);
  });
  return r;
}

export const router: Router = createAuthRouter();
export default router;
