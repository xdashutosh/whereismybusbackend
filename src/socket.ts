// Socket.IO server (contract §7, BP §8.6). Namespace /rt; the JWT travels in the handshake
// (`auth: { token }` or `Authorization: Bearer`). On connect the session is loaded exactly like an
// HTTP request (revoked/expired → refused) and school-scoped principals must belong to an active
// school. Sockets auto-join actor:{id}, session:{sid} and (staff/admins) school:{id}:members.
// `join` / `leave` ({ room }, ack): every join re-validates the LIVE session (not the handshake
// token, which expires after 15 minutes while the session stays valid): session id unrevoked and
// unexpired, actor active, owner/role/school unchanged, school active — then runs the room's
// registered authorizer. Revocation also disconnects sockets immediately (realtime.disconnectSessions).
// A session refused because its school was closed (closing a school revokes its sessions) answers
// SCHOOL_INACTIVE, not UNAUTHENTICATED, on the handshake and on joins (the client shows the school message).
// `auth:refresh` ({ token }, ack) lets a long-lived socket adopt the fresh access token (and session
// id) of the same principal after an HTTP refresh, without reconnecting.
// Emits arrive via shared/realtime (pub/sub) and are relayed to LOCAL sockets.
// Room memberships are RE-CHECKED after joins too: `realtime.revalidateActors(ids)` (after a change that
// narrows what someone may see) and a periodic sweep (`revalidateIntervalMs`, default 5 min — catches
// assignment windows that simply expire and out-of-band changes) re-run each joined room's authorizer;
// a socket that may no longer watch a room leaves it and receives SOCKET_EVENTS.ROOM_REVOKED. A
// transient authorizer failure (thrown error) keeps the membership until the next check.
// With REDIS_URL the @socket.io/redis-adapter is installed for multi-instance deployments.
import type { Server as HttpServer } from 'node:http';
import { createAdapter } from '@socket.io/redis-adapter';
import { SOCKET_EVENTS, SOCKET_NAMESPACE } from '@wimb/shared';
import { Server, type Namespace, type Socket } from 'socket.io';
import { corsOptions } from './app.js';
import config from './config/index.js';
import { authenticateAccessToken, reloadAuthContext, type AuthContext } from './middleware/authenticate.js';
import { toAppError } from './middleware/errorHandler.js';
import { loadSchoolStateFromDb, runSubscriptionChecks, type SchoolStateLoader } from './middleware/resolveTenant.js';
import { forbidden, notFound, schoolInactive } from './shared/errors.js';
import { logger as rootLogger, type Logger } from './shared/logger.js';
import { pubsub as defaultPubsub, type PubSub } from './shared/pubsub.js';
import {
  roomRegistry as defaultRegistry,
  rooms,
  RT_CONTROL_CHANNEL,
  RT_EMIT_CHANNEL,
  type ControlMessage,
  type EmitMessage,
  type RoomRegistry,
} from './shared/realtime.js';
import { createRedis } from './shared/redis.js';
import { loadSessionFromDb, type SessionLoader } from './shared/sessions.js';
import { bearerFrom, verifyAccessToken } from './shared/tokens.js';

export interface SocketData {
  auth: AuthContext;
}

type RtSocket = Socket<Record<string, never>, Record<string, never>, Record<string, never>, SocketData>;
type AckError = { ok: false; error: { code: string; message: string } };
type Ack = (response: { ok: true; room: string } | AckError) => void;
type RefreshAck = (response: { ok: true; sessionId: string; tokenExpiresAt: string } | AckError) => void;
/** Codes that end the socket (the session is gone or the school closed). */
const FATAL_CODES = new Set(['UNAUTHENTICATED', 'SCHOOL_INACTIVE']);

/** Built-in school rooms: school admins of that (active) school only. Idempotent per registry. */
const builtinRegistries = new WeakSet<RoomRegistry>();
export function registerBuiltinRooms(registry: RoomRegistry = defaultRegistry): void {
  if (builtinRegistries.has(registry)) return;
  builtinRegistries.add(registry);
  const adminOfSchool = async (p: AuthContext, params: Record<string, string>) => p.role === 'school_admin' && p.schoolId === params.schoolId;
  registry.register('school:{schoolId}:fleet', adminOfSchool);
  registry.register('school:{schoolId}:alerts', adminOfSchool);
}

export interface SocketServerOptions {
  loadSession?: SessionLoader;
  loadSchool?: SchoolStateLoader;
  registry?: RoomRegistry;
  pubsub?: PubSub;
  redisUrl?: string | null;
  logger?: Logger;
  /** Periodic re-check of every joined room (ms); 0 disables the sweep. */
  revalidateIntervalMs?: number;
}

/** Default period of the room-membership sweep. */
export const ROOM_REVALIDATE_INTERVAL_MS = 5 * 60_000;
/** Sockets re-checked in parallel by one sweep. */
const REVALIDATE_CONCURRENCY = 8;

export interface SocketServer {
  io: Server;
  namespace: Namespace;
  /**
   * Re-checks the joined rooms of the local sockets (all, or those of `actorIds`); returns the number
   * of memberships removed. Runs on `realtime.revalidateActors` and on the periodic sweep.
   */
  revalidate(opts?: { actorIds?: readonly string[] }): Promise<number>;
  close(): Promise<void>;
}

export async function createSocketServer(httpServer: HttpServer, opts: SocketServerOptions = {}): Promise<SocketServer> {
  const {
    loadSession = loadSessionFromDb,
    loadSchool = loadSchoolStateFromDb,
    registry = defaultRegistry,
    pubsub = defaultPubsub,
    redisUrl = config.redisUrl,
    logger = rootLogger.child({ module: 'socket' }),
    revalidateIntervalMs = ROOM_REVALIDATE_INTERVAL_MS,
  } = opts;
  registerBuiltinRooms(registry);
  const cors = corsOptions();
  const io = new Server(httpServer, {
    cors: { origin: cors.origin as never, credentials: true },
    serveClient: false,
    pingInterval: 25000,
    pingTimeout: 20000,
    maxHttpBufferSize: 64 * 1024,
  });
  const redisClients = redisUrl ? [createRedis('socket-pub', redisUrl), createRedis('socket-sub', redisUrl)] : [];
  if (redisClients.length === 2) io.adapter(createAdapter(redisClients[0]!, redisClients[1]!, { key: 'wimb:sio' }));

  const nsp = io.of(SOCKET_NAMESPACE);

  const assertSchoolActive = async (schoolId: string) => {
    const school = await loadSchool(schoolId);
    if (!school || school.deleted || school.status !== 'active') throw schoolInactive();
    // Expired / cancelled plans close the school for sockets too (platform subscription hook).
    await runSubscriptionChecks(school, null);
  };

  /**
   * A refused session whose school is closed is reported as SCHOOL_INACTIVE, not UNAUTHENTICATED: closing
   * a school revokes its sessions, and the client must show the school-inactive message, not "session ended".
   */
  const refineSessionError = async (err: unknown, schoolId: string | null | undefined): Promise<unknown> => {
    if (!schoolId || toAppError(err).code !== 'UNAUTHENTICATED') return err;
    try {
      const school = await loadSchool(schoolId);
      if (!school || school.deleted || school.status !== 'active') return schoolInactive();
    } catch {
      /* keep the original refusal */
    }
    return err;
  };
  /** Live session of a socket, refined as above. */
  const reloadSocketAuth = async (auth: AuthContext): Promise<AuthContext> => {
    try {
      return await reloadAuthContext(auth, loadSession);
    } catch (err) {
      throw await refineSessionError(err, auth.schoolId);
    }
  };
  /** School claimed by a (signature-checked, unexpired) access token; null when it does not verify. */
  const claimedSchoolId = (token: string): string | null => {
    try {
      return verifyAccessToken(token).schoolId;
    } catch {
      return null;
    }
  };

  /** Re-runs the authorizer of every registered room the socket joined; returns the rooms it left. */
  const revalidateSocket = async (socket: RtSocket): Promise<number> => {
    const joined = [...socket.rooms].filter((room) => registry.match(room) !== null);
    if (!joined.length || !socket.connected) return 0;
    let fresh: AuthContext;
    try {
      fresh = await reloadSocketAuth(socket.data.auth);
      if (fresh.schoolId) await assertSchoolActive(fresh.schoolId);
    } catch (err) {
      const appErr = toAppError(err);
      if (FATAL_CODES.has(appErr.code)) {
        socket.disconnect(true);
        return joined.length;
      }
      logger.warn({ err, actorId: socket.data.auth.actorId }, 'Room revalidation skipped (session check failed)');
      return 0;
    }
    socket.data.auth = fresh;
    let left = 0;
    for (const room of joined) {
      const match = registry.match(room)!;
      let allowed: boolean;
      try {
        allowed = await match.def.authorize(fresh, match.params, room);
      } catch (err) {
        logger.warn({ err, room, actorId: fresh.actorId }, 'Room revalidation failed; membership kept until the next check');
        continue;
      }
      if (allowed) continue;
      await socket.leave(room);
      (socket as unknown as Socket).emit(SOCKET_EVENTS.ROOM_REVOKED, { room, reason: 'NOT_ALLOWED' });
      left += 1;
    }
    return left;
  };

  const revalidate = async ({ actorIds }: { actorIds?: readonly string[] } = {}): Promise<number> => {
    const actorRooms = actorIds ? new Set(actorIds.map((id) => rooms.actor(id))) : null;
    const targets = [...nsp.sockets.values()].filter((sk) => !actorRooms || [...sk.rooms].some((r) => actorRooms.has(r))) as RtSocket[];
    let removed = 0;
    for (let i = 0; i < targets.length; i += REVALIDATE_CONCURRENCY) {
      const counts = await Promise.all(targets.slice(i, i + REVALIDATE_CONCURRENCY).map((sk) => revalidateSocket(sk)));
      removed += counts.reduce((a, b) => a + b, 0);
    }
    return removed;
  };

  nsp.use((socket: RtSocket, next) => {
    void (async () => {
      const handshakeToken = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
      const token = typeof handshakeToken === 'string' ? handshakeToken : bearerFrom(socket.handshake.headers.authorization);
      if (!token) throw toAppError(Object.assign(new Error('missing token'), { status: 401 }));
      let auth: AuthContext;
      try {
        auth = await authenticateAccessToken(token, loadSession);
      } catch (err) {
        throw await refineSessionError(err, claimedSchoolId(token));
      }
      if (auth.role === 'super_admin') throw forbidden('Platform accounts have no realtime access to school data.');
      if (auth.schoolId) await assertSchoolActive(auth.schoolId);
      socket.data = { auth };
    })().then(
      () => next(),
      (err: unknown) => {
        const appErr = toAppError(err);
        const code = appErr.code === 'VALIDATION_ERROR' ? 'UNAUTHENTICATED' : appErr.code;
        next(Object.assign(new Error(appErr.message), { data: { code } }));
      },
    );
  });

  nsp.on('connection', (socket: RtSocket) => {
    const { auth } = socket.data;
    void socket.join(rooms.actor(auth.actorId));
    void socket.join(rooms.session(auth.sessionId));
    if (auth.schoolId) void socket.join(rooms.schoolMembers(auth.schoolId));

    socket.on(SOCKET_EVENTS.JOIN as never, (payload: unknown, ack?: Ack) => {
      const reply: Ack = typeof ack === 'function' ? ack : () => undefined;
      void (async () => {
        const room = (payload as { room?: unknown } | null)?.room;
        const match = typeof room === 'string' ? registry.match(room) : null;
        if (!match) throw notFound('Unknown room.');
        // Re-validate the live session on every join (revocation, deactivation since connect).
        const fresh = await reloadSocketAuth(socket.data.auth);
        if (fresh.schoolId) await assertSchoolActive(fresh.schoolId);
        socket.data.auth = fresh;
        if (!(await match.def.authorize(fresh, match.params, room as string))) throw forbidden('You are not allowed to join this room.');
        await socket.join(room as string);
        return room as string;
      })().then(
        (joined) => reply({ ok: true, room: joined }),
        (err: unknown) => {
          const appErr = toAppError(err);
          if (appErr.status >= 500) logger.error({ err }, 'Socket join failed');
          reply({ ok: false, error: { code: appErr.code, message: appErr.message } });
          if (FATAL_CODES.has(appErr.code)) socket.disconnect(true);
        },
      );
    });

    socket.on(SOCKET_EVENTS.AUTH_REFRESH as never, (payload: unknown, ack?: RefreshAck) => {
      const reply: RefreshAck = typeof ack === 'function' ? ack : () => undefined;
      void (async () => {
        const token = (payload as { token?: unknown } | null)?.token;
        if (typeof token !== 'string') throw toAppError(Object.assign(new Error('missing token'), { status: 401 }));
        const next = await authenticateAccessToken(token, loadSession);
        const current = socket.data.auth;
        // Same principal only: a socket never changes identity, role or school.
        if (next.actorId !== current.actorId || next.role !== current.role || next.ownerType !== current.ownerType || next.schoolId !== current.schoolId) {
          throw forbidden('The token belongs to another account.');
        }
        if (next.schoolId) await assertSchoolActive(next.schoolId);
        if (next.sessionId !== current.sessionId) {
          await socket.join(rooms.session(next.sessionId));
          await socket.leave(rooms.session(current.sessionId));
        }
        socket.data.auth = next;
        return next;
      })().then(
        (next) => reply({ ok: true, sessionId: next.sessionId, tokenExpiresAt: next.tokenExpiresAt }),
        (err: unknown) => {
          const appErr = toAppError(err);
          const code = appErr.code === 'VALIDATION_ERROR' ? 'UNAUTHENTICATED' : appErr.code;
          if (appErr.status >= 500) logger.error({ err }, 'Socket auth refresh failed');
          // A bad/expired token leaves the socket on its current (still valid) session.
          reply({ ok: false, error: { code, message: appErr.message } });
          if (code === 'SCHOOL_INACTIVE') socket.disconnect(true);
        },
      );
    });

    socket.on(SOCKET_EVENTS.LEAVE as never, (payload: unknown, ack?: Ack) => {
      const room = (payload as { room?: unknown } | null)?.room;
      const reply: Ack = typeof ack === 'function' ? ack : () => undefined;
      if (typeof room !== 'string' || !registry.match(room)) return reply({ ok: false, error: { code: 'NOT_FOUND', message: 'Unknown room.' } });
      void socket.leave(room);
      return reply({ ok: true, room });
    });
  });

  // Relay emits / control messages from any process to the local sockets.
  const unsubscribers = [
    await pubsub.subscribe<EmitMessage>(RT_EMIT_CHANNEL, (msg) => {
      if (msg && typeof msg.room === 'string' && typeof msg.event === 'string') nsp.local.to(msg.room).emit(msg.event as never, msg.payload);
    }),
    await pubsub.subscribe<ControlMessage>(RT_CONTROL_CHANNEL, (msg) => {
      if (msg?.type === 'disconnect-sessions') for (const sid of msg.sessionIds) nsp.local.in(rooms.session(sid)).disconnectSockets(true);
      else if (msg?.type === 'disconnect-school') nsp.local.in(rooms.schoolMembers(msg.schoolId)).disconnectSockets(true);
      else if (msg?.type === 'revalidate-actors' && Array.isArray(msg.actorIds)) {
        revalidate({ actorIds: msg.actorIds }).catch((err: unknown) => logger.error({ err }, 'Room revalidation failed'));
      }
    }),
  ];

  let sweeping = false;
  const sweep =
    revalidateIntervalMs > 0
      ? setInterval(() => {
          if (sweeping) return;
          sweeping = true;
          revalidate()
            .then((removed) => {
              if (removed) logger.info({ removed }, 'Room memberships revoked by the periodic check');
            })
            .catch((err: unknown) => logger.error({ err }, 'Periodic room revalidation failed'))
            .finally(() => {
              sweeping = false;
            });
        }, revalidateIntervalMs)
      : null;
  sweep?.unref();

  return {
    io,
    namespace: nsp,
    revalidate,
    /** Disconnects every socket and closes Socket.IO — which also closes the attached HTTP server. */
    async close() {
      if (sweep) clearInterval(sweep);
      for (const u of unsubscribers) await u();
      nsp.disconnectSockets(true);
      await new Promise<void>((resolve) => {
        void io.close(() => resolve());
      });
      await Promise.allSettled(redisClients.map((c) => c.quit()));
    },
  };
}
