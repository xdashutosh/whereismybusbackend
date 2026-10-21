// HTTP layer of the auth module: reads validated input, calls the flows, shapes responses.
// Token delivery (contract §6): web clients (X-WIMB-Client: web) receive the refresh token only as
// the httpOnly `wimb_rt` cookie (path /api/v1/auth); mobile clients receive it in the body.
import net from 'node:net';
import { APP_NAMES, HEADERS } from '@wimb/shared';
import type { Request, Response } from 'express';
import type { AuthContext } from '../../middleware/authenticate.js';
import { authenticateAccessToken } from '../../middleware/authenticate.js';
import { ok } from '../../shared/envelope.js';
import { unauthenticated } from '../../shared/errors.js';
import { bearerFrom } from '../../shared/tokens.js';
import { validated } from '../../shared/validate.js';
import { REFRESH_COOKIE_NAME, refreshCookieOptions, REFRESH_COOKIE_PATH, WEB_CLIENT_VALUE } from './policy.js';
import { buildProfile } from './profile.js';
import type { RefreshBody } from './schemas.js';
import type { ClientInfo, IssuedSession, SessionOwner } from './sessions.js';
import { revokeByRefreshToken, revokeSessionFamily } from './sessions.js';

const APP_NAME_SET: ReadonlySet<string> = new Set(APP_NAMES);
const SEMVER_RE = /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/;

export function isWebClient(req: Request): boolean {
  return (req.get(HEADERS.CLIENT) ?? '').trim().toLowerCase() === WEB_CLIENT_VALUE;
}

function dbIp(req: Request): string | null {
  const raw = (req.ip ?? req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '');
  return net.isIP(raw) ? raw : null;
}

/** Client descriptor stored on the session row. */
export function clientInfo(req: Request): ClientInfo {
  const web = isWebClient(req);
  const appName = req.get(HEADERS.APP_NAME)?.trim();
  const appVersion = req.get(HEADERS.APP_VERSION)?.trim();
  const deviceUid = req.get(HEADERS.DEVICE_ID)?.trim().slice(0, 128);
  return {
    client: web ? 'web' : 'mobile',
    ip: dbIp(req),
    userAgent: req.get('user-agent')?.slice(0, 512) ?? null,
    deviceUid: deviceUid || null,
    appName: appName && APP_NAME_SET.has(appName) ? (appName) : web ? 'web_admin' : null,
    appVersion: appVersion && SEMVER_RE.test(appVersion) ? appVersion : null,
  };
}

/** AuthContext of a freshly issued session (to build the login profile). */
function contextOf(owner: SessionOwner, session: IssuedSession, deviceId: string | null, mustChangePassword: boolean): AuthContext {
  return {
    sessionId: session.sessionId,
    ownerType: owner.ownerType,
    actorId: owner.ownerId,
    role: owner.role,
    schoolId: owner.ownerType === 'user' ? owner.schoolId : null,
    deviceId,
    actorName: null,
    mustChangePassword,
    tokenExpiresAt: session.accessTokenExpiresAt,
  };
}

/** Token part of every sign-in / refresh response (+ cookie for web clients). */
export function tokenPayload(res: Response, session: IssuedSession) {
  if (session.client === 'web') {
    res.cookie(REFRESH_COOKIE_NAME, session.refreshToken, refreshCookieOptions(Math.max(0, Date.parse(session.refreshTokenExpiresAt) - Date.now())));
  }
  res.setHeader('Cache-Control', 'no-store');
  return {
    tokenType: 'Bearer' as const,
    accessToken: session.accessToken,
    accessTokenExpiresAt: session.accessTokenExpiresAt,
    expiresIn: session.expiresInSeconds,
    ...(session.client === 'mobile' ? { refreshToken: session.refreshToken } : {}),
    refreshTokenExpiresAt: session.refreshTokenExpiresAt,
    sessionId: session.sessionId,
  };
}

/** Sends a completed sign-in: tokens + role-specific profile. */
export async function sendLogin(
  req: Request,
  res: Response,
  r: { session: IssuedSession; owner: SessionOwner; mustChangePassword: boolean; deviceId?: string | null },
): Promise<void> {
  const tokens = tokenPayload(res, r.session);
  const user = await buildProfile(req, contextOf(r.owner, r.session, r.deviceId ?? null, r.mustChangePassword));
  ok(res, { status: 'authenticated', ...tokens, mustChangePassword: r.mustChangePassword, user });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE_NAME, { httpOnly: true, secure: refreshCookieOptions().secure, sameSite: 'strict', path: REFRESH_COOKIE_PATH });
}

/** Refresh token of the request: cookie for web clients, body for mobile clients. */
export function refreshTokenOf(req: Request): string | null {
  if (isWebClient(req)) {
    const cookie = (req.cookies as Record<string, unknown> | undefined)?.[REFRESH_COOKIE_NAME];
    return typeof cookie === 'string' && cookie.length >= 20 && cookie.length <= 256 ? cookie : null;
  }
  return validated<RefreshBody>(req, 'body').refreshToken ?? null;
}

function ownerOfAuth(auth: AuthContext): SessionOwner {
  return { ownerType: auth.ownerType, ownerId: auth.actorId, role: auth.role, schoolId: auth.schoolId };
}

/** POST /auth/logout — current session family; works with an expired access token via the refresh token. */
export async function logout(req: Request, res: Response): Promise<void> {
  let auth: AuthContext | null = null;
  const bearer = bearerFrom(req.get('authorization'));
  if (bearer) {
    try {
      auth = await authenticateAccessToken(bearer);
    } catch {
      auth = null;
    }
  }
  let done = false;
  if (auth) {
    await revokeSessionFamily(ownerOfAuth(auth), auth.sessionId, 'logout', { action: 'auth.logout', entityType: 'session', entityId: auth.sessionId });
    done = true;
  } else {
    const token = refreshTokenOf(req);
    if (token) done = await revokeByRefreshToken(token);
  }
  clearRefreshCookie(res);
  if (!done && !bearer && !refreshTokenOf(req)) throw unauthenticated();
  ok(res, { loggedOut: true });
}

export { ownerOfAuth };
