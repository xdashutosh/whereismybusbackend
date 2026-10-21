// Wave-2 integration regressions of tracking ingest (edge cases around the fixes of the adversarial
// review): exact `accepted` counts for replayed backfill, the 10-s floor for a device whose clock runs
// consistently ahead, trips.last_point_at never moving into the future, and parent-safe trip-room payloads.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyBatch, LIVE_AHEAD_MS } from '../src/modules/tracking/motion.js';
import { lateFinalize } from '../src/modules/tracking/persist.js';
import { useRealtime } from '../src/modules/tracking/publish.js';
import { buildApp, DEVICE, type TestApp } from './helpers/authApp.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import { drainJobs, northbound, postPoints, storedPoints, trackingWorld, type TrackingWorld } from './helpers/trackingWorld.js';

let t: TestApp;
let seq = 0;

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  lateFinalize.delayMs = 0;
});
afterAll(async () => {
  await drainJobs();
  await closeDb();
});

async function world(): Promise<TrackingWorld & { uid: string }> {
  seq += 1;
  const uid = `reg-device-${seq}`;
  return Object.assign(await trackingWorld(t.app, { device: { ...DEVICE, deviceId: uid } }), { uid });
}
const post = (w: TrackingWorld & { uid: string }, points: ReturnType<typeof northbound>) => postPoints(t.app, w, points, { deviceUid: w.uid });

describe('backfill replays', () => {
  it('a replayed or shifted offline queue that is already stored reports accepted = 0', async () => {
    const w = await world();
    const now = Date.now();
    expect((await post(w, northbound({ baseMs: now - 2000, count: 1 }))).body.data.accepted).toBe(1);
    const queue = northbound({ baseMs: now - 20 * 60_000, count: 20, stepS: 15 });
    const first = await post(w, queue);
    expect(first.body.data).toMatchObject({ accepted: 20, backfilled: 20 });
    await drainJobs();
    const replay = await post(w, queue);
    expect(replay.body.data).toMatchObject({ accepted: 0, backfilled: 0, dropped: 20 });
    const shifted = await post(w, northbound({ baseMs: now - 20 * 60_000 + 3000, count: 20, stepS: 15 }));
    expect(shifted.body.data).toMatchObject({ accepted: 0, dropped: 20 });
    await drainJobs();
    expect(await storedPoints(w.trip.id)).toHaveLength(21);
  });
});

describe('device clock ahead of the server', () => {
  it('pure rule: a consistently forward-skewed device keeps the 10-s floor; a single bogus point is superseded', () => {
    const now = 1_800_000_000_000;
    const skew = 60_000;
    const window = { nowMs: now, windowStartMs: now - 3600_000, windowEndMs: null };
    const pt = (ms: number) => ({ t: new Date(ms).toISOString(), lat: 12.9, lng: 77.6 });
    // Previous live point recorded at now+60 s, received at `now` (forward-dated reference).
    const flood = classifyBatch([pt(now + skew + 1000), pt(now + skew + 2000)], { ...window, lastLiveAtMs: now + skew, lastReceivedAtMs: now });
    expect(flood.live).toHaveLength(0);
    expect(flood.dropped.floor).toBe(2);
    const next = classifyBatch([pt(now + skew + 10_000)], { ...window, lastLiveAtMs: now + skew, lastReceivedAtMs: now });
    expect(next.live).toHaveLength(1);
    // A real point recorded just before the bogus reference arrived is live again; older ones stay backfill.
    const real = classifyBatch([pt(now - LIVE_AHEAD_MS - 60_000), pt(now - 1000)], { ...window, lastLiveAtMs: now + 110_000, lastReceivedAtMs: now });
    expect(real.live.map((p) => p.ms)).toEqual([now - 1000]);
    expect(real.backfill).toHaveLength(1);
  });

  it('a forward-dated point never moves trips.last_point_at beyond now()', async () => {
    const w = await world();
    const res = await post(w, northbound({ baseMs: Date.now() + 90_000, count: 1 }));
    expect(res.body.data.accepted).toBe(1);
    await drainJobs();
    const { rows } = await ownerQuery<{ ahead: boolean }>('select last_point_at > now() as ahead from trips where id = $1', [w.trip.id]);
    expect(rows[0]!.ahead).toBe(false);
  });
});

describe('trip-room payloads (parents)', () => {
  it('carry no phone battery / network type, while the admin fleet room keeps them', async () => {
    const w = await world();
    const emitted: { room: string; event: string; payload: { live?: { point?: { bat: unknown; net: unknown } } } }[] = [];
    const restore = useRealtime({
      emit: async (room: string, event: string, payload: unknown) => void emitted.push({ room, event, payload: payload as never }),
      disconnectSessions: async () => undefined,
      revalidateActors: async () => undefined,
      disconnectSchool: async () => undefined,
    });
    try {
      expect((await post(w, northbound({ baseMs: Date.now() - 2000, count: 1 }))).status).toBe(200);
    } finally {
      restore();
    }
    const fleet = emitted.find((e) => e.room === `school:${w.school.id}:fleet` && e.event === 'live:position');
    const trip = emitted.find((e) => e.room === `trip:${w.trip.id}` && e.event === 'live:position');
    expect(fleet!.payload.live!.point).toMatchObject({ bat: 80, net: '4g' });
    expect(trip!.payload.live!.point).toMatchObject({ bat: null, net: null });
  });
});
