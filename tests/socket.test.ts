// Socket.IO /rt: JWT handshake with session reload, built-in school rooms, module room registry,
// join re-authorization, realtime.emit fan-out through pub/sub, session/school disconnects.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SchoolState } from '../src/middleware/resolveTenant.js';
import { createMemoryPubSub } from '../src/shared/pubsub.js';
import { createRealtime, createRoomRegistry, rooms } from '../src/shared/realtime.js';
import { createSocketServer, type SocketServer } from '../src/socket.js';
import { createSessionStore } from './helpers/auth.js';

const SCHOOL_A = '0a000000-0000-4000-8000-00000000000a';
const SCHOOL_B = '0b000000-0000-4000-8000-00000000000b';
const SUSPENDED = '0c000000-0000-4000-8000-00000000000c';
const TRIP = '7e000000-0000-4000-8000-00000000007e';

const states: Record<string, SchoolState> = {
  [SCHOOL_A]: { id: SCHOOL_A, status: 'active', deleted: false, timezone: 'Asia/Kolkata', tenantMode: 'shared', dbConnectionRef: null },
  [SCHOOL_B]: { id: SCHOOL_B, status: 'active', deleted: false, timezone: 'Asia/Kolkata', tenantMode: 'shared', dbConnectionRef: null },
  [SUSPENDED]: { id: SUSPENDED, status: 'suspended', deleted: false, timezone: 'Asia/Kolkata', tenantMode: 'shared', dbConnectionRef: null },
};

const store = createSessionStore();
const bus = createMemoryPubSub();
const realtime = createRealtime(bus);
const registry = createRoomRegistry();
const parentTrips = new Set<string>();
registry.register('trip:{tripId}', async (p, { tripId }) => p.role === 'parent' && parentTrips.has(`${p.actorId}|${tripId}`));

let server: http.Server;
let sockets: SocketServer;
let url: string;
const clients: ClientSocket[] = [];

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

function client(token?: string): ClientSocket {
  const c = connect(url, { auth: token ? { token } : {}, transports: ['websocket'], reconnection: false, forceNew: true });
  clients.push(c);
  return c;
}

const connected = (c: ClientSocket) =>
  new Promise<void>((resolve, reject) => {
    c.once('connect', () => resolve());
    c.once('connect_error', (err) => reject(err));
  });
const rejected = (c: ClientSocket) => new Promise<{ message: string; data?: { code?: string } }>((resolve) => c.once('connect_error', (err) => resolve(err as never)));
const join = (c: ClientSocket, room: string) => c.timeout(2000).emitWithAck('join', { room }) as Promise<{ ok: boolean; room?: string; error?: { code: string } }>;
const nextEvent = <T>(c: ClientSocket, event: string) => new Promise<T>((resolve) => c.once(event, (p: T) => resolve(p)));

describe('handshake', () => {
  it('rejects missing/invalid tokens, super admins and suspended schools', async () => {
    expect((await rejected(client())).data?.code).toBe('UNAUTHENTICATED');
    expect((await rejected(client('not-a-token-at-all-really'))).data?.code).toBe('UNAUTHENTICATED');
    expect((await rejected(client(store.issue({ role: 'super_admin' }).token))).data?.code).toBe('FORBIDDEN');
    expect((await rejected(client(store.issue({ role: 'school_admin', schoolId: SUSPENDED }).token))).data?.code).toBe('SCHOOL_INACTIVE');
    const revoked = store.issue({ role: 'driver', schoolId: SCHOOL_A });
    store.update(revoked.sessionId, { revokedAt: new Date().toISOString() });
    expect((await rejected(client(revoked.token))).data?.code).toBe('UNAUTHENTICATED');
  });
});

describe('rooms', () => {
  it('lets school admins join their own fleet room only and delivers emits', async () => {
    const admin = client(store.issue({ role: 'school_admin', schoolId: SCHOOL_A }).token);
    await connected(admin);
    expect(await join(admin, rooms.schoolFleet(SCHOOL_A))).toEqual({ ok: true, room: `school:${SCHOOL_A}:fleet` });
    expect((await join(admin, rooms.schoolFleet(SCHOOL_B))).error?.code).toBe('FORBIDDEN');
    expect((await join(admin, 'school:not-a-uuid:fleet')).error?.code).toBe('NOT_FOUND');
    expect((await join(admin, rooms.trip(TRIP))).error?.code).toBe('FORBIDDEN');
    const event = nextEvent<{ busId: string }>(admin, 'live:position');
    await realtime.emit(rooms.schoolFleet(SCHOOL_A), 'live:position', { busId: 'b1' });
    expect(await event).toEqual({ busId: 'b1' });
  });

  it('uses module authorizers (parents on a trip) and personal rooms', async () => {
    const parent = store.issue({ role: 'parent' });
    parentTrips.add(`${parent.actorId}|${TRIP}`);
    const c = client(parent.token);
    await connected(c);
    expect((await join(c, rooms.trip(TRIP))).ok).toBe(true);
    const inbox = nextEvent<{ title: string }>(c, 'notification:new');
    await realtime.emit(rooms.actor(parent.actorId), 'notification:new', { title: 'Bus R1 started' });
    expect(await inbox).toEqual({ title: 'Bus R1 started' });
    const ack = (await c.timeout(2000).emitWithAck('leave', { room: rooms.trip(TRIP) })) as { ok: boolean };
    expect(ack.ok).toBe(true);
  });

  it('re-checks the session on every join', async () => {
    const issued = store.issue({ role: 'school_admin', schoolId: SCHOOL_A });
    const c = client(issued.token);
    await connected(c);
    store.update(issued.sessionId, { revokedAt: new Date().toISOString() });
    const disconnected = new Promise<void>((r) => c.once('disconnect', () => r()));
    expect((await join(c, rooms.schoolAlerts(SCHOOL_A))).error?.code).toBe('UNAUTHENTICATED');
    await disconnected;
  });

  it('disconnects revoked sessions and deactivated schools on demand', async () => {
    const one = store.issue({ role: 'driver', schoolId: SCHOOL_B });
    const two = store.issue({ role: 'conductor', schoolId: SCHOOL_B });
    const a = client(one.token);
    const b = client(two.token);
    await Promise.all([connected(a), connected(b)]);
    const aGone = new Promise<void>((r) => a.once('disconnect', () => r()));
    await realtime.disconnectSessions([one.sessionId]);
    await aGone;
    expect(b.connected).toBe(true);
    const bGone = new Promise<void>((r) => b.once('disconnect', () => r()));
    await realtime.disconnectSchool(SCHOOL_B);
    await bGone;
  });
});
