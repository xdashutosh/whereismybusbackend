// Trip timeline of GET /school/trips/:id (BP §13.3 Trips & Audit): the lifecycle (started, interrupted,
// ended / auto-closed / cancelled) merged with every device event the driver app reported for the trip
// (trip_device_events, migration 925: GPS off, location permission denied / restored, low battery, no
// network, mock location, clock drift, harsh driving, breakdown), oldest first. Device event times are on
// the server clock (corrected when the phone clock was off, BP §14.3). Stop arrivals stay in stopEvents.
import type { AlertSeverity, DeviceEventType, LocationPermissionState, TripStatus, TripTimelineEntry } from '@wimb/shared';
import type { Tx } from '../../db/tenant.js';

export interface TimelineTripRow extends Record<string, unknown> {
  status: TripStatus;
  started_at: string | null;
  interrupted_at: string | null;
  close_reason: string | null;
  ended_at: string | null;
  closed_at: string | null;
  cancel_reason: string | null;
  updated_at: string;
}

export interface DeviceEventRow extends Record<string, unknown> {
  event_type: DeviceEventType;
  occurred_at: string;
  device_occurred_at: string;
  received_at: string;
  clock_offset_ms: string | number | null;
  latitude: string | number | null;
  longitude: string | number | null;
  details: Record<string, unknown> | null;
  alert_id: string | null;
}

/** Title and severity of each device event type on the timeline. */
export const DEVICE_EVENT_LABELS: Readonly<Record<DeviceEventType, { title: string; severity: AlertSeverity }>> = Object.freeze({
  gps_disabled: { title: 'GPS turned off on the phone', severity: 'warning' },
  low_battery: { title: 'Phone battery low', severity: 'warning' },
  no_network: { title: 'Phone had no network', severity: 'warning' },
  mock_location: { title: 'Mock location detected', severity: 'critical' },
  trip_interrupted: { title: 'Breakdown reported from the app', severity: 'warning' },
  harsh_braking: { title: 'Harsh braking', severity: 'warning' },
  harsh_acceleration: { title: 'Harsh acceleration', severity: 'warning' },
  harsh_cornering: { title: 'Harsh cornering', severity: 'warning' },
  location_permission_denied: { title: 'Location permission denied — tracking stopped', severity: 'critical' },
  location_permission_restored: { title: 'Location permission restored', severity: 'info' },
  clock_drift: { title: 'Phone clock wrong', severity: 'warning' },
});

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

function lifecycle(at: string, kind: TripTimelineEntry['kind'], title: string, severity: AlertSeverity, note: string | null = null): TripTimelineEntry {
  return { at, kind, event: null, severity, title, note, deviceOccurredAt: null, receivedAt: null, clockOffsetMs: null, latitude: null, longitude: null, batteryPct: null, permission: null, alertId: null };
}

/** Pure: lifecycle entries of the trip + its device events, oldest first (lifecycle first on ties). */
export function buildTimeline(trip: TimelineTripRow, events: readonly DeviceEventRow[]): TripTimelineEntry[] {
  const out: TripTimelineEntry[] = [];
  if (trip.started_at) out.push(lifecycle(trip.started_at, 'trip_started', 'Trip started', 'info'));
  if (trip.interrupted_at) out.push(lifecycle(trip.interrupted_at, 'trip_interrupted', 'Trip interrupted (breakdown)', 'critical', str(trip.close_reason)));
  if (trip.status === 'completed' && trip.ended_at) out.push(lifecycle(trip.ended_at, 'trip_ended', 'Trip ended', 'info'));
  if (trip.status === 'auto_closed') {
    out.push(lifecycle(trip.closed_at ?? trip.ended_at ?? trip.updated_at, 'trip_auto_closed', 'Trip auto-closed', 'warning', trip.interrupted_at ? null : str(trip.close_reason)));
  }
  if (trip.status === 'cancelled') out.push(lifecycle(trip.closed_at ?? trip.updated_at, 'trip_cancelled', 'Trip cancelled', 'warning', str(trip.cancel_reason)));
  const lifecycleCount = out.length;
  for (const e of events) {
    const label = DEVICE_EVENT_LABELS[e.event_type] ?? { title: e.event_type, severity: 'info' as const };
    const d = e.details ?? {};
    out.push({
      at: new Date(e.occurred_at).toISOString(),
      kind: 'device_event',
      event: e.event_type,
      severity: label.severity,
      title: label.title,
      note: str(d.message),
      deviceOccurredAt: new Date(e.device_occurred_at).toISOString(),
      receivedAt: new Date(e.received_at).toISOString(),
      clockOffsetMs: num(e.clock_offset_ms),
      latitude: num(e.latitude),
      longitude: num(e.longitude),
      batteryPct: num(d.batteryPct),
      permission: (str(d.permission) as LocationPermissionState | null) ?? null,
      alertId: e.alert_id,
    });
  }
  const rank = (i: number) => (i < lifecycleCount ? 0 : 1);
  return out
    .map((entry, i) => ({ entry, i }))
    .sort((a, b) => Date.parse(a.entry.at) - Date.parse(b.entry.at) || rank(a.i) - rank(b.i) || a.i - b.i)
    .map((x) => ({ ...x.entry, at: new Date(x.entry.at).toISOString() }));
}

/** Timeline of one trip of the transaction's school. */
export async function loadTimeline(tx: Tx, tripId: string): Promise<TripTimelineEntry[]> {
  const trip = await tx.maybeOne<TimelineTripRow>(
    'select status, started_at, interrupted_at, close_reason, ended_at, closed_at, cancel_reason, updated_at from trips where id = $1',
    [tripId],
  );
  if (!trip) return [];
  const events = await tx.many<DeviceEventRow>(
    `select event_type, occurred_at, device_occurred_at, received_at, clock_offset_ms, latitude, longitude, details, alert_id
       from trip_device_events where trip_id = $1 order by occurred_at, received_at, id`,
    [tripId],
  );
  return buildTimeline(trip, events);
}
