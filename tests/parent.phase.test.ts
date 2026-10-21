// Trip phase for parents (BP §10.4 breakdown, §9.4): every ParentTripStatus — tracking snapshot, child
// live events — and every /parent/children direction carries `phase` (no_trip, scheduled, running,
// interrupted, completed, cancelled, missed) with `phaseReason` (the driver's breakdown reason / the
// school's cancel reason, max 200 characters) and `interruptedAt`. The BP §9.4 status itself is
// unchanged (an interrupted trip stays "Bus Stopped", reason TRIP_INTERRUPTED).
import { HEADERS, type ChildLiveEvent, type ParentChildrenResponse, type ParentTrackingSnapshot } from '@wimb/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createChildRelay } from '../src/modules/parent/index.js';
import { PHASE_REASON_MAX, parentStatus, tripPhase } from '../src/modules/tracking/status.js';
import { createMemoryKv } from '../src/shared/kv.js';
import type { Realtime } from '../src/shared/realtime.js';
import { buildApp, DEVICE, loginParent, type TestApp } from './helpers/authApp.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { auth, drainJobs, trackingWorld, type TrackingWorld } from './helpers/trackingWorld.js';
import { asParent, linkChild, localDate, type LinkedChild } from './parent.fixtures.js';

let t: TestApp;
let w: TrackingWorld;
let token: string;
let child: LinkedChild;

const opts = { delayThresholdMin: 10, notStartedGraceMin: 10, nowMs: Date.parse('2026-10-19T03:00:00Z') };

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  w = await trackingWorld(t.app, { startedMinAgo: 20 });
  const today = await localDate();
  await ownerQuery(`update trips set trip_date = $2::date, planned_start_at = now() - interval '25 minutes' where id = $1`, [w.trip.id, today]);
  const parent = await f.parentAccount({ display_name: 'Lakshmi Rao' });
  child = await linkChild(w.school.id, parent.id, { busId: w.bus.id, routeId: w.route.id, stopId: w.stops[1]!.id }, { fullName: 'Rohan Rao' });
  token = (await loginParent(t, String(parent.phone))).accessToken;
});
afterAll(async () => {
  await drainJobs();
  await closeDb();
});

const snapshot = async (direction?: string): Promise<ParentTrackingSnapshot> =>
  (await asParent(t, token, w.school.id).get(`/parent/children/${child.student.id}/tracking${direction ? `?direction=${direction}` : ''}`)).body.data as ParentTrackingSnapshot;
const morningCard = async () => {
  const res = (await asParent(t, token).get('/parent/children')).body.data as ParentChildrenResponse;
  return res.schools[0]!.children[0]!.directions.find((d) => d.direction === 'morning')!;
};

describe('tripPhase (pure)', () => {
  it('maps every trip status to a phase, with the reason only for interrupted and cancelled trips', () => {
    expect(tripPhase({ status: 'scheduled', plannedStartAt: null })).toEqual({ phase: 'scheduled', phaseReason: null, interruptedAt: null });
    expect(tripPhase({ status: 'in_progress', plannedStartAt: null })).toEqual({ phase: 'running', phaseReason: null, interruptedAt: null });
    expect(tripPhase({ status: 'in_progress', plannedStartAt: null, interruptedAt: '2026-10-19T03:00:00.000Z', interruptionReason: '  Flat tyre ' })).toEqual({ phase: 'interrupted', phaseReason: 'Flat tyre', interruptedAt: '2026-10-19T03:00:00.000Z' });
    expect(tripPhase({ status: 'cancelled', plannedStartAt: null, cancelReason: 'Road closed' })).toMatchObject({ phase: 'cancelled', phaseReason: 'Road closed' });
    expect(tripPhase({ status: 'missed', plannedStartAt: null }).phase).toBe('missed');
    expect(tripPhase({ status: 'auto_closed', plannedStartAt: null, interruptedAt: '2026-10-19T03:00:00.000Z' })).toEqual({ phase: 'completed', phaseReason: null, interruptedAt: null });
    const long = tripPhase({ status: 'in_progress', plannedStartAt: null, interruptedAt: '2026-10-19T03:00:00.000Z', interruptionReason: 'x'.repeat(500) });
    expect(long.phaseReason).toHaveLength(PHASE_REASON_MAX);
    expect(long.phaseReason!.endsWith('…')).toBe(true);
  });

  it('is part of every parentStatus result', () => {
    const interrupted = parentStatus({ status: 'in_progress', plannedStartAt: null, interruptedAt: '2026-10-19T02:50:00.000Z', interruptionReason: 'Engine overheating' }, null, { stopId: 's1' }, opts);
    expect(interrupted).toMatchObject({ status: 'bus_stopped', reason: 'TRIP_INTERRUPTED', interrupted: true, phase: 'interrupted', phaseReason: 'Engine overheating', interruptedAt: '2026-10-19T02:50:00.000Z' });
    expect(parentStatus({ status: 'cancelled', plannedStartAt: null, cancelReason: 'Holiday' }, null, null, opts)).toMatchObject({ status: 'not_started', reason: 'TRIP_CANCELLED', phase: 'cancelled', phaseReason: 'Holiday' });
    expect(parentStatus({ status: 'scheduled', plannedStartAt: null }, null, null, opts)).toMatchObject({ phase: 'scheduled', phaseReason: null, interruptedAt: null });
  });
});

describe('parent payloads', () => {
  it('running → interrupted (driver reason) in the snapshot, the children list and the child live event', async () => {
    expect((await snapshot()).status).toMatchObject({ phase: 'running', phaseReason: null, interruptedAt: null });
    expect(await morningCard()).toMatchObject({ phase: 'running', phaseReason: null });

    const res = await request(t.app).post(`/api/v1/driver/trips/${w.trip.id}/interrupt`).set(auth(w.driver.accessToken)).set(HEADERS.DEVICE_ID, DEVICE.deviceId).send({ reason: 'Flat tyre near Silk Board' });
    expect(res.status).toBe(200);
    const s = await snapshot();
    expect(s.status).toMatchObject({ status: 'bus_stopped', reason: 'TRIP_INTERRUPTED', phase: 'interrupted', phaseReason: 'Flat tyre near Silk Board' });
    expect(Date.parse(s.status.interruptedAt!)).toBeGreaterThan(Date.now() - 60_000);
    expect(await morningCard()).toMatchObject({ phase: 'interrupted', phaseReason: 'Flat tyre near Silk Board', status: 'bus_stopped' });

    const sent: { room: string; payload: unknown }[] = [];
    const fake = { emit: async (room: string, _event: string, payload: unknown) => void sent.push({ room, payload }) } as unknown as Realtime;
    const relay = createChildRelay({ kv: createMemoryKv(), realtime: fake });
    expect(await relay.onTripStatus(w.school.id, { tripId: w.trip.id, status: 'in_progress', interrupted: true })).toBe(1);
    expect((sent[0]!.payload as ChildLiveEvent).status).toMatchObject({ phase: 'interrupted', phaseReason: 'Flat tyre near Silk Board' });
  });

  it('cancelled by the school → phase cancelled with the school reason; no trip in a direction → no_trip', async () => {
    const res = await request(t.app).post(`/api/v1/school/trips/${w.trip.id}/cancel`).set(auth(w.admin.accessToken)).send({ reason: 'Bus breakdown — replacement not available' });
    expect(res.status).toBe(200);
    expect((await snapshot()).status).toMatchObject({ phase: 'cancelled', phaseReason: 'Bus breakdown — replacement not available', reason: 'TRIP_CANCELLED' });
    expect(await morningCard()).toMatchObject({ phase: 'cancelled', phaseReason: 'Bus breakdown — replacement not available' });

    // Afternoon assignment without a trip today.
    const pm = await f.route(w.school.id, { code: 'R1PM', name: 'Route 1 PM', direction: 'afternoon' });
    const pmStop = await f.stop(w.school.id, pm.id, { name: 'Gate', sequence: 1, latitude: 12.91, longitude: 77.6 });
    await f.studentAssignment(w.school.id, { studentId: child.student.id, busId: w.bus.id, routeId: pm.id, stopId: pmStop.id, direction: 'afternoon' }, { valid_from: await localDate() });
    const afternoon = await snapshot('afternoon');
    expect(afternoon.trip).toBeNull();
    expect(afternoon.status).toMatchObject({ reason: 'NO_TRIP_TODAY', phase: 'no_trip', phaseReason: null, interruptedAt: null });
  });
});
