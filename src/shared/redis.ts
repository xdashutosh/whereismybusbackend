// Redis connections (contract §2: required in production, optional in dev/tests). Modules never
// talk to Redis directly — they use shared/kv, shared/pubsub, jobs and the socket adapter, which
// obtain connections here. Connection errors are logged at most every 30 s per connection.
import { Redis, type RedisOptions } from 'ioredis';
import config from '../config/index.js';
import { logger as rootLogger } from './logger.js';

const log = rootLogger.child({ module: 'redis' });
export type { Redis } from 'ioredis';

export type RedisRole = 'kv' | 'pub' | 'sub' | 'bullmq' | 'socket-pub' | 'socket-sub';

/** Fail-fast options for request-path commands; BullMQ needs maxRetriesPerRequest = null. */
export function redisOptions(role: RedisRole): RedisOptions {
  const base: RedisOptions = {
    connectionName: `wimb-${role}`,
    connectTimeout: 5000,
    retryStrategy: (times) => Math.min(times * 500, 10000),
  };
  if (role === 'bullmq') return { ...base, maxRetriesPerRequest: null, enableReadyCheck: true };
  if (role === 'kv' || role === 'pub') return { ...base, enableOfflineQueue: false, maxRetriesPerRequest: 1 };
  return { ...base, maxRetriesPerRequest: null };
}

/** New connection with throttled error logging. */
export function createRedis(role: RedisRole, url: string | null = config.redisUrl): Redis {
  if (!url) throw new Error('REDIS_URL is not configured');
  const client = new Redis(url, redisOptions(role));
  let lastLogged = 0;
  client.on('error', (err: Error & { code?: string }) => {
    const now = Date.now();
    if (now - lastLogged > 30000) {
      lastLogged = now;
      log.warn({ role, err: { message: err.message, code: err.code } }, 'Redis connection error');
    }
  });
  return client;
}

const shared = new Map<RedisRole, Redis>();

/** Process-wide connection for a role (created on first use). */
export function getRedis(role: Extract<RedisRole, 'kv' | 'pub' | 'sub'>): Redis {
  let c = shared.get(role);
  if (!c) {
    c = createRedis(role);
    shared.set(role, c);
  }
  return c;
}

/** Quits every shared connection (graceful shutdown). */
export async function closeRedis(): Promise<void> {
  const clients = [...shared.values()];
  shared.clear();
  await Promise.allSettled(
    clients.map(async (c) => {
      try {
        await c.quit();
      } catch {
        c.disconnect();
      }
    }),
  );
}

/** Readiness probe: { ok, latencyMs } — never throws. */
export async function pingRedis(client: Redis = getRedis('kv')): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = performance.now();
  try {
    await client.ping();
    return { ok: true, latencyMs: Math.round(performance.now() - started) };
  } catch (err) {
    return { ok: false, latencyMs: Math.round(performance.now() - started), error: (err as { code?: string }).code ?? 'REDIS_UNAVAILABLE' };
  }
}
