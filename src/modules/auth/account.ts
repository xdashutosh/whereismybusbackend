// Account actions of an authenticated principal: change password (clears must_change_password and
// signs out every other session) and logout-all (BP §5.2 "force logout", contract §6).
import { withTenant } from '../../db/tenant.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { hashPassword, verifyPassword } from '../../shared/crypto.js';
import { fieldError, unauthenticated } from '../../shared/errors.js';
import { realtime } from '../../shared/realtime.js';
import * as repo from './repository.js';
import type { ChangePasswordBody } from './schemas.js';
import { auditAuth, ownerContext, revokeAllSessions, type SessionOwner } from './sessions.js';

function ownerOf(auth: AuthContext): SessionOwner {
  return { ownerType: auth.ownerType, ownerId: auth.actorId, role: auth.role, schoolId: auth.schoolId };
}

/** POST /auth/change-password. Parents without a password may set one without currentPassword. */
export async function changePassword(auth: AuthContext, body: ChangePasswordBody): Promise<{ changed: true; otherSessionsRevoked: number }> {
  const owner = ownerOf(auth);
  const ctx = ownerContext(owner);
  const { currentHash, familyId } = await withTenant(
    ctx,
    async (tx) => ({ currentHash: await repo.passwordHashOf(tx, owner.ownerType, owner.ownerId), familyId: await repo.familyOfSession(tx, auth.sessionId) }),
    { readOnly: true },
  );
  if (currentHash === undefined) throw unauthenticated();
  const settingFirstPassword = owner.ownerType === 'parent_account' && currentHash === null;
  if (!settingFirstPassword) {
    if (!body.currentPassword) throw fieldError('currentPassword', 'The current password is required.');
    if (!(await verifyPassword(currentHash, body.currentPassword))) throw fieldError('currentPassword', 'The current password is incorrect.');
  }
  if (currentHash && (await verifyPassword(currentHash, body.newPassword))) throw fieldError('newPassword', 'The new password must differ from the current one.');
  const hash = await hashPassword(body.newPassword);
  const revoked = await withTenant(ctx, async (tx) => {
    await repo.setPassword(tx, owner.ownerType, owner.ownerId, hash);
    const ids = await revokeAllSessions(tx, owner.ownerType, owner.ownerId, 'password_changed', { keepFamilyId: familyId });
    await auditAuth(tx, {
      action: 'auth.password_change',
      entityType: owner.ownerType,
      entityId: owner.ownerId,
      new: { initial: settingFirstPassword, otherSessionsRevoked: ids.length },
    });
    return ids;
  });
  if (revoked.length) await realtime.disconnectSessions(revoked);
  return { changed: true, otherSessionsRevoked: revoked.length };
}

/** POST /auth/logout-all — every session of the principal, including this one. */
export async function logoutAll(auth: AuthContext): Promise<{ revokedSessions: number }> {
  const owner = ownerOf(auth);
  const ids = await withTenant(ownerContext(owner), async (tx) => {
    const revoked = await revokeAllSessions(tx, owner.ownerType, owner.ownerId, 'logout_all');
    await auditAuth(tx, { action: 'auth.logout_all', entityType: owner.ownerType, entityId: owner.ownerId, new: { revokedSessions: revoked.length } });
    return revoked;
  });
  // Rotated rows of the current family may still hold sockets: include the current session too.
  await realtime.disconnectSessions([...new Set([...ids, auth.sessionId])]);
  return { revokedSessions: ids.length };
}
