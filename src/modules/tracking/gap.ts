// location-gap-detector (BP §7.3, §9.3, §11.1): every minute, for each active school, running trips
// whose newest point is older than 3× the expected interval (moving 10 s / stopped 90 s by default)
// become "Location unavailable" (live state flag + live:status to the fleet and trip rooms); once the
// gap reaches gapAlertAfterS (≥ 5 min) a GPS alert is raised, deduplicated per trip while open. The
// alert type follows the last fix: low battery (≤ LOW_BATTERY_PCT) → low_battery, no network →
// no_network, otherwise gps_disabled — or location_permission while the app reported the location
// permission as denied (deduplicated into that event's alert). Ages are measured from when the server
// last heard from the bus (arrival time, liveState.lastHeardMs), so a phone with a wrong clock is judged
// on the server clock (BP §14.3). Points arriving again clear the flag (ingest). Idempotent.
import type { AlertType } from '@wimb/shared';
import { withSchoolSystem, withSystem } from '../../db/tenant.js';
import { events } from '../../shared/events.js';
import { logger as rootLogger, type Logger } from '../../shared/logger.js';
import { announceAlerts, raiseAlert, type RaiseAlertInput, type RaisedAlert } from '../alerts/service.js';
import { gapAlertAfterS, readTrackingConfig, staleAfterS } from './config.js';
import { lastHeardMs, liveStore, newLiveState, type StoredLiveState } from './liveState.js';
import { emitStatus } from './publish.js';
import './events.js';

export const LOW_BATTERY_PCT = 10;
const OFFLINE_NETWORKS = new Set(['none', 'offline', 'no_network', 'unknown']);

interface ActiveTripRow extends Record<string, unknown> {
  id: string;
  bus_id: string;
  route_id: string | null;
  direction: 'morning' | 'afternoon' | null;
  started_at: string;
  last_point_at: string | null;
  driver_staff_id: string | null;
  bus_code: string | null;
}

export interface GapDetectionResult {
  checked: number;
  flagged: number;
  alerts: number;
}

export function gapAlertType(point: StoredLiveState['point']): AlertType {
  if (point?.bat !== null && point?.bat !== undefined && point.bat <= LOW_BATTERY_PCT) return 'low_battery';
  if (point?.net && OFFLINE_NETWORKS.has(point.net)) return 'no_network';
  return 'gps_disabled';
}

/** One pass over a school's running trips (exported for tests). */
export async function detectLocationGaps(schoolId: string, { nowMs = Date.now(), logger = rootLogger.child({ job: 'location-gap-detector' }) }: { nowMs?: number; logger?: Logger } = {}): Promise<GapDetectionResult> {
  const { trips, cfg } = await withSchoolSystem(
    schoolId,
    async (tx) => ({
      trips: await tx.many<ActiveTripRow>(
        `select t.id, t.bus_id, t.route_id, t.direction, t.started_at, t.last_point_at, t.driver_staff_id,
                coalesce(t.bus_code_snapshot, b.code) as bus_code
           from trips t join buses b on b.id = t.bus_id
          where t.status = 'in_progress'`,
      ),
      cfg: await readTrackingConfig(tx),
    }),
    { readOnly: true },
  );
  const result: GapDetectionResult = { checked: trips.length, flagged: 0, alerts: 0 };
  const alerts: RaiseAlertInput[] = [];
  for (const trip of trips) {
    await liveStore.withLock(schoolId, trip.id, async () => {
      const state =
        (await liveStore.get(schoolId, trip.id)) ??
        newLiveState({ schoolId, tripId: trip.id, busId: trip.bus_id, routeId: trip.route_id, direction: trip.direction, tripStatus: 'in_progress', lastPointAt: trip.last_point_at });
      // Arrival time of the newest fix (a forward-dated or slow-clock fix counts from when it arrived).
      const pointMs = state.point ? lastHeardMs(state) : NaN;
      const candidates = [pointMs, trip.last_point_at ? Math.min(Date.parse(trip.last_point_at), nowMs) : NaN].filter(Number.isFinite);
      const lastMs = candidates.length ? Math.max(...candidates) : Date.parse(trip.started_at);
      const ageS = (nowMs - lastMs) / 1000;
      if (ageS <= staleAfterS(cfg, state.motion)) return;
      if (!state.locationUnavailable) {
        state.locationUnavailable = true;
        await liveStore.put(state);
        result.flagged += 1;
        await emitStatus(state, cfg, 'location_unavailable', {}, nowMs);
        events.emit('tracking.location_unavailable', { schoolId, tripId: trip.id, busId: trip.bus_id, lastPointAt: candidates.length ? new Date(lastMs).toISOString() : null });
      }
      if (ageS >= gapAlertAfterS(cfg, state.motion)) {
        const minutes = Math.floor(ageS / 60);
        const permission = (state.locationPermissionDeniedAtMs ?? null) !== null;
        const type: AlertType = permission ? 'location_permission' : gapAlertType(state.point);
        alerts.push({
          type,
          entity: { type: 'trip', id: trip.id },
          severity: permission ? 'critical' : 'warning',
          title: (permission
            ? `Location permission denied on the driver's phone for bus ${trip.bus_code ?? ''}: no update for ${minutes} min`
            : `Location unavailable for bus ${trip.bus_code ?? ''}: no update for ${minutes} min`
          ).replace('  ', ' '),
          tripId: trip.id,
          busId: trip.bus_id,
          staffId: trip.driver_staff_id,
          details: {
            reason: 'location_gap',
            lastPointAt: candidates.length ? new Date(lastMs).toISOString() : null,
            gapS: Math.round(ageS),
            battery: state.point?.bat ?? null,
            network: state.point?.net ?? null,
          },
          dedupeKey: `${type}:${trip.id}`,
        });
      }
    });
  }
  if (alerts.length) {
    const raised = await withSchoolSystem(schoolId, async (tx) => {
      const out: RaisedAlert[] = [];
      for (const a of alerts) {
        const r = await raiseAlert(tx, a);
        if (r) out.push(r);
      }
      return out;
    });
    await announceAlerts(raised);
    result.alerts = raised.length;
    if (raised.length) logger.info({ schoolId, alerts: raised.length }, 'Location gap alerts raised');
  }
  return result;
}

/** Every active school (the job handler). */
export async function detectLocationGapsAllSchools(opts: { nowMs?: number; logger?: Logger } = {}): Promise<GapDetectionResult> {
  const schools = await withSystem((tx) => tx.many<{ id: string }>('select id from active_school_ids() as id'), { readOnly: true });
  const total: GapDetectionResult = { checked: 0, flagged: 0, alerts: 0 };
  for (const s of schools) {
    try {
      const r = await detectLocationGaps(s.id, opts);
      total.checked += r.checked;
      total.flagged += r.flagged;
      total.alerts += r.alerts;
    } catch (err) {
      (opts.logger ?? rootLogger).error({ err, schoolId: s.id }, 'Location gap detection failed for a school');
    }
  }
  return total;
}
