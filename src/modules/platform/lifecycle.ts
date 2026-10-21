// School lifecycle and admin access (BP §2.2, §8.2, App. C; contract §4, §6):
//   activate / deactivate (inactive | suspended) / soft delete / reset a school admin's password.
// Closing a school (deactivate, suspend, delete) in ONE platform transaction: status change +
// platform_revoke_school_sessions() (every session of the school's users) + platform audit. After
// commit: the cached school state is evicted (resolveTenant then blocks logins, API calls,
// ingestion and file URLs; refresh is refused), every socket of the school is disconnected, and the
// parents whose only active school this was are signed out through the auth module
// (revokeAllSessions in the parent's own context) and disconnected.
import type { SchoolStatus } from '@wimb/shared';
import type { Request } from 'express';
import { withTenant } from '../../db/tenant.js';
import { invalidateSchoolState } from '../../middleware/resolveTenant.js';
import { audit } from '../../shared/audit.js';
import { invalidState, notFound } from '../../shared/errors.js';
import { events } from '../../shared/events.js';
import { logger as rootLogger } from '../../shared/logger.js';
import { realtime } from '../../shared/realtime.js';
import { ownerContext, revokeAllSessions } from '../auth/index.js';
import { issuePassword, sendPasswordResetEmail } from './credentials.js';
import { toAdminDto, toSchoolDto } from './dto.js';
import * as repo from './repository.js';
import { actorOf, lockLiveSchool, logoUrls, platformTx } from './schools.js';
import type { ActivateSchoolBody, DeactivateSchoolBody, ResetAdminPasswordBody } from './schemas.js';
import * as scope from './schoolScope.js';
import { getSubscriptionState, invalidateSubscriptionState } from './subscription.js';

const log = rootLogger.child({ module: 'platform.lifecycle' });
/** Parallel parent sign-outs after a school closes (each is one small transaction). */
const PARENT_REVOKE_CONCURRENCY = 4;

export interface ClosureResult {
  userSessionsRevoked: number;
  parentsSignedOut: number;
  parentSessionsRevoked: number;
  /** false when the post-commit parent clean-up failed (re-run deactivate to retry). */
  complete: boolean;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Post-commit effects of closing a school (see header). Never throws: failures are logged. */
async function afterSchoolClosed(req: Request, schoolId: string, status: SchoolStatus | 'deleted', m: { reason: string; at: string; userSessionsRevoked: number }): Promise<ClosureResult> {
  invalidateSchoolState(schoolId);
  invalidateSubscriptionState(schoolId);
  events.emit('school.status_changed', { schoolId, status });
  const result: ClosureResult = { userSessionsRevoked: m.userSessionsRevoked, parentsSignedOut: 0, parentSessionsRevoked: 0, complete: true };
  try {
    await realtime.disconnectSchool(schoolId);
    const { userSessionIds, parentIds } = await withTenant(
      { schoolId, actorId: actorOf(req), role: 'system' },
      async (tx) => ({ userSessionIds: await scope.revokedSessionIds(tx, { reason: m.reason, at: m.at }), parentIds: await scope.parentsWithoutActiveSchool(tx) }),
      { readOnly: true },
    );
    if (userSessionIds.length) await realtime.disconnectSessions(userSessionIds);
    const parentSessions = await mapLimit(parentIds, PARENT_REVOKE_CONCURRENCY, async (parentId) => {
      const owner = { ownerType: 'parent_account' as const, ownerId: parentId, role: 'parent' as const, schoolId: null };
      const ids = await withTenant(ownerContext(owner), (tx) => revokeAllSessions(tx, 'parent_account', parentId, m.reason));
      if (ids.length) await realtime.disconnectSessions(ids);
      return ids.length;
    });
    result.parentsSignedOut = parentSessions.filter((n) => n > 0).length;
    result.parentSessionsRevoked = parentSessions.reduce((a, b) => a + b, 0);
  } catch (err) {
    result.complete = false;
    log.error({ schoolId, err: { message: (err as Error).message } }, 'Post-closure clean-up of the school failed');
  }
  log.info({ schoolId, status, ...result }, 'School closed: sessions revoked and sockets disconnected');
  return result;
}

/** POST /platform/schools/:id/deactivate — status inactive (default) or suspended. Idempotent. */
export async function deactivateSchool(req: Request, id: string, body: DeactivateSchoolBody) {
  const reason = body.status === 'suspended' ? 'school_suspended' : 'school_deactivated';
  const r = await platformTx(req, async (tx) => {
    const before = await lockLiveSchool(tx, id);
    const school = await repo.setStatus(tx, id, body.status, body.reason ?? null);
    const revoked = await repo.revokeSchoolSessions(tx, id, reason);
    const at = await repo.txNowExact(tx);
    await audit.log(tx, {
      action: body.status === 'suspended' ? 'school.suspend' : 'school.deactivate',
      entityType: 'school',
      entityId: id,
      old: { status: before.status, statusReason: before.status_reason },
      new: { status: school.status, statusReason: school.status_reason, sessionsRevoked: revoked },
    });
    return { school, revoked, at };
  });
  const closure = await afterSchoolClosed(req, id, body.status, { reason, at: r.at, userSessionsRevoked: r.revoked });
  const logo = await logoUrls(req, r.school);
  return { school: { ...toSchoolDto(r.school), logoUrl: logo.url, logoThumbnailUrl: logo.thumbnailUrl }, sessions: closure };
}

/** POST /platform/schools/:id/activate — back to active (users sign in again). Idempotent. */
export async function activateSchool(req: Request, id: string, body: ActivateSchoolBody) {
  const school = await platformTx(req, async (tx) => {
    const before = await lockLiveSchool(tx, id);
    if (before.status === 'active') return before;
    const after = await repo.setStatus(tx, id, 'active', body.reason ?? null);
    await audit.log(tx, { action: 'school.activate', entityType: 'school', entityId: id, old: { status: before.status, statusReason: before.status_reason }, new: { status: 'active', statusReason: after.status_reason } });
    return after;
  });
  invalidateSchoolState(id);
  invalidateSubscriptionState(id);
  events.emit('school.status_changed', { schoolId: id, status: 'active' });
  // The school is active again, but an expired/cancelled subscription still blocks it.
  const subscription = await getSubscriptionState(id, school.timezone);
  const warnings: string[] = [];
  if (subscription?.status === 'cancelled') warnings.push('SUBSCRIPTION_CANCELLED');
  else if (subscription && (subscription.status === 'expired' || subscription.lapsed)) warnings.push('SUBSCRIPTION_EXPIRED');
  const logo = await logoUrls(req, school);
  return { school: { ...toSchoolDto(school), logoUrl: logo.url, logoThumbnailUrl: logo.thumbnailUrl }, warnings };
}

/** DELETE /platform/schools/:id — soft delete of a deactivated school (closes it like deactivate). */
export async function deleteSchool(req: Request, id: string, body: { reason?: string | null }) {
  const reason = 'school_deleted';
  const r = await platformTx(req, async (tx) => {
    const before = await lockLiveSchool(tx, id);
    if (before.status === 'active') throw invalidState('Deactivate the school before deleting it.', { reason: 'SCHOOL_ACTIVE' });
    const school = await repo.softDelete(tx, id, body.reason ?? null);
    const revoked = await repo.revokeSchoolSessions(tx, id, reason);
    const at = await repo.txNowExact(tx);
    await audit.log(tx, { action: 'school.delete', entityType: 'school', entityId: id, old: { status: before.status, deletedAt: null }, new: { deletedAt: school.deleted_at, sessionsRevoked: revoked } });
    return { school, revoked, at };
  });
  const closure = await afterSchoolClosed(req, id, 'deleted', { reason, at: r.at, userSessionsRevoked: r.revoked });
  return { school: { ...toSchoolDto(r.school), logoUrl: null, logoThumbnailUrl: null }, sessions: closure };
}

/**
 * POST /platform/schools/:id/admin/reset-password — a school admin's access only (BP §2.2): new
 * temporary password, forced change, lockout cleared, every session revoked and disconnected.
 */
export async function resetAdminPassword(req: Request, id: string, body: ResetAdminPasswordBody) {
  const credential = await issuePassword(body.password, ['password']);
  const r = await platformTx(req, async (tx) => {
    const school = await lockLiveSchool(tx, id);
    const admins = await repo.schoolAdmins(tx, id);
    const admin = body.userId ? admins.find((a) => a.id === body.userId) : (admins.find((a) => a.is_active) ?? admins[0]);
    if (!admin) throw notFound('School admin not found.');
    if (!(await repo.resetSchoolAdminPassword(tx, id, admin.id, credential.hash))) throw notFound('School admin not found.');
    const at = await repo.txNowExact(tx);
    await audit.log(tx, {
      action: 'school.admin_password_reset',
      entityType: 'user',
      entityId: admin.id,
      new: { schoolId: id, adminEmail: admin.email, passwordDelivery: body.delivery, passwordGenerated: credential.generated },
    });
    return { school, admin, at };
  });
  const sessionIds = await withTenant(
    { schoolId: id, actorId: actorOf(req), role: 'system' },
    (tx) => scope.revokedSessionIds(tx, { reason: 'password_reset', at: r.at, ownerId: r.admin.id }),
    { readOnly: true },
  );
  if (sessionIds.length) await realtime.disconnectSessions(sessionIds);
  const emailPassword = body.delivery === 'email' ? credential.password : null;
  const emailDelivered = await sendPasswordResetEmail({ to: r.admin.email, adminName: r.admin.full_name, schoolName: r.school.name, schoolCode: r.school.code, password: emailPassword });
  const reveal = (body.delivery === 'show' && credential.generated) || (body.delivery === 'email' && !emailDelivered);
  return {
    admin: toAdminDto({ ...r.admin, must_change_password: true }),
    sessionsRevoked: sessionIds.length,
    credentials: { delivery: body.delivery, passwordGenerated: credential.generated, emailDelivered, ...(reveal ? { temporaryPassword: credential.password } : {}) },
  };
}
