// Wave-2 adversarial suite, part 3: Socket.IO room joins of foreign / forged rooms, stale memberships,
// membership re-checks after unlink / bus change / reassignment, and fleet / path endpoints leaking
// another school's data.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { HEADERS, SOCKET_EVENTS } from '@wimb/shared';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSocketServer, type SocketServer } from '../src/socket.js';
import { buildApp, DEVICE, loginParent, staffUser, type TestApp, type Tokens } from './helpers/authApp.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { auth, drainJobs, northbound, postPoints, trackingWorld, type TrackingWorld } from './helpers/trackingWorld.js';

let t: TestApp;
let a: TrackingWorld;
let b: TrackingWorld;
let parentA: Tokens;
let parentAfternoon: Tokens;
let parentInactiveChild: Tokens;
let childA: f.TenantRow;
let server: http.Server;
let sockets: SocketServer;
let url: string;
const clients: ClientSocket[] = [];

async function parentWith(school: TrackingWorld, o: { direction?: string; studentActive?: boolean } = {}): Promise<{ tokens: Tokens; child: f.TenantRow }> {
  const child = await f.student(school.school.id, o.studentActive === false ? { is_active: false } : {});
  const parent = await f.parentAccount();
  await f.schoolParent(school.school.id, parent.id);
  await f.studentParent(school.school.id, child.id, parent.id);
  await f.studentAssignment(school.school.id, { studentId: child.id, busId: school.bus.id, routeId: school.route.id, stopId: school.stops[1]!.id, direction: o.direction ?? 'morning' });
  return { tokens: await loginParent(t, String(parent.phone)), child };
}

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  a = await trackingWorld(t.app, { device: { ...DEVICE, deviceId: 'sock-dev-aaaa' } });
  b = await trackingWorld(t.app, { device: { ...DEVICE, deviceId: 'sock-dev-bbbb' } });
  const pa = await parentWith(a);
  parentA = pa.tokens;
  childA = pa.child;
  // An afternoon route on the same bus is needed for an afternoon assignment.
  const pm = await f.route(a.school.id, { code: 'R1P', name: 'Route 1 PM', direction: 'afternoon' });
  const pmStop = await f.stop(a.school.id, pm.id, { name: 'PM Stop', sequence: 1, latitude: 12.95, longitude: 77.6 });
  const child = await f.student(a.school.id);
  const parent = await f.parentAccount();
  await f.schoolParent(a.school.id, parent.id);
  await f.studentParent(a.school.id, child.id, parent.id);
  await f.studentAssignment(a.school.id, { studentId: child.id, busId: a.bus.id, routeId: pm.id, stopId: pmStop.id, direction: 'afternoon' });
  parentAfternoon = await loginParent(t, String(parent.phone));
  parentInactiveChild = (await parentWith(a, { studentActive: false })).tokens;

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
async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}
const join = (c: ClientSocket, room: string) => c.timeout(4000).emitWithAck(SOCKET_EVENTS.JOIN, { room }) as Promise<JoinAck>;

describe('foreign and forged rooms', () => {
  it('school A admin: own alerts/fleet yes; B fleet, B alerts, B trip and forged room names no', async () => {
    const c = await socketFor(a.admin.accessToken);
    expect((await join(c, `school:${a.school.id}:alerts`)).ok).toBe(true);
    for (const room of [
      `school:${b.school.id}:fleet`,
      `school:${b.school.id}:alerts`,
      `trip:${b.trip.id}`,
      `trip:${a.trip.id.toUpperCase()}`,
      `trip:${a.trip.id}:x`,
      ` trip:${a.trip.id}`,
      `school:*:fleet`,
      `trip:${a.trip.id},trip:${b.trip.id}`,
    ]) {
      expect((await join(c, room)).ok, room).toBe(false);
    }
  });

  it('crew: no fleet/alerts rooms, no other trip of the same school, no foreign trip', async () => {
    const other = await f.activeTrip(a.school.id, (await f.bus(a.school.id, { code: 'R7' })).id, {});
    const c = await socketFor(a.driver.accessToken);
    for (const room of [`school:${a.school.id}:fleet`, `school:${a.school.id}:alerts`, `trip:${other.id}`, `trip:${b.trip.id}`]) {
      expect((await join(c, room)).ok, room).toBe(false);
    }
    await ownerQuery("update trips set status = 'cancelled' where id = $1", [other.id]);
  });

  it('parents: other direction, inactive child and completed trips are refused', async () => {
    const pm = await socketFor(parentAfternoon.accessToken);
    expect((await join(pm, `trip:${a.trip.id}`)).ok).toBe(false);
    const inactive = await socketFor(parentInactiveChild.accessToken);
    expect((await join(inactive, `trip:${a.trip.id}`)).ok).toBe(false);
    const done = await f.trip(a.school.id, a.bus.id, { status: 'completed', started_at: new Date(Date.now() - 7200_000).toISOString(), ended_at: new Date(Date.now() - 3600_000).toISOString(), trip_date: f.isoDay(0) });
    const ok = await socketFor(parentA.accessToken);
    expect((await join(ok, `trip:${done.id}`)).ok).toBe(false);
  });

  it('a planned driver reassigned off a trip can no longer join its room; the user who started a running trip still can', async () => {
    const w2 = await trackingWorld(t.app, { device: { ...DEVICE, deviceId: 'sock-dev-cccc' } });
    const sub = await f.staffProfile(w2.school.id, { staff_type: 'driver', full_name: 'Substitute', user_id: (await staffUser(w2.school.id, 'driver')).id });
    // Scheduled trip: the planned driver loses the room after the reassignment.
    const planned = await f.trip(w2.school.id, w2.bus.id, { status: 'scheduled', trip_date: f.isoDay(0), direction: 'afternoon', driver_staff_id: w2.driverProfile.id, planned_start_at: new Date(Date.now() + 3600_000).toISOString() });
    const c = await socketFor(w2.driver.accessToken);
    expect((await join(c, `trip:${planned.id}`)).ok).toBe(true);
    const revoked: unknown[] = [];
    c.on(SOCKET_EVENTS.ROOM_REVOKED, (p) => revoked.push(p));
    const re1 = await request(t.app).post(`/api/v1/school/trips/${planned.id}/reassign`).set(auth(w2.admin.accessToken)).send({ driverId: sub.id, reason: 'swap' });
    expect(re1.status).toBe(200);
    await waitFor(() => revoked.length === 1);
    expect(revoked[0]).toEqual({ room: `trip:${planned.id}`, reason: 'NOT_ALLOWED' });
    expect((await join(c, `trip:${planned.id}`)).ok).toBe(false);
    // Running trip started on this driver's phone: the trip stays bound to it, so the room stays open.
    const sub2 = await f.staffProfile(w2.school.id, { staff_type: 'driver', full_name: 'Substitute 2', user_id: (await staffUser(w2.school.id, 'driver')).id });
    const re2 = await request(t.app).post(`/api/v1/school/trips/${w2.trip.id}/reassign`).set(auth(w2.admin.accessToken)).send({ driverId: sub2.id, reason: 'swap' });
    expect(re2.status).toBe(200);
    expect((await join(c, `trip:${w2.trip.id}`)).ok).toBe(true);
  });

  // Regression: room authorization used to run only on join. Unlinking through the API disconnects
  // the parent's sockets; moving the child to another bus re-checks the parent's rooms; an out-of-band
  // change (or an assignment window that simply expired) is caught by the periodic revalidation.
  it('a parent unlinked from the child through the API stops receiving live positions of the trip', async () => {
    const extra = await parentWith(a);
    const c = await socketFor(extra.tokens.accessToken);
    expect((await join(c, `trip:${a.trip.id}`)).ok).toBe(true);
    const got: unknown[] = [];
    c.on(SOCKET_EVENTS.LIVE_POSITION, (p) => got.push(p));
    const parentRow = await ownerQuery<{ id: string }>('select sp.id from school_parents sp join student_parents l on l.parent_account_id = sp.parent_account_id and l.school_id = sp.school_id where l.student_id = $1', [extra.child.id]);
    const unlink = await request(t.app).delete(`/api/v1/school/students/${extra.child.id}/parents/${parentRow.rows[0]!.id}`).set(auth(a.admin.accessToken));
    expect(unlink.status).toBe(200);
    await waitFor(() => c.disconnected);
    const res = await postPoints(t.app, a, northbound({ baseMs: Date.now() - 2000, count: 1 }), { deviceUid: 'sock-dev-aaaa' });
    expect(res.status).toBe(200);
    await drainJobs();
    await new Promise((r) => setTimeout(r, 300));
    expect(got).toHaveLength(0);
  });

  it('a parent whose child moves to another bus is removed from the old trip room (ROOM_REVOKED) and cannot re-join', async () => {
    const moved = await parentWith(a);
    const c = await socketFor(moved.tokens.accessToken);
    expect((await join(c, `trip:${a.trip.id}`)).ok).toBe(true);
    const revoked: unknown[] = [];
    c.on(SOCKET_EVENTS.ROOM_REVOKED, (p) => revoked.push(p));
    const bus9 = await f.bus(a.school.id, { code: 'R9' });
    await f.busRouteAssignment(a.school.id, bus9.id, a.route.id);
    const res = await request(t.app).put(`/api/v1/school/students/${moved.child.id}/assignment`).set(auth(a.admin.accessToken)).send({ morning: { busId: bus9.id, routeId: a.route.id, stopId: a.stops[1]!.id } });
    expect(res.status, JSON.stringify(res.body.error ?? {})).toBe(200);
    await waitFor(() => revoked.length === 1);
    expect(revoked[0]).toEqual({ room: `trip:${a.trip.id}`, reason: 'NOT_ALLOWED' });
    expect((await join(c, `trip:${a.trip.id}`)).ok).toBe(false);
  });

  it('the periodic revalidation removes a parent whose link was deleted out of band', async () => {
    const c = await socketFor(parentA.accessToken);
    expect((await join(c, `trip:${a.trip.id}`)).ok).toBe(true);
    const revoked: unknown[] = [];
    c.on(SOCKET_EVENTS.ROOM_REVOKED, (p) => revoked.push(p));
    await ownerQuery('delete from student_parents where student_id = $1', [childA.id]);
    expect(await sockets.revalidate()).toBeGreaterThanOrEqual(1);
    await waitFor(() => revoked.length === 1);
    const got: unknown[] = [];
    c.on(SOCKET_EVENTS.LIVE_POSITION, (p) => got.push(p));
    await new Promise((r) => setTimeout(r, 300));
    expect(got).toHaveLength(0);
  });
});

describe('fleet / path endpoints never leak another school', () => {
  it('fleet and path of school A never mention school B buses, trips or points', async () => {
    const pts = await postPoints(t.app, b, northbound({ baseMs: Date.now() - 2000, count: 1 }), { deviceUid: 'sock-dev-bbbb' });
    expect(pts.status).toBe(200);
    await drainJobs();
    const fleet = await request(t.app).get('/api/v1/school/fleet/live').set(auth(a.admin.accessToken));
    expect(fleet.status).toBe(200);
    const text = JSON.stringify(fleet.body);
    for (const id of [b.bus.id, b.trip.id, b.driverProfile.id, b.school.id]) expect(text).not.toContain(id);
    const path = await request(t.app).get(`/api/v1/school/trips/${b.trip.id}/path?includePoints=true`).set(auth(a.admin.accessToken));
    expect(path.status).toBe(404);
    const smuggled = await request(t.app).get('/api/v1/school/fleet/live').set(auth(a.admin.accessToken)).set(HEADERS.SCHOOL_ID, String(b.school.id));
    expect(JSON.stringify(smuggled.body)).not.toContain(b.bus.id);
    const route = await request(t.app).get(`/api/v1/driver/trips/${b.trip.id}/route`).set(auth(a.driver.accessToken)).set(HEADERS.DEVICE_ID, 'sock-dev-aaaa');
    expect(route.status).toBe(404);
  });
});
