// Key/value store with TTL (contract §2): Redis when REDIS_URL is set, otherwise an in-process
// LRU+TTL map with the same semantics. Used for live positions, caches, OTP cooldowns, rate-limit
// counters, idempotency records and dedupe locks. Keys MUST include school_id for tenant data
// (contract §4) — build them with kvKey('live', schoolId, tripId).
import { LRUCache } from 'lru-cache';
import config from '../config/index.js';
import { logger as rootLogger } from './logger.js';
import { getRedis, type Redis } from './redis.js';

const log = rootLogger.child({ module: 'kv' });

export interface KvStore {
  readonly name: 'redis' | 'memory';
  get(key: string): Promise<string | null>;
  /** Stores a value; ttlSec omitted = no expiry (use sparingly). */
  set(key: string, value: string, ttlSec?: number): Promise<void>;
  /** SET NX: stores only when absent → true when stored. */
  setIfAbsent(key: string, value: string, ttlSec: number): Promise<boolean>;
  del(...keys: string[]): Promise<void>;
  /** Atomic counter in a fixed window: first increment sets the TTL. → { count, ttlMs } */
  incr(key: string, windowSec: number): Promise<{ count: number; ttlMs: number }>;
  /**
   * Atomic decrement of an existing counter, keeping its window (TTL); a counter that reaches 0 is
   * removed and a missing one stays missing. → the new count (0 when missing).
   */
  decr(key: string): Promise<number>;
  /** Remaining TTL in ms (-1 no expiry, -2 missing). */
  ttlMs(key: string): Promise<number>;
  /** Removes every key with this prefix (tests/maintenance; SCAN on Redis). */
  deleteByPrefix(prefix: string): Promise<number>;
  close(): Promise<void>;
}

/** 'live', schoolId, tripId → 'live:<schoolId>:<tripId>'. */
export function kvKey(...parts: (string | number)[]): string {
  if (!parts.length) throw new TypeError('kvKey requires at least one part');
  return parts.map((p) => String(p).replace(/[\s:]+/g, '_')).join(':');
}

// ── memory ───────────────────────────────────────────────────────────────────
export function createMemoryKv({ maxEntries = 100_000 } = {}): KvStore {
  const lru = new LRUCache<string, string>({ max: maxEntries, ttlAutopurge: false, allowStale: false, updateAgeOnGet: false });
  const ttlOf = (key: string): number => {
    if (!lru.has(key)) return -2;
    const remaining = lru.getRemainingTTL(key);
    return remaining === Infinity || remaining === 0 ? -1 : Math.max(1, Math.round(remaining));
  };
  return {
    name: 'memory',
    async get(key) {
      return lru.get(key) ?? null;
    },
    async set(key, value, ttlSec) {
      lru.set(key, value, ttlSec ? { ttl: Math.max(1, Math.round(ttlSec * 1000)) } : {});
    },
    async setIfAbsent(key, value, ttlSec) {
      if (lru.has(key)) return false;
      lru.set(key, value, { ttl: Math.max(1, Math.round(ttlSec * 1000)) });
      return true;
    },
    async del(...keys) {
      for (const k of keys) lru.delete(k);
    },
    async incr(key, windowSec) {
      const current = lru.get(key);
      if (current === undefined) {
        const ttl = Math.max(1, Math.round(windowSec * 1000));
        lru.set(key, '1', { ttl });
        return { count: 1, ttlMs: ttl };
      }
      const count = Number(current) + 1;
      const remaining = lru.getRemainingTTL(key);
      lru.set(key, String(count), { ttl: Math.max(1, Math.round(remaining)) }); // keep the window end
      return { count, ttlMs: Math.max(1, Math.round(remaining)) };
    },
    async decr(key) {
      const current = lru.get(key);
      if (current === undefined) return 0;
      const count = Number(current) - 1;
      if (!(count > 0)) {
        lru.delete(key);
        return 0;
      }
      const remaining = lru.getRemainingTTL(key);
      lru.set(key, String(count), remaining === Infinity || remaining <= 0 ? {} : { ttl: Math.max(1, Math.round(remaining)) });
      return count;
    },
    async ttlMs(key) {
      return ttlOf(key);
    },
    async deleteByPrefix(prefix) {
      let n = 0;
      for (const k of [...lru.keys()]) {
        if (k.startsWith(prefix)) {
          lru.delete(k);
          n += 1;
        }
      }
      return n;
    },
    async close() {
      lru.clear();
    },
  };
}

// ── redis ────────────────────────────────────────────────────────────────────
const INCR_LUA = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {n, ttl}`;

const DECR_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
local n = redis.call('DECR', KEYS[1])
if n <= 0 then
  redis.call('DEL', KEYS[1])
  return 0
end
return n`;

type RedisWithIncr = Redis & {
  wimbIncrWindow(key: string, windowMs: string): Promise<[number, number]>;
  wimbDecr(key: string): Promise<number>;
};

export function createRedisKv({ client, keyPrefix = 'wimb:' }: { client: Redis; keyPrefix?: string }): KvStore {
  const redis = client as RedisWithIncr;
  if (typeof redis.wimbIncrWindow !== 'function') redis.defineCommand('wimbIncrWindow', { numberOfKeys: 1, lua: INCR_LUA });
  if (typeof redis.wimbDecr !== 'function') redis.defineCommand('wimbDecr', { numberOfKeys: 1, lua: DECR_LUA });
  const k = (key: string) => `${keyPrefix}${key}`;
  return {
    name: 'redis',
    async get(key) {
      return redis.get(k(key));
    },
    async set(key, value, ttlSec) {
      if (ttlSec) await redis.set(k(key), value, 'PX', Math.max(1, Math.round(ttlSec * 1000)));
      else await redis.set(k(key), value);
    },
    async setIfAbsent(key, value, ttlSec) {
      return (await redis.set(k(key), value, 'PX', Math.max(1, Math.round(ttlSec * 1000)), 'NX')) === 'OK';
    },
    async del(...keys) {
      if (keys.length) await redis.del(...keys.map(k));
    },
    async incr(key, windowSec) {
      const [count, ttlMs] = await redis.wimbIncrWindow(k(key), String(Math.max(1, Math.round(windowSec * 1000))));
      return { count: Number(count), ttlMs: Number(ttlMs) };
    },
    async decr(key) {
      return Number(await redis.wimbDecr(k(key)));
    },
    async ttlMs(key) {
      return redis.pttl(k(key));
    },
    async deleteByPrefix(prefix) {
      let cursor = '0';
      let n = 0;
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `${k(prefix)}*`, 'COUNT', 500);
        cursor = next;
        if (keys.length) n += await redis.del(...keys);
      } while (cursor !== '0');
      return n;
    },
    async close() {
      // The shared connection is closed by closeRedis().
    },
  };
}

// ── JSON + cache helpers ─────────────────────────────────────────────────────
export async function getJson<T>(store: KvStore, key: string): Promise<T | null> {
  const raw = await store.get(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function setJson(store: KvStore, key: string, value: unknown, ttlSec?: number): Promise<void> {
  await store.set(key, JSON.stringify(value), ttlSec);
}

const inflight = new Map<string, Promise<unknown>>();

/**
 * Read-through cache: returns the cached JSON value or runs loader() once per key in this
 * process (concurrent callers share the promise). Store failures degrade to a cache miss.
 * Never cache authorization decisions.
 */
export async function cached<T>(key: string, ttlSec: number, loader: () => Promise<T>, store: KvStore = kv): Promise<T> {
  try {
    const hit = await getJson<{ v: T }>(store, key);
    if (hit) return hit.v;
  } catch (err) {
    log.warn({ err: { message: (err as Error).message }, key }, 'Cache read failed');
  }
  const pending = inflight.get(key) as Promise<T> | undefined;
  if (pending) return pending;
  const promise = (async () => {
    const value = await loader();
    try {
      await setJson(store, key, { v: value }, ttlSec);
    } catch (err) {
      log.warn({ err: { message: (err as Error).message }, key }, 'Cache write failed');
    }
    return value;
  })();
  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
}

/** Process-wide store: Redis when configured, memory otherwise. */
export const kv: KvStore = config.redisUrl ? createRedisKv({ client: getRedis('kv') }) : createMemoryKv();
export default kv;
