// Triggers end to end: trip/tracking events → listeners → 'notifications-dispatch' jobs → inbox,
// through the real trip start API and the real location pipeline (ingest → points-persist →
// analytics → tracking events), plus the ETA-driven approaching / delayed triggers and their
// cross-run dedupe.
import type { TripEta } from '@wimb/shared';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../src/modules/notifications/listeners.js';
import { clearThresholdCache } from '../src/modules/notifications/listeners.js';
import { lateFinalize } from '../src/modules/tracking/persist.js';
import { events } from '../src/shared/events.js';
import { buildApp } from './helpers/authApp.js';
import { closeDb, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { drainJobs, northbound, postPoints, trackingWorld } from './helpers/trackingWorld.js';
import { capture, eventsOf, inboxOf, linkParent, notifWorld, parentPhone, type Capture, type NotifWorld } from './notifications.fixtures.js';
import { startScheduled, tripWorld } from './trips.fixtures.js';

let cap: Capture;

beforeEach(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  clearThresholdCache();
  lateFinalize.delayMs = 0;
  cap = capture();
});
afterEach(async () => {
  await drainJobs();
  cap.restore();
});
afterAll(closeDb);

function eta(stops: { stopId: string; inMin: number; delayMin: number | null }[], quality: TripEta['quality'] = 'good'): TripEta {
  const computedAt = new Date().toISOString();
  return {
    computedAt,
    quality,
    reason: null,
    speedKmh: 24,
    destinationEtaAt: null,
    stops: stops.map((s, i) => ({ stopId: s.stopId, sequence: i + 1, name: `Stop ${i + 1}`, remainingM: 400 * (i + 1), etaAt: new Date(Date.parse(computedAt) + s.inMin * 60_000).toISOString(), plannedAt: null, delayMin: s.delayMin })),
  };
}

describe('trip started through the driver API', () => {
  it('starting the scheduled trip notifies the parents of its students', async () => {
    const w = await tripWorld(buildApp());
    const child = await f.student(w.sid, { full_name: 'Riya Menon' });
    await f.studentAssignment(w.sid, { studentId: child.id, busId: w.bus.id, routeId: w.route.id, stopId: w.stops[0]!.id });
    const parent = await f.parentAccount({ preferred_language: 'en' });
    await linkParent(w.sid, parent.id, [child.id]);
    await parentPhone(parent.id, 'tok-riya');
    const res = await startScheduled(w);
    expect(res.status).toBe(201);
    await drainJobs();
    const inbox = await inboxOf(parent.id);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ kind: 'trip_started', trip_id: w.trip.id, body: 'The morning trip of bus R1 for Riya has started.' });
    expect(cap.push.sent.map((m) => m.tokens)).toEqual([['tok-riya']]);
  });
});

describe('events → jobs', () => {
  let w: NotifWorld;
  beforeEach(async () => {
    w = await notifWorld({ settings: { approaching_stop_minutes: 5, trip_delay_threshold_min: 10 } });
  });
  const base = () => ({ schoolId: w.sid, tripId: w.trip.id, busId: w.bus.id, routeId: w.route.id, direction: 'morning' as const });

  it('a status change to in_progress (only) queues trip_started', async () => {
    const status = { ...base(), tripType: 'school' as const, tripDate: String(w.trip.trip_date), interrupted: false, at: new Date().toISOString(), reason: null };
    await events.emitAndWait('trip.status_changed', { ...status, status: 'completed', previousStatus: 'in_progress' });
    await drainJobs();
    expect(await eventsOf(w.trip.id)).toEqual([]);
    await events.emitAndWait('trip.status_changed', { ...status, status: 'in_progress', previousStatus: 'scheduled' });
    await drainJobs();
    expect((await eventsOf(w.trip.id)).map((e) => e.event_type)).toEqual(['trip_started', 'trip_started', 'trip_started']);
  });

  it('left school and stop arrival queue their events', async () => {
    await events.emitAndWait('tracking.left_school', { ...base(), stopId: null, at: new Date().toISOString() });
    await events.emitAndWait('tracking.stop_arrived', { ...base(), stopId: w.stops[1]!.id, at: new Date().toISOString(), distanceM: 20 });
    await drainJobs();
    const ev = await eventsOf(w.trip.id);
    expect(ev.filter((e) => e.event_type === 'bus_left_school')).toHaveLength(3);
    expect(ev.filter((e) => e.event_type === 'arrived_at_stop').map((e) => e.student_id)).toEqual([w.students.kabir.id]);
  });

  it('trip.not_started queues trip_not_started for a scheduled trip', async () => {
    await truncateAll({ keep: ['platform_settings'] });
    const s = await notifWorld({ tripStatus: 'scheduled' });
    await events.emitAndWait('trip.not_started', { schoolId: s.sid, tripId: s.trip.id, busId: s.bus.id, routeId: s.route.id, direction: 'morning', tripDate: String(s.trip.trip_date), plannedStartAt: new Date().toISOString(), busCode: 'R1' });
    await drainJobs();
    expect((await inboxOf(s.parents.pA.id)).map((x) => x.kind)).toEqual(['trip_not_started']);
  });

  it('ETA updates: approaching once per student, delayed only on good quality, repeats ignored', async () => {
    const send = (e: TripEta) => events.emitAndWait('tracking.eta_updated', { ...base(), eta: e });
    await send(eta([{ stopId: w.stops[0]!.id, inMin: 7, delayMin: 2 }, { stopId: w.stops[1]!.id, inMin: 12, delayMin: 25 }], 'degraded'));
    await drainJobs();
    expect(await eventsOf(w.trip.id)).toEqual([]);
    await send(eta([{ stopId: w.stops[0]!.id, inMin: 4, delayMin: 2 }, { stopId: w.stops[1]!.id, inMin: 9, delayMin: 12 }]));
    await drainJobs();
    let ev = await eventsOf(w.trip.id);
    expect(ev.filter((e) => e.event_type === 'approaching_stop').map((e) => e.student_id).sort()).toEqual([w.students.aarav.id, w.students.diya.id].sort());
    expect(ev.filter((e) => e.event_type === 'trip_delayed').map((e) => e.student_id)).toEqual([w.students.kabir.id]);
    expect((await inboxOf(w.parents.pA.id))[0]!.body).toBe("Bus R1 is about 4 minutes away from Aarav's stop.");
    const pushes = cap.push.sent.length;
    for (let i = 0; i < 3; i += 1) await send(eta([{ stopId: w.stops[0]!.id, inMin: 2, delayMin: 3 }, { stopId: w.stops[1]!.id, inMin: 4, delayMin: 15 }]));
    await drainJobs();
    ev = await eventsOf(w.trip.id);
    expect(ev.filter((e) => e.event_type === 'approaching_stop')).toHaveLength(3);
    expect(ev.filter((e) => e.event_type === 'trip_delayed')).toHaveLength(1);
    // Kabir's newly approaching stop: his parent has no phone (inbox only); Aarav's parents are not pushed again.
    expect(cap.push.sent.length).toBe(pushes);
    expect(cap.push.sent.filter((m) => m.tokens.includes('tok-a') && m.title.includes('almost'))).toHaveLength(1);
  });

  it('a settings change applies to the next ETA (threshold cache dropped)', async () => {
    await events.emitAndWait('tracking.eta_updated', { ...base(), eta: eta([{ stopId: w.stops[1]!.id, inMin: 8, delayMin: 0 }]) });
    await drainJobs();
    expect(await eventsOf(w.trip.id)).toEqual([]);
    await f.schoolSettings(w.sid, { approaching_stop_minutes: 10 });
    await events.emitAndWait('school.settings_changed', { schoolId: w.sid, changedFields: ['approachingStopMinutes'] });
    await events.emitAndWait('tracking.eta_updated', { ...base(), eta: eta([{ stopId: w.stops[1]!.id, inMin: 8, delayMin: 0 }]) });
    await drainJobs();
    expect((await eventsOf(w.trip.id)).map((e) => e.event_type)).toEqual(['approaching_stop']);
  });
});

describe('real location pipeline', () => {
  it('points through Stop 1 notify its parents (arrived) and the next stop parents (approaching)', async () => {
    const t = buildApp();
    const tw = await trackingWorld(t.app, { settings: { approaching_stop_minutes: 5 } });
    const sid = String(tw.school.id);
    const atStop1 = await f.student(sid, { full_name: 'Anaya Iyer' });
    const atStop2 = await f.student(sid, { full_name: 'Vihaan Das' });
    await f.studentAssignment(sid, { studentId: atStop1.id, busId: tw.bus.id, routeId: tw.route.id, stopId: tw.stops[0]!.id });
    await f.studentAssignment(sid, { studentId: atStop2.id, busId: tw.bus.id, routeId: tw.route.id, stopId: tw.stops[1]!.id });
    const p1 = await f.parentAccount();
    const p2 = await f.parentAccount();
    await linkParent(sid, p1.id, [atStop1.id]);
    await linkParent(sid, p2.id, [atStop2.id]);
    const count = 14;
    const res = await postPoints(t.app, tw, northbound({ baseMs: Date.now() - count * 10_000, fromKm: -0.5, kmh: 30, count }));
    expect(res.status).toBe(200);
    // Tracking emits its events fire-and-forget from inside the persist job, so the dispatch jobs
    // they queue may start after the first drain: poll until the inbox entries exist.
    await vi.waitFor(
      async () => {
        await drainJobs();
        expect((await inboxOf(p1.id)).map((x) => x.kind)).toContain('arrived_at_stop');
        expect((await inboxOf(p2.id)).map((x) => x.kind)).toContain('approaching_stop');
      },
      { timeout: 10_000, interval: 100 },
    );
    expect((await inboxOf(p1.id)).find((x) => x.kind === 'arrived_at_stop')!.body).toBe("Bus R1 has reached Anaya's stop.");
    const b = await inboxOf(p2.id);
    expect(b.map((x) => x.kind)).toContain('approaching_stop');
  });
});
