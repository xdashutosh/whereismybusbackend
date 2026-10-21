// Realtime facade (contract §7). Modules never touch Socket.IO directly:
//   registerRoom('trip:{tripId}', async (principal, { tripId }) => …)   room authorization
//   realtime.emit(`trip:${tripId}`, SOCKET_EVENTS.LIVE_POSITION, payload)  from API or worker
//   realtime.disconnectSessions([sid]) / realtime.disconnectSchool(schoolId)
//   realtime.revalidateActors([actorId])  re-check room memberships after a narrowing change
// Emits and control messages travel over shared/pubsub (Redis across processes, in-process
// otherwise); every API instance relays them to its LOCAL sockets, so each socket receives a
// message exactly once whatever the number of instances. Every `join` re-runs the authorizer.
import type { SocketEvent } from '@wimb/shared';
import type { AuthContext } from '../middleware/authenticate.js';
import { pubsub as defaultPubsub, type PubSub } from './pubsub.js';

export const RT_EMIT_CHANNEL = 'rt:emit';
export const RT_CONTROL_CHANNEL = 'rt:control';

export type RoomParams = Record<string, string>;
/** Resolves true to allow the principal into the room; may throw an AppError. */
export type RoomAuthorizer = (principal: AuthContext, params: RoomParams, room: string) => Promise<boolean>;

interface RoomDef {
  pattern: string;
  regex: RegExp;
  names: string[];
  authorize: RoomAuthorizer;
}

const PARAM_RE = /\{([a-zA-Z][a-zA-Z0-9]*)\}/g;
const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';

export function createRoomRegistry() {
  const rooms: RoomDef[] = [];
  return {
    /** Registers a room pattern; `{name}` segments match lower-case UUIDs. */
    register(pattern: string, authorize: RoomAuthorizer): void {
      if (!/^[a-z][a-z0-9_]*(:(\{[a-zA-Z][a-zA-Z0-9]*\}|[a-z0-9_]+))+$/.test(pattern)) throw new TypeError(`Invalid room pattern: ${pattern}`);
      if (rooms.some((r) => r.pattern === pattern)) throw new TypeError(`Room already registered: ${pattern}`);
      const names: string[] = [];
      // The pattern is validated above: only [a-z0-9_:] literals and {param} segments.
      const source = pattern.replace(PARAM_RE, (_m, name: string) => {
        names.push(name);
        return UUID;
      });
      rooms.push({ pattern, regex: new RegExp(`^${source}$`), names, authorize });
    },
    /** Finds the definition and parameters of a concrete room name. */
    match(room: string): { def: RoomDef; params: RoomParams } | null {
      if (typeof room !== 'string' || room.length > 200) return null;
      for (const def of rooms) {
        const m = def.regex.exec(room);
        if (!m) continue;
        const params: RoomParams = {};
        def.names.forEach((n, i) => {
          params[n] = m[i + 1]!;
        });
        return { def, params };
      }
      return null;
    },
    patterns: () => rooms.map((r) => r.pattern),
  };
}

export type RoomRegistry = ReturnType<typeof createRoomRegistry>;

/** Process-wide room registry (modules register at import time). */
export const roomRegistry: RoomRegistry = createRoomRegistry();
export const registerRoom = (pattern: string, authorize: RoomAuthorizer): void => roomRegistry.register(pattern, authorize);

export interface EmitMessage {
  room: string;
  event: string;
  payload: unknown;
}

export type ControlMessage =
  | { type: 'disconnect-sessions'; sessionIds: string[] }
  | { type: 'disconnect-school'; schoolId: string }
  | { type: 'revalidate-actors'; actorIds: string[] };

export function createRealtime(bus: PubSub = defaultPubsub) {
  return {
    /** Emits an event to every socket in a room (any process). */
    emit(room: string, event: SocketEvent | (string & {}), payload: unknown): Promise<void> {
      return bus.publish(RT_EMIT_CHANNEL, { room, event, payload } satisfies EmitMessage);
    },
    /** Disconnects the sockets of revoked sessions (logout, deactivation). */
    disconnectSessions(sessionIds: string[]): Promise<void> {
      return bus.publish(RT_CONTROL_CHANNEL, { type: 'disconnect-sessions', sessionIds } satisfies ControlMessage);
    },
    /**
     * Re-runs the room authorizers for every socket of these principals (user / parent account ids)
     * and removes them from rooms they may no longer watch (they receive SOCKET_EVENTS.ROOM_REVOKED).
     * Call after commit when a change narrows what someone may see (assignment moved, crew reassigned).
     */
    revalidateActors(actorIds: readonly string[]): Promise<void> {
      const ids = [...new Set(actorIds)];
      if (!ids.length) return Promise.resolve();
      return bus.publish(RT_CONTROL_CHANNEL, { type: 'revalidate-actors', actorIds: ids } satisfies ControlMessage);
    },
    /** Disconnects every socket of a school (suspension / deactivation / deletion). */
    disconnectSchool(schoolId: string): Promise<void> {
      return bus.publish(RT_CONTROL_CHANNEL, { type: 'disconnect-school', schoolId } satisfies ControlMessage);
    },
  };
}

export type Realtime = ReturnType<typeof createRealtime>;
export const realtime: Realtime = createRealtime();

/** Room names (contract §7) — use these builders instead of string literals. */
export const rooms = {
  schoolFleet: (schoolId: string) => `school:${schoolId}:fleet`,
  schoolAlerts: (schoolId: string) => `school:${schoolId}:alerts`,
  trip: (tripId: string) => `trip:${tripId}`,
  childLive: (studentId: string) => `child:${studentId}:live`,
  /** Auto-joined personal room (in-app notifications). */
  actor: (actorId: string) => `actor:${actorId}`,
  /** Auto-joined per session (revocation). */
  session: (sessionId: string) => `session:${sessionId}`,
  /** Auto-joined for every school-scoped principal (school deactivation). */
  schoolMembers: (schoolId: string) => `school:${schoolId}:members`,
};
