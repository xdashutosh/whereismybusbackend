// Idempotency-Key store (contract §5, BP §7.2) on the shared KV store.
//   begin()    claims (scope, key): 'started' | 'replay' (stored response) | 'mismatch' (same key,
//              different request) | 'in_progress' (first request still running)
//   complete() stores the final response (status < 500) for 24 h
//   release()  forgets an in-flight claim (5xx / aborted: the client may retry)
// In-flight claims expire after STALE_IN_FLIGHT_SECONDS so a crashed process never blocks a key.
// Scopes always include the principal (and school) so keys never collide across tenants.
import crypto from 'node:crypto';
import { getJson, kv as defaultKv, kvKey, setJson, type KvStore } from './kv.js';

export const IDEMPOTENCY_TTL_SECONDS = 24 * 3600;
export const STALE_IN_FLIGHT_SECONDS = 120;
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:~-]{8,128}$/;

type Record =
  | { state: 'in_progress'; hash: string }
  | { state: 'done'; hash: string; statusCode: number; body: unknown };

export type BeginResult =
  | { state: 'started' }
  | { state: 'replay'; statusCode: number; body: unknown }
  | { state: 'mismatch' }
  | { state: 'in_progress' };

function canonical(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonical);
  const out: { [k: string]: unknown } = {};
  for (const k of Object.keys(value).sort()) {
    const v = (value as { [k: string]: unknown })[k];
    if (v !== undefined) out[k] = canonical(v);
  }
  return out;
}

/** SHA-256 of method + path + canonical JSON body (key-order independent). */
export function requestHash({ method, path, body }: { method: string; path: string; body: unknown }): string {
  return crypto
    .createHash('sha256')
    .update(`${method.toUpperCase()}\n${path}\n${JSON.stringify(canonical(body ?? null))}`)
    .digest('hex');
}

export function createIdempotencyStore(store: KvStore = defaultKv) {
  const keyOf = (scope: string, key: string) => kvKey('idem', scope, key);
  return {
    async begin(scope: string, key: string, hash: string): Promise<BeginResult> {
      const k = keyOf(scope, key);
      const claimed = await store.setIfAbsent(k, JSON.stringify({ state: 'in_progress', hash } satisfies Record), STALE_IN_FLIGHT_SECONDS);
      if (claimed) return { state: 'started' };
      const existing = await getJson<Record>(store, k);
      if (!existing) {
        // Expired/released between the two calls: try once more.
        const again = await store.setIfAbsent(k, JSON.stringify({ state: 'in_progress', hash } satisfies Record), STALE_IN_FLIGHT_SECONDS);
        return again ? { state: 'started' } : { state: 'in_progress' };
      }
      if (existing.hash !== hash) return { state: 'mismatch' };
      if (existing.state === 'in_progress') return { state: 'in_progress' };
      return { state: 'replay', statusCode: existing.statusCode, body: existing.body };
    },
    async complete(scope: string, key: string, hash: string, statusCode: number, body: unknown): Promise<void> {
      await setJson(store, keyOf(scope, key), { state: 'done', hash, statusCode, body: body ?? null } satisfies Record, IDEMPOTENCY_TTL_SECONDS);
    },
    async release(scope: string, key: string): Promise<void> {
      await store.del(keyOf(scope, key));
    },
  };
}

export type IdempotencyStore = ReturnType<typeof createIdempotencyStore>;
export const idempotencyStore: IdempotencyStore = createIdempotencyStore();
