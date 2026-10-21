// Access tokens (contract §2/§6, BP §5.2): HS256 JWT, 15 min, claims
//   sub (actor id) · role · school_id (null for super_admin and parent) · sid (session id) · typ
// The algorithm is pinned on verify (alg confusion / 'none' rejected) and issuer/audience are
// checked. Key rotation (BP §16): new tokens carry the header kid of JWT_ACTIVE_KID and are verified
// by looking that kid up in JWT_ACCESS_KEYS; kid-less tokens (issued before rotation was configured)
// fall back to JWT_ACCESS_SECRET, so old and new keys overlap gracefully. The token only identifies the session: authenticate() reloads session + actor on every
// request, so revocation (logout, deactivation, school suspension) is immediate.
import crypto from 'node:crypto';
import { ROLES, type OwnerType, type Role } from '@wimb/shared';
import jwt from 'jsonwebtoken';
import config from '../config/index.js';
import { tokenExpired, unauthenticated } from './errors.js';

export const JWT_ALGORITHM = 'HS256';
export const JWT_ISSUER = 'whereismybus';
export const JWT_AUDIENCE = 'whereismybus-api';
const ROLE_SET: ReadonlySet<string> = new Set(ROLES);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Session owner type implied by a role. */
export function ownerTypeOfRole(role: Role): OwnerType {
  if (role === 'super_admin') return 'platform_user';
  if (role === 'parent') return 'parent_account';
  return 'user';
}

export interface AccessClaims {
  sub: string;
  role: Role;
  schoolId: string | null;
  sid: string;
  iat: number;
  exp: number;
}

export interface SignAccessInput {
  actorId: string;
  role: Role;
  /** Required for school_admin/driver/conductor; must be null for super_admin/parent. */
  schoolId: string | null;
  sessionId: string;
}

export interface SigningKey {
  /** Header kid (null → no kid; verified against the legacy secret). */
  kid: string | null;
  secret: string;
}

export interface VerificationKeys {
  /** Secret for kid-less tokens (JWT_ACCESS_SECRET). */
  legacySecret: string;
  /** kid → secret (JWT_ACCESS_KEYS). */
  keys: Readonly<Record<string, string>>;
}

/** The key that signs new access tokens: JWT_ACTIVE_KID's entry, else the legacy secret. */
export function activeSigningKey(jwtConfig: { accessSecret: string; activeKid: string | null; accessKeys: Readonly<Record<string, string>> } = config.jwt): SigningKey {
  const { activeKid, accessKeys, accessSecret } = jwtConfig;
  if (activeKid !== null && Object.hasOwn(accessKeys, activeKid)) return { kid: activeKid, secret: accessKeys[activeKid]! };
  return { kid: null, secret: accessSecret };
}

function configuredVerificationKeys(): VerificationKeys {
  return { legacySecret: config.jwt.accessSecret, keys: config.jwt.accessKeys };
}

/** Secret that verifies a token with this header kid, or null when the kid is unknown. */
function secretForKid(kid: unknown, { legacySecret, keys }: VerificationKeys): string | null {
  if (kid === undefined) return legacySecret;
  if (typeof kid !== 'string' || !Object.hasOwn(keys, kid)) return null;
  return keys[kid]!;
}

/** → { accessToken, accessTokenExpiresAt, expiresInSeconds }. */
export function signAccessToken(
  { actorId, role, schoolId, sessionId }: SignAccessInput,
  { key = activeSigningKey(), ttlSeconds = config.jwt.accessTtlSeconds, now = Date.now() }: { key?: SigningKey; ttlSeconds?: number; now?: number } = {},
) {
  if (!UUID_RE.test(actorId) || !UUID_RE.test(sessionId) || !ROLE_SET.has(role)) throw new TypeError('signAccessToken: invalid actorId, sessionId or role');
  const schoolScoped = role === 'school_admin' || role === 'driver' || role === 'conductor';
  if (schoolScoped && (!schoolId || !UUID_RE.test(schoolId))) throw new TypeError(`signAccessToken: ${role} tokens require a schoolId`);
  if (!schoolScoped && schoolId !== null) throw new TypeError(`signAccessToken: ${role} tokens carry no schoolId`);
  const iat = Math.floor(now / 1000);
  const exp = iat + ttlSeconds;
  const accessToken = jwt.sign({ sub: actorId, role, school_id: schoolId, sid: sessionId, typ: 'access', iat, exp }, key.secret, {
    algorithm: JWT_ALGORITHM,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    jwtid: crypto.randomUUID(),
    ...(key.kid !== null ? { keyid: key.kid } : {}),
  });
  return { accessToken, accessTokenExpiresAt: new Date(exp * 1000).toISOString(), expiresInSeconds: ttlSeconds };
}

/** Verifies an access token → claims. Throws TOKEN_EXPIRED or UNAUTHENTICATED. */
export function verifyAccessToken(token: unknown, { keys = configuredVerificationKeys() }: { keys?: VerificationKeys } = {}): AccessClaims {
  if (typeof token !== 'string' || token.length < 20 || token.length > 4096) throw unauthenticated('Invalid access token.');
  const header = jwt.decode(token, { complete: true })?.header as Record<string, unknown> | undefined;
  if (!header) throw unauthenticated('Invalid access token.');
  const secret = secretForKid(header.kid, keys);
  if (secret === null) throw unauthenticated('Invalid access token.');
  let raw: jwt.JwtPayload | string;
  try {
    raw = jwt.verify(token, secret, { algorithms: [JWT_ALGORITHM], issuer: JWT_ISSUER, audience: JWT_AUDIENCE, clockTolerance: 5 });
  } catch (err) {
    if ((err as { name?: string }).name === 'TokenExpiredError') throw tokenExpired();
    throw unauthenticated('Invalid access token.');
  }
  if (typeof raw !== 'object' || raw === null) throw unauthenticated('Invalid access token.');
  const c = raw as Record<string, unknown>;
  const schoolId = c.school_id;
  if (
    c.typ !== 'access' ||
    typeof c.sub !== 'string' ||
    !UUID_RE.test(c.sub) ||
    typeof c.sid !== 'string' ||
    !UUID_RE.test(c.sid) ||
    typeof c.role !== 'string' ||
    !ROLE_SET.has(c.role) ||
    !(schoolId === null || (typeof schoolId === 'string' && UUID_RE.test(schoolId)))
  ) {
    throw unauthenticated('Invalid access token.');
  }
  return {
    sub: c.sub.toLowerCase(),
    role: c.role as Role,
    schoolId: typeof schoolId === 'string' ? schoolId.toLowerCase() : null,
    sid: c.sid.toLowerCase(),
    iat: Number(c.iat),
    exp: Number(c.exp),
  };
}

/** Bearer token from an Authorization header value, or null. */
export function bearerFrom(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  const m = /^Bearer\s+([A-Za-z0-9._~+/=-]+)\s*$/i.exec(header);
  return m ? m[1]! : null;
}
