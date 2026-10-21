// Parent module — Socket.IO room child:{studentId}:live (contract §7, BP §8.6, §9.3, Appendix B step 6):
// join authorization (linked parent + current assignment + active school; never other parents, other
// schools, staff or admins), the relayed 'child:live' feed (parent-safe, per-child status), coalescing
// (≥ 9 s per trip moving, 30 s stopped; exactly once across instances), trip status changes, fan-out
// that follows reassignments at once, and room:revoked when the assignment ends.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PARENT_SOCKET_EVENTS, SOCKET_EVENTS, type ChildLiveEvent, type LivePositionEvent, type LiveStatusEvent, type TripLiveState } from '@wimb/shared';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidateSchoolState } from '../src/middleware/resolveTenant.js';
import { createChildRelay } from '../src/modules/parent/index.js';
import { createMemoryKv } from '../src/shared/kv.js';
import type { Realtime } from '../src/shared/realtime.js';
import { createSocketServer, type SocketServer } from '../src/socket.js';
import { buildApp, DEVICE, loginParent, type TestApp, type Tokens } from './helpers/authApp.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { auth, drainJobs, northbound, postPoints, trackingWorld, type TrackingWorld } from './helpers/trackingWorld.js';
import { linkChild, localDate, reassign, unassign, type LinkedChild } from './parent.fixtures.js';

let t: TestApp;
let a: TrackingWorld;
let b: TrackingWorld;
let parent: Tokens;
let parentAccountId: string;
let parentB: Tokens;
let child: LinkedChild;
let unassignedChild: f.TenantRow;
let childB: LinkedChild;
let server: http.Server;
let sockets: SocketServer;
let url: string;
const clients: ClientSocket[] = [];

type JoinAck = { ok: boolean; error?: { code: string } };
async function socketFor(token: string): Promise<ClientSocket> {
  const c = connect(url, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
  clients.push(c);
  await new Promise<void>((resolve, reject) => {
    c.once('connect', () => resolve());
    c.once('connect_error', reject);
  });
  return c;
}
const join = (c: ClientSocket, room: string) => c.timeout(4000).emitWithAck(SOCKET_EVENTS.JOIN, { room }) as Promise<JoinAck>;
const room = (studentId: string) => `child:${studentId}:live`;

/** Collects events of one name; next() resolves with the first matching one (or rejects after ms). */
function collector<T>(c: ClientSocket, event: string) {
  const seen: T[] = [];
  c.on(event, (p: T) => seen.push(p));
  return {
    seen,
    async next(pred: (p: T) => boolean = () => true, ms = 4000): Promise<T> {
      const deadline = Date.now() + ms;
      for (;;) {
        const hit = seen.find(pred);
        if (hit) return hit;
        if (Date.now() > deadline) throw new Error(`no ${event} event within ${ms} ms (seen ${seen.length})`);
        await new Promise((r) => setTimeout(r, 25));
      }
    },
  };
}

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  a = await trackingWorld(t.app);
  b = await trackingWorld(t.app, { device: { ...DEVICE, deviceId: 'device-b-0002' } });
  const today = await localDate();
  await ownerQuery(`update trips set trip_date = $1::date where id = any ($2::uuid[])`, [today, [a.trip.id, b.trip.id]]);
  await ownerQuery('update stops set expected_time = null where route_id = any ($1::uuid[])', [[a.route.id, b.route.id]]);
  const p = await f.parentAccount();
  parentAccountId = p.id;
  child = await linkChild(a.school.id, p.id, { busId: a.bus.id, routeId: a.route.id, stopId: a.stops[1]!.id }, { fullName: 'Arjun Das' });
  unassignedChild = await f.student(a.school.id, { full_name: 'Tara Das' });
  await f.studentParent(a.school.id, unassignedChild.id, p.id, { is_primary: false });
  parent = await loginParent(t, String(p.phone));
  const pb = await f.parentAccount();
  childB = await linkChild(b.school.id, pb.id, { busId: b.bus.id, routeId: b.route.id, stopId: b.stops[0]!.id }, { fullName: 'Nila Menon' });
  parentB = await loginParent(t, String(pb.phone));

  server = http.createServer();
  sockets = await createSocketServer(server, { redisUrl: null, revalidateIntervalMs: 0 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/rt`;
});

afterAll(async () => {
  for (const c of clients) c.close();
  await sockets.close();
  await new Promise<void>((r) => server.close(() => r()));
  await drainJobs();
  await closeDb();
});

describe('child room authorization', () => {
  it('lets a linked parent join while the child has a current assignment', async () => {
    const c = await socketFor(parent.accessToken);
    expect(await join(c, room(child.student.id))).toEqual({ ok: true, room: room(child.student.id) });
  });

  it('refuses the parent\'s child without an assignment, other parents\' children and other schools', async () => {
    const c = await socketFor(parent.accessToken);
    expect((await join(c, room(unassignedChild.id))).ok).toBe(false);
    expect((await join(c, room(childB.student.id))).ok).toBe(false);
    const cb = await socketFor(parentB.accessToken);
    expect((await join(cb, room(child.student.id))).ok).toBe(false);
    expect((await join(cb, room(childB.student.id))).ok).toBe(true);
  });

  it('refuses school admins and staff', async () => {
    for (const token of [a.admin.accessToken, a.driver.accessToken]) {
      const c = await socketFor(token);
      expect((await join(c, room(child.student.id))).ok).toBe(false);
    }
  });

  it('refuses joins while the school is suspended', async () => {
    await ownerQuery("update schools set status = 'suspended' where id = $1", [a.school.id]);
    invalidateSchoolState();
    try {
      const c = await socketFor(parent.accessToken);
      expect((await join(c, room(child.student.id))).ok).toBe(false);
    } finally {
      await ownerQuery("update schools set status = 'active' where id = $1", [a.school.id]);
      invalidateSchoolState();
    }
  });
});

describe('child:live feed', () => {
  it('relays a new position with the child\'s own status, without battery/network data', async () => {
    const c = await socketFor(parent.accessToken);
    const events = collector<ChildLiveEvent>(c, PARENT_SOCKET_EVENTS.CHILD_LIVE);
    const other = await socketFor(parentB.accessToken);
    const otherEvents = collector<ChildLiveEvent>(other, PARENT_SOCKET_EVENTS.CHILD_LIVE);
    expect((await join(c, room(child.student.id))).ok).toBe(true);
    expect((await join(other, room(childB.student.id))).ok).toBe(true);
    const points = northbound({ baseMs: Date.now() - 25_000, fromKm: 0.2, count: 3 });
    expect((await postPoints(t.app, a, points)).status).toBe(200);
    const e = await events.next((p) => p.kind === 'position');
    const last = points.at(-1)!;
    expect(e).toMatchObject({
      studentId: child.student.id,
      schoolId: a.school.id,
      tripId: a.trip.id,
      busId: a.bus.id,
      direction: 'morning',
      tripStatus: 'in_progress',
      status: { status: 'on_route', lastUpdatedAt: last.t },
      position: { lat: last.lat, lng: last.lng, t: last.t },
      freshness: 'live',
    });
    expect(JSON.stringify(e)).not.toMatch(/"bat"|"net"/);
    await drainJobs();
    await new Promise((r) => setTimeout(r, 200));
    expect(otherEvents.seen).toEqual([]);
  });

  it('relays a trip status change made through the API (cancelled by the school)', async () => {
    const c = await socketFor(parent.accessToken);
    const events = collector<ChildLiveEvent>(c, PARENT_SOCKET_EVENTS.CHILD_LIVE);
    expect((await join(c, room(childB.student.id))).ok).toBe(false);
    const cb = await socketFor(parentB.accessToken);
    const bEvents = collector<ChildLiveEvent>(cb, PARENT_SOCKET_EVENTS.CHILD_LIVE);
    expect((await join(cb, room(childB.student.id))).ok).toBe(true);
    const res = await request(t.app).post(`/api/v1/school/trips/${b.trip.id}/cancel`).set(auth(b.admin.accessToken)).send({ reason: 'Bus breakdown at depot' });
    expect(res.status).toBe(200);
    const e = await bEvents.next((p) => p.kind === 'trip');
    expect(e).toMatchObject({ studentId: childB.student.id, tripId: b.trip.id, tripStatus: 'cancelled', change: 'cancelled', status: { status: 'not_started', reason: 'TRIP_CANCELLED' }, position: null });
    expect(events.seen).toEqual([]);
  });
});

describe('relay mechanics', () => {
  const sentTo: { room: string; event: string; payload: ChildLiveEvent }[] = [];
  const fakeRealtime = {
    emit: async (r: string, event: string, payload: unknown) => {
      sentTo.push({ room: r, event, payload: payload as ChildLiveEvent });
    },
  } as unknown as Realtime;
  const live = (o: Partial<TripLiveState> = {}): TripLiveState => ({
    tripId: a.trip.id, busId: a.bus.id, routeId: a.route.id, direction: 'morning', tripStatus: 'in_progress',
    point: { t: new Date().toISOString(), lat: 12.91, lng: 77.6, spd: 30, hdg: 0, acc: 8, bat: null, net: null, mv: true },
    receivedAt: new Date().toISOString(), motion: 'moving', stoppedSince: null, freshness: 'live', ageS: 1, locationUnavailable: false,
    progressM: 100, distanceFromRouteM: 3, currentStop: null, visitedStopIds: [], eta: null, ...o,
  });
  const position = (l: TripLiveState) => ({ room: `trip:${a.trip.id}`, event: SOCKET_EVENTS.LIVE_POSITION, payload: { schoolId: a.school.id, tripId: a.trip.id, busId: a.bus.id, live: l } satisfies LivePositionEvent });
  const status = (change: LiveStatusEvent['change'], l: TripLiveState, stopId?: string) => ({
    room: `trip:${a.trip.id}`, event: SOCKET_EVENTS.LIVE_STATUS, payload: { schoolId: a.school.id, tripId: a.trip.id, busId: a.bus.id, change, stopId, live: l } satisfies LiveStatusEvent,
  });

  it('coalesces positions per trip (≥ 9 s moving) and delivers each message once across two instances', async () => {
    const kv = createMemoryKv();
    const one = createChildRelay({ kv, realtime: fakeRealtime });
    const two = createChildRelay({ kv, realtime: fakeRealtime });
    sentTo.length = 0;
    const msg = position(live());
    expect(await one.handle(msg)).toBe(1);
    expect(await two.handle(msg)).toBe(0); // same message on the second instance
    expect(await one.handle(position(live({ point: { ...live().point!, t: new Date(Date.now() + 5000).toISOString() } })))).toBe(0); // within the window
    expect(sentTo).toHaveLength(1);
    expect(sentTo[0]).toMatchObject({ room: room(child.student.id), event: 'child:live', payload: { kind: 'position', studentId: child.student.id } });
    // Discrete changes are never coalesced away, but each is relayed once.
    const arrived = status('stop_arrived', live({ currentStop: { stopId: a.stops[1]!.id, name: 'Stop 2', sequence: 2, arrivedAt: new Date().toISOString() } }), a.stops[1]!.id);
    expect(await one.handle(arrived)).toBe(1);
    expect(await two.handle(arrived)).toBe(0);
    expect(sentTo.at(-1)!.payload).toMatchObject({ kind: 'status', change: 'stop_arrived', status: { status: 'arrived_at_stop' } });
    // ETA refreshes share the position window.
    expect(await one.handle(status('eta', live()))).toBe(0);
  });

  it('uses the slower 30-s window while the bus is stopped', async () => {
    const kv = createMemoryKv();
    const relay = createChildRelay({ kv, realtime: fakeRealtime });
    expect(await relay.handle(position(live({ motion: 'stopped' })))).toBe(1);
    const ttl = await kv.ttlMs(`parent-relay:pos:${a.school.id}:${a.trip.id}`);
    expect(ttl).toBeGreaterThan(20_000);
    expect(ttl).toBeLessThanOrEqual(30_000);
    const moving = createChildRelay({ kv: createMemoryKv(), realtime: fakeRealtime });
    expect(await moving.handle(position(live()))).toBe(1);
  });

  it('ignores other rooms and events, and fans trip status out once per status', async () => {
    const relay = createChildRelay({ kv: createMemoryKv(), realtime: fakeRealtime });
    expect(await relay.handle({ room: `school:${a.school.id}:fleet`, event: SOCKET_EVENTS.LIVE_POSITION, payload: position(live()).payload })).toBe(0);
    expect(await relay.handle({ room: `trip:${a.trip.id}`, event: SOCKET_EVENTS.ALERT_NEW, payload: {} })).toBe(0);
    // trip:status of a trip whose school is unknown to this relay is skipped (no school id in the payload)
    expect(await relay.handle({ room: `trip:${a.trip.id}`, event: SOCKET_EVENTS.TRIP_STATUS, payload: { tripId: a.trip.id, status: 'auto_closed' } })).toBe(0);
    await relay.handle(position(live()));
    expect(await relay.handle({ room: `trip:${a.trip.id}`, event: SOCKET_EVENTS.TRIP_STATUS, payload: { tripId: a.trip.id, status: 'auto_closed' } })).toBe(1);
    expect(await relay.onTripStatus(a.school.id, { tripId: a.trip.id, status: 'auto_closed' })).toBe(0);
    expect(sentTo.at(-1)!.payload).toMatchObject({ kind: 'trip', tripStatus: 'auto_closed', status: { status: 'completed', reason: 'AUTO_CLOSED' }, position: null });
  });

  it('reads the fan-out targets afresh: a child moved to another bus stops receiving the old bus at once', async () => {
    const bus2 = await f.bus(a.school.id, { code: 'R7' });
    const route2 = await f.route(a.school.id, { code: 'R7', direction: 'morning' });
    const stop2 = await f.stop(a.school.id, route2.id, { name: 'Temple', sequence: 1 });
    sentTo.length = 0;
    expect(await createChildRelay({ kv: createMemoryKv(), realtime: fakeRealtime }).handle(position(live()))).toBe(1);
    await reassign(a.school.id, child.student.id, { busId: bus2.id, routeId: route2.id, stopId: stop2.id });
    expect(await createChildRelay({ kv: createMemoryKv(), realtime: fakeRealtime }).handle(position(live()))).toBe(0);
    expect(sentTo).toHaveLength(1);
    // The room itself stays valid (the child is still assigned — to the new bus).
    const c = await socketFor(parent.accessToken);
    expect((await join(c, room(child.student.id))).ok).toBe(true);
  });
});

describe('membership re-checks', () => {
  it('revokes the room when the child loses every assignment', async () => {
    const c = await socketFor(parent.accessToken);
    const revoked = collector<{ room: string; reason: string }>(c, SOCKET_EVENTS.ROOM_REVOKED);
    expect((await join(c, room(child.student.id))).ok).toBe(true);
    await unassign(child.student.id);
    expect(await sockets.revalidate({ actorIds: [parentAccountId] })).toBeGreaterThanOrEqual(1);
    const e = await revoked.next((p) => p.room === room(child.student.id));
    expect(e.reason).toBe('NOT_ALLOWED');
    expect((await join(c, room(child.student.id))).ok).toBe(false);
  });
});
