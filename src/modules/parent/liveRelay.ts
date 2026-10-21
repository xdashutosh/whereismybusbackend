// Live feed of child:{studentId}:live (contract §7, BP §8.6, §9.3). The tracking module publishes every
// accepted position / status change of a running trip to trip:{tripId} (already parent-safe:
// battery/network nulled, positions coalesced to ≥ ~10 s per trip) and the trips module publishes trip
// status changes. This relay turns them into one 'child:live' event per child currently assigned to
// the trip's bus + direction (fan-out targets are read afresh for every relayed message, so a child
// moved to another bus stops receiving the old bus at once), with the BP §9.4 status and ETA computed
// for THAT child's stop.
//   Sources: live:position / live:status messages on the realtime pub/sub channel (they carry the
//            school id), the in-process 'trip.status_changed' event and trip:status messages of trips
//            whose school the relay learned from their live messages (worker-side auto-close).
//   Exactly once across instances: every relaying process claims a kv key first (Redis SET NX in
//            production) — positions and ETA refreshes share one claim per trip whose TTL is the
//            coalescing window (≥ 9 s moving, 30 s while stopped); discrete changes (stop arrival/
//            departure, location unavailable/restored, motion, trip status) are claimed per change.
//   Started lazily by the first authorized child-room join (API processes with parent sockets);
//            failures are logged, never thrown (live fan-out is best effort; polling is the fallback).
import { SOCKET_EVENTS, PARENT_SOCKET_EVENTS, type ChildLiveEvent, type LivePositionEvent, type LiveStatusEvent, type TripLiveState, type TripStatus } from '@wimb/shared';
import crypto from 'node:crypto';
import { withSchoolSystem } from '../../db/tenant.js';
import { events } from '../../shared/events.js';
import { kv as defaultKv, kvKey, type KvStore } from '../../shared/kv.js';
import { logger as rootLogger } from '../../shared/logger.js';
import { pubsub as defaultPubsub, type PubSub } from '../../shared/pubsub.js';
import { realtime as defaultRealtime, rooms, RT_EMIT_CHANNEL, type EmitMessage, type Realtime } from '../../shared/realtime.js';
import { getLiveState, PARENT_EMIT_MIN_MS, trackingConfig } from '../tracking/index.js';
import type { TripStatusPayload } from '../trips/events.js';
import * as repo from './repository.js';
import { childStatus, etaFor, liveFor, positionOf, statusTrip } from './view.js';

const log = rootLogger.child({ module: 'parent.liveRelay' });

/** Child rooms get at most one position per trip per window: ≥ 9 s moving (10-s floor − jitter), 30 s while stopped. */
export const CHILD_MOVING_EMIT_MS = PARENT_EMIT_MIN_MS;
export const CHILD_STOPPED_EMIT_MS = 30_000;
const CLAIM_TTL_S = 60;
const SCHOOL_MEMORY = 2000;
const TRIP_ROOM_RE = /^trip:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
/** Status changes that share the position coalescing window (they carry the same live picture). */
const COALESCED_CHANGES = new Set<LiveStatusEvent['change']>(['eta']);

interface TripStatusMessage {
  tripId: string;
  status: TripStatus;
  interrupted?: boolean;
  at?: string;
}

export interface ChildRelayDeps {
  bus?: PubSub;
  kv?: KvStore;
  realtime?: Realtime;
}

const hash = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

export function createChildRelay({ bus = defaultPubsub, kv = defaultKv, realtime = defaultRealtime }: ChildRelayDeps = {}) {
  /** tripId → schoolId learned from live messages (trip:status payloads carry no school id). */
  const schoolOfTrip = new Map<string, string>();
  let unsubscribe: Promise<() => Promise<void>> | null = null;

  const remember = (tripId: string, schoolId: string) => {
    schoolOfTrip.delete(tripId);
    schoolOfTrip.set(tripId, schoolId);
    if (schoolOfTrip.size > SCHOOL_MEMORY) schoolOfTrip.delete(schoolOfTrip.keys().next().value!);
  };

  async function fanOut(schoolId: string, tripId: string, kind: ChildLiveEvent['kind'], change: string | null, liveIn: TripLiveState | null, statusOverride?: TripStatus): Promise<number> {
    const { audience, cfg, live } = await withSchoolSystem(
      schoolId,
      async (tx) => ({
        audience: await repo.tripAudience(tx, tripId),
        cfg: await trackingConfig(tx),
        live: liveIn ?? (await getLiveState(tx, tripId)),
      }),
      { readOnly: true },
    );
    if (!audience.length) return 0;
    const nowMs = Date.now();
    await Promise.all(
      audience.map((a) => {
        const tripStatus = statusOverride ?? live?.tripStatus ?? a.trip_status;
        const tripLive = liveFor(tripStatus, live);
        const payload: ChildLiveEvent = {
          studentId: a.student_id,
          schoolId,
          tripId,
          busId: a.bus_id,
          direction: a.direction,
          kind,
          change,
          tripStatus,
          status: childStatus(statusTrip({ ...a, trip_status: tripStatus }), tripLive, { stopId: a.stop_id, plannedAt: a.stop_planned_at }, cfg, nowMs),
          position: positionOf(tripLive),
          motion: tripLive?.motion ?? null,
          freshness: tripLive?.freshness ?? 'none',
          eta: etaFor(tripLive, a.stop_id),
          at: new Date(nowMs).toISOString(),
        };
        return realtime.emit(rooms.childLive(a.student_id), PARENT_SOCKET_EVENTS.CHILD_LIVE, payload);
      }),
    );
    return audience.length;
  }

  /** Relays one trip-room live message (position or status). Returns the number of child rooms reached. */
  async function onLive(event: string, p: LivePositionEvent | LiveStatusEvent): Promise<number> {
    if (!p?.schoolId || !p.tripId || !p.live) return 0;
    remember(p.tripId, p.schoolId);
    const change = event === SOCKET_EVENTS.LIVE_STATUS ? (p as LiveStatusEvent).change : null;
    let claimed: boolean;
    if (change === null || COALESCED_CHANGES.has(change)) {
      const windowMs = p.live.motion === 'stopped' ? CHILD_STOPPED_EMIT_MS : CHILD_MOVING_EMIT_MS;
      claimed = await kv.setIfAbsent(kvKey('parent-relay', 'pos', p.schoolId, p.tripId), '1', windowMs / 1000);
    } else {
      const id = hash(`${change}|${(p as LiveStatusEvent).stopId ?? ''}|${p.live.point?.t ?? ''}|${p.live.receivedAt ?? ''}`);
      claimed = await kv.setIfAbsent(kvKey('parent-relay', 'st', p.schoolId, p.tripId, id), '1', CLAIM_TTL_S);
    }
    if (!claimed) return 0;
    return fanOut(p.schoolId, p.tripId, change === null ? 'position' : 'status', change, p.live);
  }

  /** Relays a trip status change (in-process event or pub/sub message of a known trip). */
  async function onTripStatus(schoolId: string, m: TripStatusMessage): Promise<number> {
    remember(m.tripId, schoolId);
    const claimed = await kv.setIfAbsent(kvKey('parent-relay', 'trip', schoolId, m.tripId, `${m.status}:${m.interrupted ? 1 : 0}`), '1', CLAIM_TTL_S);
    if (!claimed) return 0;
    return fanOut(schoolId, m.tripId, 'trip', m.status, null, m.status);
  }

  async function handle(msg: EmitMessage): Promise<number> {
    const m = TRIP_ROOM_RE.exec(msg?.room ?? '');
    if (!m) return 0;
    try {
      if (msg.event === SOCKET_EVENTS.LIVE_POSITION || msg.event === SOCKET_EVENTS.LIVE_STATUS) return await onLive(msg.event, msg.payload as LivePositionEvent);
      if (msg.event === SOCKET_EVENTS.TRIP_STATUS) {
        const p = msg.payload as TripStatusMessage | null;
        const schoolId = schoolOfTrip.get(m[1]!);
        if (p && p.tripId === m[1] && schoolId) return await onTripStatus(schoolId, p);
      }
    } catch (err) {
      log.warn({ err, room: msg.room, event: msg.event }, 'Child room relay failed');
    }
    return 0;
  }

  return {
    handle,
    onTripStatus,
    /** Subscribes this process to the realtime channel (idempotent). */
    start(): Promise<void> {
      unsubscribe ??= bus.subscribe<EmitMessage>(RT_EMIT_CHANNEL, (msg) => handle(msg).then(() => undefined));
      return unsubscribe.then(() => undefined);
    },
    async stop(): Promise<void> {
      const u = unsubscribe;
      unsubscribe = null;
      if (u) await (await u)();
    },
    get started(): boolean {
      return unsubscribe !== null;
    },
  };
}

export type ChildRelay = ReturnType<typeof createChildRelay>;

/** Process-wide relay (started by the first authorized child-room join). */
export const childRelay: ChildRelay = createChildRelay();

// Trip status changes made in this process reach the child rooms even before any live point exists
// (trip started, cancelled before departure). Claims dedupe it with the pub/sub copy.
events.on('trip.status_changed', (p: TripStatusPayload) => {
  if (p.tripType !== 'school') return;
  childRelay.onTripStatus(p.schoolId, { tripId: p.tripId, status: p.status, interrupted: p.interrupted, at: p.at }).catch((err: unknown) => log.warn({ err, tripId: p.tripId }, 'Child room trip status relay failed'));
});
