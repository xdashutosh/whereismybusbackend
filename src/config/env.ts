// Environment schema (contract §13). Raw strings → typed values; empty strings count as unset.
// Pure module: no file or process access (see config/index.ts for loading and derivation).
import { z } from 'zod';

const emptyToUndefined = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const str = () => z.preprocess(emptyToUndefined, z.string().trim().optional());
const secret = () => z.preprocess(emptyToUndefined, z.string().optional());
const bool = (def: boolean) =>
  z.preprocess(
    (v) => {
      const s = emptyToUndefined(v);
      if (s === undefined) return def;
      if (typeof s !== 'string') return s;
      const t = s.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(t)) return true;
      if (['false', '0', 'no', 'off'].includes(t)) return false;
      return s;
    },
    z.boolean({ invalid_type_error: 'must be true or false' }),
  );
const int = (def: number, min: number, max: number) =>
  z.preprocess(
    (v) => {
      const s = emptyToUndefined(v);
      return s === undefined ? def : Number(s);
    },
    z.number({ invalid_type_error: 'must be a number' }).int().min(min).max(max),
  );

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export const SMS_PROVIDERS = ['webpayservices', 'console'] as const;

export const envSchema = z.object({
  NODE_ENV: z.preprocess(emptyToUndefined, z.enum(['development', 'test', 'production']).default('development')),
  PORT: int(4000, 1, 65535),
  CORS_ORIGINS: str(),
  // Extra allowed origins as anchored regular expressions, separated by whitespace (e.g. Vercel
  // preview deployments: ^https://whereismybus-[a-z0-9-]+-myteam\.vercel\.app$). Optional.
  CORS_ORIGIN_PATTERNS: str(),
  APP_PUBLIC_URL: z.preprocess(emptyToUndefined, z.string().url().default('http://localhost:5173')),
  TRUST_PROXY: str(),
  ALLOW_REMOTE_DEV_DB: bool(false),

  // Owner connection (migrations, seeds, setup-roles)
  DATABASE_URL: str(),
  DB_HOST: str(),
  DB_PORT: int(5432, 1, 65535),
  DB_USER: str(),
  DB_PASSWORD: secret(),
  DB_NAME: str(),
  DB_SSL: bool(false),
  DB_SSL_REJECT_UNAUTHORIZED: bool(true),
  DB_POOL_MAX: int(10, 1, 100),
  // App connection (runtime; LOGIN NOBYPASSRLS role)
  DATABASE_APP_URL: str(),
  DB_APP_USER: str(),
  DB_APP_PASSWORD: secret(),
  // Test equivalents
  TEST_DATABASE_URL: str(),
  TEST_DATABASE_APP_URL: str(),
  TEST_DB_NAME: str(),

  // Object storage
  AWS_REGION: str(),
  AWS_ACCESS_KEY_ID: str(),
  AWS_SECRET_ACCESS_KEY: secret(),
  AWS_BUCKET_NAME: str(),
  S3_PROVIDER: str(),
  S3_ENDPOINT: z.preprocess(emptyToUndefined, z.string().url().optional()),
  S3_KEY_PREFIX: z.preprocess((v) => (v === undefined ? 'whereismybus/' : v), z.string()),
  STORAGE_DRIVER: z.preprocess(emptyToUndefined, z.enum(['s3', 'local']).optional()),
  /** Root folder of the local storage driver (absolute, or relative to backend/); default backend/storage. */
  STORAGE_LOCAL_DIR: str(),

  // Auth
  JWT_ACCESS_SECRET: secret(),
  // Rotation (BP §16): kid→secret map ("kid1:secret1,kid2:secret2" or a JSON object) and the kid
  // that signs new access tokens. Tokens are verified by their header kid; kid-less tokens fall
  // back to JWT_ACCESS_SECRET.
  JWT_ACCESS_KEYS: secret(),
  JWT_ACTIVE_KID: str(),
  ACCESS_TOKEN_TTL: z.preprocess(emptyToUndefined, z.string().default('15m')),
  REFRESH_TOKEN_TTL_DAYS: int(30, 1, 365),
  TOTP_ISSUER: z.preprocess(emptyToUndefined, z.string().default('Where Is My Bus')),
  RATE_LIMIT_ENABLED: bool(true),

  // Domain
  DEFAULT_TIMEZONE: z.preprocess(emptyToUndefined, z.string().default('Asia/Kolkata')),
  PLATFORM_ADMIN_EMAIL: z.preprocess(emptyToUndefined, z.string().email().default('superadmin@example.com')),
  // First Super Admin password for `npm run db:bootstrap` (only used when that admin does not exist yet).
  PLATFORM_ADMIN_INITIAL_PASSWORD: secret(),
  SEED_DEFAULT_PASSWORD: secret(),

  // Infrastructure
  REDIS_URL: secret(),
  JOBS_IN_PROCESS: bool(false),
  // Production without Redis (one API instance; in-process KV, pub/sub, rate limits, Socket.IO adapter
  // and job runner). Requires JOBS_IN_PROCESS=true. Live state and rate limits reset on restart.
  SINGLE_INSTANCE: bool(false),
  LOG_LEVEL: z.preprocess(emptyToUndefined, z.enum(LOG_LEVELS).optional()),

  // Notification channels
  SMS_PROVIDER: z.preprocess(emptyToUndefined, z.enum(SMS_PROVIDERS).default('console')),
  // WebPay Services HTTP API (SMS_PROVIDER=webpayservices)
  SMS_API_URL: str(),
  SMS_API_USERNAME: str(),
  SMS_API_KEY: secret(),
  SMS_SENDER_ID: str(),
  SMS_ROUTE: str(),
  SMS_DLT_TEMPLATE_ID: str(),
  // OTP text: the exact DLT-registered template with {otp} as the code placeholder (not trimmed).
  SMS_OTP_MESSAGE: z.preprocess(emptyToUndefined, z.string().optional()),
  // OTP policy
  SMS_OTP_EXPIRY_MIN: int(10, 1, 30),
  SMS_OTP_MAX_ATTEMPTS: int(5, 1, 10),
  SMS_OTP_RESEND_SECONDS: int(60, 15, 600),
  SMS_OTP_DAILY_CAP: int(10, 1, 100),
  SMS_OTP_GLOBAL_DAILY_CAP: int(2000, 1, 1_000_000),
  // Non-production: only these numbers (comma-separated, E.164 or local spelling) get real SMS.
  SMS_DEV_ALLOWED_NUMBERS: str(),
  // Demo mode: the allow-list above applies in production too (other numbers: OTP written to the log).
  SMS_ALLOWLIST_ONLY: bool(false),
  SMS_LOW_BALANCE_THRESHOLD: int(500, 0, 1_000_000_000),
  FIREBASE_SERVICE_ACCOUNT_B64: secret(),
  SMTP_HOST: str(),
  SMTP_PORT: int(587, 1, 65535),
  SMTP_USER: str(),
  SMTP_PASS: secret(),
  MAIL_FROM: z.preprocess(emptyToUndefined, z.string().default('Where Is My Bus <no-reply@example.com>')),

  // Google
  GOOGLE_MAPS_SERVER_KEY: secret(),

  // Observability (BP §16 Monitoring, §17)
  // Bearer token of GET /metrics (Prometheus text format); empty = the endpoint answers 404.
  METRICS_TOKEN: secret(),
  // Sentry error reporting for the API and the worker; empty = disabled (nothing is sent anywhere).
  SENTRY_DSN: secret(),
  SENTRY_ENVIRONMENT: str(),
  SENTRY_RELEASE: str(),
});

export type RawEnv = z.infer<typeof envSchema>;

export const JWT_KID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * JWT_ACCESS_KEYS → [kid, secret][] in declaration order. Accepts a JSON object
 * ({"2026-10":"…"}) or comma-separated kid:secret pairs (split at the first ':'; secrets may contain
 * ':' and '=' but not ','). Throws on malformed input; validation of kids/lengths is the caller's.
 */
export function parseJwtKeys(raw: string): Array<[string, string]> {
  const t = raw.trim();
  if (t.startsWith('{')) {
    let obj: unknown;
    try {
      obj = JSON.parse(t);
    } catch {
      throw new Error('must be valid JSON or kid:secret pairs');
    }
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw new Error('must be a JSON object of kid → secret');
    return Object.entries(obj).map(([kid, value]) => {
      if (typeof value !== 'string') throw new Error(`secret for kid "${kid}" must be a string`);
      return [kid, value];
    });
  }
  return t
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const i = part.indexOf(':');
      if (i <= 0) throw new Error('each entry must be kid:secret');
      return [part.slice(0, i).trim(), part.slice(i + 1).trim()];
    });
}

/** '15m' | '900' | '900s' | '1h' | '1d' → seconds (NaN when unparseable). */
export function parseDurationSeconds(value: string): number {
  const m = /^\s*(\d+)\s*(s|m|h|d)?\s*$/i.exec(String(value));
  if (!m) return Number.NaN;
  const n = Number(m[1]);
  const unit = (m[2] ?? 's').toLowerCase() as 's' | 'm' | 'h' | 'd';
  return n * { s: 1, m: 60, h: 3600, d: 86400 }[unit];
}

/** Minute values a message mentions: 'valid for 10 mins' → [10]. */
export function minutesMentioned(text: string): number[] {
  return [...text.matchAll(/(\d{1,3})\s*-?\s*(?:minutes?|mins?)\b/gi)].map((m) => Number(m[1]));
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Express 'trust proxy' value from TRUST_PROXY. */
export function parseTrustProxy(raw: string | undefined): boolean | number | string[] {
  if (raw === undefined) return false;
  const t = raw.toLowerCase();
  if (t === 'false' || t === '0' || t === 'no') return false;
  if (t === 'true' || t === 'yes') return true;
  if (/^\d+$/.test(t)) return Number(t);
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * CORS_ORIGIN_PATTERNS → { patterns, issues }. Each whitespace-separated entry must be a valid regular
 * expression written with ^ and $ anchors. The whole entry is compiled as ^(?:…)$ (originPatternRegExp),
 * so a top-level alternation can never leave one branch unanchored. In production every entry must
 * start with ^https://. Values are echoed in issues: patterns are not secrets.
 */
export function parseOriginPatterns(raw: string | undefined, { isProduction }: { isProduction: boolean }): { patterns: string[]; issues: string[] } {
  const patterns: string[] = [];
  const issues: string[] = [];
  for (const p of (raw ?? '').split(/\s+/).filter(Boolean)) {
    if (!p.startsWith('^') || !p.endsWith('$') || p.endsWith('\\$') || p.length < 3) {
      issues.push(`CORS_ORIGIN_PATTERNS entry ${p} must be anchored: start with ^ and end with $`);
      continue;
    }
    try {
      originPatternRegExp(p);
    } catch {
      issues.push(`CORS_ORIGIN_PATTERNS entry ${p} is not a valid regular expression`);
      continue;
    }
    if (isProduction && (!p.startsWith('^https://') || p.includes('http://'))) {
      issues.push(`CORS_ORIGIN_PATTERNS entry ${p} must start with ^https:// in production`);
      continue;
    }
    if (!patterns.includes(p)) patterns.push(p);
  }
  return { patterns, issues };
}

/** Minimum length of METRICS_TOKEN (a random bearer secret shared with the Prometheus scraper). */
export const METRICS_TOKEN_MIN_LENGTH = 24;

export interface SentryDsnParts {
  protocol: 'http' | 'https';
  publicKey: string;
  host: string;
  projectId: string;
}

/**
 * SENTRY_DSN → its parts, or null when it is not a Sentry DSN (`https://<publicKey>@<host>[/<path>]/<projectId>`).
 * The DSN is a client key (not a secret in the strict sense), but issues never echo it.
 */
export function parseSentryDsn(raw: string): SentryDsnParts | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  const protocol = u.protocol.replace(/:$/, '');
  if (protocol !== 'http' && protocol !== 'https') return null;
  const projectId = u.pathname.split('/').filter(Boolean).pop() ?? '';
  if (!u.username || u.password || !/^\d+$/.test(projectId) || !u.hostname) return null;
  return { protocol, publicKey: decodeURIComponent(u.username), host: u.host, projectId };
}

/** Compiles a validated ^…$ origin pattern as ^(?:…)$ (anchors apply to every alternative). */
export function originPatternRegExp(pattern: string): RegExp {
  return new RegExp(`^(?:${pattern.slice(1, -1)})$`);
}
