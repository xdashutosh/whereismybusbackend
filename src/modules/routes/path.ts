// Planned path geometry of a route (pure): the live stops in sequence order plus the school endpoint —
// the destination of a morning route and the origin of an afternoon route — unless the last/first stop
// already lies within SCHOOL_ENDPOINT_MERGE_M of the school. Shared by the polyline service, the seeds
// and other modules (ETA, parent tracking).
import { SCHOOL_ENDPOINT_MERGE_M } from '@wimb/shared';
import { haversineMeters } from '../../shared/geo.js';
import type { StopRow } from './dto.js';

export interface PathPoint {
  lat: number;
  lng: number;
  /** null = the school endpoint. */
  stopId: string | null;
}

export interface RoutePath {
  points: PathPoint[];
  includesSchool: boolean;
  /** Identity of the geometry (order + coordinates) — detects concurrent edits. */
  fingerprint: string;
}

/** Ordered path points of a route: its stops plus the school endpoint for the route's direction. */
export function buildPath(direction: string, stops: Pick<StopRow, 'id' | 'latitude' | 'longitude'>[], school: { latitude: number; longitude: number } | null): RoutePath {
  const points: PathPoint[] = stops.map((s) => ({ lat: Number(s.latitude), lng: Number(s.longitude), stopId: s.id }));
  let includesSchool = false;
  if (school && points.length > 0) {
    const schoolPoint: PathPoint = { lat: school.latitude, lng: school.longitude, stopId: null };
    const end = direction === 'morning' ? points[points.length - 1]! : points[0]!;
    if (haversineMeters(end, schoolPoint) > SCHOOL_ENDPOINT_MERGE_M) {
      includesSchool = true;
      if (direction === 'morning') points.push(schoolPoint);
      else points.unshift(schoolPoint);
    }
  }
  const fingerprint = points.map((p) => `${p.stopId ?? 'school'}@${p.lat.toFixed(6)},${p.lng.toFixed(6)}`).join('|');
  return { points, includesSchool, fingerprint };
}
