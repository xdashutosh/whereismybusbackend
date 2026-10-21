// points-persist job (contract §8): one batched multi-row INSERT … ON CONFLICT DO NOTHING per
// accepted batch into the location_points partitions (+ trips.last_point_at / points_count), then
// the per-point analytics for live points (stop arrival/dwell, school exit, checks, ETA) under the
// per-trip lock: writes and alerts in one transaction, the live state and the fan-out after commit.
import { withSchoolSystem } from '../../db/tenant.js';
import { events } from '../../shared/events.js';
import { logger as rootLogger, type Logger } from '../../shared/logger.js';
import { announceAlerts, raiseAlert, type RaisedAlert } from '../alerts/service.js';
import { analyzePoints, type AnalyticsOutcome } from './analytics.js';
import { TRIP_FINALIZER_JOB, type PersistPayload } from './constants.js';
import { readTrackingConfig } from './config.js';
import { readEtaV2, refreshEtaV2 } from './etaV2.js';
import { loadGeometry } from './geometry.js';
import { liveStore } from './liveState.js';
import type { ParsedPoint } from './motion.js';
import { emitStatus } from './publish.js';
import * as repo from './repository.js';
import './events.js';

const rootLog = rootLogger.child({ module: 'tracking.persist' });

/** Delay before a finalizer re-run after late backfill (more batches usually follow); tests set 0. */
export const lateFinalize = { delayMs: 2 * 60_000 };

export async function persistPoints(payload: PersistPayload, log: Logger = rootLog): Promise<{ inserted: number; analyzed: AnalyticsOutcome | null }> {
  const { schoolId, tripId } = payload;
  const inserted = await withSchoolSystem(schoolId, (tx) => repo.insertPoints(tx, tripId, payload.points));
  if (payload.lateBackfill) {
    if (inserted > 0) {
      const bucket = Math.floor(Date.now() / Math.max(1000, lateFinalize.delayMs));
      // Lazy: jobs/index imports this module's job definitions (a static import would be a cycle).
      const { jobs } = await import('../../jobs/index.js');
      await jobs.enqueue(TRIP_FINALIZER_JOB, { schoolId, tripId }, { jobId: `tf-${tripId}-late-${bucket}`, ...(lateFinalize.delayMs > 0 ? { delayMs: lateFinalize.delayMs } : {}) });
    }
    return { inserted, analyzed: null };
  }
  const analyzed = payload.live.length ? await runAnalytics(schoolId, tripId, payload.live, log) : null;
  return { inserted, analyzed };
}

/** Analytics of new live points for one trip (exported for tests). */
export async function runAnalytics(schoolId: string, tripId: string, live: readonly ParsedPoint[], log: Logger = rootLog): Promise<AnalyticsOutcome | null> {
  return liveStore.withLock(schoolId, tripId, async () => {
    const state = await liveStore.get(schoolId, tripId);
    if (!state) {
      log.warn({ schoolId, tripId }, 'No live state for analytics (expired or never written); skipped');
      return null;
    }
    const nowMs = Date.now();
    const { outcome, cfg, raised, geometry } = await withSchoolSystem(schoolId, async (tx) => {
      const cfg = await readTrackingConfig(tx);
      const geometry = await loadGeometry(tx, tripId);
      const etaV2 = cfg.etaV2Enabled ? await readEtaV2(schoolId, tripId) : null;
      const outcome = analyzePoints(state, live, geometry, cfg, nowMs, etaV2);
      // An arrival already recorded for this trip (live state lost in a restart, a manual row) is not
      // announced again: sockets and parent notifications follow the stored row, not the detection.
      const known = new Set<string>();
      for (const w of outcome.writes) {
        if (w.kind === 'arrival') {
          if (!(await repo.recordArrival(tx, tripId, w.stopId, w.at, w.distanceM))) known.add(w.stopId);
        } else await repo.recordDeparture(tx, tripId, w.stopId, w.at, w.minDistanceM);
      }
      if (known.size) outcome.events = outcome.events.filter((e) => e.kind !== 'stop_arrived' || !known.has(e.stopId));
      const raised: RaisedAlert[] = [];
      for (const a of outcome.alerts) {
        const r = await raiseAlert(tx, a);
        if (r) raised.push(r);
      }
      return { outcome, cfg, raised, geometry };
    });
    await liveStore.put(state);
    await announceAlerts(raised);

    const base = { schoolId, tripId, busId: state.busId, routeId: state.routeId, direction: state.direction };
    for (const e of outcome.events) {
      if (e.kind === 'stop_arrived') {
        await emitStatus(state, cfg, 'stop_arrived', { stopId: e.stopId }, nowMs);
        events.emit('tracking.stop_arrived', { ...base, stopId: e.stopId, at: e.at, distanceM: e.distanceM });
      } else if (e.kind === 'stop_departed') {
        await emitStatus(state, cfg, 'stop_departed', { stopId: e.stopId }, nowMs);
        events.emit('tracking.stop_departed', { ...base, stopId: e.stopId, at: e.at, dwellS: e.dwellS });
      } else {
        events.emit('tracking.left_school', { ...base, stopId: null, at: e.at });
      }
    }
    if (state.eta) {
      if (outcome.etaChanged && !outcome.events.some((e) => e.kind !== 'left_school')) await emitStatus(state, cfg, 'eta', {}, nowMs);
      events.emit('tracking.eta_updated', { schoolId, tripId, busId: state.busId, routeId: state.routeId, direction: state.direction, eta: state.eta });
    }
    return { outcome, refresh: { state, geometry, cfg } };
  }).then(async (r) => {
    if (!r) return null;
    // ETA v2: the Google call runs after the lock and outside any transaction; the next batch applies it.
    await refreshEtaV2(r.refresh.state, r.refresh.geometry, r.refresh.cfg);
    return r.outcome;
  });
}
