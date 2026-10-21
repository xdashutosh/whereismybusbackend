// Parent module — notification preferences per child and direction, device/FCM registration and the
// in-app inbox (BP §8.5, §11.2, §15.2; contract §2 Push, §9): defaults, partial updates (audited),
// strict validation, per-parent isolation, the notifications-module helper, school-less device rows
// bound to the session (token never returned), and the cross-school inbox with read markers.
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NotificationPreferencesDto, ParentNotificationDto } from '@wimb/shared';
import { withSchoolSystem } from '../src/db/tenant.js';
import { effectivePreferences } from '../src/modules/parent/index.js';
import { buildApp, loginParent, loginSchoolAdmin, passwordHash, type TestApp, type Tokens } from './helpers/authApp.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { alignFixtureDates, api, asParent, bearer } from './parent.fixtures.js';

let t: TestApp;
let fx: f.TwoSchoolFixture;
let parentA: Tokens;
let shared: Tokens;
let adminA: string;

const prefs = (token: string, schoolId = fx.a.school.id) => asParent(t, token, schoolId);

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  fx = await f.twoSchoolFixture();
  await alignFixtureDates(fx);
  await ownerQuery(`update users set password_hash = $2 where id = $1`, [fx.a.admin.id, await passwordHash()]);
  parentA = await loginParent(t, String(fx.a.parent.phone));
  shared = await loginParent(t, String(fx.sharedParent.phone));
  adminA = (await loginSchoolAdmin(t.app, String(fx.a.admin.email))).accessToken;
});

afterAll(closeDb);

describe('notification preferences', () => {
  const path = (id: string) => `/parent/children/${id}/notification-preferences`;
  const allOn = { tripStarted: true, busLeftSchool: true, approachingStop: true, arrivedAtStop: true, tripDelayed: true, tripNotStarted: true, tripInterrupted: true, tripCancelled: true };

  it('defaults every toggle to on for both directions', async () => {
    const res = await prefs(shared.accessToken).get(path(fx.a.student.id));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ studentId: fx.a.student.id, morning: allOn, afternoon: allOn, updatedAt: null });
  });

  it('merges a partial update per direction, audits it and keeps other parents\' settings apart', async () => {
    const res = await prefs(parentA.accessToken).put(path(fx.a.student.id), { morning: { approachingStop: false }, afternoon: { tripStarted: false, tripDelayed: false } });
    expect(res.status).toBe(200);
    const d = res.body.data as NotificationPreferencesDto;
    expect(d.morning).toEqual({ ...allOn, approachingStop: false });
    expect(d.afternoon).toEqual({ ...allOn, tripStarted: false, tripDelayed: false });
    expect(d.updatedAt).toEqual(expect.any(String));
    const { rows } = await ownerQuery<{ direction: string; approaching_stop: boolean; trip_started: boolean; school_id: string }>(
      'select direction, approaching_stop, trip_started, school_id from notification_preferences where student_id = $1 and parent_account_id = $2 order by direction',
      [fx.a.student.id, fx.a.parent.id],
    );
    expect(rows).toEqual([
      { direction: 'afternoon', approaching_stop: true, trip_started: false, school_id: fx.a.school.id },
      { direction: 'morning', approaching_stop: false, trip_started: true, school_id: fx.a.school.id },
    ]);
    const audit = await ownerQuery<{ school_id: string; actor_type: string; actor_id: string; old_values: Record<string, unknown>; new_values: Record<string, unknown> }>(
      `select school_id, actor_type, actor_id, old_values, new_values from audit_logs where action = 'notification_preferences.update' and entity_id = $1`,
      [fx.a.student.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ school_id: fx.a.school.id, actor_id: fx.a.parent.id, new_values: { morning: { approachingStop: false } } });
    // The other parent of the same child still has everything on.
    expect((await prefs(shared.accessToken).get(path(fx.a.student.id))).body.data.morning).toEqual(allOn);
    // GET returns what PUT stored; an identical PUT changes nothing and is not audited again.
    expect((await prefs(parentA.accessToken).get(path(fx.a.student.id))).body.data).toEqual(d);
    expect((await prefs(parentA.accessToken).put(path(fx.a.student.id), { morning: { approachingStop: false } })).body.data).toEqual(d);
    const again = await ownerQuery(`select 1 from audit_logs where action = 'notification_preferences.update' and entity_id = $1`, [fx.a.student.id]);
    expect(again.rows).toHaveLength(1);
  });

  it('exposes the effective toggles to the notifications module (missing rows = all on)', async () => {
    const map = await withSchoolSystem(fx.a.school.id, (tx) => effectivePreferences(tx, fx.a.student.id, 'morning', [fx.a.parent.id, fx.sharedParent.id]));
    expect(map.get(fx.a.parent.id)).toEqual({ ...allOn, approachingStop: false });
    expect(map.get(fx.sharedParent.id)).toEqual(allOn);
  });

  it('validates the body strictly', async () => {
    for (const body of [{}, { morning: {} }, { morning: { foo: true } }, { evening: { tripStarted: false } }, { morning: { tripStarted: 'no' } }]) {
      const res = await prefs(parentA.accessToken).put(path(fx.a.student.id), body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('strips unknown body keys (contract §4): a body schoolId / parentAccountId / studentId never redirects the row', async () => {
    const res = await prefs(parentA.accessToken).put(path(fx.a.student.id), {
      afternoon: { tripNotStarted: false }, schoolId: fx.b.school.id, parentAccountId: fx.sharedParent.id, studentId: fx.a.otherStudent.id,
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ studentId: fx.a.student.id, afternoon: { tripNotStarted: false } });
    const { rows } = await ownerQuery<{ school_id: string; parent_account_id: string; student_id: string }>(
      "select school_id, parent_account_id, student_id from notification_preferences where direction = 'afternoon' and trip_not_started = false",
    );
    expect(rows).toEqual([{ school_id: fx.a.school.id, parent_account_id: fx.a.parent.id, student_id: fx.a.student.id }]);
  });

  it('answers 404 for an unlinked or other-school child and 403 for a school without a link', async () => {
    expect((await prefs(parentA.accessToken).put(path(fx.a.otherStudent.id), { morning: { tripStarted: false } })).status).toBe(404);
    expect((await prefs(shared.accessToken).put(path(fx.b.student.id), { morning: { tripStarted: false } })).status).toBe(404);
    expect((await prefs(parentA.accessToken, fx.b.school.id).get(path(fx.a.student.id))).status).toBe(403);
    const { rows } = await ownerQuery('select 1 from notification_preferences where student_id = any ($1::uuid[]) and parent_account_id = any ($2::uuid[])', [
      [fx.a.otherStudent.id, fx.b.student.id],
      [fx.a.parent.id, fx.sharedParent.id],
    ]);
    expect(rows).toHaveLength(0);
  });
});

describe('POST /parent/devices', () => {
  const device = { deviceId: 'parent-phone-0001', platform: 'android', model: 'Galaxy A54', osVersion: '14', appVersion: '1.2.0' };

  it('registers a school-less device with its FCM token (never returned) and binds the session to it', async () => {
    const res = await asParent(t, parentA.accessToken).post('/parent/devices', { ...device, fcmToken: 'fcm-token-abc' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ deviceId: 'parent-phone-0001', platform: 'android', model: 'Galaxy A54', osVersion: '14', appVersion: '1.2.0', hasFcmToken: true });
    expect(JSON.stringify(res.body)).not.toContain('fcm-token-abc');
    const { rows } = await ownerQuery<{ id: string; school_id: string | null; owner_type: string; fcm_token: string; app_name: string }>(
      'select id, school_id, owner_type, fcm_token, app_name from devices where owner_id = $1',
      [fx.a.parent.id],
    );
    expect(rows).toEqual([{ id: res.body.data.id, school_id: null, owner_type: 'parent_account', fcm_token: 'fcm-token-abc', app_name: 'parent_app' }]);
    const s = await ownerQuery<{ device_id: string }>('select device_id from sessions where id = $1', [parentA.sessionId]);
    expect(s.rows[0]!.device_id).toBe(res.body.data.id);
    const audit = await ownerQuery<{ action: string; school_id: string | null; new_values: Record<string, unknown> }>(
      `select action, school_id, new_values from audit_logs where entity_id = $1`,
      [res.body.data.id],
    );
    expect(audit.rows).toEqual([{ action: 'device.register', school_id: null, new_values: expect.objectContaining({ platform: 'android', model: 'Galaxy A54' }) }]);
    expect(JSON.stringify(audit.rows)).not.toContain('fcm-token-abc');
  });

  it('refreshes the token, clears it with null and keeps it when omitted', async () => {
    let res = await asParent(t, parentA.accessToken).post('/parent/devices', { ...device, fcmToken: 'fcm-token-def' });
    expect(res.body.data.hasFcmToken).toBe(true);
    res = await asParent(t, parentA.accessToken).post('/parent/devices', { deviceId: device.deviceId, platform: 'android', appVersion: '1.3.0' });
    expect(res.body.data).toMatchObject({ hasFcmToken: true, appVersion: '1.3.0', model: 'Galaxy A54' });
    res = await asParent(t, parentA.accessToken).post('/parent/devices', { deviceId: device.deviceId, platform: 'android', fcmToken: null });
    expect(res.body.data.hasFcmToken).toBe(false);
    const { rows } = await ownerQuery<{ n: number }>('select count(*)::int as n from devices where owner_id = $1', [fx.a.parent.id]);
    expect(rows[0]!.n).toBe(1);
  });

  it('refuses another device on a bound session, a blocked device\'s token, bad bodies and other roles', async () => {
    const other = await asParent(t, parentA.accessToken).post('/parent/devices', { ...device, deviceId: 'parent-phone-0002' });
    expect(other.status).toBe(403);
    expect(other.body.error.code).toBe('DEVICE_NOT_BOUND');
    await ownerQuery(`update devices set revoked_at = now() where owner_id = $1`, [fx.a.parent.id]);
    const blocked = await asParent(t, parentA.accessToken).post('/parent/devices', { ...device, fcmToken: 'fcm-token-blocked' });
    expect(blocked.status).toBe(200);
    expect(blocked.body.data.hasFcmToken).toBe(false);
    for (const body of [{ deviceId: 'short', platform: 'android' }, { deviceId: device.deviceId }, { deviceId: device.deviceId, platform: 'symbian' }]) {
      expect((await asParent(t, shared.accessToken).post('/parent/devices', body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await request(t.app).post(api('/parent/devices')).set(bearer(adminA)).send(device)).status).toBe(403);
  });
});

describe('in-app inbox', () => {
  let ids: Record<string, string>;
  beforeAll(async () => {
    await ownerQuery('delete from parent_notifications');
    const mk = async (sid: string, parent: string, o: f.Values) => (await f.parentNotification(sid, parent, o)).id;
    ids = {
      a1: await mk(fx.a.school.id, fx.sharedParent.id, { student_id: fx.a.student.id, title: 'Bus R1 started', created_at: new Date(Date.now() - 300_000).toISOString() }),
      b1: await mk(fx.b.school.id, fx.sharedParent.id, { student_id: fx.b.student.id, kind: 'approaching_stop', title: 'Bus R1 is 5 min away', data: { screen: 'track', studentId: fx.b.student.id }, created_at: new Date(Date.now() - 120_000).toISOString() }),
      a2: await mk(fx.a.school.id, fx.sharedParent.id, { kind: 'announcement', title: 'School closed tomorrow', created_at: new Date(Date.now() - 60_000).toISOString() }),
      other: await mk(fx.a.school.id, fx.a.parent.id, { title: 'Not yours' }),
    };
  });

  it('lists the caller\'s notifications of every school, newest first, with the unread count', async () => {
    const res = await asParent(t, shared.accessToken).get('/parent/notifications');
    expect(res.status).toBe(200);
    const items = res.body.data as ParentNotificationDto[];
    expect(items.map((n) => n.id)).toEqual([ids.a2, ids.b1, ids.a1]);
    expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 3, totalPages: 1, unreadCount: 3 });
    expect(items[1]).toMatchObject({ schoolId: fx.b.school.id, studentId: fx.b.student.id, kind: 'approaching_stop', data: { screen: 'track' }, readAt: null });
    expect(JSON.stringify(res.body)).not.toContain(ids.other);
  });

  it('filters by child and unread state and pages', async () => {
    const byChild = await asParent(t, shared.accessToken).get(`/parent/notifications?studentId=${fx.b.student.id}`);
    expect(byChild.body.data.map((n: ParentNotificationDto) => n.id)).toEqual([ids.b1]);
    const page2 = await asParent(t, shared.accessToken).get('/parent/notifications?limit=2&page=2');
    expect(page2.body.data.map((n: ParentNotificationDto) => n.id)).toEqual([ids.a1]);
    expect(page2.body.meta).toMatchObject({ total: 3, totalPages: 2, unreadCount: 3 });
    const past = await asParent(t, shared.accessToken).get('/parent/notifications?page=9');
    expect(past.body).toMatchObject({ data: [], meta: { total: 3, unreadCount: 3 } });
    expect((await asParent(t, shared.accessToken).get('/parent/notifications?unread=maybe')).status).toBe(400);
  });

  it('marks one as read (idempotent), refuses other parents\' ids and marks the rest with read-all', async () => {
    const first = await asParent(t, shared.accessToken).post(`/parent/notifications/${ids.b1}/read`);
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ id: ids.b1, readAt: expect.any(String) });
    const again = await asParent(t, shared.accessToken).post(`/parent/notifications/${ids.b1}/read`);
    expect(again.body.data.readAt).toBe(first.body.data.readAt);
    expect((await asParent(t, shared.accessToken).post(`/parent/notifications/${ids.other}/read`)).status).toBe(404);
    expect((await asParent(t, shared.accessToken).post('/parent/notifications/0190a0a0-0000-7000-8000-000000000000/read')).status).toBe(404);
    const unread = await asParent(t, shared.accessToken).get('/parent/notifications?unread=true');
    expect(unread.body.data.map((n: ParentNotificationDto) => n.id)).toEqual([ids.a2, ids.a1]);
    expect(unread.body.meta.unreadCount).toBe(2);
    const all = await asParent(t, shared.accessToken).post('/parent/notifications/read-all');
    expect(all.body.data).toEqual({ updated: 2 });
    expect((await asParent(t, shared.accessToken).get('/parent/notifications')).body.meta.unreadCount).toBe(0);
    const { rows } = await ownerQuery<{ read_at: string | null }>('select read_at from parent_notifications where id = $1', [ids.other]);
    expect(rows[0]!.read_at).toBeNull();
  });

  it('is not reachable by other roles', async () => {
    expect((await request(t.app).get(api('/parent/notifications')).set(bearer(adminA))).status).toBe(403);
    expect((await request(t.app).post(api('/parent/notifications/read-all'))).status).toBe(401);
  });
});
