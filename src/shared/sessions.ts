// Session + actor loading for authenticate() and the socket handshake (contract §6, BP §5.2).
// Default loader: ONE statement on the app pool calling the SECURITY DEFINER function
//   auth_session_actor(p_session_id uuid) RETURNS TABLE (
//     session_id uuid, owner_type text, owner_id uuid, school_id uuid, device_id uuid,
//     revoked_at timestamptz, expires_at timestamptz,
//     actor_active boolean, actor_role text, actor_name text, must_change_password boolean)
// provided by core migration 012. It does not depend on caller context (owner-owned definer
// function reaching FORCE-RLS tables through the definer_access policies).
// It is never cached: revocation is effective on the next request.
import { OWNER_TYPES, ROLES, type OwnerType, type Role } from '@wimb/shared';
import { definerQuery } from '../db/definer.js';

export interface SessionRecord {
  sessionId: string;
  ownerType: OwnerType;
  ownerId: string;
  schoolId: string | null;
  deviceId: string | null;
  revokedAt: string | null;
  expiresAt: string;
  actorActive: boolean;
  actorRole: Role;
  actorName: string | null;
  mustChangePassword: boolean;
}

export type SessionLoader = (sessionId: string) => Promise<SessionRecord | null>;

interface SessionRow {
  session_id: string;
  owner_type: string;
  owner_id: string;
  school_id: string | null;
  device_id: string | null;
  revoked_at: string | null;
  expires_at: string;
  actor_active: boolean;
  actor_role: string;
  actor_name: string | null;
  must_change_password: boolean | null;
}

const OWNER_SET: ReadonlySet<string> = new Set(OWNER_TYPES);
const ROLE_SET: ReadonlySet<string> = new Set(ROLES);

export function mapSessionRow(row: SessionRow): SessionRecord | null {
  if (!OWNER_SET.has(row.owner_type) || !ROLE_SET.has(row.actor_role)) return null;
  return {
    sessionId: row.session_id,
    ownerType: row.owner_type as OwnerType,
    ownerId: row.owner_id,
    schoolId: row.school_id,
    deviceId: row.device_id,
    revokedAt: row.revoked_at,
    expiresAt: row.expires_at,
    actorActive: row.actor_active,
    actorRole: row.actor_role as Role,
    actorName: row.actor_name,
    mustChangePassword: Boolean(row.must_change_password),
  };
}

/** Default loader (see header). A missing function is reported as 503, never as "logged out". */
export const loadSessionFromDb: SessionLoader = async (sessionId) => {
  const rows = await definerQuery<SessionRow>(
    'select session_id, owner_type, owner_id, school_id, device_id, revoked_at, expires_at, actor_active, actor_role, actor_name, must_change_password from auth_session_actor($1::uuid)',
    [sessionId],
    { unavailableMessage: 'Authentication is not available yet.' },
  );
  return rows[0] ? mapSessionRow(rows[0]) : null;
};

/** True when a session record is usable at `now`. */
export function isSessionUsable(s: SessionRecord, now = Date.now()): boolean {
  return s.revokedAt === null && Date.parse(s.expiresAt) > now && s.actorActive;
}
