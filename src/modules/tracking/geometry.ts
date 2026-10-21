// Planned geometry of a trip (BP §9.5): the route polyline (Google or the flagged straight line, or
// the straight path through the stops when no polyline was stored yet), the stops with their
// geofences, timetable instants and their progress along the polyline. Cached per trip in kv for a
// few minutes (keys carry school_id) so each accepted point costs no geometry query.
import type { Direction } from '@wimb/shared';
import { withSchoolSystem, type Tx } from '../../db/tenant.js';
import { events } from '../../shared/events.js';
import { decodePolyline, encodePolyline, projectOnPolyline, polylineLengthM, type LatLng } from '../../shared/geo.js';
import { getJson, kv as defaultKv, kvKey, setJson, type KvStore } from '../../shared/kv.js';
import { logger as rootLogger } from '../../shared/logger.js';
import { buildPath } from '../routes/index.js';
import '../school/events.js';
import * as repo from './repository.js';

export const GEOMETRY_TTL_S = 300;

const log = rootLogger.child({ module: 'tracking.geometry' });

export interface GeoStop {
  id: string;
  sequence: number;
  name: string;
  lat: number;
  lng: number;
  radiusM: number;
  expectedTime: string | null;
  /** Timetable instant on the trip date (ms) or null. */
  plannedAtMs: number | null;
  /** Distance of the stop along the polyline (m). */
  progressM: number;
}

export interface TripGeometry {
  tripId: string;
  routeId: string | null;
  direction: Direction | null;
  tripDate: string;
  timezone: string;
  /** Planned polyline vertices (≥ 2) or null when the trip has no usable route. */
  polyline: LatLng[] | null;
  encoded: string | null;
  source: 'google' | 'straight' | null;
  totalM: number;
  stops: GeoStop[];
  /** School location with its geofence radius (schools.geofence_radius_m) or null when not set. */
  school: SchoolGeofence | null;
}

export interface SchoolGeofence extends LatLng {
  radiusM: number;
}

/** Used only when a school row (or an older cached geometry) carries no geofence radius. */
export const DEFAULT_SCHOOL_RADIUS_M = 200;

/** Geofence radius of the school in a geometry (cached geometries from before the radius fall back). */
export function schoolRadiusM(school: Partial<SchoolGeofence>): number {
  const r = Number(school.radiusM);
  return Number.isFinite(r) && r > 0 ? r : DEFAULT_SCHOOL_RADIUS_M;
}

export const geometryKey = (schoolId: string, tripId: string): string => kvKey('track-geo', schoolId, tripId);

/** Builds the geometry from its row (pure; exported for tests). */
export function buildGeometry(row: repo.GeometryRow): TripGeometry {
  const school: SchoolGeofence | null =
    row.school_lat !== null && row.school_lng !== null
      ? { lat: Number(row.school_lat), lng: Number(row.school_lng), radiusM: schoolRadiusM({ radiusM: row.school_radius_m ?? undefined }) }
      : null;
  let polyline: LatLng[] | null = row.polyline_encoded ? decodePolyline(row.polyline_encoded) : null;
  let encoded = row.polyline_encoded;
  let source = row.polyline_source;
  if ((!polyline || polyline.length < 2) && row.stops.length) {
    const path = buildPath(row.direction ?? 'morning', row.stops, school ? { latitude: school.lat, longitude: school.lng } : null);
    polyline = path.points.map((p) => ({ lat: p.lat, lng: p.lng }));
    encoded = polyline.length >= 2 ? encodePolyline(polyline) : null;
    source = polyline.length >= 2 ? 'straight' : null;
  }
  if (!polyline || polyline.length < 2) {
    polyline = null;
    encoded = null;
    source = null;
  }
  const stops: GeoStop[] = [];
  let hint = 0;
  for (const s of row.stops) {
    const lat = Number(s.latitude);
    const lng = Number(s.longitude);
    const progressM = polyline ? projectOnPolyline({ lat, lng }, polyline, { hintProgressM: hint }).progressM : 0;
    hint = progressM;
    const planned = s.planned_at ? Date.parse(s.planned_at) : NaN;
    stops.push({
      id: s.id,
      sequence: s.sequence,
      name: s.name,
      lat,
      lng,
      radiusM: s.arrival_radius_m,
      expectedTime: s.expected_time,
      plannedAtMs: Number.isFinite(planned) ? planned : null,
      progressM,
    });
  }
  return {
    tripId: row.trip_id,
    routeId: row.route_id,
    direction: row.direction,
    tripDate: row.trip_date,
    timezone: row.timezone,
    polyline,
    encoded,
    source,
    totalM: polyline ? polylineLengthM(polyline) : 0,
    stops,
    school,
  };
}

/** Geometry of a trip in the transaction's school (cached). */
export async function loadGeometry(tx: Tx, tripId: string, store: KvStore = defaultKv): Promise<TripGeometry | null> {
  const schoolId = tx.ctx.schoolId;
  if (!schoolId) throw new TypeError('loadGeometry requires a school context');
  const key = geometryKey(schoolId, tripId);
  const hit = await getJson<TripGeometry>(store, key);
  if (hit) return hit;
  const row = await repo.tripGeometry(tx, tripId);
  if (!row) return null;
  const geometry = buildGeometry(row);
  await setJson(store, key, geometry, GEOMETRY_TTL_S);
  return geometry;
}

/**
 * Drops the cached geometry of the school's open trips (the school location or geofence radius
 * changed: the next point reloads it instead of using the old campus geofence for up to the TTL).
 */
export async function dropSchoolGeometries(schoolId: string, store: KvStore = defaultKv): Promise<number> {
  const ids = await withSchoolSystem(schoolId, (tx) => repo.openTripIds(tx), { readOnly: true });
  if (ids.length) await store.del(...ids.map((id) => geometryKey(schoolId, id)));
  return ids.length;
}

events.on('school.profile_changed', async ({ schoolId }) => {
  try {
    await dropSchoolGeometries(schoolId);
  } catch (err) {
    log.warn({ err, schoolId }, 'Cached trip geometries could not be dropped (they expire within the TTL)');
  }
});
