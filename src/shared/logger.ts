// Structured logger (pino) with project-wide redaction (contract §0.5, BP §16/§17): auth headers,
// cookies, passwords, OTPs, tokens and connection strings never reach the output. Request logs
// carry requestId, schoolId, actor id/role (bindings set by middleware).
import { createRequire } from 'node:module';
import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import config from '../config/index.js';

export type { Logger } from 'pino';

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'password',
  'passwordHash',
  'password_hash',
  'newPassword',
  'currentPassword',
  'pin',
  'otp',
  'token',
  'accessToken',
  'refreshToken',
  'totpSecret',
  'totp_secret_enc',
  'fcmToken',
  '*.password',
  '*.passwordHash',
  '*.password_hash',
  '*.newPassword',
  '*.currentPassword',
  '*.pin',
  '*.otp',
  '*.otpHash',
  '*.token',
  '*.tokenHash',
  '*.refreshToken',
  '*.refresh_hash',
  '*.accessToken',
  '*.totpSecret',
  '*.fcmToken',
  '*.secret',
  '*.secretAccessKey',
  '*.authToken',
  'apiKey',
  'apikey',
  '*.apiKey',
  '*.apikey',
  '*.connectionString',
  '*.privateKey',
  '*.private_key',
];

function prettyTransport(): LoggerOptions['transport'] {
  if (!config.isDevelopment || !process.stdout.isTTY) return undefined;
  try {
    createRequire(import.meta.url).resolve('pino-pretty'); // dev dependency only
  } catch {
    return undefined;
  }
  return { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname,service' } };
}

/** Builds a pino logger with the project-wide redaction rules. */
export function createLogger({
  level = config.logLevel,
  name = 'whereismybus',
  destination,
}: { level?: string; name?: string; destination?: DestinationStream } = {}): Logger {
  const options: LoggerOptions = {
    level,
    base: { service: name },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    serializers: { err: pino.stdSerializers.err, error: pino.stdSerializers.err },
  };
  if (destination) return pino(options, destination);
  const transport = prettyTransport();
  return transport ? pino({ ...options, transport }) : pino(options);
}

const SENSITIVE_QUERY_KEYS = new Set([
  'access_token',
  'token',
  'refresh_token',
  'otp',
  'apikey',
  'api_key',
  'signature',
  'sig',
  'x-amz-signature',
  'x-amz-credential',
  'x-amz-security-token',
]);

/** Replaces sensitive query values with [REDACTED]: '/x?token=abc' → '/x?token=[REDACTED]'. */
export function sanitizeUrl(url: unknown): unknown {
  if (typeof url !== 'string') return url;
  const q = url.indexOf('?');
  if (q === -1) return url;
  const base = url.slice(0, q);
  const parts = url
    .slice(q + 1)
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      const rawKey = eq === -1 ? pair : pair.slice(0, eq);
      let key = rawKey;
      try {
        key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
      } catch {
        // keep the raw key
      }
      return SENSITIVE_QUERY_KEYS.has(key.toLowerCase()) ? `${rawKey}=[REDACTED]` : pair;
    });
  return `${base}?${parts.join('&')}`;
}

interface SerializableReq {
  id?: unknown;
  method?: string;
  url?: string;
  originalUrl?: string;
  ip?: string;
  remoteAddress?: string;
  raw?: SerializableReq;
  headers?: Record<string, unknown>;
}

/** pino-http serializers: method, sanitised URL, request id, ip and user agent — never headers or bodies. */
export const httpSerializers = {
  req(req: SerializableReq) {
    const raw = req.raw ?? req;
    return {
      id: req.id,
      method: req.method,
      url: sanitizeUrl(raw.originalUrl ?? req.url),
      ip: raw.ip ?? req.remoteAddress,
      userAgent: req.headers?.['user-agent'],
    };
  },
  res(res: { statusCode?: number }) {
    return { statusCode: res.statusCode };
  },
  err: pino.stdSerializers.err,
};

/** Process-wide logger. */
export const logger: Logger = createLogger();

/** Child logger with fixed bindings, e.g. childLogger({ module: 'jobs' }). */
export function childLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}

export default logger;
