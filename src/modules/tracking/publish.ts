// Socket.IO fan-out of live tracking (contract §7, BP §8.6): every accepted live point goes to the
// school's fleet room (admins); the trip room (admins + the trip's parents/crew) is coalesced to at
// most one position per PARENT_EMIT_MIN_MS per trip (≥ 10 s nominal, 1-s clock-jitter tolerance —
// the same tolerance as the ingestion floor). Status changes (stop arrival/departure, location
// unavailable/restored, ETA, motion) go to both rooms. Emits travel over pub/sub, so they work from
// the API and from the worker. Failures are logged, never thrown (live fan-out is best effort).
import { SOCKET_EVENTS, type LivePositionEvent, type LiveStatusEvent, type TripLiveState } from '@wimb/shared';
import { logger as rootLogger } from '../../shared/logger.js';
import { realtime as defaultRealtime, rooms, type Realtime } from '../../shared/realtime.js';
import type { TrackingConfig } from './config.js';
import { toPublicLive, type StoredLiveState } from './liveState.js';

const log = rootLogger.child({ module: 'tracking.publish' });

export const PARENT_EMIT_MIN_MS = 9_000;

let realtime: Realtime = defaultRealtime;
/** Test seam: replaces the realtime facade; returns a restore function. */
export function useRealtime(r: Realtime): () => void {
  const previous = realtime;
  realtime = r;
  return () => {
    realtime = previous;
  };
}

async function safeEmit(room: string, event: string, payload: unknown): Promise<void> {
  try {
    await realtime.emit(room, event, payload);
  } catch (err) {
    log.warn({ err, room, event }, 'Live emit failed');
  }
}

/**
 * The trip room is also joined by parents: the phone's battery level and network type and its clock
 * offset are operational data for the school only (fleet room), so trip-room payloads carry them as null.
 */
export function tripRoomLive(live: TripLiveState): TripLiveState {
  const out = live.clockOffsetMs === undefined || live.clockOffsetMs === null ? live : { ...live, clockOffsetMs: null };
  return out.point ? { ...out, point: { ...out.point, bat: null, net: null } } : out;
}

/**
 * Emits the newest position. Mutates state.lastTripEmitMs when the trip room got it (the caller
 * persists the state afterwards).
 */
export async function emitPosition(state: StoredLiveState, cfg: TrackingConfig, nowMs = Date.now()): Promise<void> {
  const payload: LivePositionEvent = { schoolId: state.schoolId, tripId: state.tripId, busId: state.busId, live: toPublicLive(state, cfg, nowMs) };
  const toTrip = state.lastTripEmitMs === null || nowMs - state.lastTripEmitMs >= PARENT_EMIT_MIN_MS;
  if (toTrip) state.lastTripEmitMs = nowMs;
  await Promise.all([
    safeEmit(rooms.schoolFleet(state.schoolId), SOCKET_EVENTS.LIVE_POSITION, payload),
    toTrip ? safeEmit(rooms.trip(state.tripId), SOCKET_EVENTS.LIVE_POSITION, { ...payload, live: tripRoomLive(payload.live) }) : Promise.resolve(),
  ]);
}

export async function emitStatus(state: StoredLiveState, cfg: TrackingConfig, change: LiveStatusEvent['change'], extra: { stopId?: string } = {}, nowMs = Date.now()): Promise<void> {
  const payload: LiveStatusEvent = { schoolId: state.schoolId, tripId: state.tripId, busId: state.busId, change, ...extra, live: toPublicLive(state, cfg, nowMs) };
  await Promise.all([
    safeEmit(rooms.schoolFleet(state.schoolId), SOCKET_EVENTS.LIVE_STATUS, payload),
    safeEmit(rooms.trip(state.tripId), SOCKET_EVENTS.LIVE_STATUS, { ...payload, live: tripRoomLive(payload.live) }),
  ]);
}
