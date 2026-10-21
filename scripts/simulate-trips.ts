// Trip simulator (development / demos): drives seeded drivers through the real driver-app API.
//
//   npx tsx scripts/simulate-trips.ts --base http://localhost:4000/api/v1 --school GWIS-BLR \
//     --drivers gwis.driver,gwis.basavaraj [--force-start] [--direction morning] [--speed 30]
//
// Per driver: sign in (school code + username/phone + password or PIN + a simulated device), resume the
// running trip or start the next due scheduled trip of /driver/home (--force-start: the next startable
// trip whatever its planned time), upload a placeholder odometer photo through the files flow
// (presigned PUT + complete), then walk the planned route (GET /driver/trips/:id/route) posting location
// batches like the app's governor: every moving interval (10 s) while moving, stopped interval (90 s)
// once stopped ≥ stoppedAfterS at a stop, honouring nextIntervalS from the server. One short network
// outage per trip is simulated: points are queued and, on reconnection, the live point is sent first and
// the queue follows as backfill. At the end of the route the trip ends with a higher odometer reading.
// Everything runs in real time (a 5-km route takes ~10–15 minutes at 30 km/h with dwell).
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { cumulativeDistances, decodePolyline, haversineMeters, type LatLng } from '../src/shared/geo.js';

const { values: opt } = parseArgs({
  options: {
    base: { type: 'string', default: process.env.API_BASE_URL ?? 'http://localhost:4000/api/v1' },
    school: { type: 'string', default: 'GWIS-BLR' },
    drivers: { type: 'string', default: 'gwis.driver' },
    password: { type: 'string', default: process.env.SEED_DEFAULT_PASSWORD ?? 'Wimb@12345' },
    pin: { type: 'string' },
    direction: { type: 'string' },
    'force-start': { type: 'boolean', default: false },
    'due-window-min': { type: 'string', default: '15' },
    speed: { type: 'string', default: '30' },
    dwell: { type: 'string', default: '75' },
    'gap-s': { type: 'string', default: '60' },
    'no-gap': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (opt.help) {
  console.log('Options: --base URL --school CODE --drivers u1,u2 (usernames or +91 phones) --password P | --pin 1234 --direction morning|afternoon --force-start --due-window-min 15 --speed 30 --dwell 75 --gap-s 60 --no-gap');
  process.exit(0);
}

const BASE = opt.base.replace(/\/$/, '');
const ORIGIN = new URL(BASE).origin;
const SPEED_KMH = Number(opt.speed);
const DWELL_S = Number(opt.dwell);
const GAP_S = opt['no-gap'] ? 0 : Number(opt['gap-s']);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Session {
  name: string;
  deviceId: string;
  accessToken: string;
  refreshToken: string;
}

interface ApiError extends Error {
  status: number;
  code?: string;
  body?: unknown;
}

function log(s: Session | string, msg: string) {
  console.log(`${new Date().toISOString().slice(11, 19)} [${typeof s === 'string' ? s : s.name}] ${msg}`);
}

async function call<T>(s: Session | null, method: string, path: string, body?: unknown, retried = false): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-App-Name': 'driver_app', 'X-App-Version': '1.0.0' };
  if (s) {
    headers.Authorization = `Bearer ${s.accessToken}`;
    headers['X-Device-Id'] = s.deviceId;
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as { success?: boolean; data?: T; error?: { code: string; message: string } };
  if (res.status === 401 && s && !retried && json.error?.code === 'TOKEN_EXPIRED') {
    await refresh(s);
    return call<T>(s, method, path, body, true);
  }
  if (!res.ok || json.success === false) {
    const err = new Error(`${method} ${path} → ${res.status} ${json.error?.code ?? ''} ${json.error?.message ?? ''}`) as ApiError;
    err.status = res.status;
    err.code = json.error?.code;
    err.body = json;
    throw err;
  }
  return json.data as T;
}

async function refresh(s: Session): Promise<void> {
  const d = await call<{ accessToken: string; refreshToken: string }>(null, 'POST', '/auth/refresh', { refreshToken: s.refreshToken });
  s.accessToken = d.accessToken;
  s.refreshToken = d.refreshToken;
  log(s, 'access token refreshed');
}

async function login(who: string): Promise<Session> {
  const deviceId = `sim-${crypto.createHash('sha256').update(`${opt.school}:${who}`).digest('hex').slice(0, 16)}`;
  const id = who.startsWith('+') ? { phone: who } : { username: who };
  const secret = opt.pin ? { pin: opt.pin } : { password: opt.password };
  const d = await call<{ accessToken: string; refreshToken: string; mustChangePassword?: boolean }>(null, 'POST', '/auth/staff/login', {
    schoolCode: opt.school,
    ...id,
    ...secret,
    device: { deviceId, platform: 'android', model: 'Simulator', appVersion: '1.0.0' },
  });
  if (d.mustChangePassword) throw new Error(`${who} must change the password first (sign in once in the driver app)`);
  return { name: who, deviceId, accessToken: d.accessToken, refreshToken: d.refreshToken };
}

/** A small JPEG "odometer photo" with the reading drawn on it. */
async function odometerJpeg(reading: number): Promise<Buffer> {
  const svg = `<svg width="640" height="360" xmlns="http://www.w3.org/2000/svg"><rect width="640" height="360" fill="#1d2d3e"/>
    <rect x="120" y="120" width="400" height="120" rx="12" fill="#0b0f14" stroke="#7a8a99" stroke-width="4"/>
    <text x="320" y="200" font-size="64" font-family="monospace" fill="#f5f7fa" text-anchor="middle">${reading.toFixed(1)}</text>
    <text x="320" y="320" font-size="20" font-family="sans-serif" fill="#a9b4be" text-anchor="middle">SIMULATED ODOMETER ${new Date().toISOString()}</text></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toBuffer();
}

interface UploadUrl {
  file: { id: string };
  upload: { url: string; method: string; headers: Record<string, string> };
}

async function uploadOdometer(s: Session, entity: { type: 'trip' | 'bus'; id: string }, reading: number, at: LatLng): Promise<string> {
  const bytes = await odometerJpeg(reading);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const d = await call<UploadUrl>(s, 'POST', '/files/upload-url', {
    category: 'odometer',
    entityType: entity.type,
    entityId: entity.id,
    contentType: 'image/jpeg',
    sizeBytes: bytes.length,
    fileName: `odometer-${Date.now()}.jpg`,
    sha256,
    metadata: { capturedAt: new Date().toISOString(), latitude: at.lat, longitude: at.lng, accuracyM: 8, source: 'camera' },
  });
  const target = d.upload.url.startsWith('http') ? d.upload.url : `${ORIGIN}${d.upload.url}`;
  const put = await fetch(target, { method: d.upload.method || 'PUT', headers: d.upload.headers, body: bytes });
  if (!put.ok) throw new Error(`odometer upload PUT failed: ${put.status}`);
  await call(s, 'POST', `/files/${d.file.id}/complete`, { sha256 });
  return d.file.id;
}

interface TripConfig {
  movingIntervalS: number;
  stoppedIntervalS: number;
  movingSpeedKmh: number;
  stoppedAfterS: number;
}
interface DriverTrip {
  id: string;
  status: string;
  direction: string | null;
  busId: string;
  busCode: string | null;
  plannedStartAt: string | null;
  startOdometer: number | null;
  onThisDevice?: boolean;
}
interface HomeTrip extends DriverTrip {
  canStart: boolean;
  blockedReason: string | null;
}
interface Home {
  morning: HomeTrip[];
  afternoon: HomeTrip[];
  activeTrip: DriverTrip | null;
  config: TripConfig;
  buses: { busId: string; lastKnownOdometer?: number | null }[];
}
interface RouteView {
  polyline: string | null;
  stops: { id: string; name: string; sequence: number; lat: number; lng: number }[];
}
interface IngestResult {
  nextIntervalS: number;
  tripStatus: string;
  accepted: number;
  dropped: number;
  backfilled: number;
}
interface Fix {
  t: string;
  lat: number;
  lng: number;
  spd: number;
  hdg: number;
  acc: number;
  bat: number;
  net: string;
  mv: boolean;
}

async function pickTrip(s: Session, home: Home): Promise<{ trip: DriverTrip; started: boolean } | null> {
  if (home.activeTrip) {
    if (home.activeTrip.onThisDevice === false) throw new Error('a trip of this driver is running on another phone');
    return { trip: home.activeTrip, started: true };
  }
  const windowMs = Number(opt['due-window-min']) * 60_000;
  const candidates = [...home.morning, ...home.afternoon]
    .filter((t) => t.status === 'scheduled' && t.canStart && (!opt.direction || t.direction === opt.direction))
    .filter((t) => opt['force-start'] || (t.plannedStartAt !== null && Date.parse(t.plannedStartAt) - windowMs <= Date.now()))
    .sort((a, b) => Date.parse(a.plannedStartAt ?? '') - Date.parse(b.plannedStartAt ?? ''));
  const next = candidates[0];
  if (!next) {
    const blocked = [...home.morning, ...home.afternoon].map((t) => `${t.direction}:${t.status}${t.blockedReason ? `(${t.blockedReason})` : ''}@${t.plannedStartAt ?? '-'}`);
    log(s, `no due trip to start (${blocked.join(', ') || 'no trips today'}); use --force-start to start the next one now`);
    return null;
  }
  return { trip: next, started: false };
}

function heading(a: LatLng, b: LatLng): number {
  const y = Math.sin(((b.lng - a.lng) * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180);
  const x = Math.cos((a.lat * Math.PI) / 180) * Math.sin((b.lat * Math.PI) / 180) - Math.sin((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.cos(((b.lng - a.lng) * Math.PI) / 180);
  return Math.round(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360);
}

/** Position at distance d (m) along the polyline. */
function along(points: LatLng[], cum: number[], d: number): { p: LatLng; hdg: number } {
  const total = cum[cum.length - 1] ?? 0;
  const dist = Math.min(Math.max(0, d), total);
  let i = 1;
  while (i < cum.length - 1 && cum[i]! < dist) i += 1;
  const a = points[i - 1]!;
  const b = points[i] ?? a;
  const seg = cum[i]! - cum[i - 1]! || 1;
  const f = (dist - cum[i - 1]!) / seg;
  return { p: { lat: a.lat + f * (b.lat - a.lat), lng: a.lng + f * (b.lng - a.lng) }, hdg: heading(a, b) };
}

async function drive(s: Session, trip: DriverTrip, config: TripConfig): Promise<{ lastFix: LatLng; distanceM: number }> {
  const route = await call<RouteView>(s, 'GET', `/driver/trips/${trip.id}/route`);
  const points = route.polyline ? decodePolyline(route.polyline) : route.stops.map((x) => ({ lat: x.lat, lng: x.lng }));
  if (points.length < 2) throw new Error('the trip has no route geometry to drive');
  const cum = cumulativeDistances(points);
  const total = cum[cum.length - 1]!;
  // Distance of each stop along the path (nearest vertex — stops are path vertices).
  const stopAt = route.stops.map((st) => cum[points.reduce((best, p, i) => (haversineMeters(p, st) < haversineMeters(points[best]!, st) ? i : best), 0)]!).sort((a, b) => a - b);
  log(s, `driving ${trip.busCode ?? trip.busId} ${trip.direction ?? ''}: ${(total / 1000).toFixed(1)} km, ${route.stops.length} stops, ${SPEED_KMH} km/h`);

  let d = 0;
  let battery = 92;
  let nextStop = stopAt.findIndex((x) => x > 1);
  let dwellUntil = 0;
  let dwellStart = 0;
  let serverInterval = config.movingIntervalS;
  const gapStartM = GAP_S > 0 ? total * 0.4 : Infinity;
  let gapUntil = 0;
  const queue: Fix[] = [];
  let last: LatLng;
  let lastTick = Date.now();
  for (;;) {
    const now = Date.now();
    // Advance along the route for the time spent moving since the previous tick.
    const movingMs = Math.max(0, now - Math.max(lastTick, dwellUntil));
    lastTick = now;
    if (now >= dwellUntil) {
      d = Math.min(total, d + (SPEED_KMH / 3.6) * (movingMs / 1000));
      if (nextStop >= 0 && nextStop < stopAt.length && d >= stopAt[nextStop]!) {
        d = stopAt[nextStop]!;
        nextStop += 1;
        dwellStart = now;
        dwellUntil = now + DWELL_S * 1000;
        log(s, `at stop ${nextStop}/${stopAt.length} for ${DWELL_S} s`);
      }
    }
    const atStop = now < dwellUntil;
    const { p, hdg } = along(points, cum, d);
    const spd = atStop ? 0 : Math.max(5, SPEED_KMH + (Math.random() * 4 - 2));
    const fix: Fix = { t: new Date(now).toISOString(), lat: p.lat, lng: p.lng, spd: Math.round(spd * 10) / 10, hdg, acc: 5 + Math.round(Math.random() * 6), bat: Math.round(battery), net: '4g', mv: !atStop };
    last = p;
    if (gapUntil === 0 && d >= gapStartM) {
      gapUntil = now + GAP_S * 1000;
      log(s, `network lost for ${GAP_S} s (queueing points)`);
    }
    if (gapUntil > now) queue.push({ ...fix, net: 'none' });
    else {
      // Live point first, then the offline queue (older points → server-side backfill).
      const r = await call<IngestResult>(s, 'POST', `/driver/trips/${trip.id}/locations`, { device_id: s.deviceId, points: [fix] });
      if (queue.length) {
        const back = await call<IngestResult>(s, 'POST', `/driver/trips/${trip.id}/locations`, { device_id: s.deviceId, points: queue.splice(0) });
        log(s, `network back: ${back.accepted} queued points stored (${back.backfilled} as backfill, ${back.dropped} dropped)`);
      }
      if (r.tripStatus !== 'in_progress') {
        log(s, `server says the trip is ${r.tripStatus}; stopping`);
        return { lastFix: last, distanceM: d };
      }
      serverInterval = r.nextIntervalS;
    }
    if (d >= total && !atStop) break;
    // App governor: 10 s while moving; once stopped ≥ stoppedAfterS, the stopped interval (or the
    // server's nextIntervalS), but wake up when the dwell ends (first fast sample → 10 s again).
    const stopped = atStop && now - dwellStart >= config.stoppedAfterS * 1000;
    let waitMs = config.movingIntervalS * 1000;
    if (stopped) waitMs = Math.max(waitMs, Math.min(Math.max(serverInterval, config.stoppedIntervalS) * 1000, dwellUntil - now));
    await sleep(Math.max(config.movingIntervalS * 1000, waitMs));
    battery = Math.max(15, battery - 0.05);
  }
  if (queue.length) await call(s, 'POST', `/driver/trips/${trip.id}/locations`, { device_id: s.deviceId, points: queue.splice(0) });
  return { lastFix: last, distanceM: total };
}

async function runDriver(who: string): Promise<void> {
  const s = await login(who);
  log(s, `signed in (${opt.school}, device ${s.deviceId})`);
  const home = await call<Home>(s, 'GET', '/driver/home');
  const picked = await pickTrip(s, home);
  if (!picked) return;
  let trip = picked.trip;
  const config = home.config;
  const route = await call<RouteView>(s, 'GET', `/driver/trips/${trip.id}/route`);
  const first = route.polyline ? decodePolyline(route.polyline)[0]! : { lat: route.stops[0]!.lat, lng: route.stops[0]!.lng };
  let startReading = trip.startOdometer ?? 0;
  if (!picked.started) {
    const known = home.buses.find((b) => b.busId === trip.busId)?.lastKnownOdometer ?? 10_000;
    startReading = Math.round((Number(known) + Math.random() * 0.4) * 10) / 10;
    const fileId = await uploadOdometer(s, { type: 'trip', id: trip.id }, startReading, first);
    const started = await call<{ trip: DriverTrip; config: TripConfig; alerts: { type: string; title: string }[] }>(s, 'POST', '/driver/trips/start', {
      clientStartId: crypto.randomUUID(),
      tripId: trip.id,
      busId: trip.busId,
      odometerReading: startReading,
      odometerFileId: fileId,
      latitude: first.lat,
      longitude: first.lng,
      accuracyM: 8,
      deviceTime: new Date().toISOString(),
    });
    trip = started.trip;
    log(s, `trip ${trip.id} started at odometer ${startReading}${started.alerts.length ? ` (alerts: ${started.alerts.map((a) => a.type).join(', ')})` : ''}`);
  } else {
    log(s, `resuming trip ${trip.id}`);
  }
  const { lastFix, distanceM } = await drive(s, trip, config);
  const endReading = Math.round((startReading + distanceM / 1000 + 0.1 + Math.random() * 0.3) * 10) / 10;
  const endFile = await uploadOdometer(s, { type: 'trip', id: trip.id }, endReading, lastFix);
  const ended = await call<{ trip: DriverTrip & { distanceOdometerKm: number | null; distanceGpsKm: number | null }; alerts: { type: string }[] }>(s, 'POST', `/driver/trips/${trip.id}/end`, {
    odometerReading: endReading,
    odometerFileId: endFile,
    latitude: lastFix.lat,
    longitude: lastFix.lng,
    accuracyM: 6,
    deviceTime: new Date().toISOString(),
    pendingPoints: 0,
  });
  log(s, `trip ended at odometer ${endReading}: odometer ${ended.trip.distanceOdometerKm} km, GPS ${ended.trip.distanceGpsKm} km${ended.alerts.length ? `, alerts: ${ended.alerts.map((a) => a.type).join(', ')}` : ''}`);
}

const drivers = opt.drivers.split(',').map((x) => x.trim()).filter(Boolean);
const results = await Promise.allSettled(drivers.map((d) => runDriver(d)));
let failed = 0;
results.forEach((r, i) => {
  if (r.status === 'rejected') {
    failed += 1;
    console.error(`[${drivers[i]}] failed: ${(r.reason as Error).message}`);
  }
});
process.exit(failed ? 1 : 0);
