// Sign-in lockout (BP §5.4): N failures within a window lock the subject for a cooldown.
//
// Every attempt RESERVES a slot atomically before the credential is checked (KV INCR in a fixed
// window of LOCKOUT_MINUTES that starts at the first failure). Only reservations 1…N are evaluated;
// later ones in the window, and every attempt while the lock is active, are refused with 429
// ACCOUNT_LOCKED without verifying anything — so a parallel burst can never test more than N
// passwords / PINs / TOTP codes. The Nth failure sets the lock: for real accounts first
// users|platform_users|parent_accounts.locked_until (committed), then a KV lock key with a TTL of
// LOCKOUT_MINUTES that closes the race for requests which read the row before the lock. The ROW is
// authoritative for real accounts: when the KV lock exists, the row is re-read and a lock that was
// cleared there (super admin password reset, operator unlock) or has expired also clears the KV
// lock — an unlocked account is never kept out by a stale KV key, and a flushed KV store still
// honours the row. A success clears the counter; outcomes that are not failures (TOTP code still
// missing, deactivated account, blocked device…) refund the slot. Expected next steps of a sign-in
// (TOTP code still missing) are also tagged with nextStep(): the auth router then marks their
// responses so the failuresOnly route limiters agree (middleware/rateLimits.ts markNotFailure).
//
// Known accounts (keyed by owner id) and unknown identifiers (keyed by a hash of the identifier)
// use exactly the same counters, windows and lock durations, so responses never reveal whether an
// account exists. A KV outage fails open (logged), like the route rate limiters; the row lock
// written by earlier failures is still enforced.
import type { OwnerType } from '@wimb/shared';
import { withTenant, type TenantContext } from '../../db/tenant.js';
import { sha256Hex } from '../../shared/crypto.js';
import { rateLimited, unauthenticated, type AppError } from '../../shared/errors.js';
import { kvKey, type KvStore } from '../../shared/kv.js';
import { logger as rootLogger } from '../../shared/logger.js';
import { LOCKOUT_MINUTES, MAX_FAILED_LOGINS } from './policy.js';
import * as repo from './repository.js';
import { auditAuth } from './sessions.js';

const log = rootLogger.child({ module: 'auth.lockout' });

/** Prefix of every lockout key (fail counters and locks). */
export const LOCKOUT_KEY_PREFIX = 'auth-lockout';
const WINDOW_SECONDS = LOCKOUT_MINUTES * 60;

export const invalidCredentials = (message = 'The sign-in details are incorrect.'): AppError => unauthenticated(message);

export function lockedError(retryAfterSeconds: number): AppError {
  return rateLimited(retryAfterSeconds, 'Too many failed sign-in attempts. Please try again later.', { reason: 'ACCOUNT_LOCKED', retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds)) });
}

/** Throws ACCOUNT_LOCKED (429) while a row's lock is active. */
export function assertNotLocked(row: { locked_until: string | null }, now = Date.now()): void {
  if (!row.locked_until) return;
  const until = Date.parse(row.locked_until);
  if (until > now) throw lockedError((until - now) / 1000);
}

export type LockoutSubject =
  | {
      kind: 'account';
      ownerType: OwnerType;
      ownerId: string;
      /** locked_until as read by the login lookup. */
      lockedUntil: string | null;
      /** Re-reads locked_until (same definer lookup) — called only while a KV lock exists. */
      reloadLockedUntil: () => Promise<string | null>;
    }
  | { kind: 'unknown'; loginKind: string; identifier: string };

export interface LoginAttempt {
  readonly store: KvStore;
  readonly subjectId: string;
  /** Position of this attempt in the window (1-based); null when the KV store was unavailable. */
  readonly count: number | null;
  /** True when a failure of this attempt locks the subject. */
  readonly locksOnFailure: boolean;
}

function subjectIdOf(subject: LockoutSubject): string {
  return subject.kind === 'account'
    ? `${subject.ownerType}-${subject.ownerId}`
    : `${subject.loginKind}-${sha256Hex(subject.identifier.trim().toLowerCase()).slice(0, 40)}`;
}

const failKey = (subjectId: string) => kvKey(LOCKOUT_KEY_PREFIX, 'fail', subjectId);
const lockKey = (subjectId: string) => kvKey(LOCKOUT_KEY_PREFIX, 'lock', subjectId);

const warnStore = (err: unknown) => log.warn({ err: { message: (err as Error).message } }, 'Lockout store unavailable');

/**
 * Reserves one sign-in attempt for `subject` BEFORE its credential is checked. Throws ACCOUNT_LOCKED
 * when the subject is locked or the window's N evaluations are already taken.
 */
export async function beginAttempt(store: KvStore, subject: LockoutSubject): Promise<LoginAttempt> {
  if (subject.kind === 'account') assertNotLocked({ locked_until: subject.lockedUntil });
  const subjectId = subjectIdOf(subject);
  let lockTtl: number;
  try {
    lockTtl = await store.ttlMs(lockKey(subjectId));
  } catch (err) {
    warnStore(err);
    return { store, subjectId, count: null, locksOnFailure: false };
  }
  if (lockTtl !== -2) {
    if (subject.kind === 'unknown') throw lockedError(lockTtl > 0 ? lockTtl / 1000 : WINDOW_SECONDS);
    // The row lock is committed before the KV lock is set, so a fresh read is authoritative: still
    // locked → refuse; cleared (password reset, operator unlock) or expired → drop the stale KV state.
    assertNotLocked({ locked_until: await subject.reloadLockedUntil() });
    await Promise.all([store.del(lockKey(subjectId)), store.del(failKey(subjectId))]).catch(warnStore);
  }
  let count: number;
  try {
    ({ count } = await store.incr(failKey(subjectId), WINDOW_SECONDS));
  } catch (err) {
    warnStore(err);
    return { store, subjectId, count: null, locksOnFailure: false };
  }
  if (count > MAX_FAILED_LOGINS) {
    // Another request of this burst holds the last evaluation; its failure sets the lock.
    const ttl = await store.ttlMs(lockKey(subjectId)).catch(() => -2);
    throw lockedError(ttl > 0 ? ttl / 1000 : WINDOW_SECONDS);
  }
  return { store, subjectId, count, locksOnFailure: count >= MAX_FAILED_LOGINS };
}

/** Successful sign-in: the failure window starts over. */
export async function clearAttempts(attempt: LoginAttempt): Promise<void> {
  await attempt.store.del(failKey(attempt.subjectId)).catch(warnStore);
}

/** The attempt ended without a credential failure (e.g. TOTP code still missing): refund its slot. */
export async function releaseAttempt(attempt: LoginAttempt): Promise<void> {
  if (attempt.count === null) return;
  await attempt.store.decr(failKey(attempt.subjectId)).catch(warnStore);
}

/** Errors tagged by nextStep() (the error object itself — never classified by message or code). */
const nextSteps = new WeakSet<object>();

/**
 * Tags `err` as the expected next step of a multi-step sign-in (e.g. 401 TOTP_REQUIRED while the
 * TOTP code is still missing): not a failure for the lockout nor for the route rate limiters. Wrong
 * credentials (including wrong TOTP codes, also TOTP_REQUIRED) are never tagged.
 */
export function nextStep(err: AppError): AppError {
  nextSteps.add(err);
  return err;
}

export function isNextStep(err: unknown): boolean {
  return typeof err === 'object' && err !== null && nextSteps.has(err);
}

/** Runs `fn`; any AppError it throws refunds the attempt (non-credential outcome), then rethrows. */
export async function refundOnError<T>(attempt: LoginAttempt, fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    await releaseAttempt(attempt);
    throw err;
  }
}

async function lockInStore(attempt: LoginAttempt): Promise<void> {
  try {
    await attempt.store.set(lockKey(attempt.subjectId), '1', WINDOW_SECONDS);
    await attempt.store.del(failKey(attempt.subjectId));
  } catch (err) {
    warnStore(err);
  }
}

export interface FailureTarget {
  ownerType: OwnerType;
  ownerId: string;
  ctx: TenantContext;
  /** Extra audit details (never secrets). */
  details?: Record<string, unknown>;
}

/** Records a failed attempt on a known account (row counters + audit) and throws `error`. */
export async function failKnown(attempt: LoginAttempt, target: FailureTarget, reason: string, error: AppError = invalidCredentials()): Promise<never> {
  // Row first (authoritative), then the KV lock (see the header). Until both exist, requests of
  // the same burst are refused by the window counter (count > N).
  const lockedUntil = await withTenant(target.ctx, async (tx) => {
    const until = await repo.recordLoginFailure(tx, target.ownerType, target.ownerId, {
      count: attempt.count,
      lock: attempt.locksOnFailure,
      maxFailures: MAX_FAILED_LOGINS,
      lockMinutes: LOCKOUT_MINUTES,
    });
    const locked = until !== null && Date.parse(until) > Date.now();
    await auditAuth(tx, {
      action: locked ? 'auth.account_locked' : 'auth.login_failed',
      entityType: target.ownerType,
      entityId: target.ownerId,
      new: { reason, ...(locked ? { lockedUntil: until } : {}), ...(target.details ?? {}) },
      actorName: null,
    });
    return locked ? until : null;
  });
  if (attempt.locksOnFailure) await lockInStore(attempt);
  if (lockedUntil) log.warn({ ownerType: target.ownerType, ownerId: target.ownerId }, 'Account locked after repeated sign-in failures');
  throw error;
}

/** Records a failed attempt for an identifier that matches no account and throws `error`. */
export async function failUnknown(attempt: LoginAttempt, error: AppError = invalidCredentials()): Promise<never> {
  if (attempt.locksOnFailure) await lockInStore(attempt);
  throw error;
}
