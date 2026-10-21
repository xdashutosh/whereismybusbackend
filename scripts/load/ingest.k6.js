// k6 load test — GPS ingest (POST /driver/trips/:id/locations) and Socket.IO fan-out (BP §17 "Load tests").
// Full guide (preparing running trips, rate limits, reading the results): docs/OPERATIONS.md §4.
//
//   k6 run scripts/load/ingest.k6.js \
//     -e BASE_URL=https://staging-api.example.com -e SCHOOL_CODE=GWIS-BLR \
//     -e DRIVERS=gwis.driver,gwis.basavaraj -e PIN=1234 \
//     -e ADMIN_EMAIL=admin@greenwood.example -e ADMIN_PASSWORD=… -e WATCHERS=50 -e DURATION=5m
//
// Each ingest VU signs in as one driver with the simulator's device id (scripts/simulate-trips.ts),
// takes that driver's running trip (start it first with the simulator or the driver app) and posts one live
// fix every INTERVAL_S seconds, like the app's governor. Each watcher VU holds one Socket.IO connection to
// /rt as the school admin, joins school:{id}:fleet and measures how long live:position takes to arrive.
// Never point it at production with real parents: the fixes move the bus on every parent's map.
import http from 'k6/http';
import ws from 'k6/ws';
import exec from 'k6/execution';
import { check, fail, sleep } from 'k6';
import { sha256 } from 'k6/crypto';
import { Counter, Rate, Trend } from 'k6/metrics';
import { decodeFrame, encodeConnect, encodeEvent, PONG, SIO, socketUrl, trackPoint } from './sio.js';

const BASE = (__ENV.BASE_URL || 'http://localhost:4000').replace(/\/+$/, '');
const API = `${BASE}/api/v1`;
const SCHOOL = __ENV.SCHOOL_CODE || 'GWIS-BLR';
const DRIVERS = (__ENV.DRIVERS || 'gwis.driver').split(',').map((s) => s.trim()).filter(Boolean);
const VUS_PER_TRIP = Math.max(1, Number(__ENV.VUS_PER_TRIP || 1));
const WATCHERS = __ENV.ADMIN_EMAIL ? Math.max(0, Number(__ENV.WATCHERS || 10)) : 0;
const DURATION = __ENV.DURATION || '5m';
const INTERVAL_S = Math.max(1, Number(__ENV.INTERVAL_S || 10));
const SPEED_KMH = Number(__ENV.SPEED_KMH || 30);
const P95_MS = Number(__ENV.P95_MS || 500);
// Must satisfy platform setting min_supported_version.driver_app (else 426 APP_UPDATE_REQUIRED).
const APP_VERSION = __ENV.APP_VERSION || '1.0.0';

const ingestAccepted = new Counter('wimb_ingest_points_accepted');
const ingestDropped = new Counter('wimb_ingest_points_dropped');
const ingestOk = new Rate('wimb_ingest_ok');
const fanoutEvents = new Counter('wimb_fanout_live_position');
const fanoutLag = new Trend('wimb_fanout_lag_ms', true);
const socketJoinOk = new Rate('wimb_socket_join_ok');

const scenarios = {
  ingest: { executor: 'constant-vus', exec: 'ingest', vus: DRIVERS.length * VUS_PER_TRIP, duration: DURATION, gracefulStop: '15s' },
};
if (WATCHERS > 0) scenarios.fanout = { executor: 'constant-vus', exec: 'watch', vus: WATCHERS, duration: DURATION, gracefulStop: '15s' };

export const options = {
  scenarios,
  thresholds: {
    'http_req_duration{name:ingest}': [`p(95)<${P95_MS}`],
    wimb_ingest_ok: ['rate>0.99'],
    ...(WATCHERS > 0 ? { wimb_socket_join_ok: ['rate>0.99'], wimb_fanout_lag_ms: ['p(95)<2000'] } : {}),
  },
};

const JSON_HEADERS = { 'Content-Type': 'application/json', 'X-App-Name': 'driver_app', 'X-App-Version': APP_VERSION };

function body(res) {
  try {
    return res.json();
  } catch {
    return {};
  }
}

/** Same device id as the simulator, so a trip it started is "on this device". */
function deviceIdFor(driver) {
  return `sim-${sha256(`${SCHOOL}:${driver}`, 'hex').slice(0, 16)}`;
}

function staffLogin(driver) {
  const deviceId = deviceIdFor(driver);
  const id = driver.startsWith('+') ? { phone: driver } : { username: driver };
  const secret = __ENV.PIN ? { pin: __ENV.PIN } : { password: __ENV.PASSWORD || 'Wimb@12345' };
  const res = http.post(`${API}/auth/staff/login`, JSON.stringify({
    schoolCode: SCHOOL, ...id, ...secret,
    device: { deviceId, platform: 'android', model: 'k6', appVersion: APP_VERSION },
  }), { headers: JSON_HEADERS, tags: { name: 'staff-login' } });
  const d = body(res).data;
  if (res.status !== 200 || !d?.accessToken) fail(`${driver}: sign-in failed (${res.status} ${body(res).error?.code ?? ''})`);
  if (d.mustChangePassword) fail(`${driver}: must change the password first (sign in once in the driver app)`);
  return { driver, deviceId, accessToken: d.accessToken, refreshToken: d.refreshToken };
}

function authed(s, name) {
  return { headers: { ...JSON_HEADERS, Authorization: `Bearer ${s.accessToken}`, 'X-Device-Id': s.deviceId }, tags: { name } };
}

function refresh(s) {
  const res = http.post(`${API}/auth/refresh`, JSON.stringify({ refreshToken: s.refreshToken }), { headers: JSON_HEADERS, tags: { name: 'refresh' } });
  const d = body(res).data;
  if (res.status !== 200 || !d?.accessToken) fail(`${s.driver}: token refresh failed (${res.status})`);
  s.accessToken = d.accessToken;
  s.refreshToken = d.refreshToken;
}

function activeTrip(s) {
  const home = body(http.get(`${API}/driver/home`, authed(s, 'driver-home'))).data;
  const trip = home?.activeTrip;
  if (!trip) fail(`${s.driver}: no running trip — start one first (simulate-trips.ts --force-start, then stop it)`);
  if (trip.onThisDevice === false) fail(`${s.driver}: the running trip belongs to another phone — start it with the simulator's device`);
  const route = body(http.get(`${API}/driver/trips/${trip.id}/route`, authed(s, 'driver-route'))).data;
  const stop = route?.stops?.[0];
  return { id: trip.id, start: stop ? { lat: stop.lat, lng: stop.lng } : { lat: 12.9352, lng: 77.6245 } };
}

export function setup() {
  const health = http.get(`${BASE}/healthz`, { tags: { name: 'healthz' } });
  if (health.status !== 200) fail(`${BASE}/healthz answered ${health.status}`);
  if (WATCHERS === 0) return {};
  const res = http.post(`${API}/auth/school/login`, JSON.stringify({ email: __ENV.ADMIN_EMAIL, password: __ENV.ADMIN_PASSWORD }), { headers: JSON_HEADERS, tags: { name: 'admin-login' } });
  const d = body(res).data;
  if (res.status !== 200 || !d?.accessToken || !d.user?.school?.id) fail(`school admin sign-in failed (${res.status} ${body(res).error?.code ?? ''})`);
  return { adminToken: d.accessToken, schoolId: d.user.school.id };
}

// VU-local state (each VU is its own JS runtime): its own session, so refresh tokens never race.
let session = null;
let trip = null;

export function ingest() {
  if (!session || !trip) {
    // fail() ends only this iteration: keep both unset until sign-in and trip lookup succeed, then retry.
    try {
      const s = staffLogin(DRIVERS[(exec.vu.idInTest - 1) % DRIVERS.length]);
      trip = activeTrip(s);
      session = s;
    } catch (err) {
      sleep(INTERVAL_S); // do not hammer sign-in while a trip is missing
      throw err;
    }
  }
  const payload = JSON.stringify({ device_id: session.deviceId, points: [trackPoint(trip.start, exec.vu.iterationInScenario, { speedKmh: SPEED_KMH, intervalS: INTERVAL_S })] });
  let res = http.post(`${API}/driver/trips/${trip.id}/locations`, payload, authed(session, 'ingest'));
  if (res.status === 401 && body(res).error?.code === 'TOKEN_EXPIRED') {
    refresh(session);
    res = http.post(`${API}/driver/trips/${trip.id}/locations`, payload, authed(session, 'ingest'));
  }
  const d = body(res).data;
  const ok = check(res, { 'ingest 200': (r) => r.status === 200, 'trip still running': () => d?.tripStatus === 'in_progress' });
  ingestOk.add(ok);
  if (d) {
    ingestAccepted.add(d.accepted ?? 0);
    ingestDropped.add(d.dropped ?? 0);
  }
  if (d && d.tripStatus && d.tripStatus !== 'in_progress') {
    const ended = `${session.driver}: trip is ${d.tripStatus}; start a new one`;
    trip = null; // look for a new running trip on the next iteration
    sleep(INTERVAL_S);
    fail(ended);
  }
  sleep(INTERVAL_S);
}

export function watch(data) {
  const room = `school:${data.schoolId}:fleet`;
  const holdMs = Math.max(5_000, (exec.scenario.startTime + parseDuration(DURATION)) - Date.now());
  ws.connect(socketUrl(BASE), { tags: { name: 'socket' } }, (socket) => {
    socket.on('message', (raw) => {
      const f = decodeFrame(raw);
      if (f.kind === 'ping') return socket.send(PONG);
      if (f.kind === 'open') return socket.send(encodeConnect('/rt', { token: data.adminToken }));
      if (f.kind !== 'packet' || f.nsp !== '/rt') return undefined;
      if (f.type === SIO.CONNECT) return socket.send(encodeEvent('/rt', 'join', { room }, 1));
      if (f.type === SIO.CONNECT_ERROR) {
        socketJoinOk.add(false);
        return socket.close();
      }
      if (f.type === SIO.ACK && f.id === 1) return socketJoinOk.add(f.data?.[0]?.ok === true);
      if (f.type === SIO.EVENT && f.data?.[0] === 'live:position') {
        fanoutEvents.add(1);
        const at = Date.parse(f.data[1]?.live?.receivedAt ?? '');
        if (Number.isFinite(at)) fanoutLag.add(Date.now() - at);
      }
      return undefined;
    });
    socket.setTimeout(() => socket.close(), holdMs);
  });
}

function parseDuration(text) {
  const m = /^(\d+)(ms|s|m|h)$/.exec(String(text).trim());
  if (!m) return 300_000;
  return Number(m[1]) * { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[m[2]];
}
