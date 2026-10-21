// Odometer rules (BP §10.2 rule 3–4, §10.3 rule 1–4, §11.1): evidence photo checks, the start-time
// comparison with the bus's last reading and the previous closed trip (odometer_decrease /
// odometer_gap), and the end-time odometer ↔ GPS comparison with its minimum-km guard
// (odometer_gps_mismatch). Pure decision functions are exported for unit tests; the alert writers
// run inside the caller's transaction and return the alerts they created (announce after commit).
import { LATE_POINTS_WINDOW_HOURS, MIN_LOCATION_INTERVAL_S, type SchoolSettingsDto, type TripConfig } from '@wimb/shared';
import type { Tx } from '../../db/tenant.js';
import { raiseAlert, type RaisedAlert } from '../alerts/service.js';
import { validationError } from '../../shared/errors.js';
import * as repo from './repository.js';

/** A gap above this multiple of the threshold is critical instead of a warning. */
export const CRITICAL_GAP_FACTOR = 4;

/** Harsh-driving alerts are raised only when the school turned them on and its effective `harshDriving` feature (platform + plan) allows them. */
export function harshDrivingEnabled(s: SchoolSettingsDto): boolean {
  return s.enableHarshDrivingAlert && s.effective.features.harshDriving;
}

export function tripConfigOf(s: SchoolSettingsDto): TripConfig {
  return {
    movingIntervalS: Math.max(MIN_LOCATION_INTERVAL_S, s.effective.movingIntervalS),
    stoppedIntervalS: s.effective.stoppedIntervalS,
    movingSpeedKmh: s.effective.movingSpeedKmh,
    stoppedAfterS: s.effective.stoppedAfterS,
    minIntervalS: MIN_LOCATION_INTERVAL_S,
    latePointsWindowHours: LATE_POINTS_WINDOW_HOURS,
    odometerGalleryAllowed: s.odometerGalleryAllowed,
    allowNonSchoolTrips: s.allowNonSchoolTrips,
    allowBackupDriverStart: s.allowBackupDriverStart,
    odometerMismatchThresholdKm: s.odometerMismatchThresholdKm,
    odometerGpsVariancePct: s.odometerGpsVariancePct,
    odometerGpsMinKm: s.odometerGpsMinKm,
    tripNotStartedGraceMin: s.tripNotStartedGraceMin,
    staleTripCloseHours: s.effective.staleTripCloseHours,
    harshDrivingEnabled: harshDrivingEnabled(s),
  };
}

// ── pure decisions ───────────────────────────────────────────────────────────
export type GapVerdict = { kind: 'none' } | { kind: 'gap'; gapKm: number; severity: 'warning' | 'critical' } | { kind: 'decrease'; gapKm: number };

/** start − previous end: > threshold → gap (critical above CRITICAL_GAP_FACTOR × threshold), < 0 → decrease. */
export function gapVerdict(startReading: number, previousEnd: number, thresholdKm: number): GapVerdict {
  const gapKm = Math.round((startReading - previousEnd) * 10) / 10;
  if (gapKm < 0) return { kind: 'decrease', gapKm };
  if (gapKm > thresholdKm) return { kind: 'gap', gapKm, severity: gapKm > thresholdKm * CRITICAL_GAP_FACTOR ? 'critical' : 'warning' };
  return { kind: 'none' };
}

export interface MismatchVerdict {
  mismatch: boolean;
  diffKm: number;
  /** |odo − gps| / max(odo, gps) in percent (0 when both are 0). */
  pct: number;
}

/** BP §10.3 rule 3: relative difference above the variance AND absolute difference ≥ the minimum km. */
export function gpsMismatch(odometerKm: number, gpsKm: number, variancePct: number, minKm: number): MismatchVerdict {
  const diffKm = Math.round(Math.abs(odometerKm - gpsKm) * 10) / 10;
  const base = Math.max(odometerKm, gpsKm);
  const pct = base > 0 ? Math.round((diffKm / base) * 1000) / 10 : 0;
  return { mismatch: base > 0 && pct > variancePct && diffKm >= minKm, diffKm, pct };
}

// ── evidence photo ───────────────────────────────────────────────────────────
export interface PhotoEvidence {
  fileId: string;
  source: 'camera' | 'gallery';
  sha256: string | null;
  capturedAt: string | null;
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
}

const photoError = (message: string) => validationError(message, [{ path: 'odometerFileId', message }]);

/**
 * The photo must be an uploaded 'odometer' file of this school, uploaded by the caller, attached to
 * the bus or the trip, not used as evidence before, and captured with the live camera unless the
 * school allows gallery photos (BP §10.2 rule 3 — the capture metadata is part of the signed upload).
 */
export async function checkPhoto(
  tx: Tx,
  p: { fileId: string; actorId: string; busId: string; tripId: string | null; galleryAllowed: boolean },
): Promise<PhotoEvidence> {
  const f = await repo.findOdometerFile(tx, p.fileId);
  if (!f || f.category !== 'odometer') throw photoError('Odometer photo not found. Upload the photo first.');
  if (f.status !== 'uploaded') throw photoError('The odometer photo upload is not complete yet.');
  if (f.uploaded_by !== p.actorId) throw photoError('The odometer photo must be taken by you.');
  const attached = (f.entity_type === 'bus' && f.entity_id === p.busId) || (f.entity_type === 'trip' && p.tripId !== null && f.entity_id === p.tripId);
  if (!attached) throw photoError('The odometer photo belongs to another bus or trip.');
  if (f.used) throw photoError('This odometer photo was already used. Take a new photo.');
  const capture = (f.metadata?.capture ?? {}) as Record<string, unknown>;
  const source = capture.source === 'camera' ? 'camera' : 'gallery';
  if (source !== 'camera' && !p.galleryAllowed) throw photoError('Take a live camera photo of the odometer (gallery photos are not allowed).');
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    fileId: f.id,
    source,
    sha256: f.sha256,
    capturedAt: typeof capture.capturedAt === 'string' ? capture.capturedAt : null,
    latitude: num(capture.latitude),
    longitude: num(capture.longitude),
    accuracyM: num(capture.accuracyM),
  };
}

// ── alert writers ────────────────────────────────────────────────────────────
interface TripRef {
  id: string;
  bus_id: string;
  bus_code_snapshot: string | null;
  driver_staff_id: string | null;
}

const busLabel = (t: TripRef) => (t.bus_code_snapshot ? `Bus ${t.bus_code_snapshot}` : 'Bus');

/**
 * Start reading vs the bus's last known reading and the previous closed trip (BP §10.2 rule 4,
 * §10.3 rule 4). Decrease is critical; one alert per trip and kind.
 */
export async function startOdometerAlerts(tx: Tx, trip: TripRef, reading: number, lastKnown: number | null, thresholdKm: number): Promise<RaisedAlert[]> {
  const prev = await repo.previousClosedTrip(tx, trip.bus_id, trip.id);
  // Decrease baseline: the bus's last known reading AND every reading recorded on a started trip of
  // the bus (an auto-closed trip has a start reading but no end reading).
  const highest = await repo.highestRecordedReading(tx, trip.bus_id, trip.id);
  const out: (RaisedAlert | null)[] = [];
  const verdict = prev ? gapVerdict(reading, prev.end_odometer, thresholdKm) : { kind: 'none' as const };
  const belowLastKnown = lastKnown !== null && reading < lastKnown;
  const belowRecorded = highest !== null && reading < highest.reading;
  const base = { tripId: trip.id, busId: trip.bus_id, staffId: trip.driver_staff_id, entity: { type: 'trip' as const, id: trip.id } };
  if (verdict.kind === 'decrease' || belowLastKnown || belowRecorded) {
    out.push(
      await raiseAlert(tx, {
        ...base,
        type: 'odometer_decrease',
        severity: 'critical',
        title: `${busLabel(trip)}: odometer decreased (tampering suspected)`,
        details: {
          phase: 'start',
          reading,
          lastKnownOdometer: lastKnown,
          previousTripId: prev?.id ?? null,
          previousEndOdometer: prev?.end_odometer ?? null,
          highestRecordedOdometer: highest?.reading ?? null,
          highestRecordedTripId: highest?.trip_id ?? null,
        },
        dedupeKey: `odometer_decrease:${trip.id}:start`,
        once: true,
      }),
    );
  } else if (verdict.kind === 'gap') {
    out.push(
      await raiseAlert(tx, {
        ...base,
        type: 'odometer_gap',
        severity: verdict.severity,
        title: `${busLabel(trip)}: unexplained odometer gap of ${verdict.gapKm} km (possible unrecorded use)`,
        details: { reading, previousTripId: prev!.id, previousEndOdometer: prev!.end_odometer, gapKm: verdict.gapKm, thresholdKm },
        dedupeKey: `odometer_gap:${trip.id}`,
        once: true,
      }),
    );
  }
  return out.filter((a): a is RaisedAlert => a !== null);
}

/** End reading below the bus's last known reading (another reading was recorded meanwhile). */
export async function endDecreaseAlert(tx: Tx, trip: TripRef, reading: number, lastKnown: number | null): Promise<RaisedAlert | null> {
  if (lastKnown === null || reading >= lastKnown) return null;
  return raiseAlert(tx, {
    type: 'odometer_decrease',
    severity: 'critical',
    title: `${busLabel(trip)}: end odometer below the last known reading`,
    entity: { type: 'trip', id: trip.id },
    tripId: trip.id,
    busId: trip.bus_id,
    staffId: trip.driver_staff_id,
    details: { phase: 'end', reading, lastKnownOdometer: lastKnown },
    dedupeKey: `odometer_decrease:${trip.id}:end`,
    once: true,
  });
}

/**
 * Odometer ↔ GPS comparison (BP §10.3 rule 3). Exported for the trip-finalizer, which re-runs it once
 * late points arrived (same dedupe key → at most one alert per trip).
 */
export async function gpsMismatchAlert(
  tx: Tx,
  trip: TripRef & { start_odometer: number | null; end_odometer: number | null; distance_gps_km: number | null },
  s: Pick<SchoolSettingsDto, 'odometerGpsVariancePct' | 'odometerGpsMinKm'>,
): Promise<RaisedAlert | null> {
  if (trip.start_odometer === null || trip.end_odometer === null || trip.distance_gps_km === null) return null;
  const odometerKm = Math.round((trip.end_odometer - trip.start_odometer) * 10) / 10;
  const v = gpsMismatch(odometerKm, trip.distance_gps_km, s.odometerGpsVariancePct, s.odometerGpsMinKm);
  if (!v.mismatch) return null;
  return raiseAlert(tx, {
    type: 'odometer_gps_mismatch',
    severity: 'warning',
    title: `${busLabel(trip)}: odometer ${odometerKm} km vs GPS ${trip.distance_gps_km} km`,
    entity: { type: 'trip', id: trip.id },
    tripId: trip.id,
    busId: trip.bus_id,
    staffId: trip.driver_staff_id,
    details: { odometerKm, gpsKm: trip.distance_gps_km, diffKm: v.diffKm, diffPct: v.pct, variancePct: s.odometerGpsVariancePct, minKm: s.odometerGpsMinKm },
    dedupeKey: `odometer_gps_mismatch:${trip.id}`,
    once: true,
  });
}

/** Dedupe key of the "odometer distance without any GPS data" flag (separate from a real mismatch). */
export const noGpsDedupeKey = (tripId: string): string => `odometer_gps_mismatch:${tripId}:no_gps`;

/**
 * Odometer distance with no usable GPS data at all (BP §10.3 rule 3 with GPS = 0): a trip of at least
 * odometerGpsMinKm whose phone sent fewer than MIN_GPS_POINTS usable points is flagged, so keeping GPS
 * off cannot hide an inflated end reading (which becomes the bus baseline). The trip-finalizer closes
 * this flag when late points later give a GPS distance (resolveNoGpsFlag) and then runs the regular
 * comparison instead.
 */
export async function noGpsDataAlert(
  tx: Tx,
  trip: TripRef & { start_odometer: number | null; end_odometer: number | null; distance_gps_km: number | null },
  s: Pick<SchoolSettingsDto, 'odometerGpsMinKm'>,
  extra: { gpsPoints: number; pendingPoints: number | null },
): Promise<RaisedAlert | null> {
  if (trip.start_odometer === null || trip.end_odometer === null || trip.distance_gps_km !== null) return null;
  const odometerKm = Math.round((trip.end_odometer - trip.start_odometer) * 10) / 10;
  if (odometerKm <= 0 || odometerKm < s.odometerGpsMinKm) return null;
  return raiseAlert(tx, {
    type: 'odometer_gps_mismatch',
    severity: 'warning',
    title: `${busLabel(trip)}: odometer ${odometerKm} km but no GPS data for the trip`,
    entity: { type: 'trip', id: trip.id },
    tripId: trip.id,
    busId: trip.bus_id,
    staffId: trip.driver_staff_id,
    details: { reason: 'no_gps_data', odometerKm, gpsKm: null, gpsPoints: extra.gpsPoints, pendingPoints: extra.pendingPoints, minKm: s.odometerGpsMinKm },
    dedupeKey: noGpsDedupeKey(trip.id),
    once: true,
  });
}
