// Pub/sub contract: in-memory EventEmitter and Redis (ioredis-mock) deliver JSON asynchronously.
import RedisMock from 'ioredis-mock';
import { afterAll, describe, expect, it } from 'vitest';
import { createMemoryPubSub, createRedisPubSub, type PubSub } from '../src/shared/pubsub.js';

const publisher = new RedisMock();
const subscriber = new RedisMock();
afterAll(() => {
  publisher.disconnect();
  subscriber.disconnect();
});

const next = <T>(bus: PubSub, channel: string) =>
  new Promise<T>((resolve) => {
    void bus.subscribe<T>(channel, (m) => resolve(m));
  });

describe.each<[string, () => PubSub]>([
  ['memory', () => createMemoryPubSub()],
  ['redis', () => createRedisPubSub({ publisher, subscriber, channelPrefix: `t${Math.random().toString(36).slice(2)}:` })],
])('%s pubsub', (_name, make) => {
  it('delivers JSON copies asynchronously to every subscriber of the channel', async () => {
    const bus = make();
    const received: unknown[] = [];
    const unsubscribe = await bus.subscribe('school:1', (m) => {
      received.push(m);
    });
    const other = next<{ n: number }>(bus, 'school:1');
    const payload = { n: 1, nested: { at: '2026-10-17T00:00:00.000Z' } };
    await bus.publish('school:1', payload);
    expect(received).toEqual([]); // never synchronous
    expect(await other).toEqual(payload);
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toEqual([payload]);
    expect(received[0]).not.toBe(payload);
    await unsubscribe();
    await bus.publish('school:1', { n: 2 });
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toHaveLength(1);
  });

  it('isolates channels and survives throwing handlers', async () => {
    const bus = make();
    await bus.subscribe('a', () => {
      throw new Error('handler bug');
    });
    const b = next<string>(bus, 'b');
    await bus.publish('a', 'x');
    await bus.publish('b', 'y');
    expect(await b).toBe('y');
  });
});
