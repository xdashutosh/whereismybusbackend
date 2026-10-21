// BP §14.3 anti-tamper — device-time vs server-time drift, server half (src/modules/tracking/clock.ts):
// the ingestion puts point timestamps on the server clock (batch sentAt, else a stored or inferred
// offset), rejects batches beyond the maximum correction, raises one clock_drift alert per trip and
// answers with serverTime / clockDrift / clockOffsetMs; device events get their occurredAt corrected
// the same way (trip timeline); every driver action answer carries serverTime.
import { CLOCK_DRIFT_MAX_CORRECTION_MS, CLOCK_DRIFT_TOLERANCE_MS, HEADERS, type TripDetail } from '@wimb/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clockAction, resolveClockOffset } from '../src/modules/tracking/clock.js';
import { liveStore, toPublicLive } from '../src/modules/tracking/liveState.js';
import { lateFinalize } from '../src/modules/tracking/persist.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import { buildApp, DEVICE, type TestApp } from './helpers/authApp.js';
import { auth, drainJobs, northbound, postPoints, storedPoints, trackingWorld, type TrackingWorld } from './helpers/trackingWorld.js';

let t: TestApp;

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  lateFinalize.delayMs = 0;
  t = buildApp();
});
afterAll(async () => {
  await drainJobs();
  await closeDb();
});

const MIN = 60_000;
const driftAlerts = async (tripId: string) =>
  (await ownerQuery<{ severity: string; status: string; title: string; details: Record<string, unknown> }>(
    "select severity, status, title, details from alerts where trip_id = $1 and alert_type = 'clock_drift' order by created_at",
    [tripId],
  )).rows;
const postEvents = (w: TrackingWorld, body: object) =>
  request(t.app).post(`/api/v1/driver/trips/${w.trip.id}/events`).set(auth(w.driver.accessToken)).set(HEADERS.DEVICE_ID, DEVICE.deviceId).send(body);
const cfg = { movingIntervalS: 10, stoppedIntervalS: 90 };

describe('clock offset rules (pure)', () => {
  const now = Date.parse('2026-10-19T08:30:00.000Z');
  const window = { nowMs: now, windowStartMs: now - 70 * MIN };

  it('ignores offsets within the tolerance, corrects larger ones, rejects beyond the maximum', () => {
    expect(clockAction(null)).toBe('none');
    expect(clockAction(CLOCK_DRIFT_TOLERANCE_MS)).toBe('none');
    expect(clockAction(-CLOCK_DRIFT_TOLERANCE_MS - 1)).toBe('corrected');
    expect(clockAction(CLOCK_DRIFT_MAX_CORRECTION_MS)).toBe('corrected');
    expect(clockAction(CLOCK_DRIFT_MAX_CORRECTION_MS + 1)).toBe('rejected');
  });

  it('prefers sentAt; a fresh newest point means the clock is right (a stored offset is dropped)', () => {
    expect(resolveClockOffset([now - 5 * MIN], { ...window, sentAtMs: now - 5 * MIN })).toEqual({ offsetMs: 5 * MIN, source: 'sent_at', action: 'corrected' });
    expect(resolveClockOffset([now - 20_000], { ...window, sentAtMs: now - 20_000 })).toEqual({ offsetMs: null, source: 'sent_at', action: 'none' });
    expect(resolveClockOffset([now - 5_000], { ...window, storedOffsetMs: 15 * MIN })).toMatchObject({ action: 'none' });
    expect(resolveClockOffset([now - 15 * MIN], { ...window, storedOffsetMs: 15 * MIN })).toEqual({ offsetMs: 15 * MIN, source: 'stored', action: 'corrected' });
    // A phone 10 min fast: every point in the future → inferred (negative offset).
    expect(resolveClockOffset([now + 10 * MIN, now + 10 * MIN + 10_000], window)).toEqual({ offsetMs: -(10 * MIN + 10_000), source: 'inferred', action: 'corrected' });
    // Mixed batches are not inferred (individual points are dropped instead); nor are ended trips.
    expect(resolveClockOffset([now + 10 * MIN, now - 80 * MIN], window).action).toBe('none');
    expect(resolveClockOffset([now - 90 * MIN], { ...window, infer: false }).action).toBe('none');
  });
});

describe('POST /driver/trips/:id/locations with a wrong phone clock', () => {
  it('corrects points by the sentAt offset, keeps the offset for the trip and raises one clock_drift alert', async () => {
    const w = await trackingWorld(t.app);
    const now = Date.now();
    const slow = 5 * MIN;
    const res = await postPoints(t.app, w, northbound({ baseMs: now - slow - 20_000, count: 3 }), { body: { sentAt: new Date(now - slow).toISOString() } });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ accepted: 3, dropped: 0, backfilled: 0, clockDrift: 'corrected' });
    expect(Math.abs(res.body.data.clockOffsetMs - slow)).toBeLessThan(5_000);
    expect(Date.parse(res.body.data.serverTime)).toBeGreaterThanOrEqual(now);
    await drainJobs();
    const stored = await storedPoints(w.trip.id);
    expect(stored).toHaveLength(3);
    // Stored on the server clock: the newest point is ~now, not 5 min ago, and not flagged backfilled.
    expect(Math.abs(Date.parse(stored.at(-1)!.recorded_at) - now)).toBeLessThan(5_000);
    expect(stored.every((p) => !p.is_backfilled)).toBe(true);

    const state = (await liveStore.get(String(w.school.id), w.trip.id))!;
    expect(Math.abs(state.clockOffsetMs! - slow)).toBeLessThan(5_000);
    const live = toPublicLive(state, cfg);
    expect(live).toMatchObject({ freshness: 'live', locationUnavailable: false });

    const alerts = await driftAlerts(w.trip.id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: 'warning', status: 'open', details: { action: 'corrected', source: 'sent_at', via: 'locations' } });
    expect(alerts[0]!.title).toContain('5 min behind');

    // The next batch is corrected again, without a second alert.
    const next = await postPoints(t.app, w, northbound({ baseMs: Date.now() - slow + 10_000, fromKm: 1, count: 1 }), { body: { sentAt: new Date(Date.now() - slow).toISOString() } });
    expect(next.body.data).toMatchObject({ accepted: 1, clockDrift: 'corrected' });
    expect(await driftAlerts(w.trip.id)).toHaveLength(1);
  });

  it('leaves timestamps alone within the tolerance (no alert)', async () => {
    const w = await trackingWorld(t.app);
    const now = Date.now();
    const res = await postPoints(t.app, w, northbound({ baseMs: now - 30_000, count: 2 }), { body: { sent_at: new Date(now - 20_000).toISOString() } });
    expect(res.body.data).toMatchObject({ accepted: 2, clockDrift: 'none', clockOffsetMs: null });
    await drainJobs();
    expect(Date.parse((await storedPoints(w.trip.id)).at(-1)!.recorded_at)).toBe(now - 20_000);
    expect(await driftAlerts(w.trip.id)).toEqual([]);
  });

  it('old app without sentAt: infers the offset of a just-started trip, reuses it, and drops it once the clock is fixed', async () => {
    const w = await trackingWorld(t.app, { startedMinAgo: 1 });
    const slow = 15 * MIN;
    const first = await postPoints(t.app, w, northbound({ baseMs: Date.now() - slow - 20_000, count: 3 }));
    expect(first.body.data).toMatchObject({ accepted: 3, dropped: 0, clockDrift: 'corrected' });
    expect(first.body.data.clockOffsetMs).toBeGreaterThan(slow - 5_000);
    // Still 15 min slow: the stored offset keeps these points live (not backfill behind the corrected ones).
    const second = await postPoints(t.app, w, northbound({ baseMs: Date.now() - slow + 15_000, fromKm: 1, count: 1 }));
    expect(second.body.data).toMatchObject({ accepted: 1, backfilled: 0, clockDrift: 'corrected' });
    expect((await driftAlerts(w.trip.id))[0]).toMatchObject({ details: { source: 'inferred' } });
    // The driver switched on automatic time: correct timestamps are taken as sent and the offset is dropped.
    const fixed = await postPoints(t.app, w, northbound({ baseMs: Date.now() + 25_000, fromKm: 2, count: 1 }));
    expect(fixed.body.data).toMatchObject({ accepted: 1, clockDrift: 'none' });
    expect((await liveStore.get(String(w.school.id), w.trip.id))!.clockOffsetMs).toBeNull();
  });

  it('rejects a batch whose clock is off by more than the maximum correction (critical alert)', async () => {
    const w = await trackingWorld(t.app);
    const twoDays = 2 * 24 * 3600_000;
    const res = await postPoints(t.app, w, northbound({ baseMs: Date.now() - twoDays, count: 3 }), { body: { sentAt: new Date(Date.now() - twoDays).toISOString() } });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ accepted: 0, dropped: 3, clockDrift: 'rejected' });
    await drainJobs();
    expect(await storedPoints(w.trip.id)).toEqual([]);
    expect(await driftAlerts(w.trip.id)).toEqual([expect.objectContaining({ severity: 'critical', details: expect.objectContaining({ action: 'rejected' }) })]);
  });

  it('refuses a malformed sentAt', async () => {
    const w = await trackingWorld(t.app);
    const res = await postPoints(t.app, w, northbound({ baseMs: Date.now(), count: 1 }), { body: { sentAt: 'yesterday' } });
    expect(res.status).toBe(400);
  });
});

describe('device events and driver answers on the server clock', () => {
  it('corrects occurredAt by the sentAt offset (timeline keeps the device time) and reports the offset', async () => {
    const w = await trackingWorld(t.app);
    const now = Date.now();
    const slow = 10 * MIN;
    const res = await postEvents(w, { sentAt: new Date(now - slow).toISOString(), events: [{ type: 'low_battery', occurredAt: new Date(now - slow - 30_000).toISOString(), batteryPct: 9 }] });
    expect(res.status).toBe(200);
    expect(Math.abs(res.body.data.clockOffsetMs - slow)).toBeLessThan(5_000);
    expect(Date.parse(res.body.data.serverTime)).toBeGreaterThanOrEqual(now);
    expect(res.body.data.alerts.map((a: { type: string }) => a.type).sort()).toEqual(['clock_drift', 'low_battery']);

    const detail = (await request(t.app).get(`/api/v1/school/trips/${w.trip.id}`).set(auth(w.admin.accessToken))).body.data as TripDetail;
    const entry = detail.timeline.find((e) => e.event === 'low_battery')!;
    expect(Math.abs(Date.parse(entry.at) - (now - 30_000))).toBeLessThan(5_000);
    expect(entry.deviceOccurredAt).toBe(new Date(now - slow - 30_000).toISOString());
    expect(Math.abs(entry.clockOffsetMs! - slow)).toBeLessThan(5_000);
    expect(entry).toMatchObject({ kind: 'device_event', batteryPct: 9, alertId: expect.any(String) });
  });

  it('replaces a future occurredAt (no sentAt) with the receipt time; a clock_drift event raises the alert', async () => {
    const w = await trackingWorld(t.app);
    const before = Date.now();
    const res = await postEvents(w, {
      events: [
        { type: 'gps_disabled', occurredAt: new Date(before + 3 * 3600_000).toISOString() },
        { type: 'gps_disabled', occurredAt: new Date(before - 5_000).toISOString() },
      ],
    });
    expect(res.body.data.clockOffsetMs).toBeNull();
    const { rows } = await ownerQuery<{ occurred_at: string; details: Record<string, unknown> }>(
      'select occurred_at, details from trip_device_events where trip_id = $1 order by device_occurred_at desc',
      [w.trip.id],
    );
    expect(Date.parse(rows[0]!.occurred_at)).toBeLessThanOrEqual(Date.now());
    expect(rows[0]!.details).toMatchObject({ deviceTimeRejected: true });
    expect(rows[1]!.details.deviceTimeRejected).toBeUndefined();

    const drift = await postEvents(w, { events: [{ type: 'clock_drift', occurredAt: new Date().toISOString(), clockOffsetMs: 4 * MIN }] });
    expect(drift.body.data.alerts).toEqual([expect.objectContaining({ type: 'clock_drift', severity: 'warning' })]);
    expect((await driftAlerts(w.trip.id))[0]).toMatchObject({ details: { source: 'device_event', via: 'events', offsetMs: 4 * MIN } });
  });

  it('GET /driver/trips/active carries serverTime', async () => {
    const w = await trackingWorld(t.app);
    const res = await request(t.app).get('/api/v1/driver/trips/active').set(auth(w.driver.accessToken)).set(HEADERS.DEVICE_ID, DEVICE.deviceId);
    expect(res.status).toBe(200);
    expect(Math.abs(Date.parse(res.body.data.serverTime) - Date.now())).toBeLessThan(5_000);
    expect(res.body.data.trip).toMatchObject({ id: w.trip.id });
  });
});
