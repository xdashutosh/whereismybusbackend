// Minimal Socket.IO v4 client framing (Engine.IO protocol 4, Socket.IO protocol 5) over a raw
// WebSocket, plus the synthetic GPS track. k6 has no Socket.IO client, so ingest.k6.js speaks the wire
// format itself. Plain ES module with no k6 or Node imports: k6 loads it, node --test covers it.
//
// Frames: Engine.IO type digit (0 open, 1 close, 2 ping, 3 pong, 4 message). A message carries a
// Socket.IO packet: type digit (0 CONNECT, 1 DISCONNECT, 2 EVENT, 3 ACK, 4 CONNECT_ERROR), then the
// namespace and a comma when it is not "/", then an optional ack id, then JSON.
//   40/rt,{"token":"…"}          connect to /rt with auth      → 40/rt,{"sid":"…"} or 44/rt,{"message":"…"}
//   42/rt,1["join",{"room":"…"}] event with ack id 1           → 43/rt,1[{"ok":true,"room":"…"}]
//   42/rt,["live:position",{…}]  server event

export const SIO = Object.freeze({ CONNECT: 0, DISCONNECT: 1, EVENT: 2, ACK: 3, CONNECT_ERROR: 4 });

/** WebSocket URL of the Socket.IO endpoint for an http(s) API origin (path /socket.io). */
export function socketUrl(origin) {
  const u = String(origin).replace(/\/+$/, '').replace(/^http/i, 'ws');
  return `${u}/socket.io/?EIO=4&transport=websocket`;
}

function prefix(type, nsp, id) {
  return `4${type}${nsp && nsp !== '/' ? `${nsp},` : ''}${id ?? ''}`;
}

/** CONNECT packet for a namespace with a handshake auth payload. */
export function encodeConnect(nsp, auth) {
  return `${prefix(SIO.CONNECT, nsp)}${auth === undefined ? '' : JSON.stringify(auth)}`;
}

/** EVENT packet; pass an ack id to get an ACK back. */
export function encodeEvent(nsp, event, data, ackId) {
  return `${prefix(SIO.EVENT, nsp, ackId)}${JSON.stringify(data === undefined ? [event] : [event, data])}`;
}

/** Engine.IO pong (answer to every server ping "2"). */
export const PONG = '3';

/**
 * Decodes one WebSocket text frame.
 * → { kind: 'open', data } | { kind: 'ping' } | { kind: 'pong' } | { kind: 'close' }
 *   | { kind: 'packet', type, nsp, id, data } | { kind: 'unknown', raw }
 */
export function decodeFrame(raw) {
  const s = String(raw);
  switch (s[0]) {
    case '0':
      return { kind: 'open', data: parseJson(s.slice(1)) };
    case '1':
      return { kind: 'close' };
    case '2':
      return { kind: 'ping' };
    case '3':
      return { kind: 'pong' };
    case '4':
      return decodePacket(s.slice(1)) ?? { kind: 'unknown', raw: s };
    default:
      return { kind: 'unknown', raw: s };
  }
}

function decodePacket(p) {
  const type = Number(p[0]);
  if (!Number.isInteger(type) || type < 0 || type > 6) return null;
  let i = 1;
  let nsp = '/';
  if (p[i] === '/') {
    const comma = p.indexOf(',', i);
    const end = comma < 0 ? p.length : comma;
    nsp = p.slice(i, end);
    i = comma < 0 ? p.length : comma + 1;
  }
  let digits = '';
  while (i < p.length && p[i] >= '0' && p[i] <= '9') digits += p[i++];
  const rest = p.slice(i);
  return { kind: 'packet', type, nsp, id: digits ? Number(digits) : null, data: rest ? parseJson(rest) : null };
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Synthetic fix n of a bus driving a straight line from `start` (BP §9.1 compact keys). Speed in km/h,
 * heading in degrees, `intervalS` between fixes; `t` is the wall clock at send time (a live point).
 */
export function trackPoint(start, n, { speedKmh = 30, headingDeg = 45, intervalS = 10, now = Date.now() } = {}) {
  const meters = (speedKmh / 3.6) * intervalS * n;
  const rad = (headingDeg * Math.PI) / 180;
  const dLat = (meters * Math.cos(rad)) / 111_320;
  const dLng = (meters * Math.sin(rad)) / (111_320 * Math.cos((start.lat * Math.PI) / 180));
  return {
    t: new Date(now).toISOString(),
    lat: Math.round((start.lat + dLat) * 1e6) / 1e6,
    lng: Math.round((start.lng + dLng) * 1e6) / 1e6,
    spd: speedKmh,
    hdg: headingDeg,
    acc: 8,
    bat: 80,
    net: '4g',
    mv: speedKmh > 0,
  };
}
