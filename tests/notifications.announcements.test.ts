// Announcement fan-out (BP §20 #6, contract §9) through the real school API: parents get one inbox
// entry + push in their language, drivers/conductors a push + notification:new, exactly once
// (retries, concurrency, sweep), scheduled delivery, edits refresh / withdrawals remove the inbox
// entries, audience and feature rules, multi-school parents.
import { SOCKET_EVENTS } from '@wimb/shared';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deliverAnnouncement, sweepAnnouncements } from '../src/modules/notifications/announcements.js';
import { buildApp, loginSchoolAdmin, loginStaff, schoolAdmin, staffUser, type TestApp } from './helpers/authApp.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { drainJobs } from './helpers/trackingWorld.js';
import { capture, inboxOf, linkParent, notifWorld, parentPhone, type Capture, type NotifWorld } from './notifications.fixtures.js';

let t: TestApp;
let w: NotifWorld;
let cap: Capture;
let adminToken: string;
let driverUserId: string;

beforeEach(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  w = await notifWorld();
  cap = capture();
  const admin = await schoolAdmin(w.sid);
  adminToken = (await loginSchoolAdmin(t.app, String(admin.email))).accessToken;
  const driver = await staffUser(w.sid, 'driver');
  driverUserId = driver.id;
  await loginStaff(t.app, String(w.school.code), String(driver.phone), { deviceId: 'driver-phone-0001', platform: 'android', model: 'Pixel 8', appVersion: '1.0.0' });
  await ownerQuery("update devices set fcm_token = 'tok-driver' where owner_id = $1", [driver.id]);
  await staffUser(w.sid, 'conductor'); // never signed in: notified by socket only (no phone)
});
afterEach(async () => {
  await drainJobs();
  cap.restore();
});
afterAll(closeDb);

const api = (path: string) => `/api/v1${path}`;
const auth = () => ({ Authorization: `Bearer ${adminToken}` });
const markers = async (id: string) => (await ownerQuery("select 1 from audit_logs where entity_id = $1 and action = 'announcement.deliver'", [id])).rows.length;
const announcementInbox = async (parentId: string) => (await inboxOf(parentId)).filter((x) => x.kind === 'announcement');

async function create(body: Record<string, unknown>): Promise<string> {
  const res = await request(t.app).post(api('/school/announcements')).set(auth()).send({ title: 'Parent-teacher meeting on Saturday', body: 'Morning buses run 30 minutes later.', audience: 'all', ...body });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

async function settled(check: () => Promise<void>): Promise<void> {
  await vi.waitFor(async () => {
    await drainJobs();
    await check();
  }, { timeout: 10_000, interval: 100 });
}

describe('delivery', () => {
  it('audience all: parents (inbox + push per language) and drivers (push + socket), audited once', async () => {
    const id = await create({});
    await settled(async () => expect(await markers(id)).toBe(1));
    for (const p of [w.parents.pA, w.parents.pB, w.parents.pC]) {
      const rows = await announcementInbox(p.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ school_id: w.sid, student_id: null, trip_id: null, title: 'Parent-teacher meeting on Saturday', body: 'Morning buses run 30 minutes later.' });
      expect(rows[0]!.data).toEqual({ type: 'announcement', screen: 'announcement', schoolId: w.sid, announcementId: id });
    }
    expect(await announcementInbox(w.parents.pD.id)).toEqual([]);
    const titles = cap.push.sent.map((m) => [m.title, m.tokens.sort().join(',')]);
    expect(titles).toEqual(expect.arrayContaining([['New notice from school', 'tok-a'], ['स्कूल से नई सूचना', 'tok-b'], ['New notice from school', 'tok-driver']]));
    expect(cap.push.sent.every((m) => m.body === 'Parent-teacher meeting on Saturday')).toBe(true);
    const driverEmit = cap.emits.find((e) => e.room === `actor:${driverUserId}`);
    expect(driverEmit).toMatchObject({ event: SOCKET_EVENTS.NOTIFICATION_NEW, payload: { id: null, kind: 'announcement', schoolId: w.sid } });
    expect(cap.emits.filter((e) => e.room === `actor:${w.parents.pA.id}`)).toHaveLength(1);
  });

  it('exactly once under retries and concurrency', async () => {
    const row = await f.announcement(w.sid, { audience: 'parents' });
    const results = await Promise.all(Array.from({ length: 4 }, () => deliverAnnouncement(w.sid, row.id)));
    expect(results.filter((r) => !r.skipped)).toHaveLength(1);
    expect(results.filter((r) => r.skipped === 'ALREADY_DELIVERED')).toHaveLength(3);
    expect(await announcementInbox(w.parents.pB.id)).toHaveLength(1);
    expect(await markers(row.id)).toBe(1);
    expect((await deliverAnnouncement(w.sid, row.id)).skipped).toBe('ALREADY_DELIVERED');
  });

  it('audience drivers: no parent inbox entries', async () => {
    const id = await create({ audience: 'drivers' });
    await settled(async () => expect(await markers(id)).toBe(1));
    expect(await announcementInbox(w.parents.pA.id)).toEqual([]);
    expect(cap.push.sent.map((m) => m.tokens)).toEqual([['tok-driver']]);
  });

  it('skips withdrawn, expired and feature-disabled announcements', async () => {
    const gone = await f.announcement(w.sid, { deleted_at: new Date().toISOString() });
    expect((await deliverAnnouncement(w.sid, gone.id)).skipped).toBe('WITHDRAWN');
    const old = await f.announcement(w.sid, { published_at: new Date(Date.now() - 7_200_000).toISOString(), expires_at: new Date(Date.now() - 3_600_000).toISOString() });
    expect((await deliverAnnouncement(w.sid, old.id)).skipped).toBe('EXPIRED');
    const off = await f.announcement(w.sid);
    await f.schoolSettings(w.sid, { features: { announcements: false } });
    expect((await deliverAnnouncement(w.sid, off.id)).skipped).toBe('FEATURE_DISABLED');
    expect((await deliverAnnouncement(w.sid, '01a14cfb-0000-7000-8000-000000000000')).skipped).toBe('NOT_FOUND');
    expect(cap.push.sent).toEqual([]);
  });
});

describe('scheduling', () => {
  it('a scheduled announcement waits for publishedAt; the sweep delivers one whose timer was lost', async () => {
    const id = await create({ publishedAt: new Date(Date.now() + 3_600_000).toISOString() });
    await drainJobs();
    expect(await announcementInbox(w.parents.pA.id)).toEqual([]);
    expect((await deliverAnnouncement(w.sid, id)).skipped).toBe('NOT_DUE');
    await ownerQuery("update announcements set published_at = now() - interval '1 minute' where id = $1", [id]);
    const r = await sweepAnnouncements();
    expect(r.delivered).toBe(1);
    expect(await announcementInbox(w.parents.pA.id)).toHaveLength(1);
    expect((await sweepAnnouncements()).delivered).toBe(0);
  });

  it('moving publishedAt to now delivers immediately', async () => {
    const id = await create({ publishedAt: new Date(Date.now() + 3_600_000).toISOString() });
    await drainJobs();
    const res = await request(t.app).patch(api(`/school/announcements/${id}`)).set(auth()).send({ publishedAt: new Date(Date.now() - 1000).toISOString() });
    expect(res.status).toBe(200);
    await settled(async () => expect(await announcementInbox(w.parents.pA.id)).toHaveLength(1));
  });
});

describe('edits and withdrawal', () => {
  it('an edit rewrites the inbox text without a second push; leaving the parent audience removes it', async () => {
    const id = await create({});
    await settled(async () => expect(await markers(id)).toBe(1));
    const pushes = cap.push.sent.length;
    expect((await request(t.app).patch(api(`/school/announcements/${id}`)).set(auth()).send({ title: 'PTM moved to Monday' })).status).toBe(200);
    await settled(async () => expect((await announcementInbox(w.parents.pA.id))[0]!.title).toBe('PTM moved to Monday'));
    expect(cap.push.sent.length).toBe(pushes);
    expect((await request(t.app).patch(api(`/school/announcements/${id}`)).set(auth()).send({ audience: 'drivers' })).status).toBe(200);
    await settled(async () => expect(await announcementInbox(w.parents.pA.id)).toEqual([]));
  });

  it('widening a drivers notice to all through the API reaches the parents once (inbox + push) and never re-pushes the drivers', async () => {
    const id = await create({ audience: 'drivers' });
    await settled(async () => expect(await markers(id)).toBe(1));
    expect(await announcementInbox(w.parents.pA.id)).toEqual([]);
    const driverPushes = () => cap.push.sent.filter((m) => m.tokens.includes('tok-driver')).length;
    const parentPushes = () => cap.push.sent.filter((m) => m.tokens.includes('tok-a')).length;
    expect(driverPushes()).toBe(1);
    expect((await request(t.app).patch(api(`/school/announcements/${id}`)).set(auth()).send({ audience: 'all' })).status).toBe(200);
    await settled(async () => expect(await announcementInbox(w.parents.pA.id)).toHaveLength(1));
    await settled(async () => expect(await markers(id)).toBe(2));
    expect(parentPushes()).toBe(1);
    expect(driverPushes()).toBe(1);
    // parents → drivers → all (an admin correcting a mistake): the entries come back, without a second push.
    expect((await request(t.app).patch(api(`/school/announcements/${id}`)).set(auth()).send({ audience: 'drivers' })).status).toBe(200);
    await settled(async () => expect(await announcementInbox(w.parents.pA.id)).toEqual([]));
    expect((await request(t.app).patch(api(`/school/announcements/${id}`)).set(auth()).send({ audience: 'all' })).status).toBe(200);
    await settled(async () => expect(await announcementInbox(w.parents.pA.id)).toHaveLength(1));
    expect(await markers(id)).toBe(2);
    expect(parentPushes()).toBe(1);
    expect(driverPushes()).toBe(1);
    // The sweep finds nothing left to deliver.
    expect((await sweepAnnouncements()).delivered).toBe(0);
  });

  it('a withdrawal removes the inbox entries', async () => {
    const id = await create({ audience: 'parents' });
    await settled(async () => expect(await announcementInbox(w.parents.pB.id)).toHaveLength(1));
    expect((await request(t.app).delete(api(`/school/announcements/${id}`)).set(auth())).status).toBe(200);
    await settled(async () => expect(await announcementInbox(w.parents.pB.id)).toEqual([]));
    expect((await ownerQuery("select 1 from audit_logs where entity_id = $1 and action = 'announcement.inbox_withdraw'", [id])).rows).toHaveLength(1);
  });
});

describe('multi-school parents', () => {
  it('each school only reaches its own parents; a two-school parent gets one entry per school', async () => {
    const other = await f.school({ name: 'Second School' });
    await f.schoolSubscription(other.id);
    const childB = await f.student(other.id, { full_name: 'Aarav Sharma' });
    await linkParent(other.id, w.parents.pA.id, [childB.id]);
    await parentPhone(w.parents.pA.id, 'tok-a-2');
    const strangerB = await f.parentAccount();
    await linkParent(other.id, strangerB.id, [childB.id]);
    const a = await f.announcement(w.sid, { audience: 'parents' });
    await deliverAnnouncement(w.sid, a.id);
    expect(await announcementInbox(strangerB.id)).toEqual([]);
    const b = await f.announcement(other.id, { audience: 'parents', title: 'Second school notice' });
    await deliverAnnouncement(other.id, b.id);
    expect((await announcementInbox(w.parents.pA.id)).map((x) => [x.school_id, x.title])).toEqual([
      [w.sid, 'Notice'],
      [other.id, 'Second school notice'],
    ]);
    expect((await announcementInbox(w.parents.pB.id)).map((x) => x.school_id)).toEqual([w.sid]);
    // School B's delivery of A's announcement id finds nothing (RLS).
    expect((await deliverAnnouncement(other.id, a.id)).skipped).toBe('NOT_FOUND');
  });
});
