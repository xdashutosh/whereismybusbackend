// Central, zod-validated configuration (contract §13).
// Precedence: real environment variables > backend/.env.local > backend/.env. dotenv never
// overrides a variable that is already set, so loading .env.local first and .env second yields
// exactly that precedence. Secret values are never logged: use redactedSummary() for diagnostics.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { normalizePhone } from '../shared/phone.js';
import { buildDbPair, type DbConnection, type DbPair } from './db.js';
import {
  envSchema,
  JWT_KID_RE,
  METRICS_TOKEN_MIN_LENGTH,
  parseJwtKeys,
  isValidTimeZone,
  minutesMentioned,
  parseDurationSeconds,
  parseOriginPatterns,
  parseSentryDsn,
  parseTrustProxy,
  type LOG_LEVELS,
  type SMS_PROVIDERS,
} from './env.js';

export type { DbConnection, DbPair } from './db.js';

/** backend/ (works from src/config and dist/config). */
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export class ConfigError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/** Loads backend/.env.local then backend/.env into process.env (never overriding real env). */
export function loadEnvFiles(rootDir = ROOT_DIR): void {
  for (const name of ['.env.local', '.env']) {
    const file = path.join(rootDir, name);
    if (fs.existsSync(file)) dotenv.config({ path: file, override: false, quiet: true });
  }
}

export interface Config {
  readonly env: 'development' | 'test' | 'production';
  readonly isProduction: boolean;
  readonly isTest: boolean;
  readonly isDevelopment: boolean;
  readonly appName: string;
  readonly port: number;
  readonly appPublicUrl: string;
  readonly trustProxy: boolean | number | readonly string[];
  readonly corsOrigins: readonly string[];
  /** Anchored regular expressions (source strings) for additional allowed origins (CORS_ORIGIN_PATTERNS). */
  readonly corsOriginPatterns: readonly string[];
  readonly corsAllowAll: boolean;
  readonly allowRemoteDevDb: boolean;
  readonly logLevel: (typeof LOG_LEVELS)[number];
  /** Connections of the active mode (test database when NODE_ENV=test). */
  readonly db: DbPair;
  readonly mainDb: DbPair;
  readonly testDb: DbPair;
  readonly jwt: {
    readonly accessSecret: string;
    readonly accessSecretEphemeral: boolean;
    /** Kid that signs new access tokens (null → sign with accessSecret and no kid header). */
    readonly activeKid: string | null;
    /** Verification keys by kid (JWT_ACCESS_KEYS; null-prototype, frozen); includes the active kid. */
    readonly accessKeys: Readonly<Record<string, string>>;
    readonly accessTtl: string;
    readonly accessTtlSeconds: number;
    readonly refreshTtlDays: number;
    readonly refreshTtlSeconds: number;
  };
  readonly totpIssuer: string;
  readonly rateLimitEnabled: boolean;
  readonly storage: {
    readonly driver: 's3' | 'local';
    readonly provider: string | null;
    readonly bucket: string | null;
    readonly endpoint: string | null;
    readonly region: string | null;
    readonly accessKeyId: string | null;
    readonly secretAccessKey: string | null;
    readonly keyPrefix: string;
    readonly localDir: string;
    readonly configured: boolean;
  };
  readonly redisUrl: string | null;
  readonly jobsInProcess: boolean;
  /**
   * SINGLE_INSTANCE=true: one API process does everything (no Redis, no worker). Without REDIS_URL the
   * in-process KV/live state, pub/sub, rate-limit store, Socket.IO adapter and job runner are used.
   */
  readonly singleInstance: boolean;
  readonly sms: {
    /** Effective provider (always 'console' when NODE_ENV=test, so tests can never send SMS). */
    readonly provider: (typeof SMS_PROVIDERS)[number];
    /** WebPay Services HTTP API settings (null when unset; all required for webpayservices). */
    readonly webpay: {
      readonly url: string | null;
      readonly username: string | null;
      readonly apiKey: string | null;
      readonly senderId: string | null;
      readonly route: string | null;
      readonly templateId: string | null;
    };
    readonly otp: {
      /** Exact DLT template text; every {otp} is replaced by the code. */
      readonly message: string;
      readonly expirySeconds: number;
      readonly maxAttempts: number;
      readonly resendSeconds: number;
      readonly dailyCapPerPhone: number;
      readonly globalDailyCap: number;
    };
    /** E.164 numbers that receive real SMS outside production (others are printed to the log). */
    readonly devAllowedNumbers: readonly string[];
    /** SMS_ALLOWLIST_ONLY: devAllowedNumbers also gate real sends in production (demo deployments). */
    readonly allowlistOnly: boolean;
    readonly lowBalanceThreshold: number;
  };
  readonly push: { readonly firebaseServiceAccountB64: string | null };
  readonly smtp: {
    readonly enabled: boolean;
    readonly host: string | null;
    readonly port: number;
    readonly secure: boolean;
    readonly user: string | null;
    readonly pass: string | null;
    readonly from: string;
  };
  readonly google: { readonly mapsServerKey: string | null };
  readonly observability: {
    /** Bearer token of GET /metrics (null = endpoint disabled → 404). */
    readonly metricsToken: string | null;
    /** Sentry error reporting (null = disabled: SENTRY_DSN empty, and always in tests). */
    readonly sentry: { readonly dsn: string; readonly environment: string; readonly release: string | null } | null;
  };
  readonly defaultTimezone: string;
  readonly platformAdminEmail: string;
  /** PLATFORM_ADMIN_INITIAL_PASSWORD: used by db:bootstrap only when the Super Admin does not exist. */
  readonly platformAdminInitialPassword: string | null;
  readonly seedDefaultPassword: string | null;
  /** Non-fatal configuration warnings, logged at startup by bootChecks(). */
  readonly warnings: readonly string[];
}

/** Startup warning of SINGLE_INSTANCE=true without Redis (logged once by bootChecks()). */
export const SINGLE_INSTANCE_WARNING = 'single-instance mode: run exactly one instance; live state and rate limits reset on restart';

/** OTP text used when SMS_OTP_MESSAGE is unset (console provider only; webpayservices requires it). */
export const DEFAULT_OTP_MESSAGE = '{otp} is your Where Is My Bus login code. Do not share it.';

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === 'object') {
    for (const v of Object.values(obj as Record<string, unknown>)) {
      if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
    }
    Object.freeze(obj);
  }
  return obj;
}

/** Builds and validates the configuration from an env object (pure; used by tests). */
export function buildConfig(rawEnv: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(rawEnv);
  if (!parsed.success) throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  const e = parsed.data;
  const issues: string[] = [];
  const env = e.NODE_ENV;
  const isProduction = env === 'production';
  const isTest = env === 'test';

  // Databases --------------------------------------------------------------------------------
  const mainDb = buildDbPair(e, { test: false, isProduction }, isTest ? [] : issues);
  const testDb = buildDbPair(e, { test: true, isProduction: false }, isTest ? issues : []);
  if (testDb.owner && !testDb.owner.database.toLowerCase().includes('test')) {
    if (isTest) issues.push('test database name must contain "test" (the test harness wipes it)');
  }
  const db = isTest ? testDb : mainDb;
  if (!db.owner) {
    issues.push(
      isTest
        ? 'test database not configured: set TEST_DATABASE_URL or DB_HOST/DB_USER/TEST_DB_NAME'
        : 'database not configured: set DATABASE_URL or DB_HOST/DB_USER/DB_NAME',
    );
  }

  // HTTP ---------------------------------------------------------------------------------------
  const corsOrigins = (e.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  if (isProduction && corsOrigins.length === 0) issues.push('CORS_ORIGINS is required in production');
  for (const o of corsOrigins) {
    let u: URL | null = null;
    try {
      u = new URL(o);
    } catch {
      // reported below
    }
    if (!u || u.origin !== o) issues.push(`CORS_ORIGINS entry ${o} must be a bare origin such as https://app.example.com (scheme + host [+ port], no path)`);
  }
  const originPatterns = parseOriginPatterns(e.CORS_ORIGIN_PATTERNS, { isProduction });
  issues.push(...originPatterns.issues);

  // Auth ---------------------------------------------------------------------------------------
  const accessTtlSeconds = parseDurationSeconds(e.ACCESS_TOKEN_TTL);
  if (!Number.isFinite(accessTtlSeconds) || accessTtlSeconds < 60 || accessTtlSeconds > 86400) {
    issues.push('ACCESS_TOKEN_TTL must be a duration between 60s and 1d (e.g. 15m)');
  }
  let accessSecret = e.JWT_ACCESS_SECRET;
  let accessSecretEphemeral = false;
  if (!accessSecret) {
    if (isProduction) issues.push('JWT_ACCESS_SECRET is required in production');
    accessSecret = crypto.randomBytes(48).toString('base64url'); // per-process (dev/test only)
    accessSecretEphemeral = true;
  } else if (accessSecret.length < 32) {
    issues.push('JWT_ACCESS_SECRET must be at least 32 characters');
  }
  const accessKeys: Record<string, string> = Object.create(null) as Record<string, string>;
  if (e.JWT_ACCESS_KEYS) {
    try {
      for (const [kid, keySecret] of parseJwtKeys(e.JWT_ACCESS_KEYS)) {
        if (!JWT_KID_RE.test(kid)) issues.push(`JWT_ACCESS_KEYS: every kid must match ${JWT_KID_RE.source}`); // value not echoed (may be a pasted secret)
        else if (Object.hasOwn(accessKeys, kid)) issues.push(`JWT_ACCESS_KEYS: duplicate kid "${kid}"`);
        else if (keySecret.length < 32) issues.push(`JWT_ACCESS_KEYS: secret for kid "${kid}" must be at least 32 characters`);
        else accessKeys[kid] = keySecret;
      }
    } catch (err) {
      issues.push(`JWT_ACCESS_KEYS ${(err as Error).message}`);
    }
  }
  const activeKid = e.JWT_ACTIVE_KID ?? null;
  if (activeKid !== null && !Object.hasOwn(accessKeys, activeKid)) issues.push('JWT_ACTIVE_KID must name a kid listed in JWT_ACCESS_KEYS');
  if (isProduction && !e.RATE_LIMIT_ENABLED) issues.push('RATE_LIMIT_ENABLED=false is not allowed in production');
  // Client IPs (rate limits): behind Render (and the Vercel rewrite) only an explicit hop count or proxy
  // list is safe — unset/false puts every client in the proxy's bucket, true trusts a spoofable header.
  const trustProxyValue = parseTrustProxy(e.TRUST_PROXY);
  if (isProduction && (typeof trustProxyValue === 'boolean' || trustProxyValue === 0 || (Array.isArray(trustProxyValue) && trustProxyValue.length === 0))) {
    issues.push('TRUST_PROXY must be the number of proxy hops in front of the API (Render: 1 — see docs/DEPLOY_VERCEL_RENDER.md) or an explicit proxy address/subnet list in production — not unset, false or true');
  }

  // Storage (tests always use the local driver so they can never touch a real bucket) ---------
  const driver = isTest ? 'local' : (e.STORAGE_DRIVER ?? 's3');
  let keyPrefix = e.S3_KEY_PREFIX.trim().replace(/^\/+/, '');
  if (keyPrefix && !keyPrefix.endsWith('/')) keyPrefix += '/';
  if (!keyPrefix) issues.push('S3_KEY_PREFIX must not be empty (the bucket may be shared)');
  const s3Configured = Boolean(e.AWS_BUCKET_NAME && e.AWS_REGION && e.AWS_ACCESS_KEY_ID && e.AWS_SECRET_ACCESS_KEY);
  if (driver === 's3' && !s3Configured) {
    issues.push('STORAGE_DRIVER=s3 requires AWS_BUCKET_NAME, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (or STORAGE_DRIVER=local outside production)');
  }
  if (isProduction && driver === 'local') issues.push('STORAGE_DRIVER=local is not allowed in production');

  // Infrastructure -------------------------------------------------------------------------
  const warnings: string[] = [];
  const redisUrl = isTest ? null : (e.REDIS_URL ?? null);
  const singleInstance = e.SINGLE_INSTANCE;
  if (singleInstance && !e.JOBS_IN_PROCESS) {
    issues.push('SINGLE_INSTANCE=true requires JOBS_IN_PROCESS=true (there is no separate worker: the API process runs the jobs)');
  }
  if (isProduction && !redisUrl && !singleInstance) {
    issues.push('REDIS_URL is required in production (rate limits, live state, pub/sub, queues) unless SINGLE_INSTANCE=true (one instance, in-process state)');
  }
  if (singleInstance && !redisUrl && !isTest) warnings.push(SINGLE_INSTANCE_WARNING);

  // Notification channels ----------------------------------------------------------------
  if (isProduction && e.SMS_PROVIDER === 'console') issues.push('SMS_PROVIDER=console writes OTPs to the log and is not allowed in production');
  const otpMessage = e.SMS_OTP_MESSAGE ?? DEFAULT_OTP_MESSAGE;
  if (e.SMS_OTP_MESSAGE !== undefined && !e.SMS_OTP_MESSAGE.includes('{otp}')) issues.push('SMS_OTP_MESSAGE must contain the {otp} placeholder');
  if (e.SMS_PROVIDER === 'webpayservices') {
    const missing = (
      [
        ['SMS_API_URL', e.SMS_API_URL],
        ['SMS_API_USERNAME', e.SMS_API_USERNAME],
        ['SMS_API_KEY', e.SMS_API_KEY],
        ['SMS_SENDER_ID', e.SMS_SENDER_ID],
        ['SMS_ROUTE', e.SMS_ROUTE],
        ['SMS_DLT_TEMPLATE_ID', e.SMS_DLT_TEMPLATE_ID],
        ['SMS_OTP_MESSAGE', e.SMS_OTP_MESSAGE],
      ] as const
    )
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length) issues.push(`SMS_PROVIDER=webpayservices requires ${missing.join(', ')}`);
    if (e.SMS_API_URL) {
      let parsed: URL | null = null;
      try {
        parsed = new URL(e.SMS_API_URL);
      } catch {
        // reported below
      }
      if (parsed?.protocol !== 'https:') issues.push('SMS_API_URL must be an https:// URL');
      // The request parameters are appended as a query string: one placed after a '#' never reaches
      // the provider. Credentials belong in SMS_API_USERNAME / SMS_API_KEY (scrubbed from logs).
      if (e.SMS_API_URL.includes('#')) issues.push('SMS_API_URL must not contain a #fragment');
      if (parsed && (parsed.username || parsed.password)) issues.push('SMS_API_URL must not embed credentials (use SMS_API_USERNAME / SMS_API_KEY)');
    }
    if (e.SMS_DLT_TEMPLATE_ID && !/^\d{12,25}$/.test(e.SMS_DLT_TEMPLATE_ID)) issues.push('SMS_DLT_TEMPLATE_ID must be the numeric DLT template id (usually 19 digits)');
    if (e.SMS_SENDER_ID && !/^[A-Za-z0-9]{3,11}$/.test(e.SMS_SENDER_ID)) issues.push('SMS_SENDER_ID must be the DLT sender header (3–11 letters/digits)');
  }
  const devAllowedNumbers: string[] = [];
  (e.SMS_DEV_ALLOWED_NUMBERS ?? '')
    .split(/[,;]/)
    .map((v) => v.trim())
    .filter(Boolean)
    .forEach((raw, i) => {
      const n = normalizePhone(raw);
      if (!n) issues.push(`SMS_DEV_ALLOWED_NUMBERS entry #${i + 1} is not a valid phone number`);
      else if (!devAllowedNumbers.includes(n)) devAllowedNumbers.push(n);
    });
  if (isProduction && e.SMS_ALLOWLIST_ONLY) {
    warnings.push(
      `SMS_ALLOWLIST_ONLY=true: only the ${devAllowedNumbers.length} number(s) in SMS_DEV_ALLOWED_NUMBERS receive real SMS; ` +
        'OTPs for every other number are written to the server log (demo mode — set SMS_ALLOWLIST_ONLY=false to send to all parents)',
    );
  }
  const stale = minutesMentioned(otpMessage).filter((m) => m !== e.SMS_OTP_EXPIRY_MIN);
  if (stale.length) {
    warnings.push(`SMS_OTP_MESSAGE mentions ${stale.join('/')} minute(s) but SMS_OTP_EXPIRY_MIN=${e.SMS_OTP_EXPIRY_MIN}: codes expire after ${e.SMS_OTP_EXPIRY_MIN} minute(s)`);
  }
  if (e.FIREBASE_SERVICE_ACCOUNT_B64) {
    try {
      const sa = JSON.parse(Buffer.from(e.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8')) as Record<string, unknown>;
      if (typeof sa.project_id !== 'string' || typeof sa.private_key !== 'string' || typeof sa.client_email !== 'string') {
        issues.push('FIREBASE_SERVICE_ACCOUNT_B64 must be a base64-encoded service-account JSON (project_id, client_email, private_key)');
      }
    } catch {
      issues.push('FIREBASE_SERVICE_ACCOUNT_B64 must be base64-encoded JSON');
    }
  }

  // Observability ----------------------------------------------------------------------------
  if (e.METRICS_TOKEN !== undefined && (e.METRICS_TOKEN.length < METRICS_TOKEN_MIN_LENGTH || /\s/.test(e.METRICS_TOKEN))) {
    issues.push(`METRICS_TOKEN must be at least ${METRICS_TOKEN_MIN_LENGTH} characters without spaces (e.g. openssl rand -hex 32)`);
  }
  if (e.SENTRY_DSN !== undefined) {
    const dsn = parseSentryDsn(e.SENTRY_DSN);
    if (!dsn) issues.push('SENTRY_DSN must be a Sentry DSN such as https://<key>@o0.ingest.sentry.io/<project id>'); // value not echoed
    else if (isProduction && dsn.protocol !== 'https') issues.push('SENTRY_DSN must use https:// in production');
  }
  if (e.SENTRY_ENVIRONMENT !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(e.SENTRY_ENVIRONMENT)) issues.push('SENTRY_ENVIRONMENT must be 1–64 letters, digits, dots, dashes or underscores');
  if (e.SENTRY_RELEASE !== undefined && (e.SENTRY_RELEASE.length > 200 || /[\s/]/.test(e.SENTRY_RELEASE) || e.SENTRY_RELEASE === '.' || e.SENTRY_RELEASE === '..')) {
    issues.push('SENTRY_RELEASE must be at most 200 characters without spaces or slashes');
  }

  // Domain ---------------------------------------------------------------------------------
  if (!isValidTimeZone(e.DEFAULT_TIMEZONE)) issues.push('DEFAULT_TIMEZONE must be a valid IANA time zone');

  if (issues.length) throw new ConfigError(issues);

  return deepFreeze<Config>({
    env,
    isProduction,
    isTest,
    isDevelopment: env === 'development',
    appName: 'Where Is My Bus',
    port: e.PORT,
    appPublicUrl: e.APP_PUBLIC_URL.replace(/\/+$/, ''),
    trustProxy: trustProxyValue,
    corsOrigins,
    corsOriginPatterns: originPatterns.patterns,
    corsAllowAll: corsOrigins.length === 0 && originPatterns.patterns.length === 0 && !isProduction,
    allowRemoteDevDb: e.ALLOW_REMOTE_DEV_DB,
    logLevel: e.LOG_LEVEL ?? (isTest ? 'silent' : 'info'),
    db,
    mainDb,
    testDb,
    jwt: {
      accessSecret,
      accessSecretEphemeral,
      activeKid,
      accessKeys,
      accessTtl: e.ACCESS_TOKEN_TTL,
      accessTtlSeconds,
      refreshTtlDays: e.REFRESH_TOKEN_TTL_DAYS,
      refreshTtlSeconds: e.REFRESH_TOKEN_TTL_DAYS * 86400,
    },
    totpIssuer: e.TOTP_ISSUER,
    rateLimitEnabled: e.RATE_LIMIT_ENABLED,
    storage: {
      driver,
      provider: e.S3_PROVIDER ?? null,
      bucket: e.AWS_BUCKET_NAME ?? null,
      endpoint: e.S3_ENDPOINT ?? null,
      region: e.AWS_REGION ?? null,
      accessKeyId: e.AWS_ACCESS_KEY_ID ?? null,
      secretAccessKey: e.AWS_SECRET_ACCESS_KEY ?? null,
      keyPrefix,
      localDir: path.resolve(ROOT_DIR, e.STORAGE_LOCAL_DIR ?? 'storage'),
      configured: driver === 'local' || s3Configured,
    },
    redisUrl,
    jobsInProcess: e.JOBS_IN_PROCESS,
    singleInstance,
    sms: {
      provider: isTest ? 'console' : e.SMS_PROVIDER,
      webpay: {
        url: e.SMS_API_URL ?? null,
        username: e.SMS_API_USERNAME ?? null,
        apiKey: e.SMS_API_KEY ?? null,
        senderId: e.SMS_SENDER_ID ?? null,
        route: e.SMS_ROUTE ?? null,
        templateId: e.SMS_DLT_TEMPLATE_ID ?? null,
      },
      otp: {
        message: otpMessage,
        expirySeconds: e.SMS_OTP_EXPIRY_MIN * 60,
        maxAttempts: e.SMS_OTP_MAX_ATTEMPTS,
        resendSeconds: e.SMS_OTP_RESEND_SECONDS,
        dailyCapPerPhone: e.SMS_OTP_DAILY_CAP,
        globalDailyCap: e.SMS_OTP_GLOBAL_DAILY_CAP,
      },
      devAllowedNumbers,
      allowlistOnly: e.SMS_ALLOWLIST_ONLY,
      lowBalanceThreshold: e.SMS_LOW_BALANCE_THRESHOLD,
    },
    push: { firebaseServiceAccountB64: e.FIREBASE_SERVICE_ACCOUNT_B64 ?? null },
    smtp: {
      enabled: Boolean(e.SMTP_HOST) && !isTest,
      host: e.SMTP_HOST ?? null,
      port: e.SMTP_PORT,
      secure: e.SMTP_PORT === 465,
      user: e.SMTP_USER ?? null,
      pass: e.SMTP_PASS ?? null,
      from: e.MAIL_FROM,
    },
    google: { mapsServerKey: e.GOOGLE_MAPS_SERVER_KEY ?? null },
    observability: {
      metricsToken: e.METRICS_TOKEN ?? null,
      // Tests never report to Sentry, whatever the environment says.
      sentry: e.SENTRY_DSN && !isTest ? { dsn: e.SENTRY_DSN.trim(), environment: e.SENTRY_ENVIRONMENT ?? env, release: e.SENTRY_RELEASE ?? null } : null,
    },
    defaultTimezone: e.DEFAULT_TIMEZONE,
    platformAdminEmail: e.PLATFORM_ADMIN_EMAIL,
    platformAdminInitialPassword: e.PLATFORM_ADMIN_INITIAL_PASSWORD ?? null,
    seedDefaultPassword: e.SEED_DEFAULT_PASSWORD ?? null,
    warnings,
  });
}

function dbSummary(c: DbConnection | null) {
  if (!c) return null;
  return { source: c.source, database: c.database, ssl: c.connectionString ? 'per-url' : Boolean(c.ssl), poolMax: c.max };
}

/** Diagnostic view of a config with every secret (and host/user names) removed. */
export function redactedSummary(cfg: Config = config) {
  return {
    env: cfg.env,
    port: cfg.port,
    appPublicUrl: cfg.appPublicUrl,
    trustProxy: cfg.trustProxy,
    corsOrigins: cfg.corsOrigins,
    corsOriginPatterns: cfg.corsOriginPatterns,
    corsAllowAll: cfg.corsAllowAll,
    logLevel: cfg.logLevel,
    db: { owner: dbSummary(cfg.db.owner), app: dbSummary(cfg.db.app), appIsOwnerFallback: cfg.db.appIsOwnerFallback },
    jwt: { accessTtl: cfg.jwt.accessTtl, refreshTtlDays: cfg.jwt.refreshTtlDays, ephemeralSecret: cfg.jwt.accessSecretEphemeral, activeKid: cfg.jwt.activeKid, keyIds: Object.keys(cfg.jwt.accessKeys) },
    rateLimitEnabled: cfg.rateLimitEnabled,
    storage: { driver: cfg.storage.driver, provider: cfg.storage.provider, region: cfg.storage.region, keyPrefix: cfg.storage.keyPrefix, configured: cfg.storage.configured },
    redisEnabled: Boolean(cfg.redisUrl),
    jobsInProcess: cfg.jobsInProcess,
    singleInstance: cfg.singleInstance,
    // Never the API key, username, URL or the OTP message text.
    sms: {
      provider: cfg.sms.provider,
      route: cfg.sms.webpay.route,
      senderId: cfg.sms.webpay.senderId,
      templateConfigured: Boolean(cfg.sms.webpay.templateId),
      otp: {
        expiryMinutes: cfg.sms.otp.expirySeconds / 60,
        maxAttempts: cfg.sms.otp.maxAttempts,
        resendSeconds: cfg.sms.otp.resendSeconds,
        dailyCapPerPhone: cfg.sms.otp.dailyCapPerPhone,
        globalDailyCap: cfg.sms.otp.globalDailyCap,
      },
      devAllowedNumbers: cfg.sms.devAllowedNumbers.length,
      allowlistOnly: cfg.sms.allowlistOnly,
      lowBalanceThreshold: cfg.sms.lowBalanceThreshold,
    },
    pushEnabled: Boolean(cfg.push.firebaseServiceAccountB64),
    smtpEnabled: cfg.smtp.enabled,
    googleRoutingEnabled: Boolean(cfg.google.mapsServerKey),
    // Never the metrics token or the DSN.
    metricsEnabled: Boolean(cfg.observability.metricsToken),
    sentry: cfg.observability.sentry ? { enabled: true, environment: cfg.observability.sentry.environment, release: cfg.observability.sentry.release } : { enabled: false },
    defaultTimezone: cfg.defaultTimezone,
  };
}

loadEnvFiles();

/** The process-wide configuration (validated once at import). */
export const config: Config = buildConfig(process.env);
export default config;
