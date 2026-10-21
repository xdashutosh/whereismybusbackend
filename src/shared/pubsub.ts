// Cross-process publish/subscribe (contract §2): Redis pub/sub when REDIS_URL is set (worker →
// API → Socket.IO fan-out across instances), otherwise an in-process EventEmitter with the same
// asynchronous, JSON-serialised delivery. Channel names include school_id where tenant data flows.
import { EventEmitter } from 'node:events';
import config from '../config/index.js';
import { logger as rootLogger } from './logger.js';
import { getRedis, type Redis } from './redis.js';

const log = rootLogger.child({ module: 'pubsub' });

export type MessageHandler<T = unknown> = (message: T, channel: string) => void | Promise<void>;

export interface PubSub {
  readonly name: 'redis' | 'memory';
  publish(channel: string, message: unknown): Promise<void>;
  /** Subscribes to an exact channel; resolves an unsubscribe function. */
  subscribe<T = unknown>(channel: string, handler: MessageHandler<T>): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

function runHandler(handler: MessageHandler<never>, raw: string, channel: string): void {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    log.warn({ channel }, 'Dropping malformed pub/sub message');
    return;
  }
  try {
    const result = (handler as MessageHandler)(message, channel);
    if (result && typeof (result).then === 'function') {
      (result).catch((err: unknown) => log.error({ err, channel }, 'Pub/sub handler failed'));
    }
  } catch (err) {
    log.error({ err, channel }, 'Pub/sub handler failed');
  }
}

export function createMemoryPubSub(): PubSub {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  return {
    name: 'memory',
    async publish(channel, message) {
      const raw = JSON.stringify(message ?? null);
      // Asynchronous like Redis: publishers never run subscriber code synchronously.
      setImmediate(() => emitter.emit(channel, raw));
    },
    async subscribe<T>(channel: string, handler: MessageHandler<T>) {
      const listener = (raw: string) => runHandler(handler, raw, channel);
      emitter.on(channel, listener);
      return async () => {
        emitter.off(channel, listener);
      };
    },
    async close() {
      emitter.removeAllListeners();
    },
  };
}

export function createRedisPubSub({ publisher, subscriber, channelPrefix = 'wimb:' }: { publisher: Redis; subscriber: Redis; channelPrefix?: string }): PubSub {
  const handlers = new Map<string, Set<MessageHandler<never>>>();
  subscriber.on('message', (fullChannel: string, raw: string) => {
    if (!fullChannel.startsWith(channelPrefix)) return;
    const channel = fullChannel.slice(channelPrefix.length);
    for (const h of handlers.get(channel) ?? []) runHandler(h, raw, channel);
  });
  return {
    name: 'redis',
    async publish(channel, message) {
      await publisher.publish(`${channelPrefix}${channel}`, JSON.stringify(message ?? null));
    },
    async subscribe<T>(channel: string, handler: MessageHandler<T>) {
      let set = handlers.get(channel);
      if (!set) {
        set = new Set();
        handlers.set(channel, set);
        await subscriber.subscribe(`${channelPrefix}${channel}`);
      }
      set.add(handler);
      return async () => {
        const s = handlers.get(channel);
        if (!s) return;
        s.delete(handler);
        if (s.size === 0) {
          handlers.delete(channel);
          await subscriber.unsubscribe(`${channelPrefix}${channel}`);
        }
      };
    },
    async close() {
      handlers.clear();
    },
  };
}

/** Process-wide pub/sub (the subscriber connection is dedicated, as Redis requires). */
export const pubsub: PubSub = config.redisUrl
  ? createRedisPubSub({ publisher: getRedis('pub'), subscriber: getRedis('sub') })
  : createMemoryPubSub();
export default pubsub;

