// Breakdown notices to parents (BP §10.4: "Driver can mark Trip interrupted and the school can cancel.
// Parents are notified if enabled."): trip.interrupted → trip_interrupted, a school cancellation of a
// running or same-day trip → trip_cancelled, both through the regular dispatch (notification_events
// dedupe, inbox, push, per-direction opt-outs); calendar cancellations (holidays, schedule edits) send
// none; the parent status of an interrupted trip says so.
import type { ParentTrackingSnapshot } from '@wimb/shared';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../src/modules/notifications/listeners.js';
import { clearThresholdCache } from '../src/modules/notifications/listeners.js';
import { parentStatus } from '../src/modules/tracking/status.js';
import { tripNotStartedCheck } from '../src/modules/trips/jobs.js';
import { buildApp, loginParent } from './helpers/authApp.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { drainJobs } from './helpers/trackingWorld.js';
import { capture, eventsOf, inboxOf, linkParent, parentPhone, type Capture } from './notifications.fixtures.js';
import { asParent } from './parent.fixtures.js';
import { as, asAdmin, startScheduled, tripWorld, type TripWorld } from './trips.fixtures.js';

let cap: Capture;

beforeEach(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  clearThresholdCache();
  cap = capture();
});
afterEach(async () => {
  await drainJobs();
  cap.restore();
});
afterAll(closeDb);

/** A trip world with one child at Stop 1 whose parent (en) has a phone. */
async function withChild(): Promise<{ w: TripWorld; child: f.TenantRow; parent: f.Row }> {
  const w = await tripWorld(buildApp());
  const child = await f.student(w.sid, { full_name: 'Riya Menon' });
  await f.studentAssignment(w.sid, { studentId: child.id, busId: w.bus.id, routeId: w.route.id, stopId: w.stops[0]!.id });
  const parent = await f.parentAccount({ preferred_language: 'en' });
  await linkParent(w.sid, parent.id, [child.id]);
  await parentPhone(parent.id, 'tok-riya');
  return { w, child, parent };
}

describe('trip interrupted, then cancelled (breakdown)', () => {
  it('notifies the parents once for each step, and the parent status shows the interruption', async () => {
    const { w, child, parent } = await withChild();
    expect((await startScheduled(w)).status).toBe(201);
    await drainJobs();
    expect((await as(w.t, w.driver).post(`/driver/trips/${w.trip.id}/interrupt`, { reason: 'Engine failure' })).status).toBe(200);
    await drainJobs();
    let inbox = await inboxOf(parent.id);
    expect(inbox.find((i) => i.kind === 'trip_interrupted')).toMatchObject({
      trip_id: w.trip.id,
      title: 'Bus R1 trip interrupted',
      body: 'The morning trip of bus R1 for Riya has been interrupted. The school will share an update.',
    });

    // While still in progress, the parent snapshot reports the interruption instead of "On Route".
    const token = (await loginParent(w.t, String(parent.phone))).accessToken;
    const snap = await asParent(w.t, token, w.sid).get(`/parent/children/${child.id}/tracking`);
    expect(snap.status).toBe(200);
    expect((snap.body.data as ParentTrackingSnapshot).status).toMatchObject({ status: 'bus_stopped', reason: 'TRIP_INTERRUPTED', interrupted: true });

    expect((await asAdmin(w.t, w.adminToken).post(`/school/trips/${w.trip.id}/cancel`, { reason: 'Bus breakdown' })).status).toBe(200);
    await drainJobs();
    inbox = await inboxOf(parent.id);
    expect(inbox.map((i) => i.kind)).toEqual(['trip_started', 'trip_interrupted', 'trip_cancelled']);
    expect(inbox[2]).toMatchObject({ title: 'Bus R1 trip cancelled', body: 'The morning trip of bus R1 for Riya has been cancelled by the school.' });
    expect(cap.push.sent.map((m) => m.tokens)).toEqual([['tok-riya'], ['tok-riya'], ['tok-riya']]);
    // A repeated interruption report (device event) never notifies twice (notification_events dedupe).
    const events = (await eventsOf(w.trip.id)).map((e) => `${e.event_type}:${e.status}`);
    expect(events).toEqual(['trip_started:sent', 'trip_interrupted:sent', 'trip_cancelled:sent']);
  });

  it('today’s scheduled trip cancelled by the school notifies; a parent opt-out is honoured', async () => {
    const { w, child, parent } = await withChild();
    // The parent turns the new toggle off through the preferences API (an older app sending only the
    // BP §11.2 toggles keeps working: every toggle is optional and merged).
    const token = (await loginParent(w.t, String(parent.phone))).accessToken;
    const pref = await asParent(w.t, token, w.sid).put(`/parent/children/${child.id}/notification-preferences`, { morning: { tripCancelled: false } });
    expect(pref.status).toBe(200);
    expect(pref.body.data.morning).toMatchObject({ tripCancelled: false, tripInterrupted: true, tripStarted: true });
    const other = await f.student(w.sid, { full_name: 'Kabir Singh' });
    await f.studentAssignment(w.sid, { studentId: other.id, busId: w.bus.id, routeId: w.route.id, stopId: w.stops[1]!.id });
    const otherParent = await f.parentAccount({ preferred_language: 'hi' });
    await linkParent(w.sid, otherParent.id, [other.id]);
    expect((await asAdmin(w.t, w.adminToken).post(`/school/trips/${w.trip.id}/cancel`, { reason: 'Driver unavailable' })).status).toBe(200);
    await drainJobs();
    expect(await inboxOf(parent.id)).toEqual([]);
    expect((await inboxOf(otherParent.id)).map((i) => [i.kind, i.title])).toEqual([['trip_cancelled', 'बस R1 की यात्रा रद्द']]);
    const byStudent = Object.fromEntries((await eventsOf(w.trip.id)).map((e) => [e.student_id, `${e.event_type}:${e.status}:${e.error ?? ''}`]));
    expect(byStudent).toEqual({ [child.id]: 'trip_cancelled:skipped:PREFERENCES_OFF', [other.id]: 'trip_cancelled:sent:' });
  });

  it('a holiday entered for today cancels the trip without a breakdown notice', async () => {
    const { w, parent } = await withChild();
    expect((await asAdmin(w.t, w.adminToken).post('/school/holidays', { name: 'Rain day', startDate: w.today, appliesTo: 'all' })).status).toBe(201);
    await tripNotStartedCheck({ schoolId: w.sid });
    await drainJobs();
    expect((await ownerQuery<{ status: string }>('select status from trips where id = $1', [w.trip.id])).rows[0]!.status).toBe('cancelled');
    expect(await eventsOf(w.trip.id)).toEqual([]);
    expect(await inboxOf(parent.id)).toEqual([]);
  });
});

describe('parent status of an interrupted trip (pure)', () => {
  it('is "Bus stopped" with TRIP_INTERRUPTED and no ETA, whatever the live picture', () => {
    const opts = { delayThresholdMin: 10, notStartedGraceMin: 10, nowMs: Date.parse('2026-10-19T03:00:00Z') };
    const s = parentStatus({ status: 'in_progress', plannedStartAt: null, interruptedAt: '2026-10-19T02:55:00Z' }, null, { stopId: 'x' }, opts);
    expect(s).toMatchObject({ status: 'bus_stopped', reason: 'TRIP_INTERRUPTED', interrupted: true, etaAt: null, etaMinutes: null });
    expect(parentStatus({ status: 'in_progress', plannedStartAt: null, interruptedAt: null }, null, { stopId: 'x' }, opts)).toMatchObject({ status: 'location_unavailable' });
  });
});
