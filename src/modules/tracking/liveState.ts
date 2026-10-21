// Live state per running trip (BP §9.2): kv `live:{schoolId}:{tripId}` holds the newest accepted
// point, the moving/stopped state, the freshness timestamp, route progress, stop visits and the ETA.
// It is the source of truth for live maps (Redis in production, memory in dev/tests) and expires
// LIVE_TTL_S after the last write. Ingestion and analytics update it read-modify-write under a
// per-trip lock: an in-process queue plus a short kv lock across instances.
import type { CurrentStop, Direction, Freshness, LivePoint, MotionState, TripEta, TripLiveState, TripStatus } from '@wimb/shared';
import { getJson, kv as defaultKv, kvKey, setJson, type KvStore } from '../../shared/kv.js';
import { logger as rootLogger } from '../../shared/logger.js';
import { staleAfterS, type TrackingConfig } from './config.js';

const log = rootLogger.child({ module: 'tracking.live' });

export const LIVE_TTL_S = 24 * 3600;
const LOCK_TTL_S = 5;
const LOCK_WAIT_MS = 2000;
const LOCK_POLL_MS = 20;

export interface LongStopState {
  sinceMs: number;
  lat: number;
  lng: number;
  alerted: boolean;
}

export interface StoredLiveState {
  v: 1;
  schoolId: string;
  tripId: string;
  busId: string;
  routeId: string | null;
  direction: Direction | null;
  tripStatus: TripStatus;
  point: LivePoint | null;
  /** recorded_at (ms) of the newest accepted live point — the 10-s floor reference. */
  lastLiveAtMs: number | null;
  /** Server time (ms) when that point was accepted. */
  receivedAtMs: number | null;
  motion: MotionState;
  stoppedSinceMs: number | null;
  /** Since when the smoothed speed has been at or below the moving threshold. */
  lowSpeedSinceMs: number | null;
  /** Last accurate speed samples (km/h, newest last) for the median-of-3 smoothing. */
  speeds: number[];
  /** Exponentially weighted speed (m/s) and the time of its last update. */
  ewmaSpeedMps: number | null;
  ewmaAtMs: number | null;
  progressM: number | null;
  distanceFromRouteM: number | null;
  /** Consecutive accurate points farther than the deviation threshold from the planned route. */
  offRouteCount: number;
  currentStop: CurrentStop | null;
  /** Closest approach (m) to the current stop while inside its geofence. */
  currentStopMinM: number | null;
  visitedStopIds: string[];
  /** The bus has been inside the school geofence during this trip / left it at (ms). */
  wasInSchool: boolean;
  leftSchoolAtMs: number | null;
  /** recorded_at (ms) of the newest point processed by the analytics. */
  analyzedUpToMs: number | null;
  /**
   * Last fix the analytics accepted as plausible (the GPS-spike reference, BP §9.6 rules applied live)
   * and how many fixes in a row were rejected against it. Optional: states written before these
   * fields existed start without a reference.
   */
  analyticsRef?: { ms: number; lat: number; lng: number } | null;
  spikeRun?: number;
  eta: TripEta | null;
  locationUnavailable: boolean;
  /** Consecutive points above the speed limit and whether this run was alerted. */
  speedingRun: { count: number; alerted: boolean; maxKmh: number };
  longStop: LongStopState | null;
  /** Last emit to the trip room (parents are coalesced to ≥ 10 s per trip). */
  lastTripEmitMs: number | null;
  /**
   * server − device clock offset (ms) applied to this trip's points (BP §14.3, clock.ts); null = the
   * phone clock is right. Optional: states written before it existed have none.
   */
  clockOffsetMs?: number | null;
  /** A clock_drift alert was requested for the current drift (reset once the clock is right again). */
  clockDriftReported?: boolean;
  /** The app reported location_permission_denied at (ms, server clock) and has not reported it back. */
  locationPermissionDeniedAtMs?: number | null;
}

export const liveKey = (schoolId: string, tripId: string): string => kvKey('live', schoolId, tripId);

export interface LiveSeed {
  schoolId: string;
  tripId: string;
  busId: string;
  routeId: string | null;
  direction: Direction | null;
  tripStatus: TripStatus;
  /** trips.last_point_at — keeps the floor after a kv loss. */
  lastPointAt: string | null;
}

export function newLiveState(seed: LiveSeed): StoredLiveState {
  const last = seed.lastPointAt ? Date.parse(seed.lastPointAt) : NaN;
  return {
    v: 1,
    schoolId: seed.schoolId,
    tripId: seed.tripId,
    busId: seed.busId,
    routeId: seed.routeId,
    direction: seed.direction,
    tripStatus: seed.tripStatus,
    point: null,
    lastLiveAtMs: Number.isFinite(last) ? last : null,
    receivedAtMs: null,
    motion: 'moving',
    stoppedSinceMs: null,
    lowSpeedSinceMs: null,
    speeds: [],
    ewmaSpeedMps: null,
    ewmaAtMs: null,
    progressM: null,
    distanceFromRouteM: null,
    offRouteCount: 0,
    currentStop: null,
    currentStopMinM: null,
    visitedStopIds: [],
    wasInSchool: false,
    leftSchoolAtMs: null,
    analyzedUpToMs: null,
    analyticsRef: null,
    spikeRun: 0,
    eta: null,
    locationUnavailable: false,
    speedingRun: { count: 0, alerted: false, maxKmh: 0 },
    longStop: null,
    lastTripEmitMs: null,
    clockOffsetMs: null,
    clockDriftReported: false,
    locationPermissionDeniedAtMs: null,
  };
}

/** A trip_stop_events row as seedStopVisits needs it. */
export interface StopVisitSeedRow {
  stop_id: string;
  stop_name: string | null;
  sequence: number | null;
  arrived_at: string | null;
  departed_at: string | null;
  distance_m: number | null;
}

/**
 * Rebuilds the stop-visit part of a fresh live state of a RUNNING trip from its stored stop events (the
 * kv entry expired or was lost in a restart without Redis): stops with an arrival count as visited, and
 * the newest arrival without a departure is the current stop — so a bus still inside that geofence is
 * not announced as arriving again and its departure/dwell stay right.
 */
export function seedStopVisits(state: StoredLiveState, rows: readonly StopVisitSeedRow[]): StoredLiveState {
  const arrived = rows.filter((r) => r.arrived_at !== null).sort((a, b) => Date.parse(a.arrived_at!) - Date.parse(b.arrived_at!));
  state.visitedStopIds = [...new Set([...state.visitedStopIds, ...arrived.map((r) => r.stop_id)])];
  const last = arrived[arrived.length - 1];
  if (last && last.departed_at === null && !state.currentStop) {
    state.currentStop = { stopId: last.stop_id, name: last.stop_name ?? '', sequence: Number(last.sequence ?? 0), arrivedAt: new Date(last.arrived_at!).toISOString() };
    state.currentStopMinM = last.distance_m === null ? null : Number(last.distance_m);
  }
  return state;
}

export function createLiveStore(store: KvStore = defaultKv) {
  const chains = new Map<string, Promise<unknown>>();

  async function acquire(key: string): Promise<boolean> {
    const lockKey = `${key}:lock`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      if (await store.setIfAbsent(lockKey, '1', LOCK_TTL_S)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
    }
  }

  return {
    get(schoolId: string, tripId: string): Promise<StoredLiveState | null> {
      return getJson<StoredLiveState>(store, liveKey(schoolId, tripId));
    },
    async getMany(schoolId: string, tripIds: readonly string[]): Promise<Map<string, StoredLiveState>> {
      const out = new Map<string, StoredLiveState>();
      const values = await Promise.all(tripIds.map((id) => getJson<StoredLiveState>(store, liveKey(schoolId, id))));
      tripIds.forEach((id, i) => {
        const v = values[i];
        if (v) out.set(id, v);
      });
      return out;
    },
    put(state: StoredLiveState): Promise<void> {
      return setJson(store, liveKey(state.schoolId, state.tripId), state, LIVE_TTL_S);
    },
    del(schoolId: string, tripId: string): Promise<void> {
      return store.del(liveKey(schoolId, tripId));
    },
    /** Runs fn exclusively for one trip (this process: queued; across instances: kv lock). */
    async withLock<T>(schoolId: string, tripId: string, fn: () => Promise<T>): Promise<T> {
      const key = liveKey(schoolId, tripId);
      const previous = chains.get(key) ?? Promise.resolve();
      const run = previous.catch(() => undefined).then(async () => {
        const locked = await acquire(key);
        if (!locked) log.warn({ schoolId, tripId }, 'Live state lock not acquired in time; continuing without it');
        try {
          return await fn();
        } finally {
          if (locked) await store.del(`${key}:lock`).catch(() => undefined);
        }
      });
      chains.set(key, run);
      try {
        return await run;
      } finally {
        if (chains.get(key) === run) chains.delete(key);
      }
    },
  };
}

export type LiveStore = ReturnType<typeof createLiveStore>;
export const liveStore: LiveStore = createLiveStore();

/**
 * When the server last heard from the bus (ms): the arrival time of the newest live point, else its
 * timestamp (never later than its arrival — a forward-dated fix counts from when it arrived). Freshness
 * is judged on the server clock, so a phone whose clock is off is not shown as stale (BP §14.3).
 */
export function lastHeardMs(s: Pick<StoredLiveState, 'point' | 'receivedAtMs'>): number {
  const pointMs = s.point ? Date.parse(s.point.t) : NaN;
  if (s.receivedAtMs !== null && Number.isFinite(s.receivedAtMs)) return s.receivedAtMs;
  return pointMs;
}

/** Public view of a stored state at `nowMs` (freshness computed against the school configuration). */
export function toPublicLive(s: StoredLiveState, cfg: Pick<TrackingConfig, 'movingIntervalS' | 'stoppedIntervalS'>, nowMs = Date.now()): TripLiveState {
  const heardMs = s.point ? lastHeardMs(s) : NaN;
  const ageS = Number.isFinite(heardMs) ? Math.max(0, Math.round((nowMs - heardMs) / 1000)) : null;
  let freshness: Freshness = 'none';
  if (ageS !== null) freshness = ageS <= staleAfterS(cfg, s.motion) ? 'live' : 'stale';
  const permissionDenied = (s.locationPermissionDeniedAtMs ?? null) !== null;
  return {
    tripId: s.tripId,
    busId: s.busId,
    routeId: s.routeId,
    direction: s.direction,
    tripStatus: s.tripStatus,
    point: s.point,
    receivedAt: s.receivedAtMs ? new Date(s.receivedAtMs).toISOString() : null,
    motion: s.motion,
    stoppedSince: s.stoppedSinceMs ? new Date(s.stoppedSinceMs).toISOString() : null,
    freshness,
    ageS,
    locationUnavailable: s.locationUnavailable || freshness === 'stale' || permissionDenied,
    locationPermissionDenied: permissionDenied,
    clockOffsetMs: s.clockOffsetMs ?? null,
    progressM: s.progressM === null ? null : Math.round(s.progressM),
    distanceFromRouteM: s.distanceFromRouteM === null ? null : Math.round(s.distanceFromRouteM),
    currentStop: s.currentStop,
    visitedStopIds: s.visitedStopIds,
    eta: s.eta,
  };
}
