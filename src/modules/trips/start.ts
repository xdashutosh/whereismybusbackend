// POST /driver/trips/start (BP §8.4, §10.2) — every validation in ONE transaction:
//   1. caller active (authenticate) + school active (resolveTenant) + bound device (requireBoundDevice);
//      an active staff profile assigned to the bus now (primary/backup driver, conductor, backup
//      conductor); backup drivers only when school_settings.allow_backup_driver_start
//   2. no other in-progress trip for the bus nor for the caller (one_active_trip_per_* as backstop)
//   3. odometer reading + an uploaded odometer photo of the caller, camera source unless
//      odometer_gallery_allowed; SHA-256, device time and GPS stored as evidence
//   4. start ≥ last known reading / previous closed trip → else odometer_decrease / odometer_gap alerts
//   5. server start time, device time, user, bus, route, coordinates, device id recorded
//   6. returns the trip config (intervals, thresholds)
// School trips start a 'scheduled' trip of today; non-school trips (allow_non_school_trips, purpose
// required) are created in progress. client_start_id makes retries return the original start.
import type { StartTripBody, TripStartResult } from '@wimb/shared';
import type { Request } from 'express';
import type { Tx } from '../../db/tenant.js';
import { isPgError } from '../../db/pool.js';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { audit } from '../../shared/audit.js';
import { conflict, duplicate, forbidden, invalidState, notFound, tripAlreadyActive, validationError } from '../../shared/errors.js';
import { announceAlerts, type RaisedAlert } from '../alerts/service.js';
import { loadSchoolSettings } from '../school/index.js';
import { briefOf, driverContext, localToday, withServerTime, type DriverContext } from './context.js';
import { toDriverTrip, tripAuditView } from './dto.js';
import { publishTripStatus, statusPayload, type TripStatusPayload } from './events.js';
import { checkPhoto, startOdometerAlerts, tripConfigOf } from './odometer.js';
import * as repo from './repository.js';
import * as writes from './writes.js';

interface StartOutcome {
  /** serverTime is stamped when the answer leaves (withServerTime). */
  result: Omit<TripStartResult, 'serverTime'>;
  alerts: RaisedAlert[];
  status: TripStatusPayload | null;
}

type Person = { id: string; name: string } | null;

/** Planned partner (conductor for a driver start, driver for a conductor start) unless busy elsewhere. */
async function partner(tx: Tx, planned: Person, tripId: string | null): Promise<Person> {
  if (!planned) return null;
  return (await repo.staffBusy(tx, planned.id, tripId)) ? null : planned;
}

async function replayOf(tx: Tx, c: DriverContext, existing: repo.TripRow, body: StartTripBody): Promise<StartOutcome> {
  const sameRequest = existing.started_by === c.auth.actorId && existing.bus_id === body.busId && (!body.tripId || existing.id === body.tripId);
  if (!sameRequest) throw conflict('This clientStartId was already used for another trip start.', { reason: 'CLIENT_START_ID_REUSED' });
  const config = tripConfigOf(await loadSchoolSettings(tx));
  return { result: { trip: toDriverTrip(existing, c.device.id), config, alerts: [], replayed: true }, alerts: [], status: null };
}

async function startTx(tx: Tx, c: DriverContext, body: StartTripBody): Promise<StartOutcome> {
  // Concurrent retries of one start (app timeout + retry) queue here, BEFORE the replay lookup, so
  // the later ones see the committed start and replay it instead of hitting TRIP_IN_PROGRESS/BUS_BUSY.
  await repo.lockClientStartId(tx, body.clientStartId);
  const existing = await repo.findByClientStartId(tx, body.clientStartId);
  if (existing) return replayOf(tx, c, existing, body);

  const settings = await loadSchoolSettings(tx);
  const staff = await repo.staffOfUser(tx, c.auth.actorId);
  if (!staff || !staff.is_active) throw forbidden('Your staff profile is missing or inactive. Contact the school office.', { reason: 'NO_STAFF_PROFILE' });

  const bus = await repo.findBus(tx, body.busId, { lock: true });
  if (!bus) throw notFound('Bus not found.', { field: 'busId' });
  if (bus.status !== 'active') throw invalidState(`Bus ${bus.code} is not available for trips (${bus.status}).`, { reason: 'BUS_UNAVAILABLE', busStatus: bus.status });

  const role = await repo.assignmentRole(tx, bus.id, staff.id);
  if (!role) throw forbidden(`You are not assigned to bus ${bus.code}.`, { reason: 'NOT_ASSIGNED' });
  if (role === 'backup_driver' && !settings.allowBackupDriverStart) {
    throw forbidden('Backup drivers may not start trips at your school.', { reason: 'BACKUP_START_NOT_ALLOWED' });
  }

  let scheduled: repo.TripRow | null = null;
  if (body.tripType === 'school') {
    scheduled = await repo.findTrip(tx, body.tripId!, { lock: true });
    if (!scheduled || scheduled.trip_type !== 'school') throw notFound('Trip not found.', { field: 'tripId' });
    if (scheduled.bus_id !== bus.id) throw validationError(`This trip runs with bus ${scheduled.bus_code_snapshot ?? ''}.`.replace(' .', '.'), [{ path: 'busId', message: 'Does not match the trip' }]);
    if (scheduled.status === 'in_progress') throw tripAlreadyActive('This trip is already in progress.', { reason: 'TRIP_IN_PROGRESS', tripId: scheduled.id });
    if (scheduled.status !== 'scheduled') throw invalidState(`This trip is ${scheduled.status.replace('_', ' ')}.`, { reason: 'NOT_SCHEDULED', status: scheduled.status });
    if (scheduled.trip_date !== (await localToday(tx))) throw invalidState("Only today's trips can be started.", { reason: 'NOT_TODAY', tripDate: scheduled.trip_date });
  } else if (!settings.allowNonSchoolTrips) {
    throw forbidden('Your school does not allow non-school trips.', { reason: 'NON_SCHOOL_TRIPS_DISABLED' });
  }

  const busy = await repo.activeConflicts(tx, bus.id, c.auth.actorId, staff.id);
  const busBusy = busy.find((t) => t.bus_id === bus.id);
  if (busBusy) throw tripAlreadyActive(`Bus ${bus.code} already has a trip in progress.`, { reason: 'BUS_BUSY', tripId: busBusy.id });
  if (busy.length) throw tripAlreadyActive('You already have a trip in progress. End it first.', { reason: 'ALREADY_ON_TRIP', tripId: busy[0]!.id });

  const photo = await checkPhoto(tx, { fileId: body.odometerFileId, actorId: c.auth.actorId, busId: bus.id, tripId: scheduled?.id ?? null, galleryAllowed: settings.odometerGalleryAllowed });

  const me = { id: staff.id, name: staff.full_name };
  const driverRole = role === 'primary_driver' || role === 'backup_driver';
  const plannedDriver: Person = scheduled
    ? scheduled.driver_staff_id ? { id: scheduled.driver_staff_id, name: scheduled.driver_name_snapshot ?? '' } : null
    : await repo.currentStaffOfBus(tx, bus.id, 'primary_driver').then((s) => (s ? { id: s.id, name: s.full_name } : null));
  const plannedConductor: Person = scheduled
    ? scheduled.conductor_staff_id ? { id: scheduled.conductor_staff_id, name: scheduled.conductor_name_snapshot ?? '' } : null
    : await repo.currentStaffOfBus(tx, bus.id, 'conductor').then((s) => (s ? { id: s.id, name: s.full_name } : null));
  const driver = driverRole ? me : await partner(tx, plannedDriver?.id === me.id ? null : plannedDriver, scheduled?.id ?? null);
  const conductor = driverRole ? await partner(tx, plannedConductor?.id === me.id ? null : plannedConductor, scheduled?.id ?? null) : me;

  const write: writes.StartWrite = {
    startedBy: c.auth.actorId,
    deviceId: c.device.id,
    clientStartId: body.clientStartId,
    deviceTime: body.deviceTime,
    latitude: body.latitude,
    longitude: body.longitude,
    odometer: body.odometerReading,
    driver,
    conductor,
    busCode: bus.code,
    busRegistration: bus.registration_no,
  };
  const trip = scheduled ? await writes.startScheduled(tx, scheduled.id, write) : await writes.insertNonSchool(tx, bus.id, body.purpose!, write);
  if (!trip) throw invalidState('This trip can no longer be started.', { reason: 'NOT_SCHEDULED' });

  await repo.insertEvidence(tx, {
    tripId: trip.id,
    kind: 'start',
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
  const alerts = await startOdometerAlerts(tx, trip, body.odometerReading, bus.last_known_odometer, settings.odometerMismatchThresholdKm);
  await audit.log(tx, {
    action: 'trip.start',
    entityType: 'trip',
    entityId: trip.id,
    old: scheduled ? { status: scheduled.status } : null,
    new: { ...tripAuditView(trip), assignmentRole: role, photoFileId: photo.fileId, photoSource: photo.source, clientStartId: body.clientStartId, alerts: alerts.map((a) => a.type) },
  });
  return {
    result: { trip: toDriverTrip(trip, c.device.id), config: tripConfigOf(settings), alerts: briefOf(alerts), replayed: false },
    alerts,
    status: statusPayload(trip, scheduled ? scheduled.status : null),
  };
}

export async function startTrip(req: Request, body: StartTripBody): Promise<TripStartResult> {
  const c = driverContext(req);
  let outcome: StartOutcome;
  try {
    outcome = await withRequestTenant(req, (tx) => startTx(tx, c, body));
  } catch (err) {
    // A concurrent retry with the same clientStartId won the race: answer with its trip.
    if (isPgError(err) && err.code === '23505' && err.constraint === 'trips_client_start_id_key') {
      const replay = await withRequestTenant(req, async (tx) => {
        const existing = await repo.findByClientStartId(tx, body.clientStartId);
        return existing ? replayOf(tx, c, existing, body) : null;
      });
      if (replay) return withServerTime(replay.result);
      throw duplicate('This clientStartId was already used.', { reason: 'CLIENT_START_ID_REUSED' });
    }
    throw err;
  }
  if (outcome.status) await publishTripStatus(outcome.status);
  await announceAlerts(outcome.alerts);
  return withServerTime(outcome.result);
}
