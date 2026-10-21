// Authentication (contract §6, BP §5.2). Verifies the access JWT, then loads the session and its
// actor on EVERY request (one statement, never cached): revoked/expired sessions, inactive actors,
// role or school mismatches are rejected with 401. Sets req.auth (AuthContext).
// Owner types: platform_user (super_admin) · user (school_admin/driver/conductor) · parent_account.
import type { OwnerType, Role } from '@wimb/shared';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { passwordChangeRequired, unauthenticated } from '../shared/errors.js';
import { updateRequestContext } from '../shared/requestContext.js';
import { isSessionUsable, loadSessionFromDb, type SessionLoader } from '../shared/sessions.js';
import { bearerFrom, ownerTypeOfRole, verifyAccessToken } from '../shared/tokens.js';

export interface AuthContext {
  sessionId: string;
  ownerType: OwnerType;
  actorId: string;
  role: Role;
  /** School from the token (staff/admins); null for super_admin and parents (see req.tenant). */
  schoolId: string | null;
  deviceId: string | null;
  actorName: string | null;
  mustChangePassword: boolean;
  tokenExpiresAt: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

/** Paths reachable while must_change_password is set. */
export const PASSWORD_CHANGE_ALLOWED = new Set(['/api/v1/auth/change-password', '/api/v1/auth/logout', '/api/v1/auth/logout-all', '/api/v1/auth/me', '/api/v1/auth/refresh']);

const invalidSession = () => unauthenticated('Your session is no longer valid. Please sign in again.');

/** Token already verified for a request (prefix guards + route guards → one session load). */
const verifiedToken = new WeakMap<Request, string>();

/** Verifies a raw token and loads its session (shared by HTTP and the socket handshake). */
export async function authenticateAccessToken(token: string, loadSession: SessionLoader = loadSessionFromDb): Promise<AuthContext> {
  const claims = verifyAccessToken(token);
  const session = await loadSession(claims.sid);
  if (!session || !isSessionUsable(session)) throw invalidSession();
  if (
    session.ownerId !== claims.sub ||
    session.actorRole !== claims.role ||
    session.ownerType !== ownerTypeOfRole(claims.role) ||
    (session.schoolId ?? null) !== claims.schoolId
  ) {
    throw invalidSession();
  }
  return {
    sessionId: session.sessionId,
    ownerType: session.ownerType,
    actorId: session.ownerId,
    role: session.actorRole,
    schoolId: claims.schoolId,
    deviceId: session.deviceId,
    actorName: session.actorName,
    mustChangePassword: session.mustChangePassword,
    tokenExpiresAt: new Date(claims.exp * 1000).toISOString(),
  };
}

/**
 * Re-validates an already authenticated principal against its LIVE session (no access-token
 * check): the session must still exist, be unrevoked and unexpired, its actor active, and owner,
 * role and school unchanged. Used by long-lived sockets, whose handshake token expires after
 * 15 minutes while the session itself stays valid (contract §7: every join re-checks).
 */
export async function reloadAuthContext(auth: AuthContext, loadSession: SessionLoader = loadSessionFromDb): Promise<AuthContext> {
  const session = await loadSession(auth.sessionId);
  if (!session || !isSessionUsable(session)) throw invalidSession();
  if (session.ownerId !== auth.actorId || session.actorRole !== auth.role || session.ownerType !== auth.ownerType || (session.schoolId ?? null) !== auth.schoolId) {
    throw invalidSession();
  }
  return { ...auth, deviceId: session.deviceId, actorName: session.actorName, mustChangePassword: session.mustChangePassword };
}

export interface AuthenticateOptions {
  /** Default true: 401 without a token; false lets anonymous requests through (req.auth unset). */
  required?: boolean;
  /** Skip the PASSWORD_CHANGE_REQUIRED guard (auth endpoints). */
  allowPasswordChange?: boolean;
  loadSession?: SessionLoader;
}

export function authenticate({ required = true, allowPasswordChange = false, loadSession = loadSessionFromDb }: AuthenticateOptions = {}): RequestHandler {
  return async function authenticateMiddleware(req: Request, _res: Response, next: NextFunction) {
    const token = bearerFrom(req.get('authorization'));
    const cached = token && req.auth && verifiedToken.get(req) === token ? req.auth : undefined;
    req.auth = cached;
    if (!token) {
      if (required) throw unauthenticated();
      return next();
    }
    const auth = cached ?? (await authenticateAccessToken(token, loadSession));
    req.auth = auth;
    verifiedToken.set(req, token);
    updateRequestContext({ actorId: auth.actorId, actorRole: auth.role, actorName: auth.actorName, schoolId: auth.schoolId });
    req.log?.setBindings?.({ actorId: auth.actorId, role: auth.role, schoolId: auth.schoolId });
    if (!allowPasswordChange && auth.mustChangePassword && !PASSWORD_CHANGE_ALLOWED.has(String(req.originalUrl).split('?')[0]!)) {
      throw passwordChangeRequired();
    }
    return next();
  };
}
