// HTTP side of the metrics (shared/metrics.ts): the request counter/latency middleware and the
// GET /metrics handler (Prometheus text format 0.0.4).
//   * The route label is the Express route PATTERN ('/api/v1/school/buses/:id'), never the raw URL,
//     so ids cannot blow up the label cardinality; requests that match no route count as 'unmatched'.
//   * GET /metrics requires `Authorization: Bearer <METRICS_TOKEN>` (constant-time comparison). Without
//     a configured token the endpoint does not exist (404), so nothing is exposed by default. Wrong or
//     missing credentials → 401 with WWW-Authenticate. Responses are never cached.
import { API_PREFIX } from '@wimb/shared';
import type { Request, RequestHandler, Response } from 'express';
import { safeEqual } from './crypto.js';
import { notFound, unauthenticated } from './errors.js';
import type { KvStore } from './kv.js';
import { appMetrics, readWorkerSnapshot, type AppMetrics } from './metrics.js';
import { bearerFrom } from './tokens.js';

export const METRICS_PATH = '/metrics';
export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** Route pattern of a finished request ('unmatched' when no route handled it). */
export function routeLabel(req: Request): string {
  const pattern = (req.route as { path?: unknown } | undefined)?.path;
  if (typeof pattern !== 'string') return 'unmatched';
  const url = (req.originalUrl ?? req.url ?? '').split('?')[0]!;
  return url.startsWith(`${API_PREFIX}/`) || url === API_PREFIX ? `${API_PREFIX}${pattern}` : pattern;
}

/** Counts every request and observes its latency once the response is finished (or aborted). */
export function httpMetrics(metrics: () => AppMetrics = appMetrics): RequestHandler {
  return function httpMetricsMiddleware(req, res, next) {
    const start = process.hrtime.bigint();
    let done = false;
    const record = () => {
      if (done) return;
      done = true;
      const m = metrics();
      const route = routeLabel(req);
      const method = req.method;
      m.httpRequests.inc({ method, route, status: String(res.statusCode) });
      m.httpDuration.observe({ method, route }, Number(process.hrtime.bigint() - start) / 1e9);
    };
    res.once('finish', record);
    res.once('close', record);
    next();
  };
}

export interface MetricsHandlerOptions {
  /** Bearer token (null → endpoint disabled: 404). */
  token: string | null;
  metrics?: () => AppMetrics;
  /** KV store holding the worker's snapshot (merged when fresh). */
  kv?: KvStore | null;
}

/** GET /metrics */
export function metricsHandler({ token, metrics = appMetrics, kv = null }: MetricsHandlerOptions): RequestHandler {
  return async function metricsRoute(req: Request, res: Response) {
    if (!token) throw notFound();
    const presented = bearerFrom(req.get('authorization'));
    if (!presented || !safeEqual(presented, token)) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="metrics"');
      throw unauthenticated('A valid metrics token is required.');
    }
    const worker = kv ? await readWorkerSnapshot(kv) : [];
    res.setHeader('Content-Type', METRICS_CONTENT_TYPE);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(metrics().registry.render(worker));
  };
}
