// Socket.IO /rt with REAL sessions from the auth module (contract §7, BP §4.9): handshake for every
// owner type, school:{id}:fleet joins (school admins of that school only), deactivated users and
// suspended schools refused, logout / logout-all disconnect live sockets.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { generate, generateSecret } from 'otplib';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidateSchoolState } from '../src/middleware/resolveTenant.js';
import { encryptSecret } from '../src/shared/crypto.js';
import { createRoomRegistry, rooms } from '../src/shared/realtime.js';
import { createSocketServer, type SocketServer } from '../src/socket.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { buildApp, loginParent, loginSchoolAdmin, loginStaff, PASSWORD, passwordHash, schoolAdmin, staffUser, type TestApp } from './helpers/authApp.js';

let t: TestApp;
let server: http.Server;
let sockets: SocketServer;
let url: string;
const clients: ClientSocket[] = [];
let schoolA: f.Row;
let schoolB: f.Row;

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  schoolA = await f.school({ code: 'SOCK-A' });
  schoolB = await f.school({ code: 'SOCK-B' });
  server = http.createServer();
  sockets = await createSocketServer(server, { registry: createRoomRegistry(), redisUrl: null });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/rt`;
});
afterAll(async () => {
  for (const c of clients) c.close();
  await sockets.close();
  await closeDb();
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
const rejected = (c: ClientSocket) => new Promise<{ data?: { code?: string } }>((resolve) => c.once('connect_error', (err) => resolve(err as never)));
const join = (c: ClientSocket, room: string) => c.timeout(3000).emitWithAck('join', { room }) as Promise<{ ok: boolean; error?: { code: string } }>;
const disconnected = (c: ClientSocket) => new Promise<void>((r) => c.once('disconnect', () => r()));

describe('handshake with real sessions', () => {
  it('verifies school admins, drivers and parents; refuses super admins', async () => {
    const admin = await schoolAdmin(schoolA.id);
    const adminSocket = client((await loginSchoolAdmin(t.app, String(admin.email))).accessToken);
    await connected(adminSocket);
    expect(await join(adminSocket, rooms.schoolFleet(schoolA.id))).toMatchObject({ ok: true });
    expect((await join(adminSocket, rooms.schoolFleet(schoolB.id))).error?.code).toBe('FORBIDDEN');

    const driver = await staffUser(schoolA.id);
    const driverSocket = client((await loginStaff(t.app, 'SOCK-A', String(driver.phone))).accessToken);
    await connected(driverSocket);
    expect((await join(driverSocket, rooms.schoolFleet(schoolA.id))).error?.code).toBe('FORBIDDEN');

    const parent = await f.parentAccount();
    await f.schoolParent(schoolA.id, parent.id);
    const parentSocket = client((await loginParent(t, String(parent.phone))).accessToken);
    await connected(parentSocket);
    expect((await join(parentSocket, rooms.schoolFleet(schoolA.id))).error?.code).toBe('FORBIDDEN');

    const secret = generateSecret();
    const sa = await f.platformUser({ password_hash: await passwordHash(), totp_enabled: true, totp_secret_enc: encryptSecret(secret, { purpose: 'totp' }) });
    const login = await request(t.app).post('/api/v1/auth/platform/login').send({ email: sa.email, password: PASSWORD, totpCode: await generate({ secret }) });
    expect((await rejected(client(login.body.data.accessToken as string))).data?.code).toBe('FORBIDDEN');
  });

  it('refuses deactivated users and suspended schools', async () => {
    const admin = await schoolAdmin(schoolB.id);
    const token = (await loginSchoolAdmin(t.app, String(admin.email))).accessToken;
    await ownerQuery('update users set is_active = false where id = $1', [admin.id]);
    expect((await rejected(client(token))).data?.code).toBe('UNAUTHENTICATED');

    const s = await f.school({ code: 'SOCK-C' });
    const a2 = await schoolAdmin(s.id);
    const token2 = (await loginSchoolAdmin(t.app, String(a2.email))).accessToken;
    const live = client(token2);
    await connected(live);
    await ownerQuery("update schools set status = 'suspended' where id = $1", [s.id]);
    invalidateSchoolState(s.id);
    expect((await rejected(client(token2))).data?.code).toBe('SCHOOL_INACTIVE');
    const gone = disconnected(live);
    expect((await join(live, rooms.schoolFleet(s.id))).error?.code).toBe('SCHOOL_INACTIVE');
    await gone;
  });
});

describe('sessions revoked by a school closure', () => {
  it('answers SCHOOL_INACTIVE (not UNAUTHENTICATED) on the handshake and on joins', async () => {
    const s = await f.school({ code: 'SOCK-D' });
    const admin = await schoolAdmin(s.id);
    const login = await loginSchoolAdmin(t.app, String(admin.email));
    const live = client(login.accessToken);
    await connected(live);
    // What the platform deactivation does: close the school and revoke its sessions (reason school_deactivated).
    await ownerQuery("update schools set status = 'inactive' where id = $1", [s.id]);
    await ownerQuery("update sessions set revoked_at = now(), revoked_reason = 'school_deactivated' where school_id = $1 and revoked_at is null", [s.id]);
    invalidateSchoolState(s.id);
    expect((await rejected(client(login.accessToken))).data?.code).toBe('SCHOOL_INACTIVE');
    const gone = disconnected(live);
    expect((await join(live, rooms.schoolFleet(s.id))).error?.code).toBe('SCHOOL_INACTIVE');
    await gone;
  });

  it('keeps UNAUTHENTICATED for a revoked session of an active school', async () => {
    const admin = await schoolAdmin(schoolA.id);
    const login = await loginSchoolAdmin(t.app, String(admin.email));
    await ownerQuery("update sessions set revoked_at = now(), revoked_reason = 'logout' where id = $1", [login.sessionId]);
    expect((await rejected(client(login.accessToken))).data?.code).toBe('UNAUTHENTICATED');
  });
});

describe('revocation disconnects sockets', () => {
  it('logout and logout-all close the sockets of the revoked sessions', async () => {
    const admin = await schoolAdmin(schoolA.id);
    const s1 = await loginSchoolAdmin(t.app, String(admin.email));
    const s2 = await loginSchoolAdmin(t.app, String(admin.email));
    const c1 = client(s1.accessToken);
    const c2 = client(s2.accessToken);
    await Promise.all([connected(c1), connected(c2)]);
    const d1 = disconnected(c1);
    await request(t.app).post('/api/v1/auth/logout').set({ Authorization: `Bearer ${s1.accessToken}` }).send({});
    await d1;
    expect(c2.connected).toBe(true);
    const d2 = disconnected(c2);
    await request(t.app).post('/api/v1/auth/logout-all').set({ Authorization: `Bearer ${s2.accessToken}` }).send({});
    await d2;
  });
});
