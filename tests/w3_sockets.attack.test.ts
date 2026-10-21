// Wave-3 adversarial tests — parent sockets and the child:{id}:live relay (contract §7, BP §8.6, §9.3).
// Attacks: parents joining admin rooms (alerts/fleet), other buses' / schools' trip rooms, malformed
// or upper-cased child room names, sockets that outlive an unlink, relay flooding with mixed
// position / ETA / stopped messages across instances, spoofed school ids on the pub/sub channel,
// battery/network leakage into child events.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SOCKET_EVENTS, type ChildLiveEvent, type LivePositionEvent, type LiveStatusEvent, type TripLiveState } from '@wimb/shared';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createChildRelay } from '../src/modules/parent/index.js';
import { createMemoryKv } from '../src/shared/kv.js';
import type { Realtime } from '../src/shared/realtime.js';
import { createSocketServer, type SocketServer } from '../src/socket.js';
import { buildApp, DEVICE, loginParent, type TestApp, type Tokens } from './helpers/authApp.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { auth, drainJobs, trackingWorld, type TrackingWorld } from './helpers/trackingWorld.js';
import { linkChild, localDate, type LinkedChild } from './parent.fixtures.js';

let t: TestApp;
let a: TrackingWorld;
let b: TrackingWorld;
let parent: Tokens;
let parentId: string;
let child: LinkedChild;
let otherBusTrip: f.TenantRow;
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

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  a = await trackingWorld(t.app);
  b = await trackingWorld(t.app, { device: { ...DEVICE, deviceId: 'w3-sock-b-0002' } });
  const today = await localDate();
  await ownerQuery('update trips set trip_date = $1::date where id = any ($2::uuid[])', [today, [a.trip.id, b.trip.id]]);
  const p = await f.parentAccount();
  parentId = p.id;
  child = await linkChild(a.school.id, p.id, { busId: a.bus.id, routeId: a.route.id, stopId: a.stops[1]!.id }, { fullName: 'Arjun Das' });
  const bus2 = await f.bus(a.school.id, { code: 'R9' });
  otherBusTrip = await f.activeTrip(a.school.id, bus2.id, { route_id: a.route.id, bus_code_snapshot: 'R9' });
  parent = await loginParent(t, String(p.phone));
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

describe('room joins by a parent', () => {
  it('admin rooms (alerts, fleet) of the child\'s school are refused', async () => {
    const c = await socketFor(parent.accessToken);
    expect((await join(c, `school:${a.school.id}:alerts`)).ok).toBe(false);
    expect((await join(c, `school:${a.school.id}:fleet`)).ok).toBe(false);
    expect((await join(c, `school:${a.school.id}:members`)).ok).toBe(false);
  });

  it('trip rooms of another bus in the same school and of another school are refused', async () => {
    const c = await socketFor(parent.accessToken);
    expect((await join(c, `trip:${otherBusTrip.id}`)).ok).toBe(false);
    expect((await join(c, `trip:${b.trip.id}`)).ok).toBe(false);
  });

  it('malformed, upper-cased, suffixed and other actors\' rooms are refused', async () => {
    const c = await socketFor(parent.accessToken);
    const id = child.student.id;
    for (const r of [`child:${id.toUpperCase()}:live`, `child:${id}:live:x`, `child:${id}`, ` child:${id}:live`, `actor:${a.driverUser.id}`, `session:${a.admin.sessionId}`]) {
      expect((await join(c, r)).ok, r).toBe(false);
    }
    expect((await join(c, `child:${id}:live`)).ok).toBe(true);
  });

  it('unlinking the parent through the admin API disconnects the socket and the child room cannot be re-joined', async () => {
    const c = await socketFor(parent.accessToken);
    expect((await join(c, `child:${child.student.id}:live`)).ok).toBe(true);
    const gone = new Promise<string>((resolve) => c.once('disconnect', (reason) => resolve(String(reason))));
    const { rows } = await ownerQuery<{ id: string }>('select id from school_parents where school_id = $1 and parent_account_id = $2', [a.school.id, parentId]);
    const res = await request(t.app).delete(`/api/v1/school/students/${child.student.id}/parents/${rows[0]!.id}`).set(auth(a.admin.accessToken));
    expect(res.status).toBe(200);
    const reason = await Promise.race([gone, new Promise<string>((r) => setTimeout(() => r('still connected'), 4000))]);
    expect(reason).not.toBe('still connected');
    let rejoined: boolean;
    try {
      const again = await socketFor(parent.accessToken);
      rejoined = (await join(again, `child:${child.student.id}:live`)).ok;
    } catch {
      rejoined = false;
    }
    expect(rejoined).toBe(false);
    await f.studentParent(a.school.id, child.student.id, parentId);
  });
});

describe('relay flooding and spoofing', () => {
  const sent: { room: string; payload: ChildLiveEvent }[] = [];
  const fakeRealtime = { emit: async (room: string, _e: string, payload: unknown) => void sent.push({ room, payload: payload as ChildLiveEvent }) } as unknown as Realtime;
  const live = (o: Partial<TripLiveState> = {}, tOffsetMs = 0): TripLiveState => ({
    tripId: a.trip.id, busId: a.bus.id, routeId: a.route.id, direction: 'morning', tripStatus: 'in_progress',
    point: { t: new Date(Date.now() + tOffsetMs).toISOString(), lat: 12.91, lng: 77.6, spd: 30, hdg: 0, acc: 8, bat: 55, net: 'wifi', mv: true },
    receivedAt: new Date(Date.now() + tOffsetMs).toISOString(), motion: 'moving', stoppedSince: null, freshness: 'live', ageS: 1, locationUnavailable: false,
    progressM: 100, distanceFromRouteM: 3, currentStop: null, visitedStopIds: [], eta: null, ...o,
  });
  const pos = (l: TripLiveState, schoolId = a.school.id, tripId = a.trip.id) => ({ room: `trip:${tripId}`, event: SOCKET_EVENTS.LIVE_POSITION, payload: { schoolId, tripId, busId: a.bus.id, live: l } satisfies LivePositionEvent });
  const eta = (l: TripLiveState) => ({ room: `trip:${a.trip.id}`, event: SOCKET_EVENTS.LIVE_STATUS, payload: { schoolId: a.school.id, tripId: a.trip.id, busId: a.bus.id, change: 'eta', live: l } satisfies LiveStatusEvent });

  it('60 mixed position / ETA / stopped messages across three instances within a second reach the child room once', async () => {
    const kv = createMemoryKv();
    const relays = [0, 1, 2].map(() => createChildRelay({ kv, realtime: fakeRealtime }));
    sent.length = 0;
    const msgs = Array.from({ length: 60 }, (_, i) => (i % 3 === 0 ? eta(live({}, i * 10)) : pos(live({ motion: i % 2 ? 'stopped' : 'moving' }, i * 10))));
    await Promise.all(msgs.map((m, i) => relays[i % 3]!.handle(m)));
    const mine = sent.filter((s) => s.room === `child:${child.student.id}:live`);
    expect(mine).toHaveLength(1);
  });

  it('child events never carry battery or network data even when the trip-room message has them', async () => {
    sent.length = 0;
    await createChildRelay({ kv: createMemoryKv(), realtime: fakeRealtime }).handle(pos(live()));
    expect(sent.length).toBeGreaterThan(0);
    for (const s of sent) expect(JSON.stringify(s.payload)).not.toMatch(/"bat"|"net"|wifi/);
  });

  it('a message claiming school B for school A\'s trip (or A for B\'s) reaches no child room', async () => {
    sent.length = 0;
    const relay = createChildRelay({ kv: createMemoryKv(), realtime: fakeRealtime });
    expect(await relay.handle(pos(live(), b.school.id, a.trip.id))).toBe(0);
    expect(await relay.handle(pos(live(), a.school.id, b.trip.id))).toBe(0);
    expect(sent).toEqual([]);
  });
});
