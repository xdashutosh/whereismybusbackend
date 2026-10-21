// Wave-3 adversarial tests — notifications engine (BP §11.2, §16; contract §9).
// Attacks: fan-out to unlinked / deactivated parents and to other schools (identical codes),
// cross-school job payloads, push to dead devices, duplicate notifications under concurrent
// dispatches and announcement deliveries, sensitive data in bodies / push data / socket payloads,
// other-direction students, announcement audience flips.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deliverAnnouncement, refreshAnnouncement } from '../src/modules/notifications/announcements.js';
import { dispatchTripEvent } from '../src/modules/notifications/dispatch.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { capture, eventsOf, inboxOf, linkParent, notifWorld, parentPhone, type Capture, type NotifWorld } from './notifications.fixtures.js';

let a: NotifWorld;
let b: NotifWorld;
let cap: Capture;
const now = () => new Date().toISOString();
const started = (w: NotifWorld, tripId = w.trip.id) => dispatchTripEvent({ schoolId: w.sid, tripId, event: 'trip_started', at: now() });

beforeEach(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  a = await notifWorld();
  b = await notifWorld();
  cap = capture();
});
afterEach(() => cap.restore());
afterAll(closeDb);

describe('fan-out boundaries', () => {
  it('a job payload with school A and school B\'s trip id notifies nobody', async () => {
    const r = await started(a, b.trip.id);
    expect(r).toMatchObject({ claimed: 0, inbox: 0, reason: 'TRIP_NOT_FOUND' });
    expect(await eventsOf(b.trip.id)).toEqual([]);
    expect(cap.push.sent).toEqual([]);
    expect(cap.emits).toEqual([]);
  });

  it('identical codes in two schools: school A\'s trip reaches only school A\'s parents; a dual parent gets only the A child', async () => {
    const dual = await f.parentAccount({ display_name: 'Dual Parent' });
    await linkParent(a.sid, dual.id, [a.students.kabir.id]);
    await linkParent(b.sid, dual.id, [b.students.aarav.id]);
    await parentPhone(dual.id, 'tok-dual');
    await started(a);
    for (const p of Object.values(b.parents)) expect(await inboxOf(p.id), p.id).toEqual([]);
    const d = await inboxOf(dual.id);
    expect(d.map((x) => [x.school_id, x.student_id])).toEqual([[a.sid, a.students.kabir.id]]);
    expect(await eventsOf(b.trip.id)).toEqual([]);
    const pushedStudents = cap.push.sent.map((m) => m.data?.studentId);
    expect(pushedStudents).not.toContain(b.students.aarav.id);
    for (const e of cap.emits) expect((e.payload as { schoolId: string }).schoolId).toBe(a.sid);
  });

  it('deactivated parent accounts, deleted school profiles and removed links get nothing', async () => {
    await ownerQuery('update parent_accounts set is_active = false where id = $1', [a.parents.pA.id]);
    await ownerQuery('update school_parents set deleted_at = now() where school_id = $1 and parent_account_id = $2', [a.sid, a.parents.pB.id]);
    await ownerQuery('delete from student_parents where parent_account_id = $1', [a.parents.pC.id]);
    const r = await started(a);
    expect(r.inbox).toBe(0);
    for (const p of [a.parents.pA, a.parents.pB, a.parents.pC, a.parents.pD]) expect(await inboxOf(p.id), p.id).toEqual([]);
    expect(cap.push.sent).toEqual([]);
    const ev = await eventsOf(a.trip.id);
    expect(ev.every((e) => e.status === 'skipped' && e.error === 'NO_PARENTS')).toBe(true);
  });

  it('students assigned to the same bus in the other direction are not notified of a morning trip', async () => {
    const pm = await f.route(a.sid, { code: 'R1P', name: 'Route 1 PM', direction: 'afternoon' });
    const pmStop = await f.stop(a.sid, pm.id, { name: 'PM Stop', sequence: 1 });
    const evening = await f.student(a.sid, { full_name: 'Zoya Khan' });
    await f.studentAssignment(a.sid, { studentId: evening.id, busId: a.bus.id, routeId: pm.id, stopId: pmStop.id, direction: 'afternoon' });
    const pz = await f.parentAccount();
    await linkParent(a.sid, pz.id, [evening.id]);
    await started(a);
    expect(await inboxOf(pz.id)).toEqual([]);
    expect((await eventsOf(a.trip.id)).map((e) => e.student_id)).not.toContain(evening.id);
  });

  it('push goes only to trusted, unrevoked devices with a live, unexpired session', async () => {
    const pz = await f.parentAccount();
    await linkParent(a.sid, pz.id, [a.students.kabir.id]);
    const untrusted = await f.device({ owner_type: 'parent_account', owner_id: pz.id, school_id: null, app_name: 'parent_app', fcm_token: 'tok-untrusted', is_trusted: false });
    await f.session({ owner_type: 'parent_account', owner_id: pz.id, school_id: null, device_id: untrusted.id });
    const revoked = await f.device({ owner_type: 'parent_account', owner_id: pz.id, school_id: null, app_name: 'parent_app', fcm_token: 'tok-revoked', revoked_at: now() });
    await f.session({ owner_type: 'parent_account', owner_id: pz.id, school_id: null, device_id: revoked.id });
    const expired = await f.device({ owner_type: 'parent_account', owner_id: pz.id, school_id: null, app_name: 'parent_app', fcm_token: 'tok-expired' });
    await f.session({ owner_type: 'parent_account', owner_id: pz.id, school_id: null, device_id: expired.id, expires_at: new Date(Date.now() - 60_000).toISOString() });
    await f.device({ owner_type: 'parent_account', owner_id: pz.id, school_id: null, app_name: 'parent_app', fcm_token: 'tok-no-session' });
    await started(a);
    const tokens = cap.push.sent.flatMap((m) => m.tokens);
    for (const tk of ['tok-untrusted', 'tok-revoked', 'tok-expired', 'tok-no-session']) expect(tokens, tk).not.toContain(tk);
  });
});

describe('duplicates under concurrency and retries', () => {
  it('six concurrent trip_started dispatches store one event per student and one inbox entry per (parent, child), one push per bucket', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => started(a)));
    expect(results.reduce((n, r) => n + r.claimed, 0)).toBe(3);
    const ev = await eventsOf(a.trip.id);
    expect(ev).toHaveLength(3);
    const all = [...(await inboxOf(a.parents.pA.id)), ...(await inboxOf(a.parents.pB.id)), ...(await inboxOf(a.parents.pC.id))];
    expect(all).toHaveLength(4);
    const tokens = cap.push.sent.flatMap((m) => m.tokens).sort();
    expect(tokens).toEqual(['tok-a', 'tok-b', 'tok-b']);
    const parentRooms = cap.emits.filter((e) => e.event === 'notification:new').map((e) => e.room).sort();
    expect(parentRooms).toHaveLength(4);
  });

  it('overlapping approaching_stop dispatches ([stop1] and [stop1, stop2]) still notify each child once', async () => {
    const [s1, s2] = a.stops.map((s) => s.id) as [string, string];
    await Promise.all([
      dispatchTripEvent({ schoolId: a.sid, tripId: a.trip.id, event: 'approaching_stop', stopIds: [s1], minutesByStop: { [s1]: 4 }, at: now() }),
      dispatchTripEvent({ schoolId: a.sid, tripId: a.trip.id, event: 'approaching_stop', stopIds: [s1, s2], minutesByStop: { [s1]: 3, [s2]: 9 }, at: now() }),
      dispatchTripEvent({ schoolId: a.sid, tripId: a.trip.id, event: 'approaching_stop', stopIds: [s2], minutesByStop: { [s2]: 8 }, at: now() }),
    ]);
    const ev = await eventsOf(a.trip.id);
    expect(ev.map((e) => e.student_id).sort()).toEqual([a.students.aarav.id, a.students.diya.id, a.students.kabir.id].sort());
    expect((await inboxOf(a.parents.pB.id)).filter((x) => x.kind === 'approaching_stop')).toHaveLength(2);
  });

  it('four concurrent announcement deliveries: one inbox row per parent; school B parents and inactive links get none', async () => {
    const ann = await f.announcement(a.sid, { audience: 'parents', title: 'Bus timings change', body: 'From Monday, buses leave 10 minutes earlier.' });
    await Promise.all(Array.from({ length: 4 }, () => deliverAnnouncement(a.sid, ann.id)));
    for (const p of [a.parents.pA, a.parents.pB, a.parents.pC]) {
      expect((await inboxOf(p.id)).filter((x) => x.kind === 'announcement'), p.id).toHaveLength(1);
    }
    expect(await inboxOf(a.parents.pD.id)).toEqual([]);
    for (const p of Object.values(b.parents)) expect(await inboxOf(p.id)).toEqual([]);
    expect(cap.push.sent.flatMap((m) => m.tokens).sort()).toEqual(['tok-a', 'tok-b']);
  });

  it('a drivers-only announcement creates no parent inbox entries and notifies only this school\'s crew', async () => {
    const driverA = await f.user(a.sid, { role: 'driver' });
    const driverB = await f.user(b.sid, { role: 'driver' });
    const adminA = await f.user(a.sid, { role: 'school_admin' });
    const ann = await f.announcement(a.sid, { audience: 'drivers' });
    await deliverAnnouncement(a.sid, ann.id);
    for (const p of Object.values(a.parents)) expect(await inboxOf(p.id)).toEqual([]);
    const rooms = cap.emits.map((e) => e.room);
    expect(rooms).toContain(`actor:${driverA.id}`);
    expect(rooms).not.toContain(`actor:${driverB.id}`);
    expect(rooms).not.toContain(`actor:${adminA.id}`);
  });
});

describe('sensitive data in notification texts and payloads', () => {
  it('inbox, push, socket and SMS carry only the first name and bus code — no surname, stop, class, school, phone or coordinates', async () => {
    await f.schoolSettings(a.sid, { features: { sms: true } });
    await ownerQuery(`update platform_settings set value = value || '{"sms": true}' where key = 'modules'`);
    await ownerQuery("update students set class_name = 'Grade 7', section = 'Blue' where id = $1", [a.students.aarav.id]);
    const { rows } = await ownerQuery<{ phone: string }>('select phone from parent_accounts where id = $1', [a.parents.pA.id]);
    const pAphone = rows[0]!.phone;
    try {
      const [s1] = a.stops.map((s) => s.id) as [string];
      for (const event of ['trip_started', 'bus_left_school', 'arrived_at_stop', 'trip_delayed', 'approaching_stop'] as const) {
        await dispatchTripEvent({ schoolId: a.sid, tripId: a.trip.id, event, stopIds: event === 'trip_started' || event === 'bus_left_school' ? null : [s1], minutesByStop: { [s1]: 12 }, at: now() });
      }
      const forbidden = /Sharma|Kumar|Indiranagar|Domlur|Grade 7|Blue|Greenwood|12\.9|77\.6|Priya|Rakesh/;
      const texts = [
        ...(await inboxOf(a.parents.pA.id)).flatMap((x) => [x.title, x.body, JSON.stringify(x.data)]),
        ...(await inboxOf(a.parents.pB.id)).flatMap((x) => [x.title, x.body, JSON.stringify(x.data)]),
        ...cap.push.sent.flatMap((m) => [m.title, m.body, JSON.stringify(m.data)]),
        ...cap.emits.map((e) => JSON.stringify(e.payload)),
        ...cap.sms.texts.map((s) => s.text),
      ];
      expect(texts.length).toBeGreaterThan(10);
      for (const s of texts) {
        expect(s).not.toMatch(forbidden);
        expect(s).not.toContain(pAphone.slice(-6));
      }
      expect(cap.sms.texts.some((s) => s.text.includes('Aarav'))).toBe(true);
    } finally {
      await ownerQuery(`update platform_settings set value = value || '{"sms": false}' where key = 'modules'`);
    }
  });
});

describe('announcement audience edits', () => {
  it('an audience flipped parents → drivers → all (an admin correcting a mistake) gives the parents their notice back', async () => {
    const ann = await f.announcement(a.sid, { audience: 'parents', title: 'School closed Friday', body: 'Heavy rain: no buses on Friday.' });
    await deliverAnnouncement(a.sid, ann.id);
    expect((await inboxOf(a.parents.pA.id)).filter((x) => x.kind === 'announcement')).toHaveLength(1);
    await ownerQuery("update announcements set audience = 'drivers' where id = $1", [ann.id]);
    await refreshAnnouncement(a.sid, ann.id);
    expect((await inboxOf(a.parents.pA.id)).filter((x) => x.kind === 'announcement')).toHaveLength(0);
    await ownerQuery("update announcements set audience = 'all' where id = $1", [ann.id]);
    await refreshAnnouncement(a.sid, ann.id);
    await deliverAnnouncement(a.sid, ann.id);
    // The announcement is live and addressed to parents again; the parent app has no announcements list
    // (the inbox is the only place parents read notices), so the entry must come back.
    expect((await inboxOf(a.parents.pA.id)).filter((x) => x.kind === 'announcement')).toHaveLength(1);
  });

  it('a drivers-only notice later widened to all (audience edited to include parents) reaches the parents', async () => {
    const ann = await f.announcement(a.sid, { audience: 'drivers', title: 'Fire drill Thursday', body: 'All buses return by 2 pm on Thursday.' });
    await deliverAnnouncement(a.sid, ann.id);
    await ownerQuery("update announcements set audience = 'all' where id = $1", [ann.id]);
    // What the listeners queue for an audience edit: refresh (and deliver when publishedAt changed).
    await refreshAnnouncement(a.sid, ann.id);
    await deliverAnnouncement(a.sid, ann.id);
    expect((await inboxOf(a.parents.pA.id)).filter((x) => x.kind === 'announcement')).toHaveLength(1);
  });
});
