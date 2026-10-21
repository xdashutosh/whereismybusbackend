// Named rate limiters (contract §2/§6, BP §5.4/§7.2) on the shared counter store (Redis when
// configured → global across instances). Exceeding a limit → 429 RATE_LIMITED + Retry-After.
// Limiters with `failuresOnly` count only failed responses (successful logins/changes do not
// consume the budget): every request reserves a slot atomically BEFORE it runs (so a parallel burst
// can never exceed the limit) and a response < 400 refunds it — as does an expected ≥ 400 answer
// that its handler marked with markNotFailure(res), e.g. 401 TOTP_REQUIRED asking a Super Admin who
// entered the right password for the TOTP code (the next step of the sign-in, not a failure).
// Every limiter is a pass-through when RATE_LIMIT_ENABLED=false
// (tests; refused in production). A store outage fails open (logged) to keep the API available.
import crypto from 'node:crypto';
import { HEADERS, REFRESH_COOKIE_NAME } from '@wimb/shared';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import config from '../config/index.js';
import { rateLimited } from '../shared/errors.js';
import { kv as defaultKv, kvKey, type KvStore } from '../shared/kv.js';
import { logger as rootLogger } from '../shared/logger.js';
import { normalizePhone } from '../shared/phone.js';
import { bearerFrom, verifyAccessToken } from '../shared/tokens.js';

const log = rootLogger.child({ module: 'rate-limit' });
const MINUTE = 60;

export interface LimiterSpec {
  name: string;
  limit: number;
  windowSec: number;
  /** Bucket key for a request; return null to skip limiting this request. */
  key?: (req: Request) => string | null;
  /** Count only failed responses (status ≥ 400 and not marked with markNotFailure). */
  failuresOnly?: boolean;
  message?: string;
}

export type Limiter = RequestHandler & { reset(key: string): Promise<void>; spec: LimiterSpec };

/** res.locals flag of markNotFailure(): a module-private symbol, so nothing can set it by accident. */
const NOT_A_FAILURE = Symbol('rateLimit.notAFailure');
interface FailureFlag {
  [NOT_A_FAILURE]?: true;
}

/**
 * Marks this response as an expected answer that is not a failure although its status is ≥ 400
 * (a "next step" such as 401 TOTP_REQUIRED after a correct password, TOTP code still missing), so
 * failuresOnly limiters refund its slot like a success. Never for wrong credentials.
 */
export function markNotFailure(res: Response): void {
  (res.locals as FailureFlag)[NOT_A_FAILURE] = true;
}

/** Whether a finished response consumes the budget of a failuresOnly limiter. */
function countsAsFailure(res: Response): boolean {
  return res.statusCode >= 400 && (res.locals as FailureFlag)[NOT_A_FAILURE] !== true;
}

export function clientIp(req: Request): string {
  const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
  // IPv6: bucket by /64 so one host cannot rotate through its prefix.
  if (ip.includes(':') && !ip.startsWith('::ffff:')) return ip.split(':').slice(0, 4).join(':') + '::/64';
  return ip.replace(/^::ffff:/, '');
}

function bodyField(req: Request, field: string): string {
  const v = (req.body as Record<string, unknown> | undefined)?.[field];
  return typeof v === 'string' ? v.trim().toLowerCase().slice(0, 254) : '';
}

function phoneOf(req: Request): string {
  const raw = (req.body as Record<string, unknown> | undefined)?.phone;
  return normalizePhone(raw) ?? (typeof raw === 'string' ? raw.replace(/\D/g, '').slice(-15) : '');
}

export function createLimiter(spec: LimiterSpec, { enabled = config.rateLimitEnabled, store = defaultKv }: { enabled?: boolean; store?: KvStore } = {}): Limiter {
  const bucket = (k: string) => kvKey('rl', spec.name, k);
  const middleware = async function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
    if (!enabled) return next();
    const k = (spec.key ?? clientIp)(req);
    if (k === null) return next();
    try {
      const { count, ttlMs } = await store.incr(bucket(k), spec.windowSec);
      if (spec.failuresOnly) {
        res.on('finish', () => {
          if (!countsAsFailure(res)) store.decr(bucket(k)).catch((err: unknown) => log.warn({ err, limiter: spec.name }, 'Rate-limit store refund failed'));
        });
      }
      const resetSec = Math.max(1, Math.ceil((ttlMs || spec.windowSec * 1000) / 1000));
      res.setHeader('RateLimit-Policy', `${spec.limit};w=${spec.windowSec}`);
      res.setHeader('RateLimit', `limit=${spec.limit}, remaining=${Math.max(0, spec.limit - count)}, reset=${resetSec}`);
      if (count > spec.limit) {
        return next(rateLimited(resetSec, spec.message, { limiter: spec.name, retryAfterSeconds: resetSec }));
      }
    } catch (err) {
      log.warn({ err: { message: (err as Error).message }, limiter: spec.name }, 'Rate-limit store unavailable; allowing request');
    }
    return next();
  } as Limiter;
  middleware.reset = async (k: string) => store.del(bucket(k));
  middleware.spec = spec;
  return middleware;
}

/**
 * Bucket of a refresh request: the refresh token itself (web: httpOnly cookie, mobile: body), hashed —
 * i.e. one session. Many devices behind one school-office or carrier-NAT address therefore never share
 * a budget; requests without a token share a per-IP bucket.
 */
export function refreshBucket(req: Request): string {
  const web = (req.get(HEADERS.CLIENT) ?? '').trim().toLowerCase() === 'web';
  const raw = web ? (req.cookies as Record<string, unknown> | undefined)?.[REFRESH_COOKIE_NAME] : (req.body as Record<string, unknown> | undefined)?.refreshToken;
  if (typeof raw === 'string' && raw.length >= 20 && raw.length <= 512) return `rt:${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 40)}`;
  return `ip:${clientIp(req)}`;
}

const LOCATION_INGEST = /^\/api\/v1\/driver\/trips\/[^/]+\/locations\/?$/;
const INGEST_ROLES = new Set(['driver', 'conductor']);

/**
 * Global bucket. A request carrying a VALID access token (signature + expiry checked here; the route's
 * authenticate() still runs later) is bucketed by its account — location ingestion by a crew member by
 * its session, which the route's per-session ingest limiter then narrows. Everything else (sign-in,
 * refresh, anonymous floods of any URL, forged or expired tokens) is bucketed by client IP.
 * Why per account: web traffic reaches the API through the Vercel /api rewrite, so with the safe
 * TRUST_PROXY=1 every web user shares a few Vercel egress addresses; school offices and carrier NAT
 * put many people behind one address too. A per-IP budget would make them throttle each other.
 * Minting extra sessions does not multiply the budget (the key is the account, not the session).
 */
export function globalBucket(req: Request): string {
  const token = bearerFrom(req.get('authorization'));
  if (token) {
    try {
      const claims = verifyAccessToken(token);
      if (req.method === 'POST' && INGEST_ROLES.has(claims.role) && LOCATION_INGEST.test(req.originalUrl.split('?')[0]!)) return `sid:${claims.sid}`;
      return `actor:${claims.role}:${claims.sub}`;
    } catch {
      // invalid/expired token → IP bucket (authenticate() answers 401 later)
    }
  }
  return clientIp(req);
}

/** The application's limiter specs (BP §5.4 lockouts are enforced in the auth service itself). */
export function limiterSpecs() {
  return {
    global: { name: 'global', limit: 600, windowSec: MINUTE, key: globalBucket },
    // Per IP across identifiers (BP §5.4 "per IP and per identifier"): stops one address spraying a
    // password over many accounts. Failures only, sized for a school office / carrier NAT.
    loginIp: { name: 'loginIp', limit: 30, windowSec: 15 * MINUTE, failuresOnly: true, message: 'Too many sign-in attempts from this network. Please wait and try again.' },
    login: { name: 'login', limit: 10, windowSec: 15 * MINUTE, failuresOnly: true, key: (req) => `${clientIp(req)}|${bodyField(req, 'email') || bodyField(req, 'username') || phoneOf(req)}`, message: 'Too many sign-in attempts. Please wait and try again.' },
    otpRequestPhone: { name: 'otpRequestPhone', limit: 5, windowSec: 60 * MINUTE, key: (req) => phoneOf(req) || null, message: 'Too many code requests for this number. Please try again later.' },
    otpRequestIp: { name: 'otpRequestIp', limit: 20, windowSec: 60 * MINUTE, message: 'Too many code requests. Please try again later.' },
    otpVerify: { name: 'otpVerify', limit: 10, windowSec: 15 * MINUTE, failuresOnly: true, key: (req) => `${clientIp(req)}|${phoneOf(req)}`, message: 'Too many attempts. Please request a new code later.' },
    // Per session (refresh token): a token is used once, so 30 covers client retries generously.
    refresh: { name: 'refresh', limit: 30, windowSec: 15 * MINUTE, key: refreshBucket, message: 'Too many refresh attempts for this session. Please sign in again.' },
    // Per-IP ceiling sized for a school office or carrier NAT (thousands of devices refreshing every 15 min).
    refreshIp: { name: 'refreshIp', limit: 3000, windowSec: 15 * MINUTE, message: 'Too many refresh requests from this network. Please try again shortly.' },
    passwordChange: { name: 'passwordChange', limit: 5, windowSec: 15 * MINUTE, failuresOnly: true, key: (req) => (req.auth ? `actor:${req.auth.actorId}` : `ip:${clientIp(req)}`), message: 'Too many password change attempts. Please wait and try again.' },
    totpVerify: { name: 'totpVerify', limit: 5, windowSec: 5 * MINUTE, failuresOnly: true, key: (req) => `${clientIp(req)}|${bodyField(req, 'email')}`, message: 'Too many verification attempts. Please wait and try again.' },
    upload: { name: 'upload', limit: 120, windowSec: 60 * MINUTE, key: (req) => (req.auth ? `actor:${req.auth.actorId}` : clientIp(req)) },
    // Public lookups before sign-in (GET /auth/school/branding, /auth/legal): per IP, sized for a school
    // office or carrier NAT where many drivers open the sign-in screen; stops school-code enumeration.
    publicLookup: { name: 'publicLookup', limit: 120, windowSec: 15 * MINUTE, message: 'Too many requests. Please try again shortly.' },
  } satisfies Record<string, LimiterSpec>;
}

export type RateLimits = Record<keyof ReturnType<typeof limiterSpecs>, Limiter>;

/** Builds the named limiter set (tests pass enabled/store/overrides). */
export function createRateLimits({ enabled = config.rateLimitEnabled, store = defaultKv, overrides = {} }: { enabled?: boolean; store?: KvStore; overrides?: Partial<Record<string, Partial<LimiterSpec>>> } = {}): RateLimits {
  const specs = limiterSpecs();
  const out: Record<string, Limiter> = {};
  for (const [name, spec] of Object.entries(specs) as [string, LimiterSpec][]) out[name] = createLimiter({ ...spec, ...(overrides[name] ?? {}) }, { enabled, store });
  return out as RateLimits;
}

/** Process-wide limiters. */
export const rateLimits: RateLimits = createRateLimits();
