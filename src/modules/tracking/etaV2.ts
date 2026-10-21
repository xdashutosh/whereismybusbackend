// ETA v2 (BP §9.5 "optional: call a routing API for remaining stops every N minutes rather than per point.
// Cache the result in Redis"; contract §2 Routing/ETA "ETA v2 (Routes API every N minutes, cached) behind a
// setting"). Behind the school feature `etaV2` (platform `features.eta_v2` and plan module `eta_v2` narrow it)
// and GOOGLE_MAPS_SERVER_KEY:
//   refreshEtaV2  — called by the points-persist worker AFTER the per-trip lock and outside any transaction
//                   (the ingest request never waits for Google). At most once per ETA_V2_REFRESH_S per trip
//                   across instances (kv claim), it asks the Routes API (TRAFFIC_AWARE) for the drive time from
//                   the newest position through the upcoming stops and caches the cumulative drive seconds
//                   under kv key eta-v2:{schoolId}:{tripId}.
//   applyEtaV2    — pure: replaces the v1 stop times with origin time + drive time + dwell per passed stop
//                   while the snapshot is fresh (ETA_V2_MAX_AGE_S); stops it does not cover keep v1.
// A missing key, a Google failure (e.g. the Routes API not enabled → HTTP 403) or a snapshot that is too old
// leaves ETA v1 in force; the claim is kept, so a failing API is retried once per refresh interval only.
import type { TripEta } from '@wimb/shared';
import config from '../../config/index.js';
import { haversineMeters, type LatLng } from '../../shared/geo.js';
import { getJson, kv as defaultKv, kvKey, setJson, type KvStore } from '../../shared/kv.js';
import { logger as rootLogger } from '../../shared/logger.js';
import { computeRoute, type RoutingOptions } from '../../shared/routing.js';
import type { TrackingConfig } from './config.js';
import { ETA_DWELL_S } from './eta.js';
import type { TripGeometry } from './geometry.js';
import type { StoredLiveState } from './liveState.js';

const log = rootLogger.child({ module: 'tracking.eta-v2' });

/** Google is asked at most once per trip in this interval (BP: "every N minutes"). */
export const ETA_V2_REFRESH_S = 180;
/** A snapshot older than this is ignored (v1 again). */
export const ETA_V2_MAX_AGE_S = 2 * ETA_V2_REFRESH_S;
/** Upcoming stops per request: origin + 25 stops (+ destination) stays within one Routes API call. */
export const ETA_V2_MAX_STOPS = 25;
/** The route end counts as the last stop when it lies this close to it. */
const SAME_PLACE_M = 50;

export interface EtaV2Snapshot {
  v: 1;
  /** recorded_at (ms) of the position the estimate starts from. */
  originMs: number;
  computedAtMs: number;
  /** Cumulative drive seconds from the origin to each upcoming stop, in route order. */
  stops: { stopId: string; driveS: number }[];
  /** Cumulative drive seconds to the end of the route, or null when the request did not cover it. */
  destinationDriveS: number | null;
}

export const etaV2Key = (schoolId: string, tripId: string): string => kvKey('eta-v2', schoolId, tripId);
const claimKey = (schoolId: string, tripId: string): string => kvKey('eta-v2-claim', schoolId, tripId);

const iso = (ms: number) => new Date(ms).toISOString();
const round1 = (n: number) => Math.round(n * 10) / 10;

export function readEtaV2(schoolId: string, tripId: string, store: KvStore = defaultKv): Promise<EtaV2Snapshot | null> {
  return getJson<EtaV2Snapshot>(store, etaV2Key(schoolId, tripId));
}

/** v1 ETA + fresh snapshot → ETA with the Google stop times (pure). Unchanged without a usable snapshot. */
export function applyEtaV2(eta: TripEta, snap: EtaV2Snapshot | null, nowMs: number): TripEta {
  if (!snap || eta.quality === 'unavailable' || !eta.stops.length) return eta;
  if (nowMs - snap.computedAtMs > ETA_V2_MAX_AGE_S * 1000) return eta;
  const byId = new Map(snap.stops.map((s, index) => [s.stopId, { driveS: s.driveS, index }]));
  let applied = 0;
  const stops = eta.stops.map((st) => {
    const hit = byId.get(st.stopId);
    if (!hit) return st;
    applied += 1;
    // Absolute arrival: origin + drive time + the dwell of every stop served before this one.
    const etaMs = Math.max(nowMs, snap.originMs + (hit.driveS + hit.index * ETA_DWELL_S) * 1000);
    const plannedMs = st.plannedAt === null ? null : Date.parse(st.plannedAt);
    return { ...st, etaAt: iso(etaMs), delayMin: plannedMs === null ? null : round1((etaMs - plannedMs) / 60_000) };
  });
  if (!applied) return eta;
  const destinationEtaAt =
    snap.destinationDriveS === null ? eta.destinationEtaAt : iso(Math.max(nowMs, snap.originMs + (snap.destinationDriveS + snap.stops.length * ETA_DWELL_S) * 1000));
  return { ...eta, stops, destinationEtaAt, source: 'v2' };
}

export interface EtaV2Deps {
  store?: KvStore;
  /** apiKey / fetchImpl overrides (tests); the key defaults to GOOGLE_MAPS_SERVER_KEY. */
  routing?: RoutingOptions;
  nowMs?: number;
}

/**
 * Refreshes the trip's snapshot when due. Returns the stored snapshot, or null when nothing was asked (feature
 * off, no key, no usable v1 ETA, claim held) or Google did not answer. Never throws.
 */
export async function refreshEtaV2(
  state: StoredLiveState,
  geometry: TripGeometry | null,
  cfg: Pick<TrackingConfig, 'etaV2Enabled'>,
  deps: EtaV2Deps = {},
): Promise<EtaV2Snapshot | null> {
  const apiKey = deps.routing?.apiKey === undefined ? config.google.mapsServerKey : deps.routing.apiKey;
  const eta = state.eta;
  if (!cfg.etaV2Enabled || !apiKey || !geometry || !state.point || state.tripStatus !== 'in_progress') return null;
  if (!eta || eta.quality === 'unavailable' || !eta.stops.length) return null;
  const store = deps.store ?? defaultKv;
  try {
    const byId = new Map(geometry.stops.map((s) => [s.id, s]));
    const upcoming = eta.stops.map((s) => byId.get(s.stopId)).filter((s): s is NonNullable<typeof s> => s !== undefined).slice(0, ETA_V2_MAX_STOPS);
    if (!upcoming.length) return null;
    if (!(await store.setIfAbsent(claimKey(state.schoolId, state.tripId), '1', ETA_V2_REFRESH_S))) return null;

    const coversAll = upcoming.length === eta.stops.length;
    const end: LatLng | null = geometry.polyline?.[geometry.polyline.length - 1] ?? null;
    const last = upcoming[upcoming.length - 1]!;
    const endIsLastStop = end !== null && haversineMeters(end, last) <= SAME_PLACE_M;
    const withEnd = coversAll && end !== null && !endIsLastStop;
    const points: LatLng[] = [{ lat: state.point.lat, lng: state.point.lng }, ...upcoming.map((s) => ({ lat: s.lat, lng: s.lng })), ...(withEnd ? [end] : [])];

    const route = await computeRoute(points, { ...deps.routing, apiKey, trafficAware: true });
    if (route.source !== 'google') return null; // v1 stays; the claim spaces out the retries

    let driveS = 0;
    const stops = upcoming.map((s, i) => {
      driveS += route.legs[i]!.durationS;
      return { stopId: s.id, driveS };
    });
    const destinationDriveS = withEnd ? driveS + route.legs[upcoming.length]!.durationS : coversAll && endIsLastStop ? driveS : null;
    const snap: EtaV2Snapshot = { v: 1, originMs: Date.parse(state.point.t), computedAtMs: deps.nowMs ?? Date.now(), stops, destinationDriveS };
    await setJson(store, etaV2Key(state.schoolId, state.tripId), snap, ETA_V2_MAX_AGE_S);
    return snap;
  } catch (err) {
    log.warn({ err: { message: (err as Error).message }, schoolId: state.schoolId, tripId: state.tripId }, 'ETA v2 refresh failed; ETA v1 stays in force');
    return null;
  }
}
