// POST /driver/trips/:id/end (BP §10.3) in one transaction:
//   1. end reading ≥ start reading — hard reject (422 ODOMETER_INVALID)
//   2. live camera photo (same evidence checks as the start)
//   3. distance_odometer = end − start; GPS distance from the location points (gps.ts provider);
//      odometer_gps_mismatch when |odo − gps| / max(odo, gps) > variance AND |odo − gps| ≥ min km;
//      with no usable GPS data at all (GPS kept off) a trip of ≥ min km is flagged too (reason
//      no_gps_data — closed by the trip-finalizer if late points later give a GPS distance)
//   4. the gap to the previous closed trip was evaluated at the start (odometer_gap / odometer_decrease);
//      an end reading below the bus's last known reading raises odometer_decrease
//   5. buses.last_known_odometer = end; status completed; trip-finalizer queued after commit
//   6. the end is accepted even if the last location batch failed: points of the trip are accepted for
//      LATE_POINTS_WINDOW_HOURS after ended_at (tracking module ingestion)
// Only the device that started the trip may end it (DEVICE_NOT_BOUND otherwise). Retrying an end with
// the same reading and photo returns the completed trip.
import { LATE_POINTS_WINDOW_HOURS, type EndTripBody, type TripEndResult } from '@wimb/shared';
import type { Request } from 'express';
import type { Tx } from '../../db/tenant.js';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { audit } from '../../shared/audit.js';
import { deviceNotBound, invalidState, notFound, odometerInvalid } from '../../shared/errors.js';
import { announceAlerts, raiseAlert, type RaisedAlert } from '../alerts/service.js';
import { loadSchoolSettings } from '../school/index.js';
import { briefOf, driverContext, isParticipant, withServerTime, type DriverContext } from './context.js';
import { toDriverTrip, tripAuditView } from './dto.js';
import { enqueueFinalizer, publishTripStatus, statusPayload, type TripStatusPayload } from './events.js';
import { gpsDistance } from './gps.js';
import { checkPhoto, endDecreaseAlert, gpsMismatchAlert, noGpsDataAlert } from './odometer.js';
import * as repo from './repository.js';
import * as writes from './writes.js';

export const acceptPointsUntil = (endedAt: string): string => new Date(Date.parse(endedAt) + LATE_POINTS_WINDOW_HOURS * 3600_000).toISOString();

/** Loads a trip of the caller (404 for anyone else's trip — existence is not revealed). */
export async function ownTrip(tx: Tx, c: DriverContext, tripId: string, { lock = false } = {}): Promise<{ trip: repo.TripRow; staffId: string | null }> {
  const trip = await repo.findTrip(tx, tripId, { lock });
  const staff = await repo.staffOfUser(tx, c.auth.actorId);
  if (!trip || !isParticipant(trip, c.auth.actorId, staff?.id ?? null)) throw notFound('Trip not found.');
  return { trip, staffId: staff?.id ?? null };
}

export function assertSameDevice(trip: repo.TripRow, c: DriverContext): void {
  if (trip.device_id !== c.device.id) throw deviceNotBound('This trip was started on another phone. Continue it on that phone.');
}

interface EndOutcome {
  result: Omit<TripEndResult, 'serverTime'>;
  alerts: RaisedAlert[];
  status: TripStatusPayload | null;
}

async function endTx(tx: Tx, c: DriverContext, tripId: string, body: EndTripBody): Promise<EndOutcome> {
  const { trip } = await ownTrip(tx, c, tripId, { lock: true });
  if (trip.status === 'completed') {
    const ev = await repo.evidenceFileId(tx, trip.id, 'end');
    if (ev?.file_id === body.odometerFileId && Number(trip.end_odometer) === body.odometerReading && trip.device_id === c.device.id) {
      return { result: { trip: toDriverTrip(trip, c.device.id), alerts: [], acceptPointsUntil: acceptPointsUntil(trip.ended_at!), replayed: true }, alerts: [], status: null };
    }
    throw invalidState('This trip is already completed.', { reason: 'NOT_IN_PROGRESS', status: trip.status });
  }
  if (trip.status !== 'in_progress') throw invalidState(`This trip is ${trip.status.replace('_', ' ')}.`, { reason: 'NOT_IN_PROGRESS', status: trip.status });
  assertSameDevice(trip, c);
  const start = Number(trip.start_odometer ?? 0);
  if (body.odometerReading < start) {
    throw odometerInvalid(`The end reading must not be lower than the start reading (${start} km).`, { startOdometer: start, endOdometer: body.odometerReading });
  }
  const settings = await loadSchoolSettings(tx);
  const photo = await checkPhoto(tx, { fileId: body.odometerFileId, actorId: c.auth.actorId, busId: trip.bus_id, tripId: trip.id, galleryAllowed: settings.odometerGalleryAllowed });
  const bus = await repo.findBus(tx, trip.bus_id, { lock: true });
  const gps = await gpsDistance(tx, trip);
  const ended = await writes.complete(tx, trip.id, {
    endedBy: c.auth.actorId,
    deviceTime: body.deviceTime,
    latitude: body.latitude,
    longitude: body.longitude,
    odometer: body.odometerReading,
    distanceOdometerKm: Math.round((body.odometerReading - start) * 10) / 10,
    distanceGpsKm: gps.km,
  });
  if (!ended) throw invalidState('This trip is no longer in progress.', { reason: 'NOT_IN_PROGRESS' });
  await repo.insertEvidence(tx, {
    tripId: trip.id,
    kind: 'end',
    reading: body.odometerReading,
    fileId: photo.fileId,
    capturedAt: photo.capturedAt ?? body.deviceTime,
    latitude: photo.latitude ?? body.latitude,
    longitude: photo.longitude ?? body.longitude,
    accuracyM: photo.accuracyM ?? body.accuracyM ?? null,
    sha256: photo.sha256,
    source: photo.source,
    deviceId: c.device.id,
    recordedBy: c.auth.actorId,
  });
  const raised: (RaisedAlert | null)[] = [
    await endDecreaseAlert(tx, ended, body.odometerReading, bus?.last_known_odometer ?? null),
    await gpsMismatchAlert(tx, ended, settings),
    await noGpsDataAlert(tx, ended, settings, { gpsPoints: gps.points, pendingPoints: body.pendingPoints ?? null }),
  ];
  if (ended.trip_type === 'non_school') {
    raised.push(
      await raiseAlert(tx, {
        type: 'non_school_trip',
        severity: 'info',
        title: `Bus ${ended.bus_code_snapshot ?? ''}: non-school trip (${ended.distance_odometer_km ?? 0} km) — ${ended.purpose ?? ''}`.slice(0, 300),
        entity: { type: 'trip', id: ended.id },
        tripId: ended.id,
        busId: ended.bus_id,
        staffId: ended.driver_staff_id,
        details: { purpose: ended.purpose, distanceOdometerKm: ended.distance_odometer_km, distanceGpsKm: ended.distance_gps_km, startedAt: ended.started_at, endedAt: ended.ended_at },
        dedupeKey: `non_school_trip:${ended.id}`,
        once: true,
      }),
    );
  }
  if (bus) await repo.updateBusOdometer(tx, bus.id, body.odometerReading);
  const alerts = raised.filter((a): a is RaisedAlert => a !== null);
  await audit.log(tx, {
    action: 'trip.end',
    entityType: 'trip',
    entityId: trip.id,
    old: tripAuditView(trip),
    new: { ...tripAuditView(ended), photoFileId: photo.fileId, photoSource: photo.source, gpsPoints: gps.points, pendingPoints: body.pendingPoints ?? null, alerts: alerts.map((a) => a.type) },
  });
  return {
    result: { trip: toDriverTrip(ended, c.device.id), alerts: briefOf(alerts), acceptPointsUntil: acceptPointsUntil(ended.ended_at!), replayed: false },
    alerts,
    status: statusPayload(ended, trip.status),
  };
}

export async function endTrip(req: Request, tripId: string, body: EndTripBody): Promise<TripEndResult> {
  const c = driverContext(req);
  const outcome = await withRequestTenant(req, (tx) => endTx(tx, c, tripId, body));
  if (outcome.status) {
    await publishTripStatus(outcome.status);
    await enqueueFinalizer(c.schoolId, tripId);
  }
  await announceAlerts(outcome.alerts);
  return withServerTime(outcome.result);
}
