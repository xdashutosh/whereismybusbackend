// Express application factory (contract §5). No side effects at import. Order:
//   requestId → HTTP metrics → pino-http → helmet → cors → GET /metrics (root, bearer METRICS_TOKEN)
//   → global rate limit → cookie-parser → JSON (1 MB) → /healthz, /readyz (root)
//   → versionGate + module routers (/api/v1) → 404 → errorHandler
import { API_PREFIX, HEADERS } from '@wimb/shared';
import cookieParser from 'cookie-parser';
import cors, { type CorsOptions } from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import config, { type Config } from './config/index.js';
import { originPatternRegExp } from './config/env.js';
import { healthRouter, type ReadinessCheck } from './health.js';
import { errorHandler } from './middleware/errorHandler.js';
import { notFound } from './middleware/notFound.js';
import { rateLimits as defaultRateLimits, type RateLimits } from './middleware/rateLimits.js';
import { requestId } from './middleware/requestId.js';
import { versionGate, type MinVersionLoader } from './middleware/versionGate.js';
import { buildApiRouter, modules as defaultModules, type ModuleEntry } from './modules/index.js';
import { httpMetrics, METRICS_PATH, metricsHandler } from './shared/httpMetrics.js';
import { kv as defaultKv, type KvStore } from './shared/kv.js';
import { httpSerializers, logger as rootLogger, type Logger } from './shared/logger.js';
import { appMetrics, type AppMetrics } from './shared/metrics.js';

export const CORS_ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  HEADERS.IDEMPOTENCY_KEY,
  HEADERS.REQUEST_ID,
  HEADERS.CLIENT,
  HEADERS.SCHOOL_ID,
  HEADERS.APP_NAME,
  HEADERS.APP_VERSION,
  HEADERS.DEVICE_ID,
];
export const CORS_EXPOSED_HEADERS = ['X-Request-Id', 'Retry-After', 'Idempotent-Replayed', 'Content-Disposition', 'RateLimit', 'RateLimit-Policy'];
const PROBE_PATHS = new Set(['/healthz', '/readyz', METRICS_PATH]);

/**
 * Whether a browser Origin is allowed: exact CORS_ORIGINS entries, or a CORS_ORIGIN_PATTERNS regex
 * (e.g. Vercel preview deployments). Shared by Express CORS and the Socket.IO handshake.
 */
export function originAllowed(origin: string, cfg: Pick<Config, 'corsOrigins' | 'corsAllowAll'> & Partial<Pick<Config, 'corsOriginPatterns'>> = config): boolean {
  if (cfg.corsAllowAll) return true;
  const o = origin.replace(/\/+$/, '');
  if (cfg.corsOrigins.includes(o)) return true;
  return (cfg.corsOriginPatterns ?? []).some((p) => compiledPattern(p).test(o));
}

const patternCache = new Map<string, RegExp>();
function compiledPattern(p: string): RegExp {
  let re = patternCache.get(p);
  if (!re) patternCache.set(p, (re = originPatternRegExp(p)));
  return re;
}

/** CORS allow-list with credentials; an empty list allows all origins (development only). */
export function corsOptions(cfg: Pick<Config, 'corsOrigins' | 'corsAllowAll'> & Partial<Pick<Config, 'corsOriginPatterns'>> = config): CorsOptions {
  return {
    origin(origin, callback) {
      if (!origin) return callback(null, true); // mobile apps, curl, server-to-server
      return callback(null, originAllowed(origin, cfg));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: CORS_ALLOWED_HEADERS,
    exposedHeaders: CORS_EXPOSED_HEADERS,
    maxAge: 600,
  };
}

export interface CreateAppOptions {
  logger?: Logger;
  rateLimits?: RateLimits;
  modules?: readonly ModuleEntry[];
  readinessChecks?: Record<string, ReadinessCheck>;
  loadMinVersions?: MinVersionLoader;
  /** Bearer token of GET /metrics (default METRICS_TOKEN; null disables the endpoint). */
  metricsToken?: string | null;
  /** Metrics registry (default: the process-wide appMetrics()). */
  metrics?: () => AppMetrics;
  /** KV store holding the worker's metrics snapshot (default: the process KV store). */
  metricsKv?: KvStore | null;
}

export function createApp({
  logger = rootLogger,
  rateLimits = defaultRateLimits,
  modules = defaultModules,
  readinessChecks,
  loadMinVersions,
  metricsToken = config.observability.metricsToken,
  metrics = appMetrics,
  metricsKv = defaultKv,
}: CreateAppOptions = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('json spaces', 0);

  app.use(requestId());
  app.use(httpMetrics(metrics));
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).id,
      serializers: httpSerializers,
      wrapSerializers: false,
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      autoLogging: { ignore: (req) => PROBE_PATHS.has(String(req.url).split('?')[0]!) },
      customSuccessMessage: (req, res) => `${req.method} ${res.statusCode}`,
      customErrorMessage: (req, res) => `${req.method} ${res.statusCode}`,
    }),
  );
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.use(cors(corsOptions()));
  app.get(METRICS_PATH, rateLimits.global, metricsHandler({ token: metricsToken, metrics, kv: metricsKv }));
  app.use(API_PREFIX, rateLimits.global);
  app.use(cookieParser());
  app.use(express.json({ limit: '1mb', strict: true }));

  app.use(healthRouter(readinessChecks));
  app.use(API_PREFIX, versionGate(loadMinVersions ? { loadMinVersions } : {}));
  app.use(API_PREFIX, buildApiRouter(modules));

  app.use(notFound());
  app.use(errorHandler({ logger }));
  return app;
}

export default createApp;
