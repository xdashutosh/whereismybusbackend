// Parent sessions and sockets on behalf of a school (contract §6: deactivating/resetting a parent
// revokes its sessions and disconnects its sockets).
//
// Parent sessions are school-less rows (a parent signs in once for all its schools), so RLS never
// shows them inside a school context — by design a school cannot list another identity's sessions.
// After the school's own transaction has verified that the parent belongs to it (and committed the
// school-side change + audit), the work below runs in the parent account's OWN context
// (auth.ownerContext — the context the auth module itself uses for parent sessions), where RLS
// (own_rows) allows exactly: revoking that parent's sessions. Nothing else about the parent is
// touched here.
import type { Tx } from '../../db/tenant.js';
import { withTenant } from '../../db/tenant.js';
import { logger as rootLogger } from '../../shared/logger.js';
import { realtime } from '../../shared/realtime.js';
import { ownerContext, revokeAllSessions } from '../auth/index.js';

const log = rootLogger.child({ module: 'students.parentSessions' });

const asParent = <T>(accountId: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(ownerContext({ ownerType: 'parent_account', ownerId: accountId, role: 'parent', schoolId: null }), fn);

export interface ParentAccessReset {
  revokedSessionIds: string[];
}

/**
 * Revokes every session of the parent, then disconnects its sockets. (A failed-sign-in lock is
 * cleared in the school's own transaction through school_clear_parent_lockout(): the lockout columns
 * of the global identity are not readable by the app role — migration 015.)
 */
export async function resetParentSessions(accountId: string, reason: string): Promise<ParentAccessReset> {
  const result = await asParent(accountId, async (tx) => ({ revokedSessionIds: await revokeAllSessions(tx, 'parent_account', accountId, reason) }));
  if (result.revokedSessionIds.length) await realtime.disconnectSessions(result.revokedSessionIds);
  return result;
}

/**
 * Revokes the parent's sessions after a deactivation/removal committed in the school. The school
 * change already blocks the parent there (every request re-checks its active links), so a failure
 * here is logged instead of failing the committed request.
 */
export async function revokeParentSessionsQuietly(accountId: string, reason: string): Promise<number> {
  try {
    const ids = await asParent(accountId, (tx) => revokeAllSessions(tx, 'parent_account', accountId, reason));
    if (ids.length) await realtime.disconnectSessions(ids);
    return ids.length;
  } catch (err) {
    log.error({ err, reason }, 'Parent sessions could not be revoked');
    return 0;
  }
}

/**
 * Disconnects (without revoking) the sockets of parents whose child links changed, so their next
 * room joins are re-authorised (child:{id}:live, trip:{id}). Best effort.
 */
export async function disconnectParentSockets(accountIds: readonly string[]): Promise<void> {
  for (const accountId of new Set(accountIds)) {
    try {
      const ids = await asParent(accountId, async (tx) =>
        (await tx.many<{ id: string }>(
          `select id from sessions where owner_type = 'parent_account' and owner_id = $1 and revoked_at is null and expires_at > now()`,
          [accountId],
        )).map((r) => r.id),
      );
      if (ids.length) await realtime.disconnectSessions(ids);
    } catch (err) {
      log.warn({ err }, 'Parent sockets could not be disconnected');
    }
  }
}
