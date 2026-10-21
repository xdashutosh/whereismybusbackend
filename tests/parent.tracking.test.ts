// Parent module — GET /parent/children/:studentId/tracking (BP §8.5, §9.3, §9.4, §9.5, §15.2 Track Bus):
// status per BP §9.4 for the child's own stop, newest received position + "Last updated", ETA to the
// child's stop and the next stop, planned polyline and markers; only with a CURRENT assignment to the
// bus + direction; a reassignment moves access at once; a stale fix flips to "Location unavailable".
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ParentTrackingSnapshot } from '@wimb/shared';
import { liveStore } from '../src/modules/tracking/liveState.js';
import { buildApp, loginParent, type TestApp } from './helpers/authApp.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { drainJobs, northbound, postPoints, stopLat, ORIGIN, trackingWorld, type TrackingWorld } from './helpers/trackingWorld.js';
import { asParent, linkChild, localDate, reassign, unassign, type LinkedChild } from './parent.fixtures.js';

let t: TestApp;
let w: TrackingWorld;
let parentId: string;
let token: string;
let child: LinkedChild;
let bus2: f.TenantRow;
let route2: f.TenantRow;
let route2Stop: f.TenantRow;
let trip2: f.TenantRow;
let pmTrip: f.TenantRow;

const snap = async (studentId: string, query = ''): Promise<{ status: number; body: { data: ParentTrackingSnapshot; error?: { code: string; details?: { reason?: string } } } }> => {
  const res = await asParent(t, token, w.school.id).get(`/parent/children/${studentId}/tracking${query}`);
  return { status: res.status, body: res.body };
};

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  w = await trackingWorld(t.app, { startedMinAgo: 30 });
  const today = await localDate();
  await ownerQuery(`update trips set trip_date = $2::date, planned_start_at = now() - interval '35 minutes' where id = $1`, [w.trip.id, today]);
  // No timetable on the morning route: the status never depends on the wall-clock time of the run.
  await ownerQuery('update stops set expected_time = null where route_id = $1', [w.route.id]);
  const parent = await f.parentAccount({ display_name: 'Lakshmi Rao' });
  parentId = parent.id;
  child = await linkChild(w.school.id, parent.id, { busId: w.bus.id, routeId: w.route.id, stopId: w.stops[2]!.id }, { fullName: 'Rohan Rao' });
  // Afternoon: same bus, its own route, trip planned later today.
  const pmRoute = await f.route(w.school.id, { code: 'R1PM', name: 'Route 1 PM', direction: 'afternoon' });
  const pmStop = await f.stop(w.school.id, pmRoute.id, { name: 'Gate 2', sequence: 1, latitude: stopLat(1), longitude: ORIGIN.lng, expected_time: '23:59:00' });
  await f.studentAssignment(w.school.id, { studentId: child.student.id, busId: w.bus.id, routeId: pmRoute.id, stopId: pmStop.id, direction: 'afternoon' }, { valid_from: today });
  pmTrip = await f.trip(w.school.id, w.bus.id, { route_id: pmRoute.id, direction: 'afternoon', trip_date: today, status: 'scheduled', planned_start_at: new Date(Date.now() + 4 * 3600_000).toISOString() });
  // A second bus/route with a running trip (reassignment target).
  bus2 = await f.bus(w.school.id, { code: 'R2' });
  route2 = await f.route(w.school.id, { code: 'R2', name: 'Route 2', direction: 'morning' });
  route2Stop = await f.stop(w.school.id, route2.id, { name: 'Lake View', sequence: 1, latitude: 12.95, longitude: 77.65, expected_time: '07:40:00' });
  trip2 = await f.activeTrip(w.school.id, bus2.id, { route_id: route2.id, trip_date: today, planned_start_at: new Date(Date.now() - 1800_000).toISOString() });
  token = (await loginParent(t, String(parent.phone))).accessToken;
});

afterAll(async () => {
  await drainJobs();
  await closeDb();
});

describe('tracking snapshot', () => {
  it('shows "Location unavailable" for a running trip before the first point, with the planned route and markers', async () => {
    const { status, body } = await snap(child.student.id);
    expect(status).toBe(200);
    const d = body.data;
    expect(d).toMatchObject({
      studentId: child.student.id,
      firstName: 'Rohan',
      direction: 'morning',
      bus: { id: w.bus.id, code: 'R1' },
      route: { id: w.route.id, code: 'R1', name: 'Route 1' },
      stop: { id: w.stops[2]!.id, name: 'Stop 3', sequence: 3, arrivalRadiusM: 100 },
      trip: { id: w.trip.id, status: 'in_progress' },
      status: { status: 'location_unavailable', reason: 'NO_POSITION_YET' },
      position: null,
      freshness: 'none',
      lastUpdatedAt: null,
      room: `child:${child.student.id}:live`,
      pollAfterS: 10,
    });
    expect(d.school).toMatchObject({ id: w.school.id, name: 'Tracking Test School', lat: expect.any(Number), lng: expect.any(Number) });
    expect(d.planned.polylineSource).toBe('straight');
    expect(d.planned.polyline).toEqual(expect.any(String));
    expect(d.planned.stops.map((s) => s.name)).toEqual(['Stop 1', 'Stop 2', 'Stop 3', 'Stop 4']);
    expect(JSON.stringify(d)).not.toMatch(/"bat"|"net"|school_id/);
  });

  it('turns "On Route" with the newest fix, its time and the ETA to the child\'s stop once points arrive', async () => {
    const points = northbound({ baseMs: Date.now() - 25_000, fromKm: 0.5, count: 3 });
    expect((await postPoints(t.app, w, points)).status).toBe(200);
    await drainJobs();
    const { status, body } = await snap(child.student.id);
    expect(status).toBe(200);
    const d = body.data;
    const last = points.at(-1)!;
    expect(d.status.status).toBe('on_route');
    expect(d.position).toEqual({ lat: last.lat, lng: last.lng, hdg: 0, spd: 30, t: last.t });
    expect(d.lastUpdatedAt).toBe(last.t);
    expect(d.status.lastUpdatedAt).toBe(last.t);
    expect(d).toMatchObject({ freshness: 'live', motion: 'moving', pollAfterS: 10 });
    expect(d.eta).toMatchObject({ quality: 'good', childStop: { stopId: w.stops[2]!.id, sequence: 3 }, nextStop: { stopId: w.stops[1]!.id, sequence: 2 } });
    expect(d.eta!.childStop!.remainingM).toBeGreaterThan(d.eta!.nextStop!.remainingM);
    expect(d.status).toMatchObject({ etaAt: d.eta!.childStop!.etaAt, etaMinutes: expect.any(Number), plannedAt: null, stopPassed: false });
  });

  it('flips to "Location unavailable" when the newest fix is older than the staleness threshold (last fix kept)', async () => {
    const state = (await liveStore.get(w.school.id, w.trip.id))!;
    const oldT = new Date(Date.now() - 10 * 60_000).toISOString();
    // Freshness is judged by when the server last heard from the bus (BP §14.3): the fix arrived 10 min ago.
    state.point = { ...state.point!, t: oldT };
    state.receivedAtMs = Date.parse(oldT);
    await liveStore.put(state);
    const { body } = await snap(child.student.id);
    expect(body.data.status).toMatchObject({ status: 'location_unavailable', reason: 'STALE_POSITION', etaAt: null });
    expect(body.data.freshness).toBe('stale');
    expect(body.data.position?.t).toBe(oldT);
    expect(body.data.lastUpdatedAt).toBe(oldT);
  });

  it('serves the requested direction (afternoon trip not started yet → "Not Started", 60-s polling)', async () => {
    const { status, body } = await snap(child.student.id, '?direction=afternoon');
    expect(status).toBe(200);
    expect(body.data).toMatchObject({ direction: 'afternoon', trip: { id: pmTrip.id, status: 'scheduled' }, status: { status: 'not_started' }, position: null, pollAfterS: 60 });
    expect(body.data.stop.name).toBe('Gate 2');
    expect((await snap(child.student.id, '?direction=evening')).status).toBe(400);
  });

  it('reports "Delayed" when the trip has not started past the grace period', async () => {
    await ownerQuery(`update trips set planned_start_at = now() - interval '30 minutes' where id = $1`, [pmTrip.id]);
    try {
      const { body } = await snap(child.student.id, '?direction=afternoon');
      expect(body.data.status).toMatchObject({ status: 'delayed', reason: 'NOT_STARTED_PAST_GRACE' });
      expect(body.data.status.delayMin).toBeGreaterThanOrEqual(29);
    } finally {
      await ownerQuery(`update trips set planned_start_at = now() + interval '4 hours' where id = $1`, [pmTrip.id]);
    }
  });

  it('answers 404 NO_ASSIGNMENT for a direction the child is not assigned to', async () => {
    const only = await linkChild(w.school.id, parentId, { busId: w.bus.id, routeId: w.route.id, stopId: w.stops[0]!.id }, { fullName: 'Anika Rao' });
    const res = await snap(only.student.id, '?direction=afternoon');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'NOT_FOUND', details: { reason: 'NO_ASSIGNMENT' } });
    expect((await snap(only.student.id)).status).toBe(200);
  });

  it('reports "Completed" once the trip ended and never shows its last position', async () => {
    await ownerQuery(`update trips set status = 'completed', ended_at = now(), closed_at = now() where id = $1`, [w.trip.id]);
    try {
      const { body } = await snap(child.student.id, '?direction=morning');
      expect(body.data).toMatchObject({ trip: { status: 'completed' }, status: { status: 'completed' }, position: null, pollAfterS: 60 });
    } finally {
      await ownerQuery(`update trips set status = 'in_progress', ended_at = null, closed_at = null where id = $1`, [w.trip.id]);
    }
  });
});

describe('assignment changes move access immediately', () => {
  it('follows the child to the new bus at once (tracking, bus and staff)', async () => {
    await reassign(w.school.id, child.student.id, { busId: bus2.id, routeId: route2.id, stopId: route2Stop.id });
    const { status, body } = await snap(child.student.id, '?direction=morning');
    expect(status).toBe(200);
    expect(body.data).toMatchObject({ bus: { id: bus2.id, code: 'R2' }, route: { id: route2.id }, stop: { id: route2Stop.id }, trip: { id: trip2.id, status: 'in_progress' } });
    expect(JSON.stringify(body.data)).not.toContain(w.trip.id);
    const bus = await asParent(t, token, w.school.id).get(`/parent/children/${child.student.id}/bus?direction=morning`);
    expect(bus.body.data.bus.id).toBe(bus2.id);
    const staff = await asParent(t, token, w.school.id).get(`/parent/children/${child.student.id}/staff?direction=morning`);
    expect(staff.body.data.buses.map((b: { busId: string }) => b.busId)).toEqual([bus2.id]);
  });

  it('answers 404 NO_ASSIGNMENT everywhere once every assignment ended (the child stays listed)', async () => {
    await unassign(child.student.id);
    for (const p of ['tracking', 'bus', 'staff']) {
      const res = await asParent(t, token, w.school.id).get(`/parent/children/${child.student.id}/${p}`);
      expect(res.status, p).toBe(404);
      expect(res.body.error.details).toMatchObject({ reason: 'NO_ASSIGNMENT' });
    }
    const list = await asParent(t, token).get('/parent/children');
    const card = list.body.data.schools[0].children.find((c: { studentId: string }) => c.studentId === child.student.id);
    expect(card.directions).toEqual([]);
    // Preferences stay available for a linked child without a bus.
    expect((await asParent(t, token, w.school.id).get(`/parent/children/${child.student.id}/notification-preferences`)).status).toBe(200);
  });
});
