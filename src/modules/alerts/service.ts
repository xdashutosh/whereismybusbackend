// Alert creation API shared by every producer (trips, jobs, tracking, documents, maintenance — BP §11.1).
// The alerts module (inbox, review → escalate/close) builds on this API and keeps it stable.
//
//   raiseAlert(tx, input)    inserts an alert of the CURRENT school (school_id from the transaction
//                            context) inside the caller's transaction. With a dedupeKey, a second
//                            raise while an alert with that key is open or escalated does nothing
//                            (ON CONFLICT on the partial unique index alerts_dedupe); `once: true`
//                            additionally skips keys that were ever raised (any status), for
//                            one-per-entity alerts such as "trip not started" or "odometer gap" of a
//                            trip, so closing the alert never makes a scan raise it again.
//                            Returns the new alert, or null when deduplicated.
//   announceAlerts(alerts)   AFTER COMMIT: emits SOCKET_EVENTS.ALERT_NEW to school:{id}:alerts (admin
//                            bell) and the in-process 'alert.raised' event (notifications/e-mail).
import { SOCKET_EVENTS, type AlertSeverity, type AlertStatus, type AlertType } from '@wimb/shared';
import type { Tx } from '../../db/tenant.js';
import { events } from '../../shared/events.js';
import { logger as rootLogger } from '../../shared/logger.js';
import { realtime, rooms } from '../../shared/realtime.js';

const log = rootLogger.child({ module: 'alerts' });

export const ALERT_ENTITY_TYPES = ['bus', 'trip', 'staff', 'bus_document', 'staff_document', 'maintenance_log', 'device'] as const;
export type AlertEntityType = (typeof ALERT_ENTITY_TYPES)[number];

export interface RaiseAlertInput {
  type: AlertType;
  severity: AlertSeverity;
  /** The record the alert is about (alerts.entity_type / entity_id). */
  entity?: { type: AlertEntityType; id: string } | null;
  tripId?: string | null;
  busId?: string | null;
  staffId?: string | null;
  /** Short human title (1–300 characters; longer titles are cut). */
  title: string;
  details?: Record<string, unknown>;
  /** e.g. 'doc_expiring:{docId}:30', 'odometer_gap:{tripId}'. */
  dedupeKey?: string | null;
  /** Never raise the same dedupeKey twice, whatever the status of the earlier alert. */
  once?: boolean;
}

export interface RaisedAlert {
  id: string;
  schoolId: string;
  type: AlertType;
  severity: AlertSeverity;
  status: AlertStatus;
  title: string;
  entityType: AlertEntityType | null;
  entityId: string | null;
  tripId: string | null;
  busId: string | null;
  staffId: string | null;
  details: Record<string, unknown>;
  dedupeKey: string | null;
  createdAt: string;
}

export interface RaisedAlertRow extends Record<string, unknown> {
  id: string;
  school_id: string;
  alert_type: AlertType;
  severity: AlertSeverity;
  status: AlertStatus;
  title: string;
  entity_type: AlertEntityType | null;
  entity_id: string | null;
  trip_id: string | null;
  bus_id: string | null;
  staff_id: string | null;
  details: Record<string, unknown>;
  dedupe_key: string | null;
  created_at: string;
}

declare module '../../shared/events.js' {
  interface AppEvents {
    /** A new alert was stored (after commit). */
    'alert.raised': RaisedAlert;
  }
}

/** alerts row (ALERT_COLUMNS) → RaisedAlert. */
export function toRaised(r: RaisedAlertRow): RaisedAlert {
  return {
    id: r.id,
    schoolId: r.school_id,
    type: r.alert_type,
    severity: r.severity,
    status: r.status,
    title: r.title,
    entityType: r.entity_type,
    entityId: r.entity_id,
    tripId: r.trip_id,
    busId: r.bus_id,
    staffId: r.staff_id,
    details: r.details ?? {},
    dedupeKey: r.dedupe_key,
    createdAt: r.created_at,
  };
}

/** Columns of an alerts row as RaisedAlert needs them (bulk inserts of the scan jobs reuse them). */
export const ALERT_COLUMNS = 'id, school_id, alert_type, severity, status, title, entity_type, entity_id, trip_id, bus_id, staff_id, details, dedupe_key, created_at';

/** Inserts an alert of the current school (see the header). Null = deduplicated. */
export async function raiseAlert(tx: Tx, input: RaiseAlertInput): Promise<RaisedAlert | null> {
  const title = input.title.trim().slice(0, 300) || input.type;
  const dedupeKey = input.dedupeKey?.trim() || null;
  const row = await tx.maybeOne<RaisedAlertRow>(
    `insert into alerts (school_id, alert_type, severity, entity_type, entity_id, trip_id, bus_id, staff_id, title, details, dedupe_key)
     select nullif(current_setting('app.school_id', true), '')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10
      where not ($11::boolean and $10::text is not null
                 and exists (select 1 from alerts a
                              where a.school_id = nullif(current_setting('app.school_id', true), '')::uuid and a.dedupe_key = $10))
     on conflict (school_id, dedupe_key) where status in ('open', 'escalated') do nothing
     returning ${ALERT_COLUMNS}`,
    [
      input.type,
      input.severity,
      input.entity?.type ?? null,
      input.entity?.id ?? null,
      input.tripId ?? null,
      input.busId ?? null,
      input.staffId ?? null,
      title,
      JSON.stringify(input.details ?? {}),
      dedupeKey,
      Boolean(input.once),
    ],
  );
  return row ? toRaised(row) : null;
}

/** After commit: pushes new alerts to the admin bell and the in-process event bus. Never throws. */
export async function announceAlerts(alerts: readonly (RaisedAlert | null | undefined)[]): Promise<void> {
  for (const a of alerts) {
    if (!a) continue;
    events.emit('alert.raised', a);
    try {
      await realtime.emit(rooms.schoolAlerts(a.schoolId), SOCKET_EVENTS.ALERT_NEW, {
        id: a.id,
        type: a.type,
        severity: a.severity,
        title: a.title,
        tripId: a.tripId,
        busId: a.busId,
        entityType: a.entityType,
        entityId: a.entityId,
        createdAt: a.createdAt,
      });
    } catch (err) {
      log.warn({ err, schoolId: a.schoolId, alertId: a.id }, 'Could not publish the new alert');
    }
  }
}

/**
 * Closes the open/escalated alert with this dedupe key of the current school as the system (no
 * reviewer), e.g. a "no GPS data" flag once late points arrived. Returns the closed alert id or null.
 * The caller audits the change in the same transaction.
 */
export async function closeAlertByKey(tx: Tx, dedupeKey: string, note: string): Promise<string | null> {
  const row = await tx.maybeOne<{ id: string }>(
    `update alerts set status = 'closed', closed_at = now(), review_note = left($2, 1000), updated_at = now()
      where school_id = nullif(current_setting('app.school_id', true), '')::uuid and dedupe_key = $1 and status in ('open', 'escalated')
      returning id`,
    [dedupeKey, note],
  );
  return row?.id ?? null;
}
