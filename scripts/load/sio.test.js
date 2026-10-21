// node --test scripts/load/sio.test.js — Socket.IO framing and synthetic track used by ingest.k6.js.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFrame, encodeConnect, encodeEvent, PONG, SIO, socketUrl, trackPoint } from './sio.js';

test('socketUrl maps http(s) origins to the Engine.IO v4 websocket endpoint', () => {
  assert.equal(socketUrl('https://whereismybus-api.onrender.com/'), 'wss://whereismybus-api.onrender.com/socket.io/?EIO=4&transport=websocket');
  assert.equal(socketUrl('http://localhost:4000'), 'ws://localhost:4000/socket.io/?EIO=4&transport=websocket');
});

test('encodes CONNECT with auth and EVENT with and without an ack id', () => {
  assert.equal(encodeConnect('/rt', { token: 'abc' }), '40/rt,{"token":"abc"}');
  assert.equal(encodeConnect('/'), '40');
  assert.equal(encodeEvent('/rt', 'join', { room: 'school:s1:fleet' }, 1), '42/rt,1["join",{"room":"school:s1:fleet"}]');
  assert.equal(encodeEvent('/rt', 'ping'), '42/rt,["ping"]');
  assert.equal(PONG, '3');
});

test('decodes Engine.IO control frames', () => {
  const open = decodeFrame('0{"sid":"x","upgrades":[],"pingInterval":25000,"pingTimeout":20000}');
  assert.equal(open.kind, 'open');
  assert.equal(open.data.pingInterval, 25000);
  assert.deepEqual(decodeFrame('2'), { kind: 'ping' });
  assert.deepEqual(decodeFrame('3'), { kind: 'pong' });
  assert.deepEqual(decodeFrame('1'), { kind: 'close' });
  assert.equal(decodeFrame('9zz').kind, 'unknown');
});

test('decodes namespace connect ack, connect error, ack and events', () => {
  assert.deepEqual(decodeFrame('40/rt,{"sid":"abc"}'), { kind: 'packet', type: SIO.CONNECT, nsp: '/rt', id: null, data: { sid: 'abc' } });
  const err = decodeFrame('44/rt,{"message":"Unauthorized","data":{"code":"TOKEN_EXPIRED"}}');
  assert.equal(err.type, SIO.CONNECT_ERROR);
  assert.equal(err.data.data.code, 'TOKEN_EXPIRED');
  assert.deepEqual(decodeFrame('43/rt,12[{"ok":true,"room":"school:s1:fleet"}]'), {
    kind: 'packet', type: SIO.ACK, nsp: '/rt', id: 12, data: [{ ok: true, room: 'school:s1:fleet' }],
  });
  const ev = decodeFrame('42/rt,["live:position",{"tripId":"t1","live":{"receivedAt":"2026-10-19T07:31:11.204Z"}}]');
  assert.equal(ev.type, SIO.EVENT);
  assert.equal(ev.id, null);
  assert.equal(ev.data[0], 'live:position');
  assert.equal(ev.data[1].tripId, 't1');
  // Root namespace, no payload, and a namespace disconnect without a comma.
  assert.deepEqual(decodeFrame('40'), { kind: 'packet', type: SIO.CONNECT, nsp: '/', id: null, data: null });
  assert.deepEqual(decodeFrame('41/rt'), { kind: 'packet', type: SIO.DISCONNECT, nsp: '/rt', id: null, data: null });
});

test('encode → decode round trip keeps namespace, ack id and payload', () => {
  const frame = encodeEvent('/rt', 'join', { room: 'trip:abc' }, 7);
  assert.deepEqual(decodeFrame(frame), { kind: 'packet', type: SIO.EVENT, nsp: '/rt', id: 7, data: ['join', { room: 'trip:abc' }] });
});

test('trackPoint moves the bus by speed × interval along the heading with BP §9.1 keys', () => {
  const start = { lat: 12.9352, lng: 77.6245 };
  const p0 = trackPoint(start, 0, { now: Date.parse('2026-10-19T07:31:10Z') });
  assert.deepEqual(Object.keys(p0).sort(), ['acc', 'bat', 'hdg', 'lat', 'lng', 'mv', 'net', 'spd', 't']);
  assert.equal(p0.t, '2026-10-19T07:31:10.000Z');
  assert.equal(p0.lat, start.lat);
  // Due north at 36 km/h, 10 s apart → 100 m per fix ≈ 0.000898° of latitude.
  const p3 = trackPoint(start, 3, { speedKmh: 36, headingDeg: 0, intervalS: 10 });
  assert.ok(Math.abs(p3.lat - start.lat - 300 / 111_320) < 2e-6);
  assert.equal(p3.lng, start.lng);
  assert.equal(trackPoint(start, 1, { speedKmh: 0 }).mv, false);
});
