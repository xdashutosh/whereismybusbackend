// Rate-limit counters (contract §2, BP §7.2): fixed windows on the shared KV store, so limits are
// global across API instances when Redis is configured (per process otherwise).
import { kv as defaultKv, kvKey, type KvStore } from './kv.js';

export interface RateLimitHit {
  /** Requests counted in the current window (including this one). */
  count: number;
  limit: number;
  remaining: number;
  /** Seconds until the window resets. */
  resetSeconds: number;
  limited: boolean;
}

export interface RateLimitStore {
  hit(limiter: string, key: string, limit: number, windowSec: number): Promise<RateLimitHit>;
  /** Clears one key (e.g. after a successful login). */
  reset(limiter: string, key: string): Promise<void>;
}

export function createRateLimitStore(store: KvStore = defaultKv): RateLimitStore {
  const keyOf = (limiter: string, key: string) => kvKey('rl', limiter, key);
  return {
    async hit(limiter, key, limit, windowSec) {
      const { count, ttlMs } = await store.incr(keyOf(limiter, key), windowSec);
      return {
        count,
        limit,
        remaining: Math.max(0, limit - count),
        resetSeconds: Math.max(1, Math.ceil(ttlMs / 1000)),
        limited: count > limit,
      };
    },
    async reset(limiter, key) {
      await store.del(keyOf(limiter, key));
    },
  };
}

export const rateLimitStore: RateLimitStore = createRateLimitStore();
