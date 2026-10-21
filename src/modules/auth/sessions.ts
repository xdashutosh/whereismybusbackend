// Session lifecycle (BP §5.2, contract §6): opaque refresh tokens stored as SHA-256, one row per
// token; a refresh rotates the token into a NEW row of the same family and marks the old one
// rotated. Presenting a rotated (or revoked) token again is a reuse → the whole family is revoked
// and its sockets are disconnected. Access tokens carry the row id as `sid`.
// Grace window (migration 900, REFRESH_GRACE_SECONDS = 30): the rotation stores the successor's
// refresh token encrypted on the old row with a fingerprint of the rotating client (mobile:
// X-Device-Id, web: user agent). Re-presenting the old token within the window from the same client
// and device — a second isolate refreshing at the same moment, or a retry after a lost response —
// returns that SAME successor (fresh access token for it) instead of revoking the family. Outside
// the window, from another client/device, without a device id (mobile) / user agent (web), or once
// the successor was rotated or revoked itself, reuse detection applies exactly as before.
import type { OwnerType, Role } from '@wimb/shared';
import { withTenant, type TenantContext, type Tx } from '../../db/tenant.js';
import { loadSchoolStateFromDb } from '../../middleware/resolveTenant.js';
import { audit, type AuditEntry } from '../../shared/audit.js';
import { decryptSecret, encryptSecret, generateRefreshToken, hashToken, safeEqual, sha256Hex } from '../../shared/crypto.js';
import { schoolInactive, unauthenticated } from '../../shared/errors.js';
import { logger as rootLogger } from '../../shared/logger.js';
import { realtime } from '../../shared/realtime.js';
import { loadSessionFromDb } from '../../shared/sessions.js';
import { signAccessToken } from '../../shared/tokens.js';
import { REFRESH_GRACE_KEY_PURPOSE, REFRESH_GRACE_SECONDS } from './policy.js';
import * as repo from './repository.js';

const log = rootLogger.child({ module: 'auth.sessions' });

export interface ClientInfo {
  client: 'web' | 'mobile';
  ip: string | null;
  userAgent: string | null;
  appName: string | null;
  appVersion: string | null;
  /** X-Device-Id of the request (installation id; part of the refresh grace fingerprint). */
  deviceUid?: string | null;
}

export interface IssuedSession {
  sessionId: string;
  familyId: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  expiresInSeconds: number;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  client: 'web' | 'mobile';
}

export interface SessionOwner {
  ownerType: OwnerType;
  ownerId: string;
  role: Role;
  /** School of school users; null for super admins and parents. */
  schoolId: string | null;
}

/** Tenant context in which an owner manages its own sessions (RLS: own rows / own school). */
export function ownerContext(o: SessionOwner): TenantContext {
  if (o.ownerType === 'platform_user') return { schoolId: null, actorId: o.ownerId, role: 'super_admin' };
  if (o.ownerType === 'parent_account') return { schoolId: null, actorId: o.ownerId, role: 'parent' };
  return { schoolId: o.schoolId, actorId: o.ownerId, role: o.role };
}

/**
 * Auth events go to the audit log of the actor's scope (school log for school users, platform log
 * for super admins). Parent sign-ins are not written to audit_logs: a school-less parent row would
 * land in the platform log, which must not reveal parent identities to the Super Admin; they are
 * logged (masked) by the application logger instead.
 */
export async function auditAuth(tx: Tx, entry: AuditEntry): Promise<void> {
  if (tx.ctx.role === 'parent') {
    log.info({ action: entry.action, actorType: 'parent_account', actorId: tx.ctx.actorId }, 'Parent auth event');
    return;
  }
  await audit.log(tx, entry);
}

/** Creates a session row (new family unless familyId) and signs its tokens. Runs inside `tx`. */
export async function createSession(
  tx: Tx,
  owner: SessionOwner,
  client: ClientInfo,
  { deviceId = null, familyId = null, touchLogin = false }: { deviceId?: string | null; familyId?: string | null; touchLogin?: boolean } = {},
): Promise<IssuedSession> {
  const refresh = generateRefreshToken();
  const row = await repo.insertSession(
    tx,
    {
      ownerType: owner.ownerType,
      ownerId: owner.ownerId,
      schoolId: owner.ownerType === 'user' ? owner.schoolId : null,
      deviceId,
      familyId,
      refreshHash: refresh.tokenHash,
      client: client.client,
      ip: client.ip,
      userAgent: client.userAgent,
      appName: client.appName,
      appVersion: client.appVersion,
      expiresAt: refresh.expiresAt,
    },
    { touchLogin },
  );
  const access = signAccessToken({ actorId: owner.ownerId, role: owner.role, schoolId: owner.ownerType === 'user' ? owner.schoolId : null, sessionId: row.id });
  return {
    sessionId: row.id,
    familyId: row.family_id,
    accessToken: access.accessToken,
    accessTokenExpiresAt: access.accessTokenExpiresAt,
    expiresInSeconds: access.expiresInSeconds,
    refreshToken: refresh.token,
    refreshTokenExpiresAt: row.expires_at,
    client: client.client,
  };
}

const invalidRefresh = (reason: string) => unauthenticated('Your session has expired. Please sign in again.', { reason });

function fallbackRole(ownerType: OwnerType): Role | 'system' {
  if (ownerType === 'platform_user') return 'super_admin';
  if (ownerType === 'parent_account') return 'parent';
  return 'system'; // school jobs context: may revoke any session of the school
}

/** Revokes a family in its owner's context and disconnects every socket of it. */
async function revokeFamilyAs(ctx: TenantContext, familyId: string, reason: string, auditEntry?: AuditEntry): Promise<void> {
  const ids = await withTenant(ctx, async (tx) => {
    await repo.revokeFamily(tx, familyId, reason);
    if (auditEntry) await auditAuth(tx, auditEntry);
    return repo.familySessionIds(tx, familyId);
  });
  if (ids.length) await realtime.disconnectSessions(ids);
}

/** `revoked_reason` values written when a school closes (platform lifecycle, refresh of a closed school). */
const SCHOOL_CLOSURE_REASONS: ReadonlySet<string> = new Set(['school_deactivated', 'school_suspended', 'school_deleted', 'school_inactive']);

/**
 * Whether a revoked session was revoked because its school closed: a school user's school is (still) not
 * active, or — parents, whose rows carry no school — the revocation reason names a school closure. A
 * failing lookup answers false (the token is revoked either way).
 */
async function revokedByClosedSchool(row: repo.RefreshSessionRow, ctx: TenantContext): Promise<boolean> {
  try {
    if (row.school_id) {
      const school = await loadSchoolStateFromDb(row.school_id);
      return !school || school.deleted || school.status !== 'active';
    }
    if (row.owner_type !== 'parent_account') return false;
    const reason = await withTenant(ctx, (tx) => repo.revokedReasonOf(tx, row.session_id), { readOnly: true });
    return reason !== null && SCHOOL_CLOSURE_REASONS.has(reason);
  } catch (err) {
    log.warn({ err: { message: (err as Error).message }, sessionId: row.session_id }, 'Revocation reason lookup failed');
    return false;
  }
}

/**
 * Fingerprint of the client presenting a refresh token (grace window): mobile → X-Device-Id, web →
 * user agent. null when that identifier is missing — such a client never gets the grace answer.
 */
export function clientFingerprint(client: ClientInfo): string | null {
  const id = (client.client === 'web' ? client.userAgent : client.deviceUid)?.trim();
  return id ? sha256Hex(`${client.client}|${id}`) : null;
}

/** School users need an active school; every owner an active account (else the family is revoked). */
async function assertOwnerActive(row: repo.RefreshSessionRow, actor: Awaited<ReturnType<typeof loadSessionFromDb>>, role: Role | 'system', ctx: TenantContext): Promise<SessionOwner> {
  if (!actor || !actor.actorActive || role === 'system') {
    await revokeFamilyAs(ctx, row.family_id, 'actor_inactive');
    throw invalidRefresh('ACCOUNT_INACTIVE');
  }
  if (row.school_id) {
    const school = await loadSchoolStateFromDb(row.school_id);
    if (!school || school.deleted || school.status !== 'active') {
      await revokeFamilyAs(ctx, row.family_id, 'school_inactive');
      throw schoolInactive();
    }
  }
  return { ownerType: row.owner_type, ownerId: row.owner_id, role: actor.actorRole, schoolId: row.school_id };
}

/**
 * The successor of a rotated row when the grace window applies (see header), as an issued session
 * with a freshly signed access token; null otherwise. Runs inside the owner's transaction.
 */
async function graceSession(tx: Tx, row: repo.RefreshSessionRow, owner: SessionOwner, client: ClientInfo): Promise<IssuedSession | null> {
  const fp = clientFingerprint(client);
  if (!fp) return null;
  const g = await repo.graceSuccessor(tx, row.session_id, REFRESH_GRACE_SECONDS);
  if (!g || !g.in_window || !g.successor_token_enc || !g.successor_client_fp || !safeEqual(g.successor_client_fp, fp)) return null;
  if (g.next_rotated_at || g.next_revoked_at || Date.parse(g.next_expires_at) <= Date.now()) return null;
  let refreshToken: string;
  try {
    refreshToken = decryptSecret(g.successor_token_enc, { purpose: REFRESH_GRACE_KEY_PURPOSE });
  } catch {
    return null; // key rotated since the rotation: no grace, reuse detection decides
  }
  if (!safeEqual(hashToken(refreshToken), g.next_refresh_hash)) return null;
  const access = signAccessToken({ actorId: owner.ownerId, role: owner.role, schoolId: owner.ownerType === 'user' ? owner.schoolId : null, sessionId: g.successor_id });
  log.info({ familyId: row.family_id, ownerType: row.owner_type }, 'Refresh token re-presented within the grace window; successor returned');
  return {
    sessionId: g.successor_id,
    familyId: row.family_id,
    accessToken: access.accessToken,
    accessTokenExpiresAt: access.accessTokenExpiresAt,
    expiresInSeconds: access.expiresInSeconds,
    refreshToken,
    refreshTokenExpiresAt: g.next_expires_at,
    client: client.client,
  };
}

/** Rotates a refresh token (see header). Throws UNAUTHENTICATED / SCHOOL_INACTIVE. */
export async function rotateRefreshToken(token: string, client: ClientInfo): Promise<{ session: IssuedSession; owner: SessionOwner }> {
  const row = await repo.findSessionByRefreshHash(hashToken(token));
  if (!row) throw invalidRefresh('UNKNOWN_TOKEN');
  if (row.client !== client.client) throw invalidRefresh('CLIENT_MISMATCH');
  const actor = await loadSessionFromDb(row.session_id);
  const role = actor?.actorRole ?? fallbackRole(row.owner_type);
  const ctx: TenantContext = row.owner_type === 'user' ? { schoolId: row.school_id, actorId: row.owner_id, role } : { schoolId: null, actorId: row.owner_id, role };
  if (row.revoked_at) {
    // Revoked because the school was deactivated / suspended / deleted: say so (school-inactive message).
    if (await revokedByClosedSchool(row, ctx)) throw schoolInactive();
    throw invalidRefresh('REVOKED');
  }
  const reuse = async (tx: Tx): Promise<string[]> => {
    await repo.revokeFamily(tx, row.family_id, 'refresh_token_reuse');
    await auditAuth(tx, { action: 'auth.refresh_reuse', entityType: 'session', entityId: row.session_id, new: { familyId: row.family_id } });
    return repo.familySessionIds(tx, row.family_id);
  };
  if (row.rotated_at) {
    const owner = actor && actor.actorActive && role !== 'system' ? { ownerType: row.owner_type, ownerId: row.owner_id, role: actor.actorRole, schoolId: row.school_id } : null;
    const outcome = await withTenant(owner ? ownerContext(owner) : ctx, async (tx) => {
      const grace = owner ? await graceSession(tx, row, owner, client) : null;
      if (grace) return { grace };
      log.warn({ familyId: row.family_id, ownerType: row.owner_type, ownerId: row.owner_id }, 'Refresh token reuse detected; family revoked');
      return { ids: await reuse(tx) };
    });
    if (outcome.grace) {
      // Account / school still active? (a grace answer never outlives a deactivation)
      const checked = await assertOwnerActive(row, actor, role, ctx);
      return { session: outcome.grace, owner: checked };
    }
    if (outcome.ids?.length) await realtime.disconnectSessions(outcome.ids);
    throw invalidRefresh('REFRESH_TOKEN_REUSED');
  }
  if (Date.parse(row.expires_at) <= Date.now()) throw invalidRefresh('EXPIRED');
  const owner = await assertOwnerActive(row, actor, role, ctx);
  const result = await withTenant(ownerContext(owner), async (tx) => {
    if (!(await repo.markRotated(tx, row.session_id))) {
      // Lost a race with another refresh of the same token: the winner has committed its successor
      // (the UPDATE waited for its row lock) → the grace answer when it applies, else a reuse.
      const grace = await graceSession(tx, row, owner, client);
      if (grace) return { reused: false as const, session: grace };
      return { reused: true as const, ids: await reuse(tx) };
    }
    const session = await createSession(tx, owner, client, { deviceId: row.device_id, familyId: row.family_id });
    const fp = clientFingerprint(client);
    if (fp) {
      await repo.recordSuccessor(tx, {
        sessionId: row.session_id,
        familyId: row.family_id,
        successorId: session.sessionId,
        tokenEnc: encryptSecret(session.refreshToken, { purpose: REFRESH_GRACE_KEY_PURPOSE }),
        clientFp: fp,
        graceSeconds: REFRESH_GRACE_SECONDS,
      });
    }
    return { reused: false as const, session };
  });
  if (result.reused) {
    if (result.ids.length) await realtime.disconnectSessions(result.ids);
    throw invalidRefresh('REFRESH_TOKEN_REUSED');
  }
  return { session: result.session, owner };
}

/** Revokes the family of a session (logout) → revoked + rotated session ids (for sockets). */
export async function revokeSessionFamily(owner: SessionOwner, sessionId: string, reason: string, auditEntry?: AuditEntry): Promise<string[]> {
  const ids = await withTenant(ownerContext(owner), async (tx) => {
    const familyId = await repo.familyOfSession(tx, sessionId);
    if (!familyId) return [];
    await repo.revokeFamily(tx, familyId, reason);
    if (auditEntry) await auditAuth(tx, auditEntry);
    return repo.familySessionIds(tx, familyId);
  });
  if (ids.length) await realtime.disconnectSessions(ids);
  return ids;
}

/** Logout with a refresh token only (expired access token): revokes its family. */
export async function revokeByRefreshToken(token: string): Promise<boolean> {
  const row = await repo.findSessionByRefreshHash(hashToken(token));
  if (!row || row.revoked_at) return false;
  const actor = await loadSessionFromDb(row.session_id);
  const role = actor?.actorRole ?? fallbackRole(row.owner_type);
  const ctx: TenantContext = row.owner_type === 'user' ? { schoolId: row.school_id, actorId: row.owner_id, role } : { schoolId: null, actorId: row.owner_id, role };
  await revokeFamilyAs(ctx, row.family_id, 'logout', { action: 'auth.logout', entityType: 'session', entityId: row.session_id });
  return true;
}

/**
 * Revokes every session of an owner inside the caller's transaction (deactivation, password
 * reset, logout-all) → revoked ids. Call realtime.disconnectSessions(ids) after commit.
 * Exported for the users/staff/parents modules.
 */
export function revokeAllSessions(tx: Tx, ownerType: OwnerType, ownerId: string, reason: string, { keepFamilyId = null }: { keepFamilyId?: string | null } = {}): Promise<string[]> {
  return repo.revokeOwnerSessions(tx, ownerType, ownerId, reason, keepFamilyId);
}

