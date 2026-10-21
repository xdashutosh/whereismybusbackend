// Stops (BP §8.3 CRUD /school/routes/:id/stops, PUT …/stops/reorder) and planned polylines (POST
// …/recompute-polyline, contract §2): positions stay 1…n (insert, delete, reorder, concurrency), stop codes
// are unique per route, deletes are blocked by student assignments, geometry changes refresh the path,
// the straight-line fallback (no key / Google error) and the Google Routes request (fake fetch).
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useRoutingOptions } from '../src/modules/routes/polyline.js';
import { decodePolyline } from '../src/shared/geo.js';
import type { FetchLike } from '../src/shared/routing.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { buildApp, loginSchoolAdmin, schoolAdmin, type TestApp } from './helpers/authApp.js';

let t: TestApp;
let schoolId: string;
let token: string;
let plainToken: string;

const SCHOOL = { latitude: 12.9716, longitude: 77.5946 };
const auth = (tk: string) => ({ Authorization: `Bearer ${tk}` });
const api = (path: string) => `/api/v1${path}`;
const post = (path: string, body: object, tk = token) => request(t.app).post(api(path)).set(auth(tk)).send(body);
const patch = (path: string, body: object, tk = token) => request(t.app).patch(api(path)).set(auth(tk)).send(body);
const put = (path: string, body: object, tk = token) => request(t.app).put(api(path)).set(auth(tk)).send(body);
const get = (path: string, tk = token) => request(t.app).get(api(path)).set(auth(tk));
const del = (path: string, tk = token) => request(t.app).delete(api(path)).set(auth(tk));

async function newRoute(direction: 'morning' | 'afternoon' = 'morning', tk = token): Promise<string> {
  const res = await post('/school/routes', { code: `T${f.nextSeq()}`, direction }, tk);
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}
const addStop = (routeId: string, body: Record<string, unknown>, tk = token) => post(`/school/routes/${routeId}/stops`, { latitude: 12.93, longitude: 77.62, ...body }, tk);
const sequences = async (routeId: string) =>
  (await ownerQuery<{ name: string; sequence: number }>('select name, sequence from stops where route_id = $1 and deleted_at is null order by sequence', [routeId])).rows;

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  const school = await f.school(SCHOOL);
  schoolId = school.id;
  token = (await loginSchoolAdmin(t.app, String((await schoolAdmin(schoolId)).email))).accessToken;
  const plain = await f.school({ latitude: null, longitude: null });
  plainToken = (await loginSchoolAdmin(t.app, String((await schoolAdmin(plain.id)).email))).accessToken;
});
afterAll(closeDb);

describe('stop CRUD and positions', () => {
  it('appends stops, inserts at a position and keeps sequences 1…n', async () => {
    const id = await newRoute();
    const a = await addStop(id, { name: 'HSR Layout BDA Complex', code: 'HSR', expectedTime: '07:05', school_id: '00000000-0000-0000-0000-000000000000' });
    expect(a.status).toBe(201);
    expect(a.body.data.stop).toMatchObject({ sequence: 1, name: 'HSR Layout BDA Complex', code: 'HSR', expectedTime: '07:05', arrivalRadiusM: 100, routeId: id });
    await addStop(id, { name: 'Agara Lake', expectedTime: '07:15', arrivalRadiusM: 150 });
    const first = await addStop(id, { name: 'Silk Board', sequence: 1, expectedTime: '07:00' });
    expect(first.body.data.stop.sequence).toBe(1);
    expect(await sequences(id)).toEqual([
      { name: 'Silk Board', sequence: 1 },
      { name: 'HSR Layout BDA Complex', sequence: 2 },
      { name: 'Agara Lake', sequence: 3 },
    ]);
    expect(first.body.data.route.stops.map((s: { name: string }) => s.name)).toEqual(['Silk Board', 'HSR Layout BDA Complex', 'Agara Lake']);
    expect((await addStop(id, { name: 'Too far', sequence: 5 })).status).toBe(400);
    const row = await ownerQuery('select school_id from stops where id = $1', [a.body.data.stop.id]);
    expect(row.rows[0]!.school_id).toBe(schoolId);
    const list = await get(`/school/routes/${id}/stops`);
    expect(list.body.data.map((s: { sequence: number }) => s.sequence)).toEqual([1, 2, 3]);
    const one = await get(`/school/routes/${id}/stops/${a.body.data.stop.id}`);
    expect(one.body.data.name).toBe('HSR Layout BDA Complex');
  });

  it('stop codes are unique per route (case-insensitive) and validated', async () => {
    const id = await newRoute();
    await addStop(id, { name: 'One', code: 'S1' });
    const dup = await addStop(id, { name: 'Two', code: 's1' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE');
    expect((await addStop(await newRoute(), { name: 'Elsewhere', code: 'S1' })).status).toBe(201);
    const bad = await post(`/school/routes/${id}/stops`, { name: '', latitude: 91, longitude: 'x', arrivalRadiusM: 5, expectedTime: '25:00' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(['arrivalRadiusM', 'expectedTime', 'latitude', 'longitude', 'name']);
  });

  it('updates a stop; renaming keeps the planned path, moving it recomputes', async () => {
    const id = await newRoute();
    const s1 = await addStop(id, { name: 'A', latitude: 12.91, longitude: 77.6 });
    await addStop(id, { name: 'B', latitude: 12.92, longitude: 77.61 });
    const before = (await ownerQuery<{ polyline_encoded: string; polyline_computed_at: string }>('select polyline_encoded, polyline_computed_at from routes where id = $1', [id])).rows[0]!;
    const renamed = await patch(`/school/routes/${id}/stops/${s1.body.data.stop.id}`, { name: 'A Renamed', expectedTime: '06:55' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data.stop).toMatchObject({ name: 'A Renamed', expectedTime: '06:55', sequence: 1 });
    const same = (await ownerQuery('select polyline_encoded, polyline_computed_at from routes where id = $1', [id])).rows[0]!;
    expect(same).toEqual(before);
    const moved = await patch(`/school/routes/${id}/stops/${s1.body.data.stop.id}`, { latitude: 12.905, longitude: 77.595 });
    expect(decodePolyline(moved.body.data.route.polylineEncoded)[0]).toEqual({ lat: 12.905, lng: 77.595 });
    const audit = await ownerQuery<{ new_values: Record<string, unknown> }>("select new_values from audit_logs where action = 'stop.update' and entity_id = $1 order by id", [s1.body.data.stop.id]);
    expect(audit.rows.map((r) => r.new_values)).toEqual([{ name: 'A Renamed', expectedTime: '06:55' }, { latitude: 12.905, longitude: 77.595 }]);
  });

  it('deletes a stop and closes the gap; stops with assigned students cannot be deleted', async () => {
    const id = await newRoute();
    const ids: string[] = [];
    for (const name of ['P', 'Q', 'R', 'S']) ids.push((await addStop(id, { name })).body.data.stop.id);
    const res = await del(`/school/routes/${id}/stops/${ids[1]}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: ids[1], deleted: true });
    expect(await sequences(id)).toEqual([{ name: 'P', sequence: 1 }, { name: 'R', sequence: 2 }, { name: 'S', sequence: 3 }]);
    expect((await get(`/school/routes/${id}/stops/${ids[1]}`)).status).toBe(404);

    const bus = await f.bus(schoolId);
    const student = await f.student(schoolId);
    await f.studentAssignment(schoolId, { studentId: student.id, busId: bus.id, routeId: id, stopId: ids[2]! });
    const blocked = await del(`/school/routes/${id}/stops/${ids[2]}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatchObject({ code: 'CONFLICT', details: { studentAssignments: 1 } });
    expect((await get(`/school/routes/${id}`)).body.data.stops.find((s: { id: string }) => s.id === ids[2]).studentCount).toBe(1);
  });

  it('caps the number of stops per route', async () => {
    const id = await newRoute();
    await ownerQuery(
      `insert into stops (school_id, route_id, name, sequence, latitude, longitude)
       select $1, $2, 'Stop ' || g, g, 12.9 + g / 1000.0, 77.6 from generate_series(1, 60) g`,
      [schoolId, id],
    );
    const res = await addStop(id, { name: 'One more' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'INVALID_STATE', details: { maxStops: 60 } });
  });
});

describe('reorder', () => {
  it('applies a permutation in one statement and validates the id set', async () => {
    const id = await newRoute();
    const ids: string[] = [];
    for (const [i, name] of ['W', 'X', 'Y', 'Z'].entries()) ids.push((await addStop(id, { name, latitude: 12.9 + i / 100, longitude: 77.6 })).body.data.stop.id);
    const order = [ids[3]!, ids[1]!, ids[0]!, ids[2]!];
    const res = await put(`/school/routes/${id}/stops/reorder`, { stopIds: order });
    expect(res.status).toBe(200);
    expect(res.body.data.stops.map((s: { id: string }) => s.id)).toEqual(order);
    expect(await sequences(id)).toEqual([{ name: 'Z', sequence: 1 }, { name: 'X', sequence: 2 }, { name: 'W', sequence: 3 }, { name: 'Y', sequence: 4 }]);
    expect(decodePolyline(res.body.data.polylineEncoded)[0]).toEqual({ lat: 12.93, lng: 77.6 });

    const missing = await put(`/school/routes/${id}/stops/reorder`, { stopIds: order.slice(0, 3) });
    expect(missing.status).toBe(400);
    expect(missing.body.error.details).toEqual([{ path: 'stopIds', message: `Missing stop ${ids[2]}` }]);
    const foreign = (await addStop(await newRoute(), { name: 'Other' })).body.data.stop.id as string;
    const unknown = await put(`/school/routes/${id}/stops/reorder`, { stopIds: [...order, foreign] });
    expect(unknown.body.error.details).toEqual([{ path: 'stopIds', message: `Unknown stop ${foreign}` }]);
    expect((await put(`/school/routes/${id}/stops/reorder`, { stopIds: [ids[0], ids[0], ids[1], ids[2]] })).status).toBe(400);
    const audits = async () => (await ownerQuery<{ n: number }>("select count(*)::int as n from audit_logs where action = 'stop.reorder' and entity_id = $1", [id])).rows[0]!.n;
    const n = await audits();
    expect((await put(`/school/routes/${id}/stops/reorder`, { stopIds: order })).status).toBe(200);
    expect(await audits()).toBe(n);
  });

  it('keeps sequences contiguous and unique under concurrent inserts, deletes and reorders', async () => {
    const id = await newRoute();
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) ids.push((await addStop(id, { name: `C${i}`, latitude: 12.9 + i / 100, longitude: 77.6 })).body.data.stop.id);
    const ops = [
      put(`/school/routes/${id}/stops/reorder`, { stopIds: [...ids].reverse() }),
      addStop(id, { name: 'N1', sequence: 2 }),
      addStop(id, { name: 'N2', sequence: 1 }),
      del(`/school/routes/${id}/stops/${ids[2]}`),
      addStop(id, { name: 'N3' }),
      put(`/school/routes/${id}/stops/reorder`, { stopIds: ids }),
    ];
    const results = await Promise.all(ops);
    for (const r of results) expect([200, 201, 400]).toContain(r.status);
    const seq = await sequences(id);
    expect(seq.map((s) => s.sequence)).toEqual(seq.map((_, i) => i + 1));
    expect(seq.map((s) => s.name)).toEqual(expect.arrayContaining(['N1', 'N2', 'N3']));
    expect(seq).toHaveLength(8);
  });
});

interface SentRequest {
  url: string;
  headers: Record<string, string>;
  body: { origin: unknown; destination: unknown; intermediates: unknown[] };
}

/** Fake Routes API: one leg per waypoint pair, 1 km / 3 min each; `status` ≠ 200 simulates an error. */
function fakeGoogle(status = 200, onCall?: () => Promise<void>): { fetchImpl: FetchLike; sent: SentRequest[] } {
  const sent: SentRequest[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body) as SentRequest['body'];
    sent.push({ url, headers: init.headers, body });
    if (onCall) await onCall();
    const legs = body.intermediates.length + 1;
    return {
      ok: status === 200,
      status,
      json: async () => ({
        routes: [{ distanceMeters: legs * 1000, duration: `${legs * 180}s`, polyline: { encodedPolyline: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' }, legs: Array.from({ length: legs }, () => ({ distanceMeters: 1000, duration: '180s' })) }],
      }),
    };
  };
  return { fetchImpl, sent };
}

describe('planned polyline', () => {
  it('uses the flagged straight line through the stops and the school without a server key', async () => {
    const id = await newRoute('morning');
    await addStop(id, { name: 'A', latitude: 12.95, longitude: 77.64 });
    const second = await addStop(id, { name: 'B', latitude: 12.96, longitude: 77.62 });
    const route = second.body.data.route;
    expect(route).toMatchObject({ polylineSource: 'straight', warnings: ['polyline_straight'] });
    expect(decodePolyline(route.polylineEncoded)).toEqual([{ lat: 12.95, lng: 77.64 }, { lat: 12.96, lng: 77.62 }, { lat: 12.9716, lng: 77.5946 }]);
    expect(route.distanceM).toBeGreaterThan(3000);

    const res = await post(`/school/routes/${id}/recompute-polyline`, {});
    expect(res.status).toBe(200);
    expect(res.body.data.routing).toMatchObject({ source: 'straight', fallbackReason: 'no_api_key', includesSchool: true });
    expect(res.body.data.routing.legs.map((l: { fromStopId: string | null; toStopId: string | null }) => [l.fromStopId, l.toStopId])).toEqual([
      [route.stops[0].id, route.stops[1].id],
      [route.stops[1].id, null],
    ]);
    const audit = await ownerQuery("select new_values from audit_logs where action = 'route.polyline_recompute' and entity_id = $1 order by id desc limit 1", [id]);
    expect(audit.rows[0]!.new_values).toMatchObject({ polylineSource: 'straight', trigger: 'manual', points: 3, fallbackReason: 'no_api_key' });
  });

  it('starts an afternoon route at the school and merges a stop at the school gate', async () => {
    const pm = await newRoute('afternoon');
    await addStop(pm, { name: 'Gate', latitude: 12.9717, longitude: 77.5947 });
    const res = await addStop(pm, { name: 'Far', latitude: 12.99, longitude: 77.6 });
    expect(decodePolyline(res.body.data.route.polylineEncoded)).toEqual([{ lat: 12.9717, lng: 77.5947 }, { lat: 12.99, lng: 77.6 }]);
    const am = await newRoute('afternoon');
    const one = await addStop(am, { name: 'Only', latitude: 12.95, longitude: 77.6 });
    expect(decodePolyline(one.body.data.route.polylineEncoded)).toEqual([{ lat: 12.9716, lng: 77.5946 }, { lat: 12.95, lng: 77.6 }]);
  });

  it('needs two points; dropping below two clears the stored path', async () => {
    const empty = await newRoute('morning', plainToken);
    const none = await post(`/school/routes/${empty}/recompute-polyline`, {}, plainToken);
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe('INVALID_STATE');
    const a = await addStop(empty, { name: 'A' }, plainToken);
    expect(a.body.data.route).toMatchObject({ polylineSource: null, school: null, warnings: ['too_few_stops'] });
    const b = await addStop(empty, { name: 'B', latitude: 12.94 }, plainToken);
    expect(b.body.data.route.polylineSource).toBe('straight');
    const gone = await del(`/school/routes/${empty}/stops/${b.body.data.stop.id}`, plainToken);
    expect(gone.body.data.route).toMatchObject({ polylineSource: null, polylineEncoded: null, distanceM: null });
  });

  it('calls Google Routes with the stops as intermediates once a server key is configured', async () => {
    const id = await newRoute('morning');
    for (const [i, name] of ['G1', 'G2', 'G3'].entries()) await addStop(id, { name, latitude: 12.9 + i / 100, longitude: 77.6 });
    const google = fakeGoogle();
    const restore = useRoutingOptions({ apiKey: 'test-server-key', fetchImpl: google.fetchImpl });
    try {
      const res = await post(`/school/routes/${id}/recompute-polyline`, {});
      expect(res.status).toBe(200);
      expect(res.body.data.routing).toMatchObject({ source: 'google', fallbackReason: null, distanceM: 3000, durationS: 540, includesSchool: true });
      expect(res.body.data.route).toMatchObject({ polylineSource: 'google', polylineEncoded: '_p~iF~ps|U_ulLnnqC_mqNvxq`@', distanceM: 3000, durationS: 540, warnings: [] });
      expect(google.sent).toHaveLength(1);
      expect(google.sent[0]!.url).toBe('https://routes.googleapis.com/directions/v2:computeRoutes');
      expect(google.sent[0]!.headers['X-Goog-Api-Key']).toBe('test-server-key');
      expect(google.sent[0]!.body.intermediates).toHaveLength(2);
      expect(google.sent[0]!.body.destination).toEqual({ location: { latLng: { latitude: 12.9716, longitude: 77.5946 } } });
    } finally {
      restore();
    }
  });

  it('falls back to the straight line when Google answers with an error (e.g. API not enabled)', async () => {
    const id = await newRoute('morning');
    await addStop(id, { name: 'E1', latitude: 12.91, longitude: 77.6 });
    const google = fakeGoogle(403);
    const restore = useRoutingOptions({ apiKey: 'test-server-key', fetchImpl: google.fetchImpl });
    try {
      const res = await addStop(id, { name: 'E2', latitude: 12.92, longitude: 77.6 });
      expect(google.sent).toHaveLength(1);
      expect(res.body.data.route.polylineSource).toBe('straight');
      const manual = await post(`/school/routes/${id}/recompute-polyline`, {});
      expect(manual.body.data.routing).toMatchObject({ source: 'straight', fallbackReason: 'api_error' });
    } finally {
      restore();
    }
  });

  it('refuses to store a path computed for stops that changed meanwhile', async () => {
    const id = await newRoute('morning');
    const s = await addStop(id, { name: 'M1', latitude: 12.91, longitude: 77.6 });
    await addStop(id, { name: 'M2', latitude: 12.92, longitude: 77.6 });
    const before = (await ownerQuery('select polyline_encoded from routes where id = $1', [id])).rows[0]!.polyline_encoded as string;
    const google = fakeGoogle(200, async () => {
      await ownerQuery('update stops set latitude = 12.915 where id = $1', [s.body.data.stop.id]);
    });
    const restore = useRoutingOptions({ apiKey: 'test-server-key', fetchImpl: google.fetchImpl });
    try {
      const res = await post(`/school/routes/${id}/recompute-polyline`, {});
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
      expect((await ownerQuery('select polyline_encoded from routes where id = $1', [id])).rows[0]!.polyline_encoded).toBe(before);
    } finally {
      restore();
    }
  });
});
