// POST /driver/trips/:id/locations (BP §9.1, §9.2). The endpoint stays fast: one read-only
// authorization transaction, the floor/backfill classification and live-state update under the
// per-trip lock, then persistence and analytics are handed to the points-persist job and the newest
// position is fanned out over Socket.IO.
//
// Authorization (else 401/403/404/409): user active + school active (guards), the trip belongs to
// the calling driver/conductor (403 FORBIDDEN), the session's device is the trip's start device
// (403 DEVICE_NOT_BOUND), the trip is in_progress (409 INVALID_STATE) — a completed/auto-closed
// trip, or one cancelled while running (breakdown), still accepts late backfill recorded before its
// close for LATE_BACKFILL_HOURS after the close (BP §10.3.6; trips.acceptsLatePoints — closed_at, so
// an auto-closed trip takes its outage queue).
//
// Device clock (BP §14.3, clock.ts): `sentAt` of the batch (or, for older apps, a stored / inferred
// offset) puts the point timestamps on the server clock when the phone is off by more than
// CLOCK_DRIFT_TOLERANCE_MS; beyond CLOCK_DRIFT_MAX_CORRECTION_MS the batch is dropped. The offset is kept
// in the live state for the following batches and a clock_drift alert is raised once (drift.ts). The
// answer carries serverTime, clockDrift and clockOffsetMs so the app can align its own clock.
import { LATE_POINTS_WINDOW_HOURS, type LocationIngestBody, type LocationIngestResult } from '@wimb/shared';
import { acceptsLatePoints } from '../trips/index.js';
import type { Request } from 'express';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { deviceNotBound, forbidden, invalidState, notFound, serviceUnavailable, unauthenticated } from '../../shared/errors.js';
import { events } from '../../shared/events.js';
import { logger as rootLogger } from '../../shared/logger.js';
import { appMetrics } from '../../shared/metrics.js';
import { expectedIntervalS, trackingConfig } from './config.js';
import { jobs } from '../../jobs/index.js';
import { POINTS_PERSIST_JOB, type PersistPayload } from './constants.js';
import { TRIP_START_TOLERANCE_MS } from './clock.js';
import { reportClockDrift, type ClockDriftReport } from './drift.js';
import { liveStore, newLiveState, seedStopVisits } from './liveState.js';
import { applyLivePoints, classifyBatch } from './motion.js';
import { emitPosition, emitStatus } from './publish.js';
import * as repo from './repository.js';
import './events.js';

const log = rootLogger.child({ module: 'tracking.ingest' });

/** Late backfill window after a trip ended (BP §10.3.6) — the trips module's window (@wimb/shared). */
export const LATE_BACKFILL_HOURS = LATE_POINTS_WINDOW_HOURS;
/** Points may predate the recorded start by this much (clock skew, start latency). */
export const START_TOLERANCE_MS = TRIP_START_TOLERANCE_MS;
/** Points may postdate the recorded end by this much. */
export const END_TOLERANCE_MS = 2 * 60_000;

/**
 * Hands a batch to the points-persist job (batched insert + analytics). No job id: a batch the app
 * re-sends after a failure must be queued again (the insert is idempotent; analytics skip points
 * they already processed).
 */
export function enqueuePersist(payload: PersistPayload): Promise<void> {
  return jobs.enqueue(POINTS_PERSIST_JOB, payload);
}

export async function ingestLocations(req: Request, tripId: string, body: LocationIngestBody): Promise<LocationIngestResult> {
  const auth = req.auth;
  const device = req.boundDevice;
  if (!auth || !req.tenant) throw unauthenticated();
  if (!device) throw deviceNotBound();
  if (body.deviceId !== undefined && body.deviceId !== device.deviceUid) throw deviceNotBound('device_id does not match the device this session is bound to.');
  const schoolId = req.tenant.schoolId;

  const { trip, cfg } = await withRequestTenant(
    req,
    async (tx) => ({ trip: await repo.ingestTrip(tx, tripId, auth.actorId), cfg: await trackingConfig(tx) }),
    { readOnly: true },
  );
  if (!trip) throw notFound('Trip not found.');
  if (!trip.is_crew) throw forbidden('This trip is not assigned to you.');
  if (!trip.device_id || trip.device_id !== device.id) throw deviceNotBound('This trip was started on another device.');

  const nowMs = Date.now();
  const live = trip.status === 'in_progress';
  if (!live && !acceptsLatePoints(trip, nowMs)) {
    throw invalidState(`Locations are accepted only while the trip is in progress (trip is ${trip.status}).`, { tripStatus: trip.status });
  }
  const startedMs = trip.started_at ? Date.parse(trip.started_at) : nowMs;
  // Ended trips take points recorded up to their close: for an auto-closed trip that is the close
  // instant (closed_at), not ended_at (= its last fix), so the outage queue that caused the close fits.
  const closedAt = trip.closed_at ?? trip.ended_at;
  const windowEndMs = live || !closedAt ? null : Date.parse(closedAt) + END_TOLERANCE_MS;

  const sentAtMs = body.sentAt ? Date.parse(body.sentAt) : null;
  let drift: ClockDriftReport | null = null;
  const result = await liveStore.withLock(schoolId, tripId, async (): Promise<LocationIngestResult> => {
    const stored = await liveStore.get(schoolId, tripId);
    let state = stored;
    if (!state) {
      state = newLiveState({ schoolId, tripId, busId: trip.bus_id, routeId: trip.route_id, direction: trip.direction, tripStatus: trip.status, lastPointAt: trip.last_point_at });
      // Live state lost (restart without Redis, expiry): stops already recorded stay visited.
      if (live && trip.last_point_at) {
        const visits = await withRequestTenant(req, (tx) => repo.stopEvents(tx, tripId), { readOnly: true });
        seedStopVisits(state, visits);
      }
    }
    state.tripStatus = trip.status;
    const batch = classifyBatch(body.points, {
      // Ended trips take backfill only: everything up to the end counts as "older than live".
      lastLiveAtMs: live ? state.lastLiveAtMs : Number.MAX_SAFE_INTEGER,
      lastReceivedAtMs: live ? state.receivedAtMs : null,
      nowMs,
      windowStartMs: startedMs - START_TOLERANCE_MS,
      windowEndMs,
      sentAtMs,
      storedClockOffsetMs: live ? (state.clockOffsetMs ?? null) : null,
      inferClock: live,
    });
    const clock = batch.clock;
    if (clock.action !== 'none' && clock.offsetMs !== null && (live ? !state.clockDriftReported : true)) {
      drift = {
        tripId, busId: trip.bus_id, busCode: trip.bus_code_snapshot, staffId: trip.driver_staff_id, offsetMs: clock.offsetMs,
        action: clock.action, source: clock.source ?? 'inferred', via: 'locations', deviceId: device.id,
      };
    }
    if (live) {
      state.clockOffsetMs = clock.action === 'corrected' ? clock.offsetMs : null;
      state.clockDriftReported = clock.action === 'none' ? false : true;
    }
    if (batch.backfill.length) {
      // Backfill already stored (a replayed or shifted offline queue) is dropped here, so `accepted`
      // reports what is really new; insertPoints enforces the same floor at write time.
      const near = await withRequestTenant(req, (tx) => repo.storedNeighbours(tx, tripId, batch.backfill.map((p) => p.t)), { readOnly: true });
      if (near.size) {
        batch.backfill = batch.backfill.filter((_p, i) => !near.has(i));
        batch.dropped.duplicate += near.size;
      }
    }
    const accepted = [...batch.backfill, ...batch.live].sort((a, b) => a.ms - b.ms);
    const dropped = batch.dropped.floor + batch.dropped.duplicate + batch.dropped.future + batch.dropped.outsideTrip + batch.dropped.clockDrift;

    if (accepted.length) {
      try {
        await enqueuePersist({ schoolId, tripId, points: accepted, live: live ? batch.live : [], lateBackfill: !live });
      } catch (err) {
        log.error({ err, schoolId, tripId }, 'points-persist enqueue failed');
        throw serviceUnavailable('Locations could not be queued. Please retry.');
      }
      appMetrics().ingestPoints.inc({}, accepted.length);
    }

    let motionChanged = false;
    let restored = false;
    if (live && batch.live.length) {
      motionChanged = applyLivePoints(state, batch.live, cfg, nowMs);
      // Fresh fixes prove the app has the location permission again (even if its "restored" event is still queued).
      state.locationPermissionDeniedAtMs = null;
      if (state.locationUnavailable) {
        state.locationUnavailable = false;
        restored = true;
      }
      await emitPosition(state, cfg, nowMs);
    }
    if (live) await liveStore.put(state);
    if (restored) {
      await emitStatus(state, cfg, 'location_restored', {}, nowMs);
      events.emit('tracking.location_restored', { schoolId, tripId, busId: state.busId, at: new Date(nowMs).toISOString() });
    } else if (motionChanged) {
      await emitStatus(state, cfg, 'motion', {}, nowMs);
    }

    return {
      serverTime: new Date(nowMs).toISOString(),
      nextIntervalS: expectedIntervalS(cfg, state.motion),
      tripStatus: trip.status,
      accepted: accepted.length,
      dropped,
      backfilled: batch.backfill.length,
      clockDrift: clock.action,
      clockOffsetMs: clock.offsetMs,
    };
  });
  if (drift) await reportClockDrift(schoolId, drift);
  return result;
}
