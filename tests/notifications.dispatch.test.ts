// Parent trip notifications against the real database (RLS app role): recipients per bus +
// direction (+ stop), per-parent per-child per-direction preferences, dedupe under retries and
// concurrency, inbox entries, push targets (live sessions only, invalid tokens pruned), channel
// selection (push / SMS / WhatsApp / platform switch), gating, multi-school parent isolation.
import { SOCKET_EVENTS } from '@wimb/shared';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createUnavailableWhatsApp } from '../src/modules/notifications/channels.js';
import { dispatchTripEvent } from '../src/modules/notifications/dispatch.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { capture, eventsOf, fakePush, inboxOf, linkParent, notifWorld, parentPhone, type Capture, type NotifWorld } from './notifications.fixtures.js';

let w: NotifWorld;
let cap: Capture;
const now = () => new Date().toISOString();

beforeEach(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  w = await notifWorld();
  cap = capture();
});
afterEach(() => cap.restore());
afterAll(closeDb);

const started = () => dispatchTripEvent({ schoolId: w.sid, tripId: w.trip.id, event: 'trip_started', at: now() });

describe('trip started', () => {
  it('notifies the opted-in parents of every student assigned to the bus + direction', async () => {
    const r = await started();
    expect(r).toMatchObject({ claimed: 3, notified: 3, inbox: 4 });
    const ev = await eventsOf(w.trip.id);
    expect(ev.map((e) => e.student_id).sort()).toEqual([w.students.aarav.id, w.students.diya.id, w.students.kabir.id].sort());
    for (const e of ev) expect(e).toMatchObject({ event_type: 'trip_started', status: 'sent', channel: 'push' });
    const aarav = ev.find((e) => e.student_id === w.students.aarav.id)!;
    expect(aarav.payload).toMatchObject({ recipients: 2, channels: { in_app: { status: 'sent', delivered: 2 }, push: { status: 'sent', targets: 2, delivered: 2 }, sms: { status: 'skipped', error: 'FEATURE_DISABLED' } } });
    expect(aarav.sent_at).not.toBeNull();
    // Kabir's parent has no phone: inbox only.
    expect(ev.find((e) => e.student_id === w.students.kabir.id)!.payload).toMatchObject({ channels: { push: { status: 'skipped', error: 'NO_DEVICES' } } });

    const a = await inboxOf(w.parents.pA.id);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ school_id: w.sid, student_id: w.students.aarav.id, trip_id: w.trip.id, kind: 'trip_started', title: 'Bus R1 has started', body: 'The morning trip of bus R1 for Aarav has started.' });
    expect(a[0]!.data).toEqual({ type: 'trip_started', screen: 'track', schoolId: w.sid, studentId: w.students.aarav.id, tripId: w.trip.id, direction: 'morning' });
    const b = await inboxOf(w.parents.pB.id);
    expect(b.map((x) => x.student_id).sort()).toEqual([w.students.aarav.id, w.students.diya.id].sort());
    expect(b[0]!.title).toBe('बस R1 चल पड़ी है');
    expect(await inboxOf(w.parents.pD.id)).toEqual([]);
  });

  it('pushes once per (student, language) with the live-session tokens only and deep-link data', async () => {
    await started();
    const tokens = cap.push.sent.flatMap((m) => m.tokens);
    expect(tokens.sort()).toEqual(['tok-a', 'tok-b', 'tok-b']);
    expect(tokens).not.toContain('tok-b-old');
    const forPA = cap.push.sent.find((m) => m.tokens.includes('tok-a'))!;
    expect(forPA.data).toEqual({ type: 'trip_started', screen: 'track', schoolId: w.sid, studentId: w.students.aarav.id, tripId: w.trip.id, direction: 'morning' });
    expect(`${forPA.title} ${forPA.body}`).not.toMatch(/Sharma|Indiranagar|Kumar/);
  });

  it('emits notification:new to each parent personal room', async () => {
    await started();
    const rooms = cap.emits.filter((e) => e.event === SOCKET_EVENTS.NOTIFICATION_NEW).map((e) => e.room).sort();
    expect(rooms).toEqual([`actor:${w.parents.pA.id}`, `actor:${w.parents.pB.id}`, `actor:${w.parents.pB.id}`, `actor:${w.parents.pC.id}`].sort());
    const one = cap.emits.find((e) => e.room === `actor:${w.parents.pA.id}`)!.payload;
    expect(one).toMatchObject({ schoolId: w.sid, kind: 'trip_started', title: 'Bus R1 has started' });
    expect(typeof one.id).toBe('string');
  });

  it('audits a claiming run once (notification.dispatch with counts, in the school) and a retry not at all', async () => {
    await started();
    await started();
    const { rows } = await ownerQuery<{ school_id: string; entity_type: string; entity_id: string; actor_type: string; new_values: Record<string, unknown> }>(
      "select school_id, entity_type, entity_id, actor_type, new_values from audit_logs where action = 'notification.dispatch'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ school_id: w.sid, entity_type: 'trip', entity_id: w.trip.id, actor_type: 'system' });
    expect(rows[0]!.new_values).toMatchObject({ event: 'trip_started', claimed: 3, notified: 3, skipped: 0, inbox: 4 });
    // Counts only: no child names, phones or message texts in the audit trail.
    expect(JSON.stringify(rows[0]!.new_values)).not.toMatch(/Aarav|\+91|Bus R1/);
  });

  it('excludes inactive students, future assignments and other directions', async () => {
    const afternoon = await f.route(w.sid, { code: 'R1A', direction: 'afternoon' });
    const st = await f.stop(w.sid, afternoon.id, { sequence: 1 });
    const other = await f.student(w.sid, { full_name: 'Afternoon Only' });
    await f.studentAssignment(w.sid, { studentId: other.id, busId: w.bus.id, routeId: afternoon.id, stopId: st.id, direction: 'afternoon' });
    await started();
    const ids = (await eventsOf(w.trip.id)).map((e) => e.student_id);
    expect(ids).not.toContain(w.students.inactive.id);
    expect(ids).not.toContain(w.students.future.id);
    expect(ids).not.toContain(other.id);
  });
});

describe('preferences', () => {
  it('respects per-parent, per-child, per-direction toggles', async () => {
    await f.notificationPreference(w.sid, w.parents.pB.id, w.students.aarav.id, { direction: 'morning', trip_started: false });
    await f.notificationPreference(w.sid, w.parents.pB.id, w.students.diya.id, { direction: 'afternoon', trip_started: false });
    await f.notificationPreference(w.sid, w.parents.pC.id, w.students.kabir.id, { direction: 'morning', trip_started: false, arrived_at_stop: true });
    await started();
    expect((await inboxOf(w.parents.pB.id)).map((x) => x.student_id)).toEqual([w.students.diya.id]);
    expect(await inboxOf(w.parents.pA.id)).toHaveLength(1);
    const kabir = (await eventsOf(w.trip.id)).find((e) => e.student_id === w.students.kabir.id)!;
    expect(kabir).toMatchObject({ status: 'skipped', error: 'PREFERENCES_OFF', channel: 'in_app' });
    expect(await inboxOf(w.parents.pC.id)).toEqual([]);
  });

  it('a student without an active parent is recorded as skipped (NO_PARENTS) and never replayed', async () => {
    const lonely = await f.student(w.sid, { full_name: 'No Parent' });
    await f.studentAssignment(w.sid, { studentId: lonely.id, busId: w.bus.id, routeId: w.route.id, stopId: w.stops[0]!.id });
    await started();
    const parent = await f.parentAccount();
    await linkParent(w.sid, parent.id, [lonely.id]);
    expect((await started()).claimed).toBe(0);
    expect((await eventsOf(w.trip.id)).find((e) => e.student_id === lonely.id)).toMatchObject({ status: 'skipped', error: 'NO_PARENTS' });
    expect(await inboxOf(parent.id)).toEqual([]);
  });
});

describe('dedupe', () => {
  it('a retry claims nothing and sends nothing', async () => {
    await started();
    const pushes = cap.push.sent.length;
    const again = await started();
    expect(again).toMatchObject({ claimed: 0, inbox: 0 });
    expect(cap.push.sent.length).toBe(pushes);
    expect(await eventsOf(w.trip.id)).toHaveLength(3);
  });

  it('concurrent runs produce one event per student and one inbox entry per parent', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => started()));
    expect(results.reduce((n, r) => n + r.claimed, 0)).toBe(3);
    expect(await eventsOf(w.trip.id)).toHaveLength(3);
    expect(await inboxOf(w.parents.pB.id)).toHaveLength(2);
    expect(cap.push.sent.flatMap((m) => m.tokens).filter((t) => t === 'tok-a')).toHaveLength(1);
  });

  it('different events of the same trip are independent', async () => {
    await started();
    await dispatchTripEvent({ schoolId: w.sid, tripId: w.trip.id, event: 'bus_left_school', at: now() });
    const a = await inboxOf(w.parents.pA.id);
    expect(a.map((x) => x.kind)).toEqual(['trip_started', 'bus_left_school']);
    expect(a[1]!.body).toBe("Bus R1 (Aarav's morning bus) has left the school.");
  });
});

describe('stop events', () => {
  it('arrived at stop: only the students of that stop', async () => {
    const r = await dispatchTripEvent({ schoolId: w.sid, tripId: w.trip.id, event: 'arrived_at_stop', stopIds: [w.stops[1]!.id], at: now() });
    expect(r).toMatchObject({ claimed: 1, notified: 1 });
    expect((await inboxOf(w.parents.pC.id))[0]).toMatchObject({ kind: 'arrived_at_stop', body: "Bus R1 has reached Kabir's stop." });
    expect(await inboxOf(w.parents.pA.id)).toEqual([]);
  });

  it('approaching stop / delayed carry the minutes of each stop', async () => {
    await dispatchTripEvent({ schoolId: w.sid, tripId: w.trip.id, event: 'approaching_stop', stopIds: [w.stops[0]!.id], minutesByStop: { [w.stops[0]!.id]: 4 }, at: now() });
    expect((await inboxOf(w.parents.pA.id))[0]!.body).toBe("Bus R1 is about 4 minutes away from Aarav's stop.");
    await dispatchTripEvent({ schoolId: w.sid, tripId: w.trip.id, event: 'trip_delayed', stopIds: [w.stops[1]!.id], minutesByStop: { [w.stops[1]!.id]: 14 }, at: now() });
    expect((await inboxOf(w.parents.pC.id))[0]!.body).toBe("Bus R1 is running about 14 minutes late for Kabir's stop.");
    expect((await eventsOf(w.trip.id)).find((e) => e.event_type === 'trip_delayed')!.payload).toMatchObject({ minutes: 14, stopId: w.stops[1]!.id });
  });
});

describe('gating', () => {
  it('stale signals, finished trips and non-school trips notify nobody', async () => {
    expect((await dispatchTripEvent({ schoolId: w.sid, tripId: w.trip.id, event: 'approaching_stop', stopIds: [w.stops[0]!.id], at: new Date(Date.now() - 6 * 60_000).toISOString() })).reason).toBe('STALE_SIGNAL');
    await ownerQuery("update trips set status = 'completed', ended_at = now(), closed_at = now() where id = $1", [w.trip.id]);
    expect((await started()).reason).toBe('TRIP_NOT_RUNNING');
    const ns = await f.activeTrip(w.sid, w.bus.id, { trip_type: 'non_school', direction: null, purpose: 'Workshop visit' });
    expect((await dispatchTripEvent({ schoolId: w.sid, tripId: ns.id, event: 'trip_started', at: now() })).reason).toBe('NOT_A_SCHOOL_TRIP');
    expect(await eventsOf(w.trip.id)).toEqual([]);
  });

  it('trip not started: only for a scheduled/missed trip and only when the school enabled it', async () => {
    await truncateAll({ keep: ['platform_settings'] });
    w = await notifWorld({ tripStatus: 'scheduled', settings: { notify_trip_not_started: false } });
    const p = { schoolId: w.sid, tripId: w.trip.id, event: 'trip_not_started' as const, at: now() };
    expect((await dispatchTripEvent(p)).reason).toBe('DISABLED_BY_SCHOOL');
    await f.schoolSettings(w.sid, { notify_trip_not_started: true });
    expect((await dispatchTripEvent(p)).claimed).toBe(3);
    expect((await inboxOf(w.parents.pA.id))[0]!.body).toBe('The morning trip of bus R1 for Aarav has not started yet.');
  });
});

describe('channel selection', () => {
  it('push disabled (no FCM): in-app inbox only, recorded as such', async () => {
    cap.restore();
    cap = capture({ push: fakePush({ enabled: false }) });
    await started();
    expect(cap.push.sent).toHaveLength(0);
    const e = (await eventsOf(w.trip.id))[0]!;
    expect(e).toMatchObject({ status: 'sent', channel: 'in_app' });
    expect(e.payload).toMatchObject({ channels: { push: { status: 'skipped', error: 'PUSH_DISABLED' }, in_app: { status: 'sent' } } });
    expect(await inboxOf(w.parents.pA.id)).toHaveLength(1);
  });

  it('the platform push switch turns push off', async () => {
    await ownerQuery(`update platform_settings set value = jsonb_set(value, '{push}', 'false') where key = 'modules'`);
    try {
      await started();
      expect(cap.push.sent).toHaveLength(0);
      expect((await eventsOf(w.trip.id))[0]!.payload).toMatchObject({ channels: { push: { error: 'MODULE_DISABLED' } } });
    } finally {
      await ownerQuery(`update platform_settings set value = jsonb_set(value, '{push}', 'true') where key = 'modules'`);
    }
  });

  it('SMS only when the school feature and the platform module are on; WhatsApp reports NOT_AVAILABLE', async () => {
    await f.schoolSettings(w.sid, { features: { sms: true, whatsapp: true } });
    await started();
    expect(cap.sms.texts).toEqual([]);
    expect((await eventsOf(w.trip.id))[0]!.payload).toMatchObject({ channels: { sms: { error: 'FEATURE_DISABLED' } } });
    await ownerQuery(`update platform_settings set value = value || '{"sms": true, "whatsapp": true}' where key = 'modules'`);
    try {
      await dispatchTripEvent({ schoolId: w.sid, tripId: w.trip.id, event: 'bus_left_school', at: now() });
      const phones = (await ownerQuery<{ phone: string }>('select phone from parent_accounts where id = any ($1)', [[w.parents.pA.id, w.parents.pB.id, w.parents.pC.id]])).rows.map((r) => r.phone);
      expect(cap.sms.texts).toHaveLength(4);
      expect(new Set(cap.sms.texts.map((t) => t.to))).toEqual(new Set(phones));
      // Send order follows parent ids (random uuids): check each parent's text by phone and language.
      const textTo = async (id: string) => {
        const phone = (await ownerQuery<{ phone: string }>('select phone from parent_accounts where id = $1', [id])).rows[0]!.phone;
        return cap.sms.texts.find((t) => t.to === phone)?.text;
      };
      expect(await textTo(w.parents.pA.id)).toMatch(/Bus R1/);
      expect(await textTo(w.parents.pB.id)).toMatch(/बस R1/);
      const left = (await eventsOf(w.trip.id)).find((e) => e.event_type === 'bus_left_school')!;
      expect(left.payload).toMatchObject({ channels: { sms: { status: 'sent' }, whatsapp: { status: 'skipped', error: 'NOT_AVAILABLE' } } });
    } finally {
      await ownerQuery(`update platform_settings set value = value || '{"sms": false, "whatsapp": false}' where key = 'modules'`);
    }
  });

  it('an installed WhatsApp adapter is used when the feature is on', async () => {
    cap.restore();
    const sent: string[] = [];
    cap = capture({ whatsapp: { enabled: true, sendText: async (to) => { sent.push(to); return { delivered: true }; } } });
    await f.schoolSettings(w.sid, { features: { whatsapp: true } });
    await ownerQuery(`update platform_settings set value = value || '{"whatsapp": true}' where key = 'modules'`);
    try {
      await started();
      expect(sent).toHaveLength(4);
    } finally {
      await ownerQuery(`update platform_settings set value = value || '{"whatsapp": false}' where key = 'modules'`);
      expect(createUnavailableWhatsApp().enabled).toBe(false);
    }
  });

  it('prunes tokens FCM reports as invalid', async () => {
    cap.restore();
    cap = capture({ push: fakePush({ invalid: ['tok-a'] }) });
    await started();
    const { rows } = await ownerQuery<{ fcm_token: string | null }>('select fcm_token from devices where owner_id = $1', [w.parents.pA.id]);
    expect(rows.map((r) => r.fcm_token)).toEqual([null]);
    expect((await eventsOf(w.trip.id)).find((e) => e.student_id === w.students.aarav.id)!.payload).toMatchObject({ channels: { push: { status: 'sent', targets: 2, delivered: 1 } } });
  });
});

describe('multi-school parents', () => {
  it('a parent linked in two schools is notified only about the child of the trip school', async () => {
    const other = await f.school({ name: 'Second School' });
    await f.schoolSubscription(other.id);
    const busB = await f.bus(other.id, { code: 'R1' });
    const routeB = await f.route(other.id, { code: 'R1', direction: 'morning' });
    const stopB = await f.stop(other.id, routeB.id, { sequence: 1 });
    const childB = await f.student(other.id, { full_name: 'Aarav Sharma' });
    await f.studentAssignment(other.id, { studentId: childB.id, busId: busB.id, routeId: routeB.id, stopId: stopB.id });
    await linkParent(other.id, w.parents.pA.id, [childB.id]);
    await parentPhone(w.parents.pA.id, 'tok-a2');
    await started();
    const inbox = await inboxOf(w.parents.pA.id);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ school_id: w.sid, student_id: w.students.aarav.id });
    const { rows } = await ownerQuery('select 1 from notification_events where school_id = $1', [other.id]);
    expect(rows).toHaveLength(0);
    const tripB = await f.activeTrip(other.id, busB.id, { route_id: routeB.id, bus_code_snapshot: 'R1' });
    await dispatchTripEvent({ schoolId: other.id, tripId: tripB.id, event: 'trip_started', at: now() });
    const after = await inboxOf(w.parents.pA.id);
    expect(after.map((x) => [x.school_id, x.student_id])).toEqual([[w.sid, w.students.aarav.id], [other.id, childB.id]]);
    // A trip id of school A dispatched in school B's context finds nothing (RLS).
    expect((await dispatchTripEvent({ schoolId: other.id, tripId: w.trip.id, event: 'bus_left_school', at: now() })).reason).toBe('TRIP_NOT_FOUND');
  });
});
