// Location permission device events (POST /driver/trips/:id/events): location_permission_denied raises
// a critical location_permission alert (not gps_disabled) and makes the running trip "Location
// unavailable" at once (live state, live:status, parent reason LOCATION_PERMISSION_DENIED; the gap
// detector deduplicates into the same alert); location_permission_restored auto-closes that alert and
// clears the flag; the next fix clears "Location unavailable". Every event lands in the trip timeline of
// GET /school/trips/:id next to the lifecycle (started, interrupted, ended / cancelled).
import { HEADERS, type TripDetail } from '@wimb/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectLocationGaps } from '../src/modules/tracking/gap.js';
import { onLocationPermission } from '../src/modules/tracking/lifecycle.js';
import { liveStore, toPublicLive } from '../src/modules/tracking/liveState.js';
import { lateFinalize } from '../src/modules/tracking/persist.js';
import { useRealtime } from '../src/modules/tracking/publish.js';
import { parentStatus } from '../src/modules/tracking/status.js';
import { buildTimeline } from '../src/modules/trips/timeline.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import { buildApp, DEVICE, type TestApp } from './helpers/authApp.js';
import { auth, drainJobs, northbound, postPoints, trackingWorld, type TrackingWorld } from './helpers/trackingWorld.js';

let t: TestApp;
const emitted: { room: string; event: string; payload: { change?: string; live?: { locationPermissionDenied?: boolean } } }[] = [];
let restore: () => void;

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  lateFinalize.delayMs = 0;
  t = buildApp();
  restore = useRealtime({
    emit: async (room: string, event: string, payload: unknown) => void emitted.push({ room, event, payload: payload as (typeof emitted)[number]['payload'] }),
    disconnectSessions: async () => undefined,
    revalidateActors: async () => undefined,
    disconnectSchool: async () => undefined,
  });
});
afterAll(async () => {
  restore();
  await drainJobs();
  await closeDb();
});

const cfg = { movingIntervalS: 10, stoppedIntervalS: 90 };
const postEvents = (w: TrackingWorld, events: object[]) =>
  request(t.app).post(`/api/v1/driver/trips/${w.trip.id}/events`).set(auth(w.driver.accessToken)).set(HEADERS.DEVICE_ID, DEVICE.deviceId).send({ events });
const alertsOf = async (tripId: string) =>
  (await ownerQuery<{ id: string; alert_type: string; severity: string; status: string; dedupe_key: string; review_note: string | null; details: Record<string, unknown> }>(
    'select id, alert_type, severity, status, dedupe_key, review_note, details from alerts where trip_id = $1 order by created_at, id',
    [tripId],
  )).rows;
/** The tracking listener runs on the event bus (next microtask + kv); wait until it applied. */
async function settle(check: () => Promise<boolean>) {
  for (let i = 0; i < 50; i += 1) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('condition not reached');
}

describe('location_permission_denied / _restored', () => {
  it('raises a critical location_permission alert and flags the live state; restored closes the alert', async () => {
    const w = await trackingWorld(t.app);
    const schoolId = String(w.school.id);
    expect((await postPoints(t.app, w, northbound({ baseMs: Date.now() - 1000, count: 1 }))).status).toBe(200);

    const denied = await postEvents(w, [{ type: 'location_permission_denied', occurredAt: new Date().toISOString(), permission: 'denied_forever', latitude: 12.9, longitude: 77.6 }]);
    expect(denied.status).toBe(200);
    expect(denied.body.data.alerts).toEqual([expect.objectContaining({ type: 'location_permission', severity: 'critical' })]);
    const [alert] = await alertsOf(w.trip.id);
    expect(alert).toMatchObject({ alert_type: 'location_permission', dedupe_key: `location_permission:${w.trip.id}`, status: 'open', details: { event: 'location_permission_denied', permission: 'denied_forever' } });

    // live:status to the trip room (parents) once the tracking listener applied the change.
    await settle(async () => emitted.some((e) => e.room === `trip:${w.trip.id}` && e.payload.change === 'location_unavailable' && e.payload.live?.locationPermissionDenied === true));
    const state = (await liveStore.get(schoolId, w.trip.id))!;
    expect(toPublicLive(state, cfg)).toMatchObject({ locationUnavailable: true, locationPermissionDenied: true, freshness: 'live' });
    // Parents see why: the BP §9.4 status turns "Location unavailable" with its own reason.
    const status = parentStatus({ status: 'in_progress', plannedStartAt: null }, toPublicLive(state, cfg), { stopId: String(w.stops[0]!.id) }, { delayThresholdMin: 10, notStartedGraceMin: 10 });
    expect(status).toMatchObject({ status: 'location_unavailable', reason: 'LOCATION_PERMISSION_DENIED', phase: 'running' });

    // The gap detector later deduplicates into the same alert instead of a gps_disabled one.
    await drainJobs();
    state.receivedAtMs = Date.now() - 10 * 60_000;
    await liveStore.put(state);
    await ownerQuery("update trips set last_point_at = now() - interval '10 minutes' where id = $1", [w.trip.id]);
    await detectLocationGaps(schoolId);
    expect((await alertsOf(w.trip.id)).map((a) => a.alert_type)).toEqual(['location_permission']);

    const restored = await postEvents(w, [{ type: 'location_permission_restored', occurredAt: new Date().toISOString(), permission: 'always' }]);
    expect(restored.status).toBe(200);
    expect(await alertsOf(w.trip.id)).toEqual([expect.objectContaining({ status: 'closed', review_note: expect.stringContaining('Location permission restored') })]);
    await settle(async () => (await liveStore.get(schoolId, w.trip.id))?.locationPermissionDeniedAtMs == null);
    expect((await liveStore.get(schoolId, w.trip.id))!.locationUnavailable).toBe(true); // until the next fix
    expect((await postPoints(t.app, w, northbound({ baseMs: Date.now() + 15_000, fromKm: 0.2, count: 1 }))).body.data.accepted).toBe(1);
    expect((await liveStore.get(schoolId, w.trip.id))!.locationUnavailable).toBe(false);
    const audit = await ownerQuery("select count(*)::int as n from audit_logs where entity_id = $1 and action = 'alert.auto_close'", [alert!.id]);
    expect(audit.rows[0]!.n).toBe(1);
  });

  it('applies a denied + restored pair queued offline in order (alert raised then closed, no flag left)', async () => {
    const w = await trackingWorld(t.app);
    const now = Date.now();
    const res = await postEvents(w, [
      { type: 'location_permission_restored', occurredAt: new Date(now - 60_000).toISOString() },
      { type: 'location_permission_denied', occurredAt: new Date(now - 120_000).toISOString() },
    ]);
    expect(res.status).toBe(200);
    expect(await alertsOf(w.trip.id)).toEqual([expect.objectContaining({ alert_type: 'location_permission', status: 'closed' })]);
    await new Promise((r) => setTimeout(r, 30));
    expect((await liveStore.get(String(w.school.id), w.trip.id))?.locationPermissionDeniedAtMs ?? null).toBeNull();
  });

  it('flags a running trip that has no fix yet (fresh live state)', async () => {
    const w = await trackingWorld(t.app);
    expect(await liveStore.get(String(w.school.id), w.trip.id)).toBeNull();
    expect((await postEvents(w, [{ type: 'location_permission_denied', occurredAt: new Date().toISOString(), permission: 'while_in_use' }])).status).toBe(200);
    await settle(async () => (await liveStore.get(String(w.school.id), w.trip.id))?.locationPermissionDeniedAtMs != null);
    const live = toPublicLive((await liveStore.get(String(w.school.id), w.trip.id))!, cfg);
    expect(live).toMatchObject({ freshness: 'none', locationUnavailable: true, locationPermissionDenied: true, busId: w.bus.id });
    expect(parentStatus({ status: 'in_progress', plannedStartAt: null }, live, null, { delayThresholdMin: 10, notStartedGraceMin: 10 }).reason).toBe('LOCATION_PERMISSION_DENIED');
  });

  it('ignores a stale denial for the live state (fixes arrived after it)', async () => {
    const w = await trackingWorld(t.app);
    await postPoints(t.app, w, northbound({ baseMs: Date.now() - 1000, count: 1 }));
    const changed = await onLocationPermission({ schoolId: String(w.school.id), tripId: w.trip.id, state: 'denied', at: new Date(Date.now() - 5 * 60_000).toISOString() });
    expect(changed).toBe(false);
    expect((await liveStore.get(String(w.school.id), w.trip.id))!.locationPermissionDeniedAtMs).toBeNull();
  });

  it('validates the permission field', async () => {
    const w = await trackingWorld(t.app);
    const res = await postEvents(w, [{ type: 'location_permission_denied', occurredAt: new Date().toISOString(), permission: 'sometimes' }]);
    expect(res.status).toBe(400);
  });
});

describe('trip timeline (GET /school/trips/:id)', () => {
  it('merges the lifecycle with the device events, oldest first', async () => {
    const w = await trackingWorld(t.app);
    const t0 = Date.now() - 3000;
    await postEvents(w, [
      { type: 'gps_disabled', occurredAt: new Date(t0).toISOString(), latitude: 12.91, longitude: 77.61 },
      { type: 'low_battery', occurredAt: new Date(t0 + 1000).toISOString(), batteryPct: 7 },
      { type: 'location_permission_denied', occurredAt: new Date(t0 + 2000).toISOString(), permission: 'denied' },
    ]);
    await request(t.app).post(`/api/v1/driver/trips/${w.trip.id}/interrupt`).set(auth(w.driver.accessToken)).set(HEADERS.DEVICE_ID, DEVICE.deviceId).send({ reason: 'Flat tyre near the depot' });
    const res = await request(t.app).get(`/api/v1/school/trips/${w.trip.id}`).set(auth(w.admin.accessToken));
    expect(res.status).toBe(200);
    const timeline = (res.body.data as TripDetail).timeline;
    expect(timeline.map((e) => e.event ?? e.kind)).toEqual(['trip_started', 'gps_disabled', 'low_battery', 'location_permission_denied', 'trip_interrupted']);
    expect(timeline[1]).toMatchObject({ kind: 'device_event', severity: 'warning', latitude: 12.91, longitude: 77.61, alertId: expect.any(String), clockOffsetMs: null });
    expect(timeline[2]).toMatchObject({ batteryPct: 7, title: 'Phone battery low' });
    expect(timeline[3]).toMatchObject({ severity: 'critical', permission: 'denied', title: expect.stringContaining('Location permission denied') });
    expect(timeline[4]).toMatchObject({ kind: 'trip_interrupted', note: 'Flat tyre near the depot', event: null });
    for (let i = 1; i < timeline.length; i += 1) expect(Date.parse(timeline[i]!.at)).toBeGreaterThanOrEqual(Date.parse(timeline[i - 1]!.at));
  });

  it('pure: ended / auto-closed / cancelled entries and lifecycle-first ordering on ties', () => {
    const at = '2026-10-19T03:00:00.000Z';
    const base = { started_at: at, interrupted_at: null, close_reason: null, closed_at: null, cancel_reason: null, updated_at: '2026-10-19T04:00:00.000Z' };
    const device = { event_type: 'no_network' as const, occurred_at: at, device_occurred_at: at, received_at: at, clock_offset_ms: '120000', latitude: null, longitude: null, details: { networkType: 'none' }, alert_id: null };
    const ended = buildTimeline({ ...base, status: 'completed', ended_at: '2026-10-19T03:40:00.000Z' }, [device]);
    expect(ended.map((e) => e.kind)).toEqual(['trip_started', 'device_event', 'trip_ended']);
    expect(ended[1]!.clockOffsetMs).toBe(120000);
    const auto = buildTimeline({ ...base, status: 'auto_closed', ended_at: '2026-10-19T03:20:00.000Z', closed_at: '2026-10-19T06:20:00.000Z', close_reason: 'stale' }, []);
    expect(auto.at(-1)).toMatchObject({ kind: 'trip_auto_closed', at: '2026-10-19T06:20:00.000Z', note: 'stale' });
    const cancelled = buildTimeline({ ...base, status: 'cancelled', started_at: null, ended_at: null, cancel_reason: 'School holiday' }, []);
    expect(cancelled).toEqual([expect.objectContaining({ kind: 'trip_cancelled', at: base.updated_at, note: 'School holiday' })]);
  });
});
