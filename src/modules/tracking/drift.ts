// Clock-drift alert (BP §14.3 anti-tamper: device-time vs server-time drift check). Raised when the
// location ingestion (or a device-events batch) finds the phone clock off by more than
// CLOCK_DRIFT_TOLERANCE_MS: 'corrected' — the timestamps were shifted onto the server clock (tracking
// keeps working; the driver should switch on automatic date and time); 'rejected' — the offset is beyond
// CLOCK_DRIFT_MAX_CORRECTION_MS and the points are dropped until the clock is fixed. One alert per trip
// while it is open (dedupe key clock_drift:{tripId}); a rejected clock is critical.
import type { ClockDriftAction } from '@wimb/shared';
import type { Tx } from '../../db/tenant.js';
import { withSchoolSystem } from '../../db/tenant.js';
import { logger as rootLogger } from '../../shared/logger.js';
import { announceAlerts, raiseAlert, type RaisedAlert } from '../alerts/service.js';
import type { ClockOffsetSource } from './clock.js';

const log = rootLogger.child({ module: 'tracking.drift' });

export interface ClockDriftReport {
  tripId: string;
  busId: string;
  busCode: string | null;
  staffId: string | null;
  /** server − device (ms); null when the app reported a drift without its size. */
  offsetMs: number | null;
  action: Exclude<ClockDriftAction, 'none'>;
  /** Where the offset came from: batch sentAt, inference, the app's own clock_drift event, … */
  source: ClockOffsetSource | 'device_event';
  /** 'locations' (ingestion) or 'events' (device events batch). */
  via: 'locations' | 'events';
  deviceId?: string | null;
}

/** "3 min", "2 h 5 min", "1 d 2 h" — human size of an offset. */
export function offsetText(offsetMs: number): string {
  const totalMin = Math.max(1, Math.round(Math.abs(offsetMs) / 60_000));
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d) return h ? `${d} d ${h} h` : `${d} d`;
  if (h) return m ? `${h} h ${m} min` : `${h} h`;
  return `${m} min`;
}

/** Inserts the clock_drift alert of the current school (deduplicated per trip). */
export function raiseClockDriftAlert(tx: Tx, r: ClockDriftReport): Promise<RaisedAlert | null> {
  const bus = r.busCode ? `Bus ${r.busCode}` : 'Bus';
  const outcome = r.action === 'corrected' ? 'location times corrected' : 'locations rejected until the clock is fixed';
  const size = r.offsetMs === null ? 'wrong' : `${offsetText(r.offsetMs)} ${r.offsetMs > 0 ? 'behind' : 'ahead of'} the server`;
  return raiseAlert(tx, {
    type: 'clock_drift',
    severity: r.action === 'rejected' ? 'critical' : 'warning',
    title: `${bus}: driver's phone clock is ${size} — ${outcome}`,
    entity: { type: 'trip', id: r.tripId },
    tripId: r.tripId,
    busId: r.busId,
    staffId: r.staffId,
    details: { reason: 'clock_drift', offsetMs: r.offsetMs, action: r.action, source: r.source, via: r.via, deviceId: r.deviceId ?? null },
    dedupeKey: `clock_drift:${r.tripId}`,
  });
}

/** After the ingestion answered: raises and announces the alert. Never throws. */
export async function reportClockDrift(schoolId: string, r: ClockDriftReport): Promise<void> {
  try {
    const raised = await withSchoolSystem(schoolId, (tx) => raiseClockDriftAlert(tx, r));
    await announceAlerts([raised]);
  } catch (err) {
    log.warn({ err, schoolId, tripId: r.tripId }, 'Could not raise the clock drift alert');
  }
}
