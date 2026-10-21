// Typed in-process event bus. Emit AFTER the transaction commits; listeners run asynchronously
// (next microtask) so an emitter is never slowed down or broken by a listener, and a throwing or
// rejecting listener is logged and isolated. For cross-process delivery use shared/pubsub.
//
// Modules declare their events by augmenting AppEvents:
//   declare module '../../shared/events.js' {
//     interface AppEvents { 'trip.status_changed': { schoolId: string; tripId: string; status: TripStatus } }
//   }
import type { SchoolStatus } from '@wimb/shared';
import { logger as rootLogger, type Logger } from './logger.js';

export interface AppEvents {
  /** A school was activated/suspended/deactivated or soft-deleted (sockets/sessions react). */
  'school.status_changed': { schoolId: string; status: SchoolStatus | 'deleted' };
  /** Sessions of a principal were revoked (sockets disconnect matching connections). */
  'session.revoked': { sessionIds?: string[]; ownerType?: string; ownerId?: string; schoolId?: string };
  /** A platform setting changed (caches drop their copy). */
  'platform_settings.changed': { key: string };
}

export type EventName = keyof AppEvents;
export type Listener<K extends EventName> = (payload: AppEvents[K]) => void | Promise<void>;

export function createEventBus({ logger = rootLogger.child({ module: 'events' }) }: { logger?: Logger } = {}) {
  const listeners = new Map<EventName, Set<Listener<never>>>();
  let failures = 0;

  const fail = (event: EventName, err: unknown) => {
    failures += 1;
    logger.error({ event, err }, 'Event listener failed');
  };

  function on<K extends EventName>(event: K, fn: Listener<K>): () => void {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(fn);
    return () => off(event, fn);
  }

  function off<K extends EventName>(event: K, fn: Listener<K>): void {
    const set = listeners.get(event);
    if (!set) return;
    set.delete(fn);
    if (set.size === 0) listeners.delete(event);
  }

  /** Fire-and-forget; returns the number of listeners notified. */
  function emit<K extends EventName>(event: K, payload: AppEvents[K]): number {
    const fns = [...(listeners.get(event) ?? [])] as Listener<K>[];
    if (!fns.length) return 0;
    queueMicrotask(() => {
      for (const fn of fns) {
        try {
          const r = fn(payload);
          if (r && typeof (r).then === 'function') (r).catch((err: unknown) => fail(event, err));
        } catch (err) {
          fail(event, err);
        }
      }
    });
    return fns.length;
  }

  /** Awaitable variant (tests, shutdown): resolves when every listener settled; never rejects. */
  async function emitAndWait<K extends EventName>(event: K, payload: AppEvents[K]): Promise<number> {
    const fns = [...(listeners.get(event) ?? [])] as Listener<K>[];
    await Promise.all(
      fns.map(async (fn) => {
        try {
          await fn(payload);
        } catch (err) {
          fail(event, err);
        }
      }),
    );
    return fns.length;
  }

  return {
    on,
    off,
    emit,
    emitAndWait,
    listenerCount: (event: EventName) => listeners.get(event)?.size ?? 0,
    removeAll: (event?: EventName) => (event ? listeners.delete(event) : listeners.clear()),
    stats: () => ({ failures, events: Object.fromEntries([...listeners].map(([k, s]) => [k, s.size])) }),
  };
}

export type EventBus = ReturnType<typeof createEventBus>;
export const events: EventBus = createEventBus();
export default events;
