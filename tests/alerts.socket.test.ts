// Admin alert bell room school:{id}:alerts (BP §8.6, §11.2): only school admins of that school may join
// (drivers, parents, other schools and forged names are refused); scan jobs push alert:new, admin
// workflow changes and system resolutions push alert:updated — never to another school's room.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ALERT_UPDATED_EVENT, SOCKET_EVENTS, type AlertNewEvent, type AlertUpdatedEvent } from '@wimb/shared';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { documentExpiryScan } from '../src/modules/alerts/jobs.js';
import { createSocketServer, type SocketServer } from '../src/socket.js';
import { buildApp, loginParent, type TestApp, type Tokens } from './helpers/authApp.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { drainJobs } from './helpers/trackingWorld.js';
import { alertsWorld, auth, type AlertsWorld } from './alerts.fixtures.js';

let t: TestApp;
let a: AlertsWorld;
let b: AlertsWorld;
let parent: Tokens;
let server: http.Server;
let sockets: SocketServer;
let url: string;
const clients: ClientSocket[] = [];

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  a = await alertsWorld(t.app, 'sock-alert-aaaa');
  b = await alertsWorld(t.app, 'sock-alert-bbbb');
  const child = await f.student(a.sid);
  const p = await f.parentAccount();
  await f.schoolParent(a.sid, p.id);
  await f.studentParent(a.sid, child.id, p.id);
  parent = await loginParent(t, String(p.phone));
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
const join = (c: ClientSocket, room: string) => c.timeout(4000).emitWithAck(SOCKET_EVENTS.JOIN, { room }) as Promise<JoinAck>;
async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}
const D = f.isoDay(0);

describe('school:{id}:alerts authorization', () => {
  it('admins join their own school room only; drivers, parents and forged names are refused', async () => {
    const admin = await socketFor(a.admin.accessToken);
    expect(await join(admin, `school:${a.sid}:alerts`)).toMatchObject({ ok: true });
    const foreign = await join(admin, `school:${b.sid}:alerts`);
    expect(foreign.ok).toBe(false);
    for (const room of [`school:${a.sid.toUpperCase()}:alerts`, `school:${a.sid}:alerts:x`, 'school:*:alerts', `school:${a.sid}:alert`]) {
      expect((await join(admin, room)).ok, room).toBe(false);
    }
    const driver = await socketFor(a.driver.accessToken);
    expect((await join(driver, `school:${a.sid}:alerts`)).ok).toBe(false);
    const parentSocket = await socketFor(parent.accessToken);
    expect((await join(parentSocket, `school:${a.sid}:alerts`)).ok).toBe(false);
  });
});

describe('alert events', () => {
  it('scan alerts arrive as alert:new, workflow and resolution changes as alert:updated, only in their school', async () => {
    const adminA = await socketFor(a.admin.accessToken);
    const adminB = await socketFor(b.admin.accessToken);
    expect((await join(adminA, `school:${a.sid}:alerts`)).ok).toBe(true);
    expect((await join(adminB, `school:${b.sid}:alerts`)).ok).toBe(true);
    const newA: AlertNewEvent[] = [];
    const updA: AlertUpdatedEvent[] = [];
    const seenB: unknown[] = [];
    adminA.on(SOCKET_EVENTS.ALERT_NEW, (p: AlertNewEvent) => newA.push(p));
    adminA.on(ALERT_UPDATED_EVENT, (p: AlertUpdatedEvent) => updA.push(p));
    adminB.on(SOCKET_EVENTS.ALERT_NEW, (p: unknown) => seenB.push(p));
    adminB.on(ALERT_UPDATED_EVENT, (p: unknown) => seenB.push(p));

    // School A: bus R1 has no insurance/fitness → two doc_missing alerts.
    const summary = await documentExpiryScan({ schoolId: a.sid, localDate: D });
    await waitFor(() => newA.length >= summary.raised);
    expect(summary.raised).toBeGreaterThanOrEqual(2);
    const missing = newA.find((x) => x.type === 'doc_missing' && x.busId === a.bus.id)!;
    expect(missing).toMatchObject({ severity: 'warning', entityType: 'bus', entityId: a.bus.id });

    // Admin closes one → alert:updated (close).
    const res = await request(t.app).patch(`/api/v1/school/alerts/${missing.id}`).set(auth(a.admin.accessToken)).send({ action: 'close', note: 'Ordered' });
    expect(res.status).toBe(200);
    await waitFor(() => updA.some((u) => u.id === missing.id));
    expect(updA.find((u) => u.id === missing.id)).toMatchObject({ status: 'closed', action: 'close', type: 'doc_missing' });

    // Uploading the other document resolves the other alert → alert:updated (resolve).
    const other = newA.find((x) => x.type === 'doc_missing' && x.busId === a.bus.id && x.id !== missing.id)!;
    const { rows } = await ownerQuery<{ dedupe_key: string }>('select dedupe_key from alerts where id = $1', [other.id]);
    const docType = rows[0]!.dedupe_key.split(':').at(-1)!;
    await f.busDocument(a.sid, a.bus.id, { doc_type: docType, expiry_date: f.isoDay(300) });
    await documentExpiryScan({ schoolId: a.sid, localDate: D });
    await waitFor(() => updA.some((u) => u.id === other.id));
    expect(updA.find((u) => u.id === other.id)).toMatchObject({ status: 'closed', action: 'resolve' });

    await new Promise((r) => setTimeout(r, 200));
    expect(seenB).toEqual([]);
  });
});
