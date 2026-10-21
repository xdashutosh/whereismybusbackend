// ETA v2 through the real pipeline (ingest → points-persist job → analytics → refreshEtaV2), with the
// feature enabled at all three levels (platform `features.eta_v2`, plan module `eta_v2`, school feature),
// a fake GOOGLE_MAPS_SERVER_KEY and the Google Routes API HTTP call stubbed (global fetch): a success
// switches the live ETA to source 'v2'; an HTTP 403 (Routes API not enabled) or a timeout leaves ETA v1 in
// force; Google is asked at most once per trip per ETA_V2_REFRESH_S (3 minutes), also after a failure.
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Before src/config is imported: a fake server key (setupEnv blanks the real one). Never reaches Google:
// every fetch below is stubbed.
vi.hoisted(() => {
  process.env.GOOGLE_MAPS_SERVER_KEY = 'fake-server-key-for-tests';
});

import config from '../src/config/index.js';
import { ETA_V2_REFRESH_S, etaV2Key, readEtaV2 } from '../src/modules/tracking/etaV2.js';
import { liveStore } from '../src/modules/tracking/liveState.js';
import { kv, kvKey } from '../src/shared/kv.js';
import { ROUTES_API_URL } from '../src/shared/routing.js';
import { buildApp, type TestApp } from './helpers/authApp.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import { auth, drainJobs, KM_LAT, ORIGIN, postPoints, trackingWorld, type TrackingWorld } from './helpers/trackingWorld.js';

const LEG_S = 120;
type Mode = 'ok' | 'forbidden' | 'timeout';

let t: TestApp;
let w: TrackingWorld;
let schoolId: string;
let mode: Mode = 'ok';
const routesCalls: { headers: Record<string, string>; body: { routingPreference: string; intermediates: unknown[] } }[] = [];
let lastMs = 0;
let km = 0.15; // between stop 1 (0 km) and stop 2 (1 km), on the route
let previousFeatures: unknown;

const claimKey = () => kvKey('eta-v2-claim', schoolId, w.trip.id);

/** Stubbed Routes API: answers per `mode`; any other URL fails the test. */
const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url !== ROUTES_API_URL) throw new Error(`unexpected fetch ${url}`);
  const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { routingPreference: string; intermediates: unknown[] };
  routesCalls.push({ headers: init?.headers as Record<string, string>, body });
  if (mode === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  if (mode === 'forbidden') return new Response(JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED' } }), { status: 403 });
  const legs = body.intermediates.length + 1;
  return new Response(
    JSON.stringify({
      routes: [{
        distanceMeters: legs * 1000,
        duration: `${legs * LEG_S}s`,
        polyline: { encodedPolyline: '_p~iF~ps|U_ulLnnqC' },
        legs: Array.from({ length: legs }, () => ({ distanceMeters: 1000, duration: `${LEG_S}s` })),
      }],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
};

/** One fresh live point a little further north (≥ 11 s after the previous one, never far ahead of now). */
async function sendPoint() {
  lastMs = Math.max(Date.now() - 1000, lastMs + 11_000);
  km += 0.05;
  const res = await postPoints(t.app, w, [{ t: new Date(lastMs).toISOString(), lat: ORIGIN.lat + km * KM_LAT, lng: ORIGIN.lng, spd: 30, hdg: 0, acc: 8, bat: 80, net: '4g', mv: true }]);
  expect(res.status).toBe(200);
  expect(res.body.data.accepted).toBe(1);
  await drainJobs();
  return (await liveStore.get(schoolId, w.trip.id))!;
}

async function setPlatformEtaV2(on: boolean) {
  await ownerQuery("update platform_settings set value = jsonb_set(value, '{eta_v2}', to_jsonb($1::boolean)) where key = 'features'", [on]);
}

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  w = await trackingWorld(t.app, { settings: { features: { eta_v2: true, route_deviation: true, speeding: true, reports: true, announcements: true } } });
  schoolId = String(w.school.id);
  previousFeatures = (await ownerQuery<{ value: unknown }>("select value from platform_settings where key = 'features'")).rows[0]!.value;
  await setPlatformEtaV2(true);
  await ownerQuery("update school_subscriptions set modules = modules || '{\"eta_v2\": true}'::jsonb where school_id = $1", [schoolId]);
  vi.spyOn(globalThis, 'fetch').mockImplementation(fakeFetch);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await ownerQuery("update platform_settings set value = $1::jsonb where key = 'features'", [JSON.stringify(previousFeatures)]);
  await drainJobs();
  await closeDb();
});

beforeEach(() => {
  routesCalls.length = 0;
});

describe('ETA v2 end to end (stubbed Routes API)', () => {
  it('runs with the fake server key and the feature on at platform, plan and school level', async () => {
    expect(config.google.mapsServerKey).toBe('fake-server-key-for-tests');
    const res = await request(t.app).get('/api/v1/school/settings').set(auth(w.admin.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.data.effective.features.etaV2).toBe(true);
  });

  it('a Google answer switches the live ETA to source v2 on the next batch; one call per trip per 3 minutes', async () => {
    mode = 'ok';
    const first = await sendPoint();
    expect(first.eta).not.toBeNull();
    expect([first.eta!.quality, first.eta!.reason]).not.toContain('unavailable');
    expect(first.eta!.source).toBeUndefined(); // v1 until a snapshot exists
    expect(routesCalls).toHaveLength(1);
    const call = routesCalls[0]!;
    expect(call.headers['X-Goog-Api-Key']).toBe('fake-server-key-for-tests');
    expect(call.body.routingPreference).toBe('TRAFFIC_AWARE');
    const upcoming = first.eta!.stops.map((s) => s.stopId);
    expect(upcoming).toEqual(w.stops.slice(1).map((s) => s.id)); // stops 2–4 ahead
    expect(call.body.intermediates).toHaveLength(upcoming.length); // origin → upcoming stops → school
    const snap = await readEtaV2(schoolId, w.trip.id);
    expect(snap!.stops).toEqual(upcoming.map((stopId, i) => ({ stopId, driveS: (i + 1) * LEG_S })));
    expect(snap!.destinationDriveS).toBe((upcoming.length + 1) * LEG_S);
    const claimTtl = await kv.ttlMs(claimKey());
    expect(claimTtl).toBeGreaterThan((ETA_V2_REFRESH_S - 10) * 1000);
    expect(claimTtl).toBeLessThanOrEqual(ETA_V2_REFRESH_S * 1000);

    const second = await sendPoint();
    expect(second.eta!.source).toBe('v2');
    expect(second.eta!.stops.map((s) => s.stopId)).toEqual(upcoming);
    expect(Date.parse(second.eta!.stops[0]!.etaAt)).toBeGreaterThanOrEqual(snap!.originMs + LEG_S * 1000 - 1000);
    // Within the refresh interval: no further Google call, however many batches arrive.
    await sendPoint();
    await sendPoint();
    expect(routesCalls).toHaveLength(1);
  });

  it('the next interval asks Google again (claim expired)', async () => {
    await kv.del(claimKey());
    const state = await sendPoint();
    expect(routesCalls).toHaveLength(1);
    expect(state.eta!.source).toBe('v2');
  });

  it('HTTP 403 (Routes API not enabled) leaves ETA v1 in force and is retried only after the interval', async () => {
    mode = 'forbidden';
    await kv.del(claimKey(), etaV2Key(schoolId, w.trip.id));
    const a = await sendPoint();
    expect(routesCalls).toHaveLength(1);
    expect(await readEtaV2(schoolId, w.trip.id)).toBeNull();
    expect(await kv.ttlMs(claimKey())).toBeGreaterThan(0); // the claim spaces out the retries
    const b = await sendPoint();
    expect(routesCalls).toHaveLength(1);
    for (const s of [a, b]) {
      expect(s.eta!.quality).not.toBe('unavailable');
      expect(s.eta!.source).toBeUndefined();
    }
  });

  it('a timeout leaves ETA v1 in force and is retried only after the interval', async () => {
    mode = 'timeout';
    await kv.del(claimKey(), etaV2Key(schoolId, w.trip.id));
    const a = await sendPoint();
    const b = await sendPoint();
    expect(routesCalls).toHaveLength(1);
    expect(await readEtaV2(schoolId, w.trip.id)).toBeNull();
    expect(a.eta!.source).toBeUndefined();
    expect(b.eta!.source).toBeUndefined();
  });

  it('switched off at platform level: Google is never asked and ETA stays v1', async () => {
    mode = 'ok';
    await setPlatformEtaV2(false);
    try {
      await kv.del(claimKey(), etaV2Key(schoolId, w.trip.id));
      const a = await sendPoint();
      const b = await sendPoint();
      expect(routesCalls).toHaveLength(0);
      expect(a.eta!.source).toBeUndefined();
      expect(b.eta!.source).toBeUndefined();
    } finally {
      await setPlatformEtaV2(true);
    }
  });
});
