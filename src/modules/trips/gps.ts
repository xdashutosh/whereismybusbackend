// GPS distance of a trip (BP §9.6, §10.3 rule 3): sum of the segment lengths between consecutive
// accepted points after outlier filtering. The tracking module may register a better provider
// (e.g. one that reads its live/finalizer state) with registerGpsDistanceProvider(); the default
// computes it in one statement from location_points (PostGIS geography distances), skipping points
// with a poor accuracy and segments implying an impossible speed (GPS jumps).
import type { Tx } from '../../db/tenant.js';

export interface GpsDistance {
  /** Kilometres (one decimal), null when there is not enough data (fewer than MIN_GPS_POINTS points). */
  km: number | null;
  /** Points that took part in the computation. */
  points: number;
}

export interface GpsTripRef {
  id: string;
  started_at: string | null;
  ended_at: string | null;
}

export type GpsDistanceProvider = (tx: Tx, trip: GpsTripRef) => Promise<GpsDistance>;

/** Points with a reported accuracy worse than this are ignored (m). */
export const MAX_POINT_ACCURACY_M = 100;
/** Segments implying more than this speed are GPS jumps (km/h). */
export const MAX_SEGMENT_SPEED_KMH = 150;
/** Below this many usable points the GPS distance is unknown (no odometer/GPS comparison). */
export const MIN_GPS_POINTS = 2;

/** Default provider: one statement over location_points of the trip (RLS-scoped). */
export const sqlGpsDistance: GpsDistanceProvider = async (tx, trip) => {
  const row = await tx.one<{ points: number; meters: number | null }>(
    `with p as (
       select recorded_at, latitude, longitude,
              lag(latitude) over w as prev_lat, lag(longitude) over w as prev_lng, lag(recorded_at) over w as prev_at
         from location_points
        where trip_id = $1 and (accuracy_m is null or accuracy_m <= $2)
       window w as (order by recorded_at)
     ), seg as (
       select st_distance(st_setsrid(st_makepoint(longitude, latitude), 4326)::geography,
                          st_setsrid(st_makepoint(prev_lng, prev_lat), 4326)::geography) as m,
              extract(epoch from recorded_at - prev_at) as s
         from p where prev_lat is not null
     )
     select (select count(*)::int from p) as points,
            (select sum(m) from seg where s > 0 and m / s * 3.6 <= $3) as meters`,
    [trip.id, MAX_POINT_ACCURACY_M, MAX_SEGMENT_SPEED_KMH],
  );
  if (row.points < MIN_GPS_POINTS) return { km: null, points: row.points };
  return { km: Math.round((Number(row.meters ?? 0) / 1000) * 10) / 10, points: row.points };
};

let provider: GpsDistanceProvider = sqlGpsDistance;

/** Replaces the GPS distance provider (tracking module); returns a restore function. */
export function registerGpsDistanceProvider(fn: GpsDistanceProvider): () => void {
  const previous = provider;
  provider = fn;
  return () => {
    provider = previous;
  };
}

/** GPS distance of a trip through the registered provider. */
export function gpsDistance(tx: Tx, trip: GpsTripRef): Promise<GpsDistance> {
  return provider(tx, trip);
}
