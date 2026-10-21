// KV store contract, run against the in-memory store and the Redis store (ioredis-mock, Lua incl.).
import RedisMock from 'ioredis-mock';
import { afterAll, describe, expect, it } from 'vitest';
import { cached, createMemoryKv, createRedisKv, getJson, kvKey, setJson, type KvStore } from '../src/shared/kv.js';
import { createRateLimitStore } from '../src/shared/rateLimitStore.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const redis = new RedisMock();
afterAll(() => redis.disconnect());

const stores: [string, () => KvStore][] = [
  ['memory', () => createMemoryKv()],
  ['redis', () => createRedisKv({ client: redis, keyPrefix: `t${Math.random().toString(36).slice(2)}:` })],
];

describe.each(stores)('%s kv', (_name, make) => {
  it('gets, sets with TTL, deletes', async () => {
    const kv = make();
    expect(await kv.get('a')).toBeNull();
    await kv.set('a', '1', 0.15);
    expect(await kv.get('a')).toBe('1');
    const ttl = await kv.ttlMs('a');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(150);
    await sleep(200);
    expect(await kv.get('a')).toBeNull();
    await kv.set('b', '2');
    expect(await kv.ttlMs('b')).toBe(-1);
    expect(await kv.ttlMs('missing')).toBe(-2);
    await kv.del('b');
    expect(await kv.get('b')).toBeNull();
  });

  it('setIfAbsent claims exactly once', async () => {
    const kv = make();
    const results = await Promise.all([kv.setIfAbsent('lock', 'x', 5), kv.setIfAbsent('lock', 'y', 5), kv.setIfAbsent('lock', 'z', 5)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('incr counts within a fixed window and restarts after it', async () => {
    const kv = make();
    expect((await kv.incr('c', 0.2)).count).toBe(1);
    const second = await kv.incr('c', 0.2);
    expect(second.count).toBe(2);
    expect(second.ttlMs).toBeGreaterThan(0);
    expect(second.ttlMs).toBeLessThanOrEqual(200);
    await sleep(250);
    expect((await kv.incr('c', 0.2)).count).toBe(1);
  });

  it('deletes by prefix and round-trips JSON', async () => {
    const kv = make();
    await setJson(kv, 'p:1', { a: 1 });
    await setJson(kv, 'p:2', [1, 2]);
    await kv.set('q:1', 'keep');
    expect(await getJson(kv, 'p:1')).toEqual({ a: 1 });
    expect(await kv.deleteByPrefix('p:')).toBe(2);
    expect(await kv.get('q:1')).toBe('keep');
  });

  it('backs the rate-limit store', async () => {
    const rl = createRateLimitStore(make());
    expect((await rl.hit('login', 'ip', 2, 60)).limited).toBe(false);
    expect((await rl.hit('login', 'ip', 2, 60)).remaining).toBe(0);
    const third = await rl.hit('login', 'ip', 2, 60);
    expect(third).toMatchObject({ limited: true, count: 3, limit: 2 });
    expect(third.resetSeconds).toBeGreaterThan(0);
    await rl.reset('login', 'ip');
    expect((await rl.hit('login', 'ip', 2, 60)).count).toBe(1);
  });
});

describe('helpers', () => {
  it('kvKey joins parts and neutralises separators', () => {
    expect(kvKey('live', 'school-1', 'trip:2')).toBe('live:school-1:trip_2');
    expect(() => kvKey()).toThrow(TypeError);
  });

  it('cached() loads once per key for concurrent callers and serves later reads from the store', async () => {
    const kv = createMemoryKv();
    let loads = 0;
    const loader = async () => {
      loads += 1;
      await sleep(20);
      return { n: loads };
    };
    const [a, b] = await Promise.all([cached('k', 60, loader, kv), cached('k', 60, loader, kv)]);
    expect(a).toEqual({ n: 1 });
    expect(b).toEqual({ n: 1 });
    expect(await cached('k', 60, loader, kv)).toEqual({ n: 1 });
    expect(loads).toBe(1);
  });

  it('cached() degrades to the loader when the store fails', async () => {
    const broken: KvStore = { ...createMemoryKv(), get: () => Promise.reject(new Error('down')), set: () => Promise.reject(new Error('down')) };
    expect(await cached('k', 60, async () => 42, broken)).toBe(42);
  });
});
