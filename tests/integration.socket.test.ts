// Integrator regressions — long-lived Socket.IO connections (contract §7):
//   · joins are authorized against the LIVE session, not the handshake access token (which expires
//     after 15 minutes): a socket keeps joining rooms while its session is valid;
//   · `auth:refresh` adopts the fresh token/session of the SAME principal without reconnecting;
//   · revocation and school deactivation still end the socket.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SOCKET_EVENTS } from '@wimb/shared';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerSubscriptionCheck, type SchoolState } from '../src/middleware/resolveTenant.js';
import { schoolInactive } from '../src/shared/errors.js';
import { createMemoryPubSub } from '../src/shared/pubsub.js';
import { createRealtime, createRoomRegistry, rooms } from '../src/shared/realtime.js';
import { signAccessToken } from '../src/shared/tokens.js';
import { createSocketServer, type SocketServer } from '../src/socket.js';
import { createSessionStore } from './helpers/auth.js';

const SCHOOL_A = '0a000000-0000-4000-8000-0000000000a1';
const SCHOOL_B = '0b000000-0000-4000-8000-0000000000b1';
const states: Record<string, SchoolState> = {
  [SCHOOL_A]: { id: SCHOOL_A, status: 'active', deleted: false, timezone: 'Asia/Kolkata', tenantMode: 'shared', dbConnectionRef: null },
  [SCHOOL_B]: { id: SCHOOL_B, status: 'active', deleted: false, timezone: 'Asia/Kolkata', tenantMode: 'shared', dbConnectionRef: null },
};

const store = createSessionStore();
const bus = createMemoryPubSub();
const realtime = createRealtime(bus);
const registry = createRoomRegistry();
let server: http.Server;
let sockets: SocketServer;
let url: string;
const clients: ClientSocket[] = [];

type JoinAck = { ok: boolean; room?: string; error?: { code: string } };
type RefreshAck = { ok: boolean; sessionId?: string; tokenExpiresAt?: string; error?: { code: string } };

beforeAll(async () => {
  server = http.createServer();
  sockets = await createSocketServer(server, { loadSession: store.loader, loadSchool: async (id) => states[id] ?? null, registry, pubsub: bus, redisUrl: null });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/rt`;
});
afterAll(async () => {
  for (const c of clients) c.close();
  await sockets.close();
});

function client(token: string): ClientSocket {
  const c = connect(url, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
  clients.push(c);
  return c;
}
const connected = (c: ClientSocket) =>
  new Promise<void>((resolve, reject) => {
    c.once('connect', () => resolve());
    c.once('connect_error', (err) => reject(err));
  });
const join = (c: ClientSocket, room: string) => c.timeout(3000).emitWithAck(SOCKET_EVENTS.JOIN, { room }) as Promise<JoinAck>;
const refresh = (c: ClientSocket, token: unknown) => c.timeout(3000).emitWithAck(SOCKET_EVENTS.AUTH_REFRESH, { token }) as Promise<RefreshAck>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A second session of the same principal (what POST /auth/refresh produces). */
function rotate(issued: ReturnType<typeof store.issue>, schoolId: string | null) {
  const next = store.issue({ role: issued.session.actorRole, schoolId, actorId: issued.actorId });
  return next;
}

describe('joins use the live session', () => {
  it('keeps joining rooms after the handshake access token has expired', async () => {
    const issued = store.issue({ role: 'school_admin', schoolId: SCHOOL_A });
    // Same session, but a token that expires in 1 s (verification allows 5 s of clock skew).
    const { accessToken } = signAccessToken({ actorId: issued.actorId, role: 'school_admin', schoolId: SCHOOL_A, sessionId: issued.sessionId }, { ttlSeconds: 1 });
    const c = client(accessToken);
    await connected(c);
    await sleep(6500);
    expect(await join(c, rooms.schoolFleet(SCHOOL_A))).toEqual({ ok: true, room: rooms.schoolFleet(SCHOOL_A) });
    expect(c.connected).toBe(true);
    // Authorization is still enforced per room.
    expect((await join(c, rooms.schoolFleet(SCHOOL_B))).error?.code).toBe('FORBIDDEN');
  }, 15_000);

  it('a deactivated actor or school ends the socket at the next join', async () => {
    const issued = store.issue({ role: 'school_admin', schoolId: SCHOOL_B });
    const c = client(issued.token);
    await connected(c);
    store.update(issued.sessionId, { actorActive: false });
    const gone = new Promise<void>((r) => c.once('disconnect', () => r()));
    expect((await join(c, rooms.schoolAlerts(SCHOOL_B))).error?.code).toBe('UNAUTHENTICATED');
    await gone;
  });
});

describe('auth:refresh', () => {
  it('adopts the rotated session of the same principal', async () => {
    const first = store.issue({ role: 'school_admin', schoolId: SCHOOL_A });
    const c = client(first.token);
    await connected(c);
    const second = rotate(first, SCHOOL_A);
    const ack = await refresh(c, second.token);
    expect(ack).toMatchObject({ ok: true, sessionId: second.sessionId });
    expect(Date.parse(ack.tokenExpiresAt!)).toBeGreaterThan(Date.now());
    // The old session can now end without affecting the socket…
    store.update(first.sessionId, { revokedAt: new Date().toISOString() });
    await realtime.disconnectSessions([first.sessionId]);
    await sleep(100);
    expect(c.connected).toBe(true);
    expect((await join(c, rooms.schoolFleet(SCHOOL_A))).ok).toBe(true);
    // …while revoking the adopted session disconnects it.
    const gone = new Promise<void>((r) => c.once('disconnect', () => r()));
    await realtime.disconnectSessions([second.sessionId]);
    await gone;
  });

  it('refuses tokens of another principal, role or school and keeps the current session', async () => {
    const mine = store.issue({ role: 'school_admin', schoolId: SCHOOL_A });
    const c = client(mine.token);
    await connected(c);
    const otherAdmin = store.issue({ role: 'school_admin', schoolId: SCHOOL_B });
    expect((await refresh(c, otherAdmin.token)).error?.code).toBe('FORBIDDEN');
    const sameActorOtherSchool = store.issue({ role: 'school_admin', schoolId: SCHOOL_B, actorId: mine.actorId });
    expect((await refresh(c, sameActorOtherSchool.token)).error?.code).toBe('FORBIDDEN');
    expect((await refresh(c, 'garbage-token-garbage-token')).error?.code).toBe('UNAUTHENTICATED');
    expect((await refresh(c, null)).error?.code).toBe('UNAUTHENTICATED');
    const revoked = rotate(mine, SCHOOL_A);
    store.update(revoked.sessionId, { revokedAt: new Date().toISOString() });
    expect((await refresh(c, revoked.token)).error?.code).toBe('UNAUTHENTICATED');
    expect(c.connected).toBe(true);
    // Still bound to its own session and school.
    expect((await join(c, rooms.schoolFleet(SCHOOL_A))).ok).toBe(true);
    expect((await join(c, rooms.schoolFleet(SCHOOL_B))).error?.code).toBe('FORBIDDEN');
  });

  it('works for parents (school-less principals) too', async () => {
    const p = store.issue({ role: 'parent' });
    const c = client(p.token);
    await connected(c);
    const next = rotate(p, null);
    expect(await refresh(c, next.token)).toMatchObject({ ok: true, sessionId: next.sessionId });
    const other = store.issue({ role: 'parent' });
    expect((await refresh(c, other.token)).error?.code).toBe('FORBIDDEN');
  });
});

describe('subscription checks apply to sockets', () => {
  it('an expired plan refuses the handshake and ends connected sockets at the next join', async () => {
    const expired = new Set<string>();
    const unregister = registerSubscriptionCheck(async (school) => {
      if (expired.has(school.id)) throw schoolInactive('The school subscription has expired.', { reason: 'SUBSCRIPTION_EXPIRED' });
    });
    try {
      const live = store.issue({ role: 'school_admin', schoolId: SCHOOL_A });
      const c = client(live.token);
      await connected(c);
      expired.add(SCHOOL_A);
      const gone = new Promise<void>((r) => c.once('disconnect', () => r()));
      expect((await join(c, rooms.schoolFleet(SCHOOL_A))).error?.code).toBe('SCHOOL_INACTIVE');
      await gone;
      const late = client(store.issue({ role: 'driver', schoolId: SCHOOL_A }).token);
      const err = await new Promise<{ data?: { code?: string } }>((resolve) => late.once('connect_error', (e) => resolve(e as never)));
      expect(err.data?.code).toBe('SCHOOL_INACTIVE');
    } finally {
      unregister();
    }
  });
});
