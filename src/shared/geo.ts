// Geographic helpers (BP §9.5, §10.3, §11): haversine distances, Google encoded polylines,
// projection of a GPS fix onto a route polyline (progress along the route + distance from it),
// bounding boxes. Projections use a local equirectangular approximation (well under 1 % error at
// route-segment scale). Points are { lat, lng } objects or [lat, lng] tuples.
import polylineCodec from '@googlemaps/polyline-codec';

export const EARTH_RADIUS_M = 6371008.8;
const DEG = Math.PI / 180;

export interface LatLng {
  lat: number;
  lng: number;
}
export type PointLike = LatLng | readonly [number, number];

export function toPoint(p: PointLike): LatLng {
  if (Array.isArray(p)) return { lat: Number(p[0]), lng: Number(p[1]) };
  const o = p as LatLng;
  return { lat: Number(o.lat), lng: Number(o.lng) };
}

export function isValidCoordinate(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

/** Great-circle distance in metres. */
export function haversineMeters(a: PointLike, b: PointLike): number {
  const p = toPoint(a);
  const q = toPoint(b);
  const dLat = (q.lat - p.lat) * DEG;
  const dLng = (q.lng - p.lng) * DEG;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(p.lat * DEG) * Math.cos(q.lat * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** True when `point` lies within radiusM of `center` (stop geofence). */
export function withinRadius(point: PointLike, center: PointLike, radiusM: number): boolean {
  return haversineMeters(point, center) <= radiusM;
}

/** Initial bearing from a to b in degrees [0, 360). */
export function bearingDeg(a: PointLike, b: PointLike): number {
  const p = toPoint(a);
  const q = toPoint(b);
  const y = Math.sin((q.lng - p.lng) * DEG) * Math.cos(q.lat * DEG);
  const x = Math.cos(p.lat * DEG) * Math.sin(q.lat * DEG) - Math.sin(p.lat * DEG) * Math.cos(q.lat * DEG) * Math.cos((q.lng - p.lng) * DEG);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

// ── encoded polylines (Google format, precision 5) ───────────────────────────
export function encodePolyline(points: readonly PointLike[], precision = 5): string {
  return polylineCodec.encode(
    points.map((p) => {
      const q = toPoint(p);
      return [q.lat, q.lng] as [number, number];
    }),
    precision,
  );
}

export function decodePolyline(encoded: string, precision = 5): LatLng[] {
  if (!encoded) return [];
  return polylineCodec.decode(encoded, precision).map(([lat, lng]) => ({ lat, lng }));
}

/** Cumulative distance per vertex: [0, d01, d01+d12, …] in metres. */
export function cumulativeDistances(points: readonly PointLike[]): number[] {
  const pts = points.map(toPoint);
  const out = new Array<number>(pts.length);
  let total = 0;
  for (let i = 0; i < pts.length; i += 1) {
    if (i > 0) total += haversineMeters(pts[i - 1]!, pts[i]!);
    out[i] = total;
  }
  return out;
}

export function polylineLengthM(points: readonly PointLike[]): number {
  const cum = cumulativeDistances(points);
  return cum.length ? cum[cum.length - 1]! : 0;
}

export interface Projection {
  /** Distance along the polyline from its start to the projected point (m). */
  progressM: number;
  /** Total polyline length (m). */
  totalM: number;
  /** Fraction of the route covered (0–1). */
  progressRatio: number;
  segmentIndex: number;
  fraction: number;
  /** Perpendicular distance from the fix to the polyline (m) — route deviation. */
  distanceFromRouteM: number;
  projected: LatLng;
}

/**
 * Projects a fix onto a polyline. `hintProgressM` (previous progress) disambiguates loops and
 * out-and-back routes: among segments almost as close as the best one (within ambiguityM), the
 * one nearest to the hint wins.
 */
export function projectOnPolyline(
  point: PointLike,
  polyline: readonly PointLike[],
  { hintProgressM, ambiguityM = 50 }: { hintProgressM?: number; ambiguityM?: number } = {},
): Projection {
  const p = toPoint(point);
  const pts = polyline.map(toPoint);
  if (pts.length === 0) throw new RangeError('Polyline must contain at least one point');
  const cum = cumulativeDistances(pts);
  const totalM = cum[cum.length - 1]!;
  if (pts.length === 1) {
    return { progressM: 0, totalM: 0, progressRatio: 0, segmentIndex: 0, fraction: 0, distanceFromRouteM: haversineMeters(p, pts[0]!), projected: { ...pts[0]! } };
  }
  const kx = Math.cos(p.lat * DEG) * DEG * EARTH_RADIUS_M;
  const ky = DEG * EARTH_RADIUS_M;
  const proj = (q: LatLng) => ({ x: (q.lng - p.lng) * kx, y: (q.lat - p.lat) * ky });
  const candidates: { i: number; f: number; dist: number; progress: number }[] = [];
  for (let i = 0; i < pts.length - 1; i += 1) {
    const A = proj(pts[i]!);
    const B = proj(pts[i + 1]!);
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const len2 = dx * dx + dy * dy;
    const f = len2 === 0 ? 0 : Math.max(0, Math.min(1, (-A.x * dx - A.y * dy) / len2));
    const dist = Math.hypot(A.x + f * dx, A.y + f * dy);
    candidates.push({ i, f, dist, progress: cum[i]! + f * (cum[i + 1]! - cum[i]!) });
  }
  let best = candidates[0]!;
  for (const c of candidates) if (c.dist < best.dist) best = c;
  if (hintProgressM !== undefined && Number.isFinite(hintProgressM)) {
    const close = candidates.filter((c) => c.dist <= best.dist + ambiguityM);
    best = close.reduce((a, b) => (Math.abs(b.progress - hintProgressM) < Math.abs(a.progress - hintProgressM) ? b : a), close[0]!);
  }
  const a = pts[best.i]!;
  const b = pts[best.i + 1]!;
  return {
    progressM: best.progress,
    totalM,
    progressRatio: totalM > 0 ? best.progress / totalM : 0,
    segmentIndex: best.i,
    fraction: best.f,
    distanceFromRouteM: best.dist,
    projected: { lat: a.lat + best.f * (b.lat - a.lat), lng: a.lng + best.f * (b.lng - a.lng) },
  };
}

export interface BBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/** Box containing every point within radiusM of a centre (index-friendly prefilter). */
export function boundingBox(center: PointLike, radiusM: number): BBox {
  const { lat, lng } = toPoint(center);
  if (!isValidCoordinate(lat, lng)) throw new RangeError('Invalid coordinate');
  if (!(radiusM >= 0)) throw new RangeError('radiusM must be >= 0');
  const dLat = radiusM / EARTH_RADIUS_M / DEG;
  const minLat = Math.max(-90, lat - dLat);
  const maxLat = Math.min(90, lat + dLat);
  const cosLat = Math.cos(lat * DEG);
  if (maxLat >= 90 || minLat <= -90 || cosLat < 1e-6) return { minLat, maxLat, minLng: -180, maxLng: 180 };
  const dLng = Math.min(180, dLat / cosLat);
  const minLng = lng - dLng;
  const maxLng = lng + dLng;
  if (minLng < -180 || maxLng > 180) return { minLat, maxLat, minLng: -180, maxLng: 180 };
  return { minLat, maxLat, minLng, maxLng };
}

/** Bounds of a set of points (map viewport fitting); null for an empty set. */
export function boundsOf(points: readonly PointLike[]): BBox | null {
  if (!points.length) return null;
  const box: BBox = { minLat: Infinity, maxLat: -Infinity, minLng: Infinity, maxLng: -Infinity };
  for (const raw of points) {
    const p = toPoint(raw);
    box.minLat = Math.min(box.minLat, p.lat);
    box.maxLat = Math.max(box.maxLat, p.lat);
    box.minLng = Math.min(box.minLng, p.lng);
    box.maxLng = Math.max(box.maxLng, p.lng);
  }
  return box;
}

/** Rounds a coordinate to `dp` decimals (cache keys: 4 dp ≈ 11 m). */
export function roundCoord(value: number, dp = 5): number {
  const f = 10 ** dp;
  return Math.round(Number(value) * f) / f;
}
