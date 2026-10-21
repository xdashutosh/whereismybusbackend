// In-memory session store for middleware/socket tests: issues real access tokens whose sessions
// are served by a fake SessionLoader (module tests with the real schema use real sessions).
import crypto from 'node:crypto';
import type { Role } from '@wimb/shared';
import type { SessionLoader, SessionRecord } from '../../src/shared/sessions.js';
import { ownerTypeOfRole, signAccessToken } from '../../src/shared/tokens.js';

export interface IssueOptions {
  role: Role;
  schoolId?: string | null;
  actorId?: string;
  actorName?: string;
  mustChangePassword?: boolean;
  deviceId?: string | null;
}

export function createSessionStore() {
  const sessions = new Map<string, SessionRecord>();
  const loads: string[] = [];
  const loader: SessionLoader = async (sid) => {
    loads.push(sid);
    return sessions.get(sid) ?? null;
  };
  return {
    loader,
    loads,
    issue({ role, schoolId = null, actorId = crypto.randomUUID(), actorName = `${role} user`, mustChangePassword = false, deviceId = null }: IssueOptions) {
      const sessionId = crypto.randomUUID();
      const session: SessionRecord = {
        sessionId,
        ownerType: ownerTypeOfRole(role),
        ownerId: actorId,
        schoolId,
        deviceId,
        revokedAt: null,
        expiresAt: new Date(Date.now() + 86400_000).toISOString(),
        actorActive: true,
        actorRole: role,
        actorName,
        mustChangePassword,
      };
      sessions.set(sessionId, session);
      const { accessToken } = signAccessToken({ actorId, role, schoolId, sessionId });
      return { token: accessToken, session, actorId, sessionId };
    },
    update(sessionId: string, patch: Partial<SessionRecord>) {
      const s = sessions.get(sessionId);
      if (s) sessions.set(sessionId, { ...s, ...patch });
    },
  };
}
