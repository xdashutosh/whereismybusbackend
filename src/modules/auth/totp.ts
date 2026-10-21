// Super Admin sign-in with TOTP (contract §2/§6, BP §5.1, §20 #9).
//   1. POST /auth/platform/login {email, password[, totpCode]}
//      - TOTP enrolled  → totpCode required (TOTP_REQUIRED without it: the expected next step, never
//        counted as a failure), verified with replay protection (totp_last_used_step) → session.
//      - not enrolled   → no session; a short-lived enrolment challenge is returned.
//   2. POST /auth/platform/totp/setup {challengeToken} → otpauth URI + QR data URL (+ secret);
//      the encrypted secret is stored but not yet enabled.
//   3. POST /auth/platform/totp/verify {challengeToken, code} → enables TOTP and signs in.
// Challenges live in the KV store (Redis in production) keyed by the SHA-256 of the token.
import { withPlatform } from '../../db/tenant.js';
import {
  decryptSecret,
  encryptSecret,
  generateOpaqueToken,
  generateTotpSecret,
  hashToken,
  totpQrDataUrl,
  totpUri,
  verifyAgainstDummy,
  verifyPassword,
  verifyTotpStep,
} from '../../shared/crypto.js';
import { AppError, forbidden, totpRequired, unauthenticated } from '../../shared/errors.js';
import { getJson, kvKey, setJson, type KvStore } from '../../shared/kv.js';
import { beginAttempt, clearAttempts, failKnown, failUnknown, nextStep, refundOnError } from './lockout.js';
import { TOTP_CHALLENGE_TTL_SECONDS } from './policy.js';
import * as repo from './repository.js';
import type { PlatformLoginBody, TotpSetupBody, TotpVerifyBody } from './schemas.js';
import { auditAuth, createSession, type ClientInfo, type SessionOwner } from './sessions.js';
import type { LoginResult } from './service.js';

const TOTP_PURPOSE = 'totp';

export type PlatformLoginOutcome =
  | ({ status: 'authenticated' } & LoginResult)
  | { status: 'totp_enrollment_required'; challengeToken: string; challengeExpiresAt: string };

interface Challenge {
  platformUserId: string;
}

const challengeKey = (token: string) => kvKey('auth', 'totp-challenge', hashToken(token));
const invalidChallenge = () => unauthenticated('The enrolment session has expired. Please sign in again.', { reason: 'CHALLENGE_INVALID' });

function ownerOf(id: string): SessionOwner {
  return { ownerType: 'platform_user', ownerId: id, role: 'super_admin', schoolId: null };
}

export async function platformLogin(kv: KvStore, body: PlatformLoginBody, client: ClientInfo): Promise<PlatformLoginOutcome> {
  const row = await repo.findPlatformUser(body.email);
  if (!row) {
    const attempt = await beginAttempt(kv, { kind: 'unknown', loginKind: 'platform', identifier: body.email });
    await verifyAgainstDummy(body.password);
    return failUnknown(attempt);
  }
  // One reservation covers the password AND the TOTP code of this request (lockout.ts), so a
  // parallel burst cannot test more than MAX_FAILED_LOGINS codes either.
  const attempt = await beginAttempt(kv, {
    kind: 'account',
    ownerType: 'platform_user',
    ownerId: row.id,
    lockedUntil: row.locked_until,
    reloadLockedUntil: async () => (await repo.findPlatformUser(body.email))?.locked_until ?? null,
  });
  const target = { ownerType: 'platform_user' as const, ownerId: row.id, ctx: { schoolId: null, actorId: row.id, role: 'super_admin' as const } };
  if (!(await verifyPassword(row.password_hash, body.password))) return failKnown(attempt, target, 'bad_password');
  // Not credential failures (refunded): deactivated account, enrolment pending, code missing (the
  // next step of this sign-in: nextStep() also keeps it out of the route rate limiter).
  const step = await refundOnError(attempt, async () => {
    if (!row.is_active) throw forbidden('This account has been deactivated.');
    if (!row.totp_enabled) return null;
    if (!body.totpCode) throw nextStep(totpRequired('Enter the 6-digit code from your authenticator app.', { reason: 'TOTP_CODE_MISSING' }));
    const secret = decryptSecret(row.totp_secret_enc ?? '', { purpose: TOTP_PURPOSE });
    return verifyTotpStep(secret, body.totpCode, { afterTimeStep: row.totp_last_used_step });
  });

  if (!row.totp_enabled) {
    const challengeToken = generateOpaqueToken(32);
    await setJson(kv, challengeKey(challengeToken), { platformUserId: row.id } satisfies Challenge, TOTP_CHALLENGE_TTL_SECONDS);
    await clearAttempts(attempt);
    return { status: 'totp_enrollment_required', challengeToken, challengeExpiresAt: new Date(Date.now() + TOTP_CHALLENGE_TTL_SECONDS * 1000).toISOString() };
  }
  if (step === null) return failKnown(attempt, target, 'bad_totp', totpRequired('The authenticator code is invalid or was already used.', { reason: 'TOTP_CODE_INVALID' }));

  const owner = ownerOf(row.id);
  const session = await withPlatform({ actorId: row.id }, async (tx) => {
    if (!(await repo.useTotpStep(tx, row.id, step))) return null; // replayed concurrently
    const s = await createSession(tx, owner, client, { touchLogin: true });
    await auditAuth(tx, { action: 'auth.login', entityType: 'session', entityId: s.sessionId, new: { method: 'password+totp', client: client.client }, actorName: row.name });
    return s;
  });
  if (!session) return failKnown(attempt, target, 'totp_replayed', totpRequired('The authenticator code was already used.', { reason: 'TOTP_CODE_INVALID' }));
  await clearAttempts(attempt);
  return { status: 'authenticated', session, owner, mustChangePassword: row.must_change_password };
}

async function challengeUser(kv: KvStore, token: string): Promise<string> {
  const c = await getJson<Challenge>(kv, challengeKey(token));
  if (!c?.platformUserId) throw invalidChallenge();
  return c.platformUserId;
}

/** Generates (or regenerates) the pending secret of an un-enrolled Super Admin. */
export async function totpSetup(kv: KvStore, body: TotpSetupBody) {
  const userId = await challengeUser(kv, body.challengeToken);
  const secret = generateTotpSecret();
  const email = await withPlatform({ actorId: userId }, async (tx) => {
    const u = await repo.pendingTotpSecret(tx, userId);
    if (!u || !u.is_active) throw invalidChallenge();
    if (u.totp_enabled) throw new AppError('INVALID_STATE', 'Two-factor authentication is already enabled.');
    await repo.storeTotpSecret(tx, userId, encryptSecret(secret, { purpose: TOTP_PURPOSE }));
    return u.email;
  });
  const otpauthUri = totpUri(secret, email);
  return { otpauthUri, qrDataUrl: await totpQrDataUrl(otpauthUri), secret, issuerLabel: email };
}

/** Confirms enrolment with a first code and signs the Super Admin in. */
export async function totpVerify(kv: KvStore, body: TotpVerifyBody, client: ClientInfo): Promise<LoginResult> {
  const userId = await challengeUser(kv, body.challengeToken);
  const owner = ownerOf(userId);
  const pending = await withPlatform({ actorId: userId }, (tx) => repo.pendingTotpSecret(tx, userId), { readOnly: true });
  if (!pending || !pending.is_active) throw invalidChallenge();
  if (pending.totp_enabled) throw new AppError('INVALID_STATE', 'Two-factor authentication is already enabled.');
  if (!pending.totp_secret_enc) throw new AppError('INVALID_STATE', 'Start the set-up first.');
  const step = await verifyTotpStep(decryptSecret(pending.totp_secret_enc, { purpose: TOTP_PURPOSE }), body.code);
  if (step === null) throw totpRequired('The authenticator code is invalid. Check the time on your phone and try again.', { reason: 'TOTP_CODE_INVALID' });
  const session = await withPlatform({ actorId: userId }, async (tx) => {
    if (!(await repo.enableTotp(tx, userId, step))) throw new AppError('INVALID_STATE', 'Two-factor authentication is already enabled.');
    await auditAuth(tx, { action: 'auth.totp_enroll', entityType: 'platform_user', entityId: userId, actorName: pending.name });
    const s = await createSession(tx, owner, client, { touchLogin: true });
    await auditAuth(tx, { action: 'auth.login', entityType: 'session', entityId: s.sessionId, new: { method: 'password+totp_enrolment', client: client.client }, actorName: pending.name });
    return s;
  });
  await kv.del(challengeKey(body.challengeToken));
  return { session, owner, mustChangePassword: false };
}
