// Read endpoints and rooms (BP §8.3, §8.6, §4.9): GET /school/fleet/live, GET /school/trips/:id/path,
// GET /driver/trips/:id/route — roles, payloads and cross-school isolation — and Socket.IO trip-room
// authorization (admins of the trip's school, its crew, parents with an active assignment to the
// bus + direction; never another school).
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { HEADERS, SOCKET_EVENTS } from '@wimb/shared';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSocketServer, type SocketServer } from '../src/socket.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { buildApp, DEVICE, loginParent, type TestApp, type Tokens } from './helpers/authApp.js';
import { auth, drainJobs, northbound, postPoints, trackingWorld, type TrackingWorld } from './helpers/trackingWorld.js';

let t: TestApp;
let a: TrackingWorld;
let b: TrackingWorld;
let parentA: Tokens;
let strangerParent: Tokens;
let idleBusId: string;
let server: http.Server;
let sockets: SocketServer;
let url: string;
const clients: ClientSocket[] = [];

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  a = await trackingWorld(t.app);
  b = await trackingWorld(t.app, { device: { ...DEVICE, deviceId: 'device-b-0002' } });
  const idle = await f.bus(a.school.id, { code: 'R9', status: 'maintenance' });
  idleBusId = idle.id;
  await f.trip(a.school.id, idle.id, { status: 'completed', started_at: new Date(Date.now() - 7200_000).toISOString(), ended_at: new Date(Date.now() - 3600_000).toISOString(), end_lat: 12.95, end_lng: 77.61 });
  // Parent of a child on bus R1 / morning in school A, and a parent of a child on another bus.
  const child = await f.student(a.school.id);
  const parent = await f.parentAccount();
  await f.schoolParent(a.school.id, parent.id);
  await f.studentParent(a.school.id, child.id, parent.id);
  await f.studentAssignment(a.school.id, { studentId: child.id, busId: a.bus.id, routeId: a.route.id, stopId: a.stops[1]!.id });
  parentA = await loginParent(t, String(parent.phone));
  const otherChild = await f.student(a.school.id);
  const stranger = await f.parentAccount();
  await f.schoolParent(a.school.id, stranger.id);
  await f.studentParent(a.school.id, otherChild.id, stranger.id);
  strangerParent = await loginParent(t, String(stranger.phone));

  const res = await postPoints(t.app, a, northbound({ baseMs: Date.now() - 25_000, fromKm: 0.5, count: 3 }));
  expect(res.status).toBe(200);
  await drainJobs();

  server = http.createServer();
  sockets = await createSocketServer(server, { redisUrl: null });
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

describe('GET /school/fleet/live', () => {
  it('lists every bus with live position, status, crew and trip (school admins only)', async () => {
    const res = await request(t.app).get('/api/v1/school/fleet/live').set(auth(a.admin.accessToken));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    const d = res.body.data;
    expect(d.summary).toMatchObject({ total: 2, onTrip: 1, moving: 1 });
    const r1 = d.buses.find((x: { busId: string }) => x.busId === a.bus.id);
    expect(r1).toMatchObject({ busCode: 'R1', status: 'moving', driver: { staffId: a.driverProfile.id, name: 'Ramesh Kumar' }, conductor: { staffId: a.conductorProfile.id } });
    expect(r1.activeTrip).toMatchObject({ id: a.trip.id, status: 'in_progress', routeCode: 'R1', pointsCount: 3 });
    expect(r1.live).toMatchObject({ tripId: a.trip.id, freshness: 'live', motion: 'moving', locationUnavailable: false });
    expect(r1.live.point).toMatchObject({ spd: 30, acc: 8 });
    const idle = d.buses.find((x: { busId: string }) => x.busId === idleBusId);
    expect(idle).toMatchObject({ status: 'maintenance', activeTrip: null, live: null, lastKnown: { lat: 12.95, lng: 77.61 } });
  });

  it('never shows another school’s buses and refuses other roles', async () => {
    const resB = await request(t.app).get('/api/v1/school/fleet/live').set(auth(b.admin.accessToken));
    expect(resB.body.data.buses.map((x: { busId: string }) => x.busId)).toEqual([b.bus.id]);
    expect(JSON.stringify(resB.body)).not.toContain(a.trip.id);
    const driver = await request(t.app).get('/api/v1/school/fleet/live').set(auth(a.driver.accessToken));
    expect(driver.status).toBe(403);
    const parent = await request(t.app).get('/api/v1/school/fleet/live').set(auth(parentA.accessToken)).set(HEADERS.SCHOOL_ID, String(a.school.id));
    expect(parent.status).toBe(403);
    expect((await request(t.app).get('/api/v1/school/fleet/live')).status).toBe(401);
  });
});

describe('GET /school/trips/:id/path', () => {
  it('returns the planned polyline, the actual path, stop events and the live state', async () => {
    const res = await request(t.app).get(`/api/v1/school/trips/${a.trip.id}/path?includePoints=true`).set(auth(a.admin.accessToken));
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.trip).toMatchObject({ id: a.trip.id, status: 'in_progress', busCode: 'R1', routeCode: 'R1' });
    expect(d.planned).toMatchObject({ polylineSource: 'straight', school: { lat: expect.any(Number) } });
    expect(d.planned.stops.map((s: { name: string }) => s.name)).toEqual(['Stop 1', 'Stop 2', 'Stop 3', 'Stop 4']);
    expect(d.actual).toMatchObject({ source: 'computed', pointCount: 3 });
    expect(d.actual.polyline).toEqual(expect.any(String));
    expect(d.actual.start).toMatchObject({ lat: expect.any(Number), at: expect.any(String) });
    expect(d.points).toHaveLength(3);
    expect(d.live).toMatchObject({ tripId: a.trip.id });
    expect(Array.isArray(d.stopEvents)).toBe(true);
  });

  it('answers 404 for another school’s trip and refuses drivers', async () => {
    expect((await request(t.app).get(`/api/v1/school/trips/${b.trip.id}/path`).set(auth(a.admin.accessToken))).status).toBe(404);
    expect((await request(t.app).get(`/api/v1/school/trips/${a.trip.id}/path`).set(auth(b.admin.accessToken))).status).toBe(404);
    expect((await request(t.app).get(`/api/v1/school/trips/${a.trip.id}/path`).set(auth(a.driver.accessToken))).status).toBe(403);
    expect((await request(t.app).get('/api/v1/school/trips/not-a-uuid/path').set(auth(a.admin.accessToken))).status).toBe(400);
  });
});

describe('GET /driver/trips/:id/route', () => {
  it('gives the crew the planned route and their live state', async () => {
    const res = await request(t.app).get(`/api/v1/driver/trips/${a.trip.id}/route`).set(auth(a.driver.accessToken)).set(HEADERS.DEVICE_ID, DEVICE.deviceId);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ tripId: a.trip.id, routeId: a.route.id, polylineSource: 'straight' });
    expect(res.body.data.stops).toHaveLength(4);
    expect(res.body.data.live.tripId).toBe(a.trip.id);
  });

  it('refuses other schools, admins and drivers not on the trip', async () => {
    const cross = await request(t.app).get(`/api/v1/driver/trips/${a.trip.id}/route`).set(auth(b.driver.accessToken)).set(HEADERS.DEVICE_ID, 'device-b-0002');
    expect(cross.status).toBe(404);
    const admin = await request(t.app).get(`/api/v1/driver/trips/${a.trip.id}/route`).set(auth(a.admin.accessToken));
    expect(admin.status).toBe(403);
    const otherTrip = await f.activeTrip(a.school.id, idleBusId, {});
    const notCrew = await request(t.app).get(`/api/v1/driver/trips/${otherTrip.id}/route`).set(auth(a.driver.accessToken)).set(HEADERS.DEVICE_ID, DEVICE.deviceId);
    expect(notCrew.status).toBe(403);
    await ownerQuery("update trips set status = 'cancelled' where id = $1", [otherTrip.id]);
  });
});

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

describe('Socket.IO room authorization', () => {
  it('lets school A admins join their fleet and trip rooms, never school B rooms', async () => {
    const c = await socketFor(a.admin.accessToken);
    expect((await join(c, `school:${a.school.id}:fleet`)).ok).toBe(true);
    expect((await join(c, `trip:${a.trip.id}`)).ok).toBe(true);
    const fleetB = await join(c, `school:${b.school.id}:fleet`);
    expect(fleetB).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    const tripB = await join(c, `trip:${b.trip.id}`);
    expect(tripB).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });

  it('lets the trip crew join its trip room only', async () => {
    const c = await socketFor(a.driver.accessToken);
    expect((await join(c, `trip:${a.trip.id}`)).ok).toBe(true);
    expect((await join(c, `trip:${b.trip.id}`)).ok).toBe(false);
    expect((await join(c, `school:${a.school.id}:fleet`)).ok).toBe(false);
  });

  it('lets a parent join the trip of the child’s bus + direction, not other trips', async () => {
    const c = await socketFor(parentA.accessToken);
    expect((await join(c, `trip:${a.trip.id}`)).ok).toBe(true);
    expect((await join(c, `trip:${b.trip.id}`)).ok).toBe(false);
    const s = await socketFor(strangerParent.accessToken);
    expect((await join(s, `trip:${a.trip.id}`)).ok).toBe(false);
  });

  it('refuses the parent once the school is suspended', async () => {
    await ownerQuery("update schools set status = 'suspended' where id = $1", [a.school.id]);
    const { invalidateSchoolState } = await import('../src/middleware/resolveTenant.js');
    invalidateSchoolState();
    try {
      const c = await socketFor(parentA.accessToken);
      expect((await join(c, `trip:${a.trip.id}`)).ok).toBe(false);
    } finally {
      await ownerQuery("update schools set status = 'active' where id = $1", [a.school.id]);
      invalidateSchoolState();
    }
  });
});
