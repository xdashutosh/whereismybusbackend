// BP §14.3 anti-tamper — device-time vs server-time drift, server half (coverage finding, moved from
// tests-pre/coverage). Freshness is judged on the server clock (arrival time of the newest fix), and a
// batch from a phone whose clock is minutes slow is put on the server clock instead of being dropped as
// "outside the trip". Pure (no HTTP/DB writes); globalSetup still prepares the private test DB. The
// HTTP side (sentAt, stored offset, rejection, alerts, device events) is in tests/tracking.clockDrift.test.ts.
import { describe, expect, it } from 'vitest';
import type { TrackingConfig } from '../../src/modules/tracking/config.js';
import { START_TOLERANCE_MS } from '../../src/modules/tracking/ingest.js';
import { newLiveState, toPublicLive } from '../../src/modules/tracking/liveState.js';
import { classifyBatch } from '../../src/modules/tracking/motion.js';

const KM = 1 / 111.195;
const LAT0 = 12.9;
const LNG = 77.6;
const at = (m: number) => ({ lat: LAT0 + (m / 1000) * KM, lng: LNG });
const T0 = Date.parse('2026-10-19T08:30:00.000Z');

const cfg: TrackingConfig = {
  movingIntervalS: 10, stoppedIntervalS: 90, movingSpeedKmh: 4, stoppedAfterS: 60, speedLimitKmh: null, speedingEnabled: false,
  routeDeviationEnabled: false, routeDeviationM: 300, stopDurationAlertMin: 10, tripDelayThresholdMin: 10, tripNotStartedGraceMin: 10,
  approachingStopMinutes: 5, etaV2Enabled: false,
};

describe('BP §14.3 anti-tamper — device-time vs server-time drift', () => {
  it('keeps a moving bus live when the driver phone clock runs 3 minutes slow', () => {
    const now = T0;
    const s = newLiveState({ schoolId: 'school-A', tripId: 'trip-1', busId: 'bus-1', routeId: 'route-1', direction: 'morning', tripStatus: 'in_progress', lastPointAt: null });
    const deviceT = now - 3 * 60_000; // point recorded "now" on a phone 3 min behind
    s.point = { t: new Date(deviceT).toISOString(), ...at(0), spd: 30, hdg: 0, acc: 8, bat: 80, net: '4g', mv: true };
    s.receivedAtMs = now; // arrived this instant
    s.motion = 'moving';
    const live = toPublicLive(s, cfg, now);
    expect(live.freshness).toBe('live');
    expect(live.ageS).toBe(0);
    // …and it goes stale on the server clock once nothing arrives for 3× the interval.
    expect(toPublicLive(s, cfg, now + 31_000).freshness).toBe('stale');
  });

  it('accepts live points from a phone whose clock runs 15 minutes slow', () => {
    const startedMs = T0; // server time of trips/start
    const now = T0 + 60_000;
    const points = [0, 10, 20].map((sec) => ({ t: new Date(now - 15 * 60_000 + sec * 1000).toISOString(), lat: LAT0, lng: LNG, spd: 30, hdg: 0, acc: 8, bat: 80, net: '4g', mv: true }));
    const batch = classifyBatch(points, { lastLiveAtMs: null, lastReceivedAtMs: null, nowMs: now, windowStartMs: startedMs - START_TOLERANCE_MS, windowEndMs: null });
    expect({ live: batch.live.length, outsideTrip: batch.dropped.outsideTrip }).toEqual({ live: 3, outsideTrip: 0 });
    // Rebased onto the server clock: the newest fix is "now", spacing kept.
    expect(batch.live.map((p) => p.ms)).toEqual([now - 20_000, now - 10_000, now]);
    expect(batch.clock).toMatchObject({ action: 'corrected', source: 'inferred', offsetMs: 15 * 60_000 - 20_000 });
  });
});
