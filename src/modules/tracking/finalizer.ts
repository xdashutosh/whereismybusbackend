// trip-finalizer (BP §7.3, §9.6) and the GPS distance helper of trip end (BP §10.3):
//   gpsDistanceKm(tx, tripId)  GPS km of a trip from its stored points (outliers filtered, jitter
//                              suppressed) — the trips module calls it inside its end transaction.
//   finalizeTrip(tx, tripId)   actual path simplified with ST_SimplifyPreserveTopology, duration, GPS
//                              distance, stop visits + dwell (fills trip_stop_events the live pass
//                              missed, e.g. backfilled stretches), planned-vs-actual deviation,
//                              over-speed runs, data quality and feature-gated flags →
//                              trips.summary + trips.distance_gps_km + finalized_at, then re-runs the
//                              trips module's odometer ↔ GPS comparison with the final distance (late
//                              points can change it; same dedupe key → at most one alert per trip).
//                              Idempotent; the caller announces `result.alerts` after commit.
import type { Tx } from '../../db/tenant.js';
import { closeAlertByKey, type RaisedAlert } from '../alerts/service.js';
import { audit } from '../../shared/audit.js';
import { loadSchoolSettings } from '../school/index.js';
import { registerGpsDistanceProvider, type GpsDistanceProvider } from '../trips/gps.js';
import { gpsMismatchAlert, noGpsDedupeKey } from '../trips/odometer.js';
import { toTrackingConfig, type TrackingConfig } from './config.js';
import { buildGeometry, type TripGeometry } from './geometry.js';
import * as repo from './repository.js';
import { DEVIATION_POINTS, SPEEDING_POINTS } from './analytics.js';
import { deviationStats, detectStopVisits, filterTrack, maxGapS, speedStats, toKm1, trackDistanceM, type TrackPoint } from './track.js';

/** ≈ 5.5 m at the equator; enough to drop GPS noise while keeping turns. */
export const SIMPLIFY_TOLERANCE_DEG = 0.00005;
/** Minimum data for analytics flags (BP §9.6: only when data quality is sufficient). */
export const MIN_POINTS_FOR_FLAGS = 10;
export const MAX_GAP_FOR_FLAGS_S = 900;
export const MAX_AVG_ACCURACY_FOR_FLAGS_M = 50;

interface FinalizeTripRow extends Record<string, unknown> {
  id: string;
  status: string;
  started_at: string | null;
  ended_at: string | null;
}

interface ClosedTripRow extends FinalizeTripRow {
  bus_id: string;
  bus_code_snapshot: string | null;
  driver_staff_id: string | null;
  start_odometer: number | null;
  end_odometer: number | null;
}

function toTrack(rows: readonly repo.StoredPointRow[]): TrackPoint[] {
  return rows.map((r) => ({ ms: Date.parse(r.recorded_at), lat: Number(r.latitude), lng: Number(r.longitude), acc: r.accuracy_m === null ? null : Number(r.accuracy_m), spd: r.speed_kmh === null ? null : Number(r.speed_kmh) }));
}

export async function loadTrack(tx: Tx, tripId: string, window: { from: string | null; to: string | null }) {
  const rows = await repo.tripPoints(tx, tripId, window);
  const all = toTrack(rows);
  return { all, ...filterTrack(all) };
}

/**
 * GPS distance provider registered with the trips module (end-trip odometer/GPS comparison):
 * km = null with fewer than 2 usable points.
 */
export const trackingGpsDistance: GpsDistanceProvider = async (tx, trip) => {
  const { kept } = await loadTrack(tx, trip.id, { from: trip.started_at, to: trip.ended_at });
  return { km: kept.length < 2 ? null : toKm1(trackDistanceM(kept)), points: kept.length };
};
registerGpsDistanceProvider(trackingGpsDistance);

/** GPS distance (km, 0.1 precision) of a trip from its stored points; 0 without points. */
export async function gpsDistanceKm(tx: Tx, tripId: string): Promise<number> {
  const trip = await tx.maybeOne<FinalizeTripRow>('select id, status, started_at, ended_at from trips where id = $1', [tripId]);
  if (!trip) return 0;
  return (await trackingGpsDistance(tx, trip)).km ?? 0;
}

export async function simplifiedPath(tx: Tx, kept: readonly TrackPoint[]): Promise<{ encoded: string | null; pointCount: number }> {
  if (kept.length < 2) return { encoded: null, pointCount: kept.length };
  const row = await tx.one<{ encoded: string | null; n: number | null }>(
    `with line as (
       select st_simplifypreservetopology(st_makeline(array_agg(st_setsrid(st_makepoint(u.lng, u.lat), 4326) order by u.i)), $3) as g
         from unnest($1::float8[], $2::float8[]) with ordinality as u(lat, lng, i)
     )
     select st_asencodedpolyline(g, 5) as encoded, st_npoints(g) as n from line`,
    [kept.map((p) => p.lat), kept.map((p) => p.lng), SIMPLIFY_TOLERANCE_DEG],
  );
  return { encoded: row.encoded, pointCount: Number(row.n ?? 0) };
}

/** Upserts finalizer stop visits (one statement); live rows keep their times, manual rows are untouched. */
async function writeStopVisits(tx: Tx, tripId: string, visits: ReturnType<typeof detectStopVisits>): Promise<void> {
  if (!visits.length) return;
  await tx.query(
    `insert into trip_stop_events (school_id, trip_id, stop_id, arrived_at, departed_at, dwell_s, distance_m, source)
     select nullif(current_setting('app.school_id', true), '')::uuid, $1, v.stop_id, v.arrived_at, v.departed_at,
            case when v.departed_at is null then null else greatest(0, extract(epoch from (v.departed_at - v.arrived_at)))::int end,
            v.distance_m, 'finalizer'
       from unnest($2::uuid[], $3::timestamptz[], $4::timestamptz[], $5::real[]) as v(stop_id, arrived_at, departed_at, distance_m)
     on conflict (trip_id, stop_id) do update
        set departed_at = coalesce(trip_stop_events.departed_at, excluded.departed_at),
            dwell_s = coalesce(trip_stop_events.dwell_s,
                               case when coalesce(trip_stop_events.departed_at, excluded.departed_at) is null then null
                                    else greatest(0, extract(epoch from (coalesce(trip_stop_events.departed_at, excluded.departed_at)
                                                                         - coalesce(trip_stop_events.arrived_at, excluded.arrived_at))))::int end),
            arrived_at = coalesce(trip_stop_events.arrived_at, excluded.arrived_at),
            distance_m = least(coalesce(trip_stop_events.distance_m, excluded.distance_m), excluded.distance_m),
            updated_at = now()
      where trip_stop_events.source <> 'manual'`,
    [tripId, visits.map((v) => v.stopId), visits.map((v) => new Date(v.arrivedMs).toISOString()), visits.map((v) => (v.departedMs === null ? null : new Date(v.departedMs).toISOString())), visits.map((v) => Math.round(v.distanceM))],
  );
}

/**
 * An auto-closed trip ends at its last fix known at close time (stale-trip-closer). The phone's offline
 * queue, uploaded later, can hold fixes recorded after that — up to the close instant: ended_at moves
 * to the newest stored fix, capped at closed_at, so durations and the GPS track cover the real trip.
 * Never moves ended_at backwards. Returns the (possibly new) ended_at.
 */
async function extendAutoClosedEnd(tx: Tx, trip: FinalizeTripRow & { closed_at?: string | null }): Promise<string | null> {
  if (!trip.started_at || !trip.ended_at) return trip.ended_at;
  const row = await tx.maybeOne<{ ended_at: string }>(
    `with last as (
       select max(lp.recorded_at) as at from location_points lp
        where lp.trip_id = $1 and lp.recorded_at >= $2::timestamptz - interval '1 day'
          and lp.recorded_at <= coalesce((select closed_at from trips where id = $1), $3::timestamptz) + interval '1 day'
     )
     update trips t set ended_at = least(last.at, coalesce(t.closed_at, last.at)), updated_at = now()
       from last
      where t.id = $1 and last.at is not null and least(last.at, coalesce(t.closed_at, last.at)) > t.ended_at
      returning t.ended_at`,
    [trip.id, trip.started_at, trip.ended_at],
  );
  return row?.ended_at ?? trip.ended_at;
}

export interface FinalizeResult {
  finalized: boolean;
  reason?: string;
  summary?: Record<string, unknown>;
  /** GPS km (0.1 precision); null with fewer than 2 usable points (unknown, like the trips provider). */
  distanceGpsKm?: number | null;
  /** Alerts raised inside the transaction (announce after commit). */
  alerts?: RaisedAlert[];
}

/** Computes and stores the post-trip analytics of a closed trip (no-op for other states). */
export async function finalizeTrip(tx: Tx, tripId: string, nowMs = Date.now()): Promise<FinalizeResult> {
  const trip = await tx.maybeOne<ClosedTripRow>(
    `select id, status, started_at, ended_at, bus_id, bus_code_snapshot, driver_staff_id, start_odometer, end_odometer
       from trips where id = $1 for update`,
    [tripId],
  );
  if (!trip) return { finalized: false, reason: 'NOT_FOUND' };
  if (trip.status !== 'completed' && trip.status !== 'auto_closed') return { finalized: false, reason: 'NOT_CLOSED' };
  if (trip.status === 'auto_closed') trip.ended_at = await extendAutoClosedEnd(tx, trip);
  const settings = await loadSchoolSettings(tx);
  const cfg: TrackingConfig = toTrackingConfig(settings);
  const geoRow = await repo.tripGeometry(tx, tripId);
  const geometry: TripGeometry | null = geoRow ? buildGeometry(geoRow) : null;
  const { all, kept, outliers } = await loadTrack(tx, tripId, { from: trip.started_at, to: trip.ended_at });

  const distanceM = trackDistanceM(kept);
  const path = await simplifiedPath(tx, kept);
  const visits = geometry ? detectStopVisits(kept, geometry.stops) : [];
  await writeStopVisits(tx, tripId, visits);
  const events = await repo.stopEvents(tx, tripId);
  const visitedIds = new Set(events.filter((e) => e.arrived_at !== null).map((e) => e.stop_id));
  const dwells = events.filter((e) => e.dwell_s !== null).map((e) => e.dwell_s!);
  const deviation = geometry?.polyline ? deviationStats(kept, geometry.polyline, cfg.routeDeviationM) : null;
  const speed = speedStats(kept, cfg.speedLimitKmh, cfg.movingSpeedKmh, SPEEDING_POINTS);
  const accuracies = kept.map((p) => p.acc).filter((a): a is number => a !== null);
  const avgAccuracyM = accuracies.length ? Math.round(accuracies.reduce((a, b) => a + b, 0) / accuracies.length) : null;
  const gapS = maxGapS(kept);
  const reasons: string[] = [];
  if (kept.length < MIN_POINTS_FOR_FLAGS) reasons.push('TOO_FEW_POINTS');
  if (gapS > MAX_GAP_FOR_FLAGS_S) reasons.push('LONG_GAP');
  if (avgAccuracyM !== null && avgAccuracyM > MAX_AVG_ACCURACY_FOR_FLAGS_M) reasons.push('LOW_ACCURACY');
  const sufficient = reasons.length === 0;
  const flags: string[] = [];
  if (sufficient && cfg.routeDeviationEnabled && deviation && deviation.longestRunOverThreshold >= DEVIATION_POINTS) flags.push('route_deviation');
  if (sufficient && cfg.speedingEnabled && (speed.overSpeedEvents ?? 0) > 0) flags.push('speeding');

  const startedMs = trip.started_at ? Date.parse(trip.started_at) : null;
  const endedMs = trip.ended_at ? Date.parse(trip.ended_at) : null;
  const distanceGpsKm = kept.length < 2 ? null : toKm1(distanceM);
  const summary = {
    version: 1,
    computedAt: new Date(nowMs).toISOString(),
    durationS: startedMs !== null && endedMs !== null ? Math.max(0, Math.round((endedMs - startedMs) / 1000)) : null,
    distanceGpsKm,
    points: { total: all.length, kept: kept.length, outliers },
    path: { encoded: path.encoded, pointCount: path.pointCount, toleranceDeg: SIMPLIFY_TOLERANCE_DEG },
    stops: {
      planned: geometry?.stops.length ?? 0,
      visited: geometry ? geometry.stops.filter((s) => visitedIds.has(s.id)).length : 0,
      missedStopIds: geometry ? geometry.stops.filter((s) => !visitedIds.has(s.id)).map((s) => s.id) : [],
      avgDwellS: dwells.length ? Math.round(dwells.reduce((a, b) => a + b, 0) / dwells.length) : null,
      dwell: events.map((e) => ({ stopId: e.stop_id, name: e.stop_name, sequence: e.sequence, arrivedAt: e.arrived_at, departedAt: e.departed_at, dwellS: e.dwell_s, source: e.source })),
    },
    deviation,
    speed,
    dataQuality: { sufficient, reasons, maxGapS: gapS, avgAccuracyM },
    flags,
  };
  await tx.query('update trips set summary = $2, distance_gps_km = $3, finalized_at = now(), updated_at = now() where id = $1', [tripId, JSON.stringify(summary), distanceGpsKm]);
  const mismatch = await gpsMismatchAlert(tx, { ...trip, distance_gps_km: distanceGpsKm }, settings);
  if (distanceGpsKm !== null) {
    // Late points gave the trip a GPS distance: the end-time "no GPS data" flag no longer applies (the
    // regular comparison above decided instead).
    const closedId = await closeAlertByKey(tx, noGpsDedupeKey(tripId), `GPS data arrived later: ${distanceGpsKm} km from ${kept.length} points.`);
    if (closedId) await audit.log(tx, { action: 'alert.auto_close', entityType: 'alert', entityId: closedId, new: { status: 'closed', reason: 'gps_data_arrived', tripId, distanceGpsKm } });
  }
  return { finalized: true, summary, distanceGpsKm, alerts: mismatch ? [mismatch] : [] };
}
