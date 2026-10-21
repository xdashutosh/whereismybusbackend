// Planned route polylines (contract §2 Routing/ETA, client constraint §0.3: Google routing).
// computeRoute(stops) calls the Google Routes API (directions/v2:computeRoutes, stops as
// intermediates, DRIVE) when GOOGLE_MAPS_SERVER_KEY is set. Routes longer than the API's waypoint
// limit are split into consecutive chunks that share their joint stop and are stitched together.
// Without a key — or when Google fails — the result is the straight-line path through the stops,
// flagged source: 'straight' (with fallbackReason) so the UI can say so.
import type { PolylineSource } from '@wimb/shared';
import config from '../config/index.js';
import { decodePolyline, encodePolyline, haversineMeters, toPoint, type LatLng, type PointLike } from './geo.js';
import { logger as rootLogger } from './logger.js';

const log = rootLogger.child({ module: 'routing' });

export const ROUTES_API_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
/** origin + 25 intermediates + destination per request (Routes API limit). */
export const MAX_POINTS_PER_REQUEST = 27;
/** Speed assumed for straight-line duration estimates (urban school-bus average). */
export const STRAIGHT_LINE_SPEED_KMH = 22;
const FIELD_MASK = 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,routes.legs.distanceMeters,routes.legs.duration';

export interface RouteLeg {
  distanceM: number;
  durationS: number;
}

export interface ComputedRoute {
  /** Google encoded polyline (precision 5). */
  polyline: string;
  distanceM: number;
  durationS: number;
  /** One leg per consecutive stop pair. */
  legs: RouteLeg[];
  source: PolylineSource;
  /** Why the straight-line fallback was used (absent for Google results). */
  fallbackReason?: 'no_api_key' | 'api_error' | 'too_few_points';
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface RoutingOptions {
  apiKey?: string | null;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** TRAFFIC_AWARE routing (live traffic in the leg durations; ETA v2). Default TRAFFIC_UNAWARE (planned polylines). */
  trafficAware?: boolean;
}

/** Straight-line path through the stops (fallback, flagged). */
export function straightLineRoute(stops: readonly PointLike[], fallbackReason: NonNullable<ComputedRoute['fallbackReason']>): ComputedRoute {
  const pts = stops.map(toPoint);
  const legs: RouteLeg[] = [];
  for (let i = 1; i < pts.length; i += 1) {
    const distanceM = haversineMeters(pts[i - 1]!, pts[i]!);
    legs.push({ distanceM: Math.round(distanceM), durationS: Math.round(distanceM / ((STRAIGHT_LINE_SPEED_KMH * 1000) / 3600)) });
  }
  return {
    polyline: encodePolyline(pts),
    distanceM: legs.reduce((s, l) => s + l.distanceM, 0),
    durationS: legs.reduce((s, l) => s + l.durationS, 0),
    legs,
    source: 'straight',
    fallbackReason,
  };
}

const waypoint = (p: LatLng) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
const seconds = (d: unknown): number => {
  const m = typeof d === 'string' ? /^(\d+(?:\.\d+)?)s$/.exec(d) : null;
  return m ? Math.round(Number(m[1])) : 0;
};

interface RoutesApiResponse {
  routes?: {
    distanceMeters?: number;
    duration?: string;
    polyline?: { encodedPolyline?: string };
    legs?: { distanceMeters?: number; duration?: string }[];
  }[];
}

/** Splits n points into chunks of ≤ max points that share their boundary point. */
export function chunkWaypoints<T>(points: readonly T[], max = MAX_POINTS_PER_REQUEST): T[][] {
  if (points.length <= max) return [points.slice()];
  const chunks: T[][] = [];
  for (let start = 0; start < points.length - 1; start += max - 1) chunks.push(points.slice(start, Math.min(points.length, start + max)));
  return chunks;
}

async function requestChunk(points: LatLng[], apiKey: string, fetchImpl: FetchLike, timeoutMs: number, trafficAware: boolean): Promise<ComputedRoute> {
  const body = {
    origin: waypoint(points[0]!),
    destination: waypoint(points[points.length - 1]!),
    intermediates: points.slice(1, -1).map(waypoint),
    travelMode: 'DRIVE',
    routingPreference: trafficAware ? 'TRAFFIC_AWARE' : 'TRAFFIC_UNAWARE',
    polylineQuality: 'HIGH_QUALITY',
    polylineEncoding: 'ENCODED_POLYLINE',
    computeAlternativeRoutes: false,
    units: 'METRIC',
  };
  const res = await fetchImpl(ROUTES_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': FIELD_MASK },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Routes API HTTP ${res.status}`);
  const data = (await res.json()) as RoutesApiResponse;
  const route = data.routes?.[0];
  const encoded = route?.polyline?.encodedPolyline;
  if (!route || !encoded) throw new Error('Routes API returned no route');
  const legs = (route.legs ?? []).map((l) => ({ distanceM: Math.round(l.distanceMeters ?? 0), durationS: seconds(l.duration) }));
  if (legs.length !== points.length - 1) throw new Error('Routes API leg count does not match the waypoints');
  return { polyline: encoded, distanceM: Math.round(route.distanceMeters ?? 0), durationS: seconds(route.duration), legs, source: 'google' };
}

/** Planned route through the ordered stops (≥ 2). Never throws for provider failures. */
export async function computeRoute(stops: readonly PointLike[], opts: RoutingOptions = {}): Promise<ComputedRoute> {
  const pts = stops.map(toPoint);
  if (pts.length < 2) return straightLineRoute(pts, 'too_few_points');
  const apiKey = opts.apiKey === undefined ? config.google.mapsServerKey : opts.apiKey;
  if (!apiKey) return straightLineRoute(pts, 'no_api_key');
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch);
  try {
    const parts: ComputedRoute[] = [];
    for (const chunk of chunkWaypoints(pts)) parts.push(await requestChunk(chunk, apiKey, fetchImpl, opts.timeoutMs ?? 10000, opts.trafficAware ?? false));
    if (parts.length === 1) return parts[0]!;
    const path: LatLng[] = [];
    for (const part of parts) {
      const decoded = decodePolyline(part.polyline);
      path.push(...(path.length ? decoded.slice(1) : decoded));
    }
    return {
      polyline: encodePolyline(path),
      distanceM: parts.reduce((s, p) => s + p.distanceM, 0),
      durationS: parts.reduce((s, p) => s + p.durationS, 0),
      legs: parts.flatMap((p) => p.legs),
      source: 'google',
    };
  } catch (err) {
    log.warn({ err: { message: (err as Error).message }, stops: pts.length }, 'Google routing failed; using straight-line fallback');
    return straightLineRoute(pts, 'api_error');
  }
}
