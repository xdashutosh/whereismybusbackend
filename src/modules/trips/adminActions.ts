// School admin trip actions (BP §10.4, §13.3), each audited in the same transaction:
//   POST /school/trips/:id/cancel             scheduled or in-progress trip → cancelled (reason)
//   POST /school/trips/:id/correct-odometer   corrected start/end reading with a reason; the driver's
//                                             readings stay in odometer_correction.original and the
//                                             evidence rows are never changed; distances, the bus's last
//                                             known reading (latest closed trip) and the GPS comparison follow
//   POST /school/trips/:id/reassign           driver/conductor of a scheduled or running trip (snapshots)
import type { CancelTripBody, CorrectOdometerBody, OdometerCorrection, ReassignTripBody, TripDetail } from '@wimb/shared';
import type { Request } from 'express';
import type { Tx } from '../../db/tenant.js';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { audit } from '../../shared/audit.js';
import { events } from '../../shared/events.js';
import { logger as rootLogger } from '../../shared/logger.js';
import { realtime } from '../../shared/realtime.js';
import { fieldError, invalidState, notFound, odometerInvalid, tripAlreadyActive } from '../../shared/errors.js';
import { announceAlerts, type RaisedAlert } from '../alerts/service.js';
import { loadSchoolSettings } from '../school/index.js';
import { detail } from './adminQueries.js';
import { schoolContext } from './context.js';
import { tripAuditView } from './dto.js';
import { publishTripStatus, statusPayload } from './events.js';
import { gpsMismatchAlert } from './odometer.js';
import * as repo from './repository.js';
import * as writes from './writes.js';

const log = rootLogger.child({ module: 'trips.admin' });
const tripNotFound = () => notFound('Trip not found.');

async function lockTrip(tx: Tx, id: string): Promise<repo.TripRow> {
  const t = await repo.findTrip(tx, id, { lock: true });
  if (!t) throw tripNotFound();
  return t;
}

export async function cancelTrip(req: Request, id: string, body: CancelTripBody): Promise<TripDetail> {
  const { auth } = schoolContext(req);
  const { before, after } = await withRequestTenant(req, async (tx) => {
    const t = await lockTrip(tx, id);
    if (t.status !== 'scheduled' && t.status !== 'in_progress') {
      throw invalidState(`A ${t.status.replace('_', ' ')} trip cannot be cancelled.`, { reason: 'NOT_CANCELLABLE', status: t.status });
    }
    const updated = await writes.cancel(tx, id, body.reason, auth.actorId);
    if (!updated) throw invalidState('This trip can no longer be cancelled.', { reason: 'NOT_CANCELLABLE' });
    await audit.log(tx, { action: 'trip.cancel', entityType: 'trip', entityId: id, old: { status: t.status }, new: { status: updated.status, reason: body.reason } });
    return { before: t, after: updated };
  });
  await publishTripStatus(statusPayload(after, before.status, body.reason));
  return detail(req, id);
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export async function correctOdometer(req: Request, id: string, body: CorrectOdometerBody): Promise<TripDetail> {
  const { auth } = schoolContext(req);
  const alerts = await withRequestTenant(req, async (tx) => {
    const t = await lockTrip(tx, id);
    const allowed = body.kind === 'start' ? ['in_progress', 'completed', 'auto_closed'] : ['completed', 'auto_closed'];
    if (!allowed.includes(t.status)) {
      throw invalidState(`The ${body.kind} reading of a ${t.status.replace('_', ' ')} trip cannot be corrected.`, { reason: 'NOT_CORRECTABLE', status: t.status });
    }
    const start = body.kind === 'start' ? body.reading : t.start_odometer === null ? null : Number(t.start_odometer);
    const end = body.kind === 'end' ? body.reading : t.end_odometer === null ? null : Number(t.end_odometer);
    if (start !== null && end !== null && end < start) {
      throw odometerInvalid(`The end reading (${end} km) must not be lower than the start reading (${start} km).`, { startOdometer: start, endOdometer: end });
    }
    const from = body.kind === 'start' ? t.start_odometer : t.end_odometer;
    if (from !== null && Number(from) === body.reading) throw fieldError('reading', 'The reading is already this value');
    const previous = (t.odometer_correction as OdometerCorrection | null) ?? null;
    const correction: OdometerCorrection = {
      original: previous?.original ?? { start: t.start_odometer === null ? null : Number(t.start_odometer), end: t.end_odometer === null ? null : Number(t.end_odometer) },
      history: [
        ...(previous?.history ?? []),
        { kind: body.kind, from: from === null ? null : Number(from), to: body.reading, reason: body.reason, by: auth.actorId, byName: auth.actorName, at: new Date().toISOString() },
      ],
    };
    const updated = await writes.applyOdometerCorrection(tx, id, {
      start,
      end,
      distanceOdometerKm: start !== null && end !== null ? round1(end - start) : null,
      correction: correction as unknown as Record<string, unknown>,
    });
    let busOdometerUpdated = false;
    if (body.kind === 'end' && updated.ended_at && (await repo.isLatestClosedTrip(tx, updated.bus_id, updated.id, updated.ended_at))) {
      await repo.updateBusOdometer(tx, updated.bus_id, body.reading);
      busOdometerUpdated = true;
    }
    const raised: (RaisedAlert | null)[] = [];
    if (updated.status !== 'in_progress') raised.push(await gpsMismatchAlert(tx, updated, await loadSchoolSettings(tx)));
    await audit.log(tx, {
      action: 'trip.correct_odometer',
      entityType: 'trip',
      entityId: id,
      old: { startOdometer: t.start_odometer === null ? null : Number(t.start_odometer), endOdometer: t.end_odometer === null ? null : Number(t.end_odometer), distanceOdometerKm: t.distance_odometer_km },
      new: { kind: body.kind, reading: body.reading, reason: body.reason, startOdometer: start, endOdometer: end, distanceOdometerKm: updated.distance_odometer_km, busOdometerUpdated },
    });
    return raised.filter((a): a is RaisedAlert => a !== null);
  });
  await announceAlerts(alerts);
  return detail(req, id);
}

async function staffFor(tx: Tx, staffId: string, type: 'driver' | 'conductor', field: string): Promise<{ id: string; name: string }> {
  const s = await tx.maybeOne<{ id: string; full_name: string; staff_type: string; is_active: boolean }>(
    'select id, full_name, staff_type, is_active from staff_profiles where id = $1 and deleted_at is null',
    [staffId],
  );
  if (!s) throw notFound(`${type === 'driver' ? 'Driver' : 'Conductor'} not found.`, { field });
  if (s.staff_type !== type) throw fieldError(field, `Must be a ${type}`);
  if (!s.is_active) throw invalidState(`${s.full_name} is inactive.`, { field, reason: 'STAFF_INACTIVE' });
  return { id: s.id, name: s.full_name };
}

export async function reassignTrip(req: Request, id: string, body: ReassignTripBody): Promise<TripDetail> {
  const out = await withRequestTenant(req, async (tx) => {
    const t = await lockTrip(tx, id);
    if (t.status !== 'scheduled' && t.status !== 'in_progress') {
      throw invalidState(`A ${t.status.replace('_', ' ')} trip cannot be reassigned.`, { reason: 'NOT_REASSIGNABLE', status: t.status });
    }
    const setDriver = body.driverId !== undefined;
    const setConductor = body.conductorId !== undefined;
    const driver = body.driverId ? await staffFor(tx, body.driverId, 'driver', 'driverId') : null;
    const conductor = body.conductorId ? await staffFor(tx, body.conductorId, 'conductor', 'conductorId') : null;
    if (t.status === 'in_progress' && setDriver && !driver) throw fieldError('driverId', 'A trip in progress needs a driver');
    if (t.status === 'in_progress') {
      for (const s of [setDriver ? driver : null, setConductor ? conductor : null]) {
        if (s && s.id !== t.driver_staff_id && s.id !== t.conductor_staff_id && (await repo.staffBusy(tx, s.id, t.id))) {
          throw tripAlreadyActive(`${s.name} is on another trip in progress.`, { reason: 'STAFF_BUSY', staffId: s.id });
        }
      }
    }
    const updated = await writes.reassign(tx, id, { driver, conductor, setDriver, setConductor });
    await audit.log(tx, {
      action: 'trip.reassign',
      entityType: 'trip',
      entityId: id,
      old: { driverStaffId: t.driver_staff_id, driverName: t.driver_name_snapshot, conductorStaffId: t.conductor_staff_id, conductorName: t.conductor_name_snapshot },
      new: { driverStaffId: updated.driver_staff_id, driverName: updated.driver_name_snapshot, conductorStaffId: updated.conductor_staff_id, conductorName: updated.conductor_name_snapshot, reason: body.reason, trip: tripAuditView(updated) },
    });
    // Users who were crew before and are not any more: their trip-room membership is re-checked after
    // commit (the user who started a running trip keeps it — the trip stays bound to that phone).
    const removedStaff = [t.driver_staff_id, t.conductor_staff_id].filter((sid): sid is string => sid !== null && sid !== updated.driver_staff_id && sid !== updated.conductor_staff_id);
    const removedUsers = await repo.userIdsOfStaff(tx, removedStaff);
    return Object.assign(updated, { removedUsers });
  });
  if (out.removedUsers.length) {
    await realtime.revalidateActors(out.removedUsers).catch((err: unknown) => log.warn({ err, tripId: id }, 'Crew room revalidation could not be requested'));
  }
  events.emit('trip.reassigned', { schoolId: out.school_id, tripId: out.id, driverStaffId: out.driver_staff_id, conductorStaffId: out.conductor_staff_id });
  await publishTripStatus(statusPayload(out, out.status, body.reason), { event: false });
  return detail(req, id);
}
