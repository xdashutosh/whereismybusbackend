// Driver trip actions besides start/end (BP §8.4, §10.4, §14.3):
//   GET  /driver/trips/active      resume after an app restart (trip + config, onThisDevice flag)
//   GET  /driver/trips/history     own trips only (started, driven or conducted by the caller)
//   POST /driver/trips/:id/events  device warnings → gps_disabled / low_battery / no_network alerts
//                                  (mock_location → critical gps_disabled; trip_interrupted → interrupt;
//                                  harsh_* sensor events → harsh_driving when the school enables it;
//                                  location_permission_denied → critical location_permission alert + live
//                                  "location unavailable", _restored → that alert auto-closed; clock_drift →
//                                  clock_drift alert). Every event is stored in trip_device_events (trip
//                                  timeline) with occurredAt on the server clock (sentAt offset, BP §14.3).
//   POST /driver/trips/:id/interrupt  breakdown: the trip stays in progress (end it or the school cancels)
//   POST /driver/devices           FCM token + app/OS versions of the bound device
import { HARSH_DRIVING_EVENT_TYPES, LATE_POINTS_WINDOW_HOURS, type DriverActiveTripResult, type DriverDeviceBody, type DriverTrip, type DriverTripHistoryQuery, type InterruptTripBody, type TripDeviceEvent, type TripEventsBody, type TripEventsResult } from '@wimb/shared';
import type { Request } from 'express';
import type { Tx } from '../../db/tenant.js';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { audit } from '../../shared/audit.js';
import { events } from '../../shared/events.js';
import { invalidState } from '../../shared/errors.js';
import { listMeta, pagedQuery, parsePagination } from '../../shared/pagination.js';
import { announceAlertUpdates, type AlertUpdate } from '../alerts/publish.js';
import { announceAlerts, closeAlertByKey, raiseAlert, type RaisedAlert } from '../alerts/service.js';
import { clockAction, correctedMs, FUTURE_TOLERANCE_MS, resolveClockOffset, TRIP_START_TOLERANCE_MS, type ClockResolution } from '../tracking/clock.js';
import { raiseClockDriftAlert, type ClockDriftReport } from '../tracking/drift.js';
import { loadSchoolSettings } from '../school/index.js';
import { briefOf, driverContext, withServerTime, type DriverContext } from './context.js';
import { toDriverTrip } from './dto.js';
import { assertSameDevice, ownTrip } from './end.js';
import { publishTripStatus, statusPayload, type TripStatusPayload } from './events.js';
import { harshDrivingEnabled, tripConfigOf } from './odometer.js';
import { TRIP_COLUMNS, type TripRow } from './repository.js';
import * as repo from './repository.js';
import * as writes from './writes.js';

/** In-progress trip of the caller (started, driving or conducting). */
export function activeTripOf(tx: Tx, userId: string, staffId: string | null): Promise<TripRow | null> {
  return tx.maybeOne<TripRow>(
    `select ${TRIP_COLUMNS} from trips t
      where t.status = 'in_progress' and (t.started_by = $1 or t.driver_staff_id = $2 or t.conductor_staff_id = $2)
      order by t.started_at desc limit 1`,
    [userId, staffId],
  );
}

export async function activeTrip(req: Request): Promise<DriverActiveTripResult> {
  const c = driverContext(req);
  const out = await withRequestTenant(
    req,
    async (tx) => {
      const staff = await repo.staffOfUser(tx, c.auth.actorId);
      const trip = await activeTripOf(tx, c.auth.actorId, staff?.id ?? null);
      const config = tripConfigOf(await loadSchoolSettings(tx));
      return { trip: trip ? toDriverTrip(trip, c.device.id) : null, config };
    },
    { readOnly: true },
  );
  return withServerTime(out);
}

export async function history(req: Request, q: DriverTripHistoryQuery) {
  const c = driverContext(req);
  const { page, limit, offset } = parsePagination(q);
  return withRequestTenant(
    req,
    async (tx) => {
      const staff = await repo.staffOfUser(tx, c.auth.actorId);
      const { rows, total } = await pagedQuery<TripRow>(tx, {
        select: TRIP_COLUMNS,
        from: 'from trips t',
        where: `(t.started_by = $1 or t.driver_staff_id = $2 or t.conductor_staff_id = $2)
          and (case when $3::text[] is null then t.status <> 'scheduled' else t.status = any ($3::text[]) end)
          and ($4::date is null or t.trip_date >= $4::date) and ($5::date is null or t.trip_date <= $5::date)`,
        params: [c.auth.actorId, staff?.id ?? null, q.status ?? null, q.from ?? null, q.to ?? null],
        orderBy: 'order by t.trip_date desc, coalesce(t.started_at, t.planned_start_at) desc nulls last, t.id desc',
        limit,
        offset,
      });
      return { items: rows.map((r) => toDriverTrip(r as TripRow, c.device.id)), meta: listMeta({ page, limit, total }) };
    },
    { readOnly: true },
  );
}

const DEVICE_ALERTS = {
  gps_disabled: { alert: 'gps_disabled', severity: 'warning', title: "GPS turned off on the driver's phone" },
  low_battery: { alert: 'low_battery', severity: 'warning', title: "driver's phone battery is low" },
  no_network: { alert: 'no_network', severity: 'warning', title: "driver's phone had no network" },
  mock_location: { alert: 'gps_disabled', severity: 'critical', title: "mock location detected on the driver's phone" },
  harsh_braking: { alert: 'harsh_driving', severity: 'warning', title: 'harsh braking' },
  harsh_acceleration: { alert: 'harsh_driving', severity: 'warning', title: 'harsh acceleration' },
  harsh_cornering: { alert: 'harsh_driving', severity: 'warning', title: 'harsh cornering' },
  // Tracking stops until the driver allows location again (not the same fault as GPS switched off).
  location_permission_denied: { alert: 'location_permission', severity: 'critical', title: "location permission denied on the driver's phone — tracking stopped" },
} as const;

const HARSH = new Set<string>(HARSH_DRIVING_EVENT_TYPES);
const PERMISSION_DEDUPE = (tripId: string) => `location_permission:${tripId}`;

async function interruptTx(tx: Tx, trip: TripRow, reason: string, extra: Record<string, unknown>): Promise<TripRow> {
  const updated = await writes.markInterrupted(tx, trip.id, reason);
  if (!updated) throw invalidState('Only a trip in progress can be marked as interrupted.', { reason: 'NOT_IN_PROGRESS', status: trip.status });
  await audit.log(tx, { action: 'trip.interrupt', entityType: 'trip', entityId: trip.id, old: { interruptedAt: trip.interrupted_at, closeReason: trip.close_reason }, new: { interruptedAt: updated.interrupted_at, closeReason: reason, ...extra } });
  return updated;
}

/** Events are accepted while the trip runs and, for late (offline) reports, until the late-points window closes. */
function acceptsEvents(t: TripRow): boolean {
  if (t.status === 'in_progress') return true;
  if ((t.status === 'completed' || t.status === 'auto_closed') && t.ended_at) return Date.now() - Date.parse(t.ended_at) <= LATE_POINTS_WINDOW_HOURS * 3600_000;
  return false;
}

interface Interruption {
  payload: TripStatusPayload;
  reason: string;
}

/** A reported event with its time on the server clock (BP §14.3). */
interface TimedEvent {
  e: TripDeviceEvent;
  deviceMs: number;
  /** Server-clock instant used for the timeline (corrected, or the receipt time when the device time was rejected). */
  atMs: number;
}

/**
 * Puts the batch's occurredAt values on the server clock (tracking clock.ts rules, the same as for
 * location points): shifted by the offset measured from `sentAt` (or inferred while the trip runs, when
 * every event predates the trip window or lies in the future); beyond the maximum correction — or a
 * single event in the future without any offset — the receipt time replaces the device time.
 */
function timedEvents(body: TripEventsBody, trip: TripRow, nowMs: number): { events: TimedEvent[]; clock: ClockResolution } {
  const startedMs = trip.started_at ? Date.parse(trip.started_at) : nowMs;
  const deviceTimes = body.events.map((e) => Date.parse(e.occurredAt));
  const clock = resolveClockOffset(deviceTimes, {
    nowMs,
    sentAtMs: body.sentAt ? Date.parse(body.sentAt) : null,
    windowStartMs: startedMs - TRIP_START_TOLERANCE_MS,
    infer: trip.status === 'in_progress',
  });
  const out = body.events.map((e, i) => {
    const deviceMs = deviceTimes[i]!;
    let atMs = clock.action === 'rejected' ? nowMs : correctedMs(deviceMs, clock);
    if (atMs > nowMs + FUTURE_TOLERANCE_MS) atMs = nowMs;
    return { e, deviceMs, atMs };
  });
  // Stable order by server time: a denied + restored pair queued offline is applied in sequence.
  out.sort((a, b) => a.atMs - b.atMs);
  return { events: out, clock };
}

interface EventsOutcome {
  alerts: RaisedAlert[];
  resolved: AlertUpdate[];
  interruption: Interruption | null;
  permission: { state: 'denied' | 'restored'; atMs: number } | null;
  clock: ClockResolution;
  trip: TripRow;
}

export async function reportEvents(req: Request, tripId: string, body: TripEventsBody): Promise<TripEventsResult> {
  const c = driverContext(req);
  const nowMs = Date.now();
  const out = await withRequestTenant(req, async (tx): Promise<EventsOutcome> => {
    const { trip } = await ownTrip(tx, c, tripId, { lock: true });
    assertSameDevice(trip, c);
    if (!acceptsEvents(trip)) throw invalidState('This trip no longer accepts device events.', { reason: 'NOT_IN_PROGRESS', status: trip.status });
    const { events: timed, clock } = timedEvents(body, trip, nowMs);
    const alerts: RaisedAlert[] = [];
    const resolved: AlertUpdate[] = [];
    let interruption: Interruption | null = null;
    let permission: EventsOutcome['permission'] = null;
    let drift: ClockDriftReport | null = null;
    const driftReport = (offsetMs: number | null, action: 'corrected' | 'rejected', source: ClockDriftReport['source']): ClockDriftReport => ({
      tripId: trip.id, busId: trip.bus_id, busCode: trip.bus_code_snapshot, staffId: trip.driver_staff_id, offsetMs, action, source, via: 'events', deviceId: c.device.id,
    });
    if (clock.action !== 'none') drift = driftReport(clock.offsetMs, clock.action, clock.source ?? 'sent_at');
    // Sensor events raise harsh_driving only while the school's flag + effective feature allow it (read once, lazily).
    let harshOn: boolean | null = null;
    for (const t of timed) {
      const { e } = t;
      let alert: RaisedAlert | null = null;
      if (HARSH.has(e.type)) {
        harshOn ??= harshDrivingEnabled(await loadSchoolSettings(tx));
        if (!harshOn) continue; // feature off for the school: neither alerted nor kept
      }
      if (e.type === 'trip_interrupted') {
        if (trip.status === 'in_progress' && !interruption) {
          const reason = e.message || 'Trip interrupted (reported by the driver app)';
          const updated = await interruptTx(tx, trip, reason, { occurredAt: e.occurredAt, via: 'events' });
          interruption = { payload: statusPayload(updated, updated.status, reason), reason };
        }
      } else if (e.type === 'location_permission_restored') {
        const closedId = await closeAlertByKey(tx, PERMISSION_DEDUPE(trip.id), `Location permission restored on the driver's phone at ${new Date(t.atMs).toISOString()}.`);
        if (closedId) {
          await audit.log(tx, { action: 'alert.auto_close', entityType: 'alert', entityId: closedId, new: { status: 'closed', reason: 'location_permission_restored', tripId: trip.id } });
          resolved.push({ schoolId: c.schoolId, id: closedId, type: 'location_permission', severity: 'critical', status: 'closed', action: 'resolve', updatedAt: new Date().toISOString() });
        }
        if (trip.status === 'in_progress') permission = { state: 'restored', atMs: t.atMs };
      } else if (e.type === 'clock_drift') {
        // The app reports clock_drift when its own measurement exceeds the tolerance (it then corrects its
        // timestamps itself); without a size it still counts. Its alert covers the batch's own drift.
        const offsetMs = e.clockOffsetMs ?? clock.offsetMs;
        const action = clockAction(offsetMs);
        if (offsetMs === null || action !== 'none') {
          alert = await raiseClockDriftAlert(tx, driftReport(offsetMs, action === 'rejected' ? 'rejected' : 'corrected', 'device_event'));
          drift = null;
        }
      } else {
        alert = await deviceAlert(tx, trip, c, e);
        if (e.type === 'location_permission_denied' && trip.status === 'in_progress') permission = { state: 'denied', atMs: t.atMs };
      }
      if (alert) alerts.push(alert);
      const key = alertKeyOf(e.type, trip.id);
      await storeEvent(tx, trip, c, t, clock, alert?.id ?? (key && e.type !== 'location_permission_restored' ? await openAlertId(tx, key) : null));
    }
    await audit.log(tx, {
      action: 'trip.device_events',
      entityType: 'trip',
      entityId: trip.id,
      new: { events: body.events.map((e) => ({ type: e.type, occurredAt: e.occurredAt })), ...(clock.action !== 'none' ? { clock: { action: clock.action, offsetMs: clock.offsetMs, source: clock.source } } : {}) },
    });
    if (drift) {
      const raised = await raiseClockDriftAlert(tx, drift);
      if (raised) alerts.push(raised);
    }
    return { alerts, resolved, interruption, permission, clock, trip };
  });
  if (out.interruption) {
    events.emit('trip.interrupted', { ...out.interruption.payload, reason: out.interruption.reason });
    await publishTripStatus(out.interruption.payload, { event: false });
  }
  if (out.permission) {
    events.emit('trip.location_permission', {
      schoolId: c.schoolId, tripId, state: out.permission.state, at: new Date(out.permission.atMs).toISOString(),
      busId: out.trip.bus_id, routeId: out.trip.route_id, direction: out.trip.direction, lastPointAt: out.trip.last_point_at,
    });
  }
  await announceAlerts(out.alerts);
  await announceAlertUpdates(out.resolved);
  return withServerTime({ accepted: body.events.length, clockOffsetMs: out.clock.action === 'corrected' ? out.clock.offsetMs : null, alerts: briefOf(out.alerts) });
}

/** Dedupe key of the alert an event type raises (null: no alert). */
function alertKeyOf(type: TripDeviceEvent['type'], tripId: string): string | null {
  if (type === 'clock_drift') return `clock_drift:${tripId}`;
  if (type === 'location_permission_denied' || type === 'location_permission_restored') return PERMISSION_DEDUPE(tripId);
  if (type === 'mock_location') return `gps_disabled:mock:${tripId}`;
  const spec = DEVICE_ALERTS[type as keyof typeof DEVICE_ALERTS];
  return spec ? `${spec.alert}:${tripId}` : null;
}

function openAlertId(tx: Tx, dedupeKey: string): Promise<string | null> {
  return tx.maybeOne<{ id: string }>("select id from alerts where dedupe_key = $1 and status in ('open', 'escalated')", [dedupeKey]).then((r) => r?.id ?? null);
}

/** trip_device_events row of one reported event (the trip timeline; migration 925). */
async function storeEvent(tx: Tx, trip: TripRow, c: DriverContext, t: TimedEvent, clock: ClockResolution, alertId: string | null): Promise<void> {
  const { e } = t;
  const details: Record<string, unknown> = {};
  if (e.batteryPct !== undefined) details.batteryPct = e.batteryPct;
  if (e.networkType !== undefined) details.networkType = e.networkType;
  if (e.message !== undefined) details.message = e.message;
  if (e.gForce !== undefined) details.gForce = e.gForce;
  if (e.speedKmh !== undefined) details.speedKmh = e.speedKmh;
  if (e.permission !== undefined) details.permission = e.permission;
  if (e.clockOffsetMs !== undefined) details.reportedClockOffsetMs = e.clockOffsetMs;
  if (clock.action === 'rejected' || (t.atMs !== correctedMs(t.deviceMs, clock))) details.deviceTimeRejected = true;
  await tx.query(
    `insert into trip_device_events (school_id, trip_id, event_type, occurred_at, device_occurred_at, clock_offset_ms, latitude, longitude, details, device_id, reported_by, alert_id)
     values (nullif(current_setting('app.school_id', true), '')::uuid, $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)`,
    [
      trip.id, e.type, new Date(t.atMs).toISOString(), e.occurredAt, clock.action === 'corrected' && t.atMs === correctedMs(t.deviceMs, clock) ? clock.offsetMs : null,
      e.latitude ?? null, e.longitude ?? null, JSON.stringify(details), c.device.id, c.auth.actorId, alertId,
    ],
  );
}

function deviceAlert(tx: Tx, trip: TripRow, c: DriverContext, e: TripDeviceEvent): Promise<RaisedAlert | null> {
  const spec = DEVICE_ALERTS[e.type as keyof typeof DEVICE_ALERTS];
  const bus = trip.bus_code_snapshot ? `Bus ${trip.bus_code_snapshot}` : 'Bus';
  const battery = e.type === 'low_battery' && e.batteryPct !== undefined ? ` (${e.batteryPct}%)` : '';
  const force = HARSH.has(e.type) && e.gForce !== undefined ? ` (${Math.round(e.gForce * 100) / 100} g)` : '';
  return raiseAlert(tx, {
    type: spec.alert,
    severity: spec.severity,
    title: `${bus}: ${spec.title}${battery}${force}`,
    entity: { type: 'trip', id: trip.id },
    tripId: trip.id,
    busId: trip.bus_id,
    staffId: trip.driver_staff_id,
    details: {
      event: e.type, occurredAt: e.occurredAt, latitude: e.latitude ?? null, longitude: e.longitude ?? null, batteryPct: e.batteryPct ?? null,
      networkType: e.networkType ?? null, message: e.message ?? null, gForce: e.gForce ?? null, speedKmh: e.speedKmh ?? null,
      permission: e.permission ?? null, deviceId: c.device.id, reportedBy: c.auth.actorId,
    },
    dedupeKey: alertKeyOf(e.type, trip.id),
  });
}

export async function interrupt(req: Request, tripId: string, body: InterruptTripBody): Promise<DriverTrip> {
  const c = driverContext(req);
  const out = await withRequestTenant(req, async (tx) => {
    const { trip } = await ownTrip(tx, c, tripId, { lock: true });
    assertSameDevice(trip, c);
    const updated = await interruptTx(tx, trip, body.reason, { latitude: body.latitude ?? null, longitude: body.longitude ?? null, via: 'interrupt' });
    return updated;
  });
  const payload = statusPayload(out, out.status, body.reason);
  events.emit('trip.interrupted', { ...payload, reason: body.reason });
  await publishTripStatus(payload, { event: false });
  return toDriverTrip(out, c.device.id);
}

interface DeviceRow extends Record<string, unknown> {
  id: string;
  device_uid: string;
  platform: string;
  device_model: string | null;
  os_version: string | null;
  app_version: string | null;
  fcm_token: string | null;
  last_seen_at: string | null;
}

export async function registerDevice(req: Request, body: DriverDeviceBody) {
  const c = driverContext(req);
  const row = await withRequestTenant(req, async (tx) => {
    const before = await tx.one<DeviceRow>('select id, device_uid, platform, device_model, os_version, app_version, fcm_token, last_seen_at from devices where id = $1', [c.device.id]);
    const d = await tx.one<DeviceRow>(
      `update devices set fcm_token = case when $2::boolean then $3::text else fcm_token end,
              platform = coalesce($4, platform), device_model = coalesce($5, device_model), os_version = coalesce($6, os_version),
              app_version = coalesce($7, app_version), app_name = coalesce(app_name, 'driver_app'), last_seen_at = now(), updated_at = now()
        where id = $1
        returning id, device_uid, platform, device_model, os_version, app_version, fcm_token, last_seen_at`,
      [c.device.id, body.fcmToken !== undefined, body.fcmToken ?? null, body.platform ?? null, body.model ?? null, body.osVersion ?? null, body.appVersion ?? null],
    );
    await audit.log(tx, {
      action: 'device.update',
      entityType: 'device',
      entityId: d.id,
      old: { platform: before.platform, model: before.device_model, osVersion: before.os_version, appVersion: before.app_version, hasFcmToken: before.fcm_token !== null },
      new: { platform: d.platform, model: d.device_model, osVersion: d.os_version, appVersion: d.app_version, hasFcmToken: d.fcm_token !== null },
    });
    return d;
  });
  return {
    id: row.id,
    deviceId: row.device_uid,
    platform: row.platform,
    model: row.device_model,
    osVersion: row.os_version,
    appVersion: row.app_version,
    hasFcmToken: row.fcm_token !== null,
    lastSeenAt: row.last_seen_at,
  };
}
