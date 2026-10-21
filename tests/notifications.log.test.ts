// GET /school/notifications — the school's parent notification log (notification_events with trip,
// bus and student): DTO shape, filters, sort, CSV export, role gate and tenant isolation (an admin of
// another school sees nothing, also when filtering by this school's ids).
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dispatchTripEvent } from '../src/modules/notifications/dispatch.js';
import { buildApp, loginSchoolAdmin, loginStaff, schoolAdmin, staffUser, type TestApp } from './helpers/authApp.js';
import { closeDb, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { capture, notifWorld, type Capture, type NotifWorld } from './notifications.fixtures.js';

let t: TestApp;
let w: NotifWorld;
let cap: Capture;
let tokenA: string;

const api = (path: string) => `/api/v1${path}`;
const now = () => new Date().toISOString();

beforeEach(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  w = await notifWorld();
  cap = capture();
  tokenA = (await loginSchoolAdmin(t.app, String((await schoolAdmin(w.sid)).email))).accessToken;
  await dispatchTripEvent({ schoolId: w.sid, tripId: w.trip.id, event: 'trip_started', at: now() });
  await dispatchTripEvent({ schoolId: w.sid, tripId: w.trip.id, event: 'arrived_at_stop', stopIds: [w.stops[0]!.id], at: now() });
});
afterEach(() => cap.restore());
afterAll(closeDb);

const get = (path: string, token = tokenA) => request(t.app).get(api(path)).set('Authorization', `Bearer ${token}`);

describe('list', () => {
  it('returns the events with trip, bus, student and per-channel outcomes', async () => {
    const res = await get('/school/notifications');
    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ page: 1, limit: 20, total: 5 });
    const aaravStarted = (res.body.data as Record<string, unknown>[]).find((d) => d.studentId === w.students.aarav.id && d.eventType === 'trip_started');
    expect(aaravStarted).toMatchObject({
      tripId: w.trip.id,
      direction: 'morning',
      busCode: 'R1',
      studentName: 'Aarav Kumar Sharma',
      channel: 'push',
      status: 'sent',
      recipients: 2,
      error: null,
      channels: { in_app: { status: 'sent', targets: 2, delivered: 2 }, push: { status: 'sent' }, sms: { status: 'skipped', error: 'FEATURE_DISABLED' } },
    });
    expect(typeof aaravStarted!.sentAt).toBe('string');
    expect(aaravStarted!.tripDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('filters by event, student, status, direction, trip date and text', async () => {
    const ids = async (qs: string) => ((await get(`/school/notifications?${qs}`)).body.data as { studentId: string; eventType: string }[]).map((d) => `${d.eventType}:${d.studentId}`).sort();
    const { aarav, diya } = w.students;
    expect(await ids('eventType=arrived_at_stop')).toEqual([`arrived_at_stop:${aarav.id}`, `arrived_at_stop:${diya.id}`].sort());
    expect(await ids(`studentId=${aarav.id}`)).toEqual([`arrived_at_stop:${aarav.id}`, `trip_started:${aarav.id}`].sort());
    expect(await ids('q=diya')).toEqual([`arrived_at_stop:${diya.id}`, `trip_started:${diya.id}`].sort());
    expect(await ids(`tripId=${w.trip.id}&status=sent`)).toHaveLength(5);
    expect(await ids('status=skipped,failed')).toEqual([]);
    expect(await ids('direction=afternoon')).toEqual([]);
    expect(await ids(`from=${f.isoDay(1)}`)).toEqual([]);
    expect(await ids(`to=${f.isoDay(1)}`)).toHaveLength(5);
  });

  it('sorts by whitelisted fields and paginates', async () => {
    const res = await get('/school/notifications?sort=studentName,eventType&limit=2&page=2');
    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ page: 2, limit: 2, total: 5, totalPages: 3 });
    expect((res.body.data as { studentName: string; eventType: string }[]).map((d) => [d.studentName, d.eventType])).toEqual([
      ['Diya Patel', 'arrived_at_stop'],
      ['Diya Patel', 'trip_started'],
    ]);
    expect((await get('/school/notifications?sort=payload')).status).toBe(400);
  });

  it('rejects bad filters and the pdf format', async () => {
    expect((await get('/school/notifications?eventType=fire_drill')).status).toBe(400);
    expect((await get('/school/notifications?tripId=nope')).status).toBe(400);
    expect((await get('/school/notifications?format=pdf')).status).toBe(400);
  });
});

describe('csv export', () => {
  it('streams every matching event with channel columns', async () => {
    const res = await get('/school/notifications?format=csv&eventType=trip_started&sort=studentName');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const lines = res.text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
    expect(lines[0]).toBe('Created at (UTC),Trip date,Direction,Bus,Student,Event,Status,Recipients,In-app,Push,SMS,Error,Sent at (UTC)');
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain(',morning,R1,Aarav Kumar Sharma,trip_started,sent,2,sent 2/2,sent 2/2,skipped 0/0 FEATURE_DISABLED,');
  });
});

describe('access', () => {
  it('drivers and anonymous callers are refused', async () => {
    const driver = await staffUser(w.sid, 'driver');
    const staffToken = (await loginStaff(t.app, String(w.school.code), String(driver.phone))).accessToken;
    expect((await get('/school/notifications', staffToken)).status).toBe(403);
    expect((await request(t.app).get(api('/school/notifications'))).status).toBe(401);
  });

  it("another school's admin sees none of these events, even by id", async () => {
    const other = await f.school({ name: 'Second School' });
    await f.schoolSubscription(other.id);
    const tokenB = (await loginSchoolAdmin(t.app, String((await schoolAdmin(other.id)).email))).accessToken;
    for (const qs of ['', `?tripId=${w.trip.id}`, `?studentId=${w.students.aarav.id}`, '?q=Aarav']) {
      const res = await get(`/school/notifications${qs}`, tokenB);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.meta.total).toBe(0);
    }
    const csv = await get('/school/notifications?format=csv', tokenB);
    expect(csv.text.replace(/^\uFEFF/, '').trim().split(/\r?\n/)).toHaveLength(1);
  });
});
