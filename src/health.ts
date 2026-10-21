// Liveness / readiness (contract §5): GET /healthz (process alive, no I/O) and GET /readyz
// (database via the app pool, Redis when configured, all migrations applied). Mounted at the root.
import { Router, type Request, type Response } from 'express';
import config from './config/index.js';
import { migrationStatus } from './db/migrate.js';
import { getAppPool, ping } from './db/pool.js';
import { pingRedis } from './shared/redis.js';

export interface CheckResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
  skipped?: boolean;
  pending?: string[];
}

export type ReadinessCheck = () => Promise<CheckResult>;

export const defaultReadinessChecks: Record<string, ReadinessCheck> = {
  database: () => ping(getAppPool()),
  redis: async () => (config.redisUrl ? pingRedis() : { ok: true, skipped: true }),
  migrations: async () => {
    try {
      const status = await migrationStatus({ pool: getAppPool() });
      const pending = status.filter((s) => s.status === 'pending' || s.status === 'checksum_mismatch').map((s) => `${s.id} (${s.status})`);
      return { ok: pending.length === 0, pending };
    } catch (err) {
      return { ok: false, error: (err as { code?: string }).code ?? 'MIGRATIONS_UNKNOWN' };
    }
  },
};

const startedAt = Date.now();

export function healthRouter(checks: Record<string, ReadinessCheck> = defaultReadinessChecks): Router {
  const router = Router();
  router.get('/healthz', (_req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store').json({ success: true, data: { status: 'ok', uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) } });
  });
  router.get('/readyz', async (req: Request, res: Response) => {
    const entries = await Promise.all(
      Object.entries(checks).map(async ([name, check]): Promise<[string, CheckResult]> => {
        try {
          return [name, await check()];
        } catch (err) {
          return [name, { ok: false, error: err instanceof Error ? err.message : 'CHECK_FAILED' }];
        }
      }),
    );
    const results: Record<string, CheckResult> = Object.fromEntries(entries);
    const ready = entries.every(([, r]) => r.ok);
    res.set('Cache-Control', 'no-store');
    if (ready) {
      res.json({ success: true, data: { status: 'ready', checks: results } });
      return;
    }
    res.status(503).json({ success: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'The service is not ready.', details: { checks: results }, requestId: req.id } });
  });
  return router;
}
