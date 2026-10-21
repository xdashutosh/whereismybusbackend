// Geo helpers and Google routing (with a fake fetch — no network): distances, encoded polylines,
// projection onto a route, bounding boxes, straight-line fallback, chunking of long routes.
import { describe, expect, it } from 'vitest';
import { boundingBox, boundsOf, decodePolyline, encodePolyline, haversineMeters, polylineLengthM, projectOnPolyline, withinRadius, bearingDeg } from '../src/shared/geo.js';
import { chunkWaypoints, computeRoute, MAX_POINTS_PER_REQUEST, ROUTES_API_URL, straightLineRoute, type FetchLike } from '../src/shared/routing.js';

describe('geo', () => {
  it('computes great-circle distances', () => {
    // Bengaluru MG Road → Majestic ≈ 4.4 km
    const d = haversineMeters({ lat: 12.9755, lng: 77.6066 }, [12.9767, 77.5713]);
    expect(d).toBeGreaterThan(3700);
    expect(d).toBeLessThan(3900);
    expect(haversineMeters([0, 0], [0, 1])).toBeCloseTo(111195, -2);
    expect(withinRadius([12.97, 77.59], [12.9705, 77.59], 100)).toBe(true);
    expect(withinRadius([12.97, 77.59], [12.972, 77.59], 100)).toBe(false);
    expect(Math.round(bearingDeg([0, 0], [1, 0]))).toBe(0);
    expect(Math.round(bearingDeg([0, 0], [0, 1]))).toBe(90);
  });

  it('encodes/decodes Google polylines (reference example)', () => {
    const pts = [
      { lat: 38.5, lng: -120.2 },
      { lat: 40.7, lng: -120.95 },
      { lat: 43.252, lng: -126.453 },
    ];
    expect(encodePolyline(pts)).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@')).toEqual(pts);
    expect(decodePolyline('')).toEqual([]);
  });

  it('projects a fix onto a route: progress, deviation, ratio and loop disambiguation', () => {
    const route = [
      [0, 0],
      [0, 0.01],
      [0.01, 0.01],
    ] as const;
    const total = polylineLengthM(route);
    const p = projectOnPolyline([0.0005, 0.005], route);
    expect(p.segmentIndex).toBe(0);
    expect(p.progressM).toBeCloseTo(556, -1);
    expect(p.distanceFromRouteM).toBeCloseTo(55.6, 0);
    expect(p.totalM).toBeCloseTo(total, 3);
    expect(p.progressRatio).toBeCloseTo(p.progressM / total, 6);
    const end = projectOnPolyline([0.02, 0.01], route);
    expect(end.progressM).toBeCloseTo(total, 3);
    expect(end.projected).toEqual({ lat: 0.01, lng: 0.01 });
    // Out-and-back: the hint picks the return leg.
    const outAndBack = [
      [0, 0],
      [0, 0.01],
      [0, 0],
    ] as const;
    expect(projectOnPolyline([0, 0.004], outAndBack).progressM).toBeLessThan(1000);
    expect(projectOnPolyline([0, 0.004], outAndBack, { hintProgressM: 1600 }).progressM).toBeGreaterThan(1000);
    expect(() => projectOnPolyline([0, 0], [])).toThrow(RangeError);
  });

  it('builds bounding boxes', () => {
    const box = boundingBox([12.97, 77.59], 1000);
    expect(box.maxLat - box.minLat).toBeCloseTo(0.018, 3);
    expect(box.maxLng).toBeGreaterThan(77.59);
    expect(boundingBox([89.999, 0], 5000)).toMatchObject({ minLng: -180, maxLng: 180 });
    expect(() => boundingBox([100, 0], 10)).toThrow(RangeError);
    expect(boundsOf([[1, 2], { lat: -1, lng: 5 }])).toEqual({ minLat: -1, maxLat: 1, minLng: 2, maxLng: 5 });
    expect(boundsOf([])).toBeNull();
  });
});

const stops = [
  { lat: 12.9716, lng: 77.5946 },
  { lat: 12.9352, lng: 77.6245 },
  { lat: 12.9141, lng: 77.6101 },
];

function fakeGoogle(record: { url: string; headers: Record<string, string>; body: unknown }[], { fail = false } = {}): FetchLike {
  return async (url, init) => {
    const body = JSON.parse(init.body) as { origin: unknown; destination: unknown; intermediates: unknown[] };
    record.push({ url, headers: init.headers, body });
    if (fail) return { ok: false, status: 403, json: async () => ({ error: { message: 'denied' } }) };
    const n = body.intermediates.length + 2;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        routes: [
          {
            distanceMeters: 1000 * (n - 1),
            duration: `${120 * (n - 1)}s`,
            polyline: { encodedPolyline: encodePolyline(Array.from({ length: n }, (_, i) => [12.9 + i * 0.001, 77.6])) },
            legs: Array.from({ length: n - 1 }, () => ({ distanceMeters: 1000, duration: '120s' })),
          },
        ],
      }),
    };
  };
}

describe('routing', () => {
  it('falls back to a flagged straight line without an API key', async () => {
    const r = await computeRoute(stops, { apiKey: null });
    expect(r).toMatchObject({ source: 'straight', fallbackReason: 'no_api_key' });
    expect(decodePolyline(r.polyline)).toHaveLength(3);
    expect(r.legs).toHaveLength(2);
    expect(r.distanceM).toBe(r.legs[0]!.distanceM + r.legs[1]!.distanceM);
    expect(r.durationS).toBeGreaterThan(0);
    expect((await computeRoute([stops[0]!])).fallbackReason).toBe('too_few_points');
  });

  it('calls computeRoutes with stops as intermediates and the field mask', async () => {
    const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
    const r = await computeRoute(stops, { apiKey: 'test-key', fetchImpl: fakeGoogle(calls) });
    expect(r).toMatchObject({ source: 'google', distanceM: 2000, durationS: 240 });
    expect(r.fallbackReason).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(ROUTES_API_URL);
    expect(calls[0]!.headers['X-Goog-Api-Key']).toBe('test-key');
    expect(calls[0]!.headers['X-Goog-FieldMask']).toContain('routes.polyline.encodedPolyline');
    expect(calls[0]!.body).toMatchObject({ travelMode: 'DRIVE', intermediates: [{ location: { latLng: { latitude: 12.9352, longitude: 77.6245 } } }] });
  });

  it('chunks long routes and stitches legs and polylines', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ lat: 12.9 + i * 0.001, lng: 77.6 }));
    expect(chunkWaypoints(many).map((c) => c.length)).toEqual([MAX_POINTS_PER_REQUEST, 14]);
    const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
    const r = await computeRoute(many, { apiKey: 'k', fetchImpl: fakeGoogle(calls) });
    expect(calls).toHaveLength(2);
    expect(r.legs).toHaveLength(39);
    expect(r.distanceM).toBe(39000);
    expect(decodePolyline(r.polyline)).toHaveLength(40);
  });

  it('falls back to a straight line when Google fails', async () => {
    const r = await computeRoute(stops, { apiKey: 'k', fetchImpl: fakeGoogle([], { fail: true }) });
    expect(r).toMatchObject({ source: 'straight', fallbackReason: 'api_error' });
    expect(straightLineRoute(stops, 'api_error').polyline).toBe(r.polyline);
  });
});
