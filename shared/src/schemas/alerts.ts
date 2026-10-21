// Alerts module schemas and DTOs (BP §11.1 alert catalogue, §7.3 document-expiry-scan /
// maintenance-due-scan, §13.3 Alerts inbox). Request schemas are shared by the backend validators,
// the web admin and the API docs; the DTO interfaces describe the responses and socket payloads.
import { z } from 'zod';
import { ALERT_SEVERITIES, ALERT_STATUSES, ALERT_TYPES } from '../enums.js';
import type { AlertSeverity, AlertStatus, AlertType, BusDocumentType, Direction, TripStatus } from '../enums.js';
import { exportFormat, isoDate, listQueryShape, optionalText, periodShape, queryEnumList, uuid, withPeriod } from './common.js';

const emptyToUndefined = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const csvOnly = exportFormat.refine((f) => f !== 'pdf', 'Supported formats: json, csv');

/** Record kinds an alert can point at (alerts.entity_type). */
export const ALERT_ENTITY_TYPES = ['bus', 'trip', 'staff', 'bus_document', 'staff_document', 'maintenance_log', 'device'] as const;
export type AlertEntityType = (typeof ALERT_ENTITY_TYPES)[number];

/** Admin actions of PATCH /school/alerts/:id (BP §11.1: open → reviewed (note) → closed / escalated). */
export const ALERT_ACTIONS = ['review', 'escalate', 'close'] as const;
export type AlertAction = (typeof ALERT_ACTIONS)[number];

/** Severity order used by recipient filters (minSeverity) and sorting. */
export const ALERT_SEVERITY_RANK: Readonly<Record<AlertSeverity, number>> = Object.freeze({ info: 1, warning: 2, critical: 3 });

/** Bus documents every active bus must carry (document-expiry-scan raises doc_missing otherwise). */
export const REQUIRED_BUS_DOCUMENT_TYPES: readonly BusDocumentType[] = ['insurance', 'fitness'];
/** maintenance-due-scan: a service counts as due this many days before its next due date … */
export const SERVICE_DUE_LEAD_DAYS = 7;
/** … or this many km before its next due odometer reading. */
export const SERVICE_DUE_LEAD_KM = 500;
/** Socket event (room school:{id}:alerts) sent when an alert changes status (review, escalate, close, auto-resolve). */
export const ALERT_UPDATED_EVENT = 'alert:updated';

// ── requests ─────────────────────────────────────────────────────────────────
/** GET /school/alerts — filters, sort, page, `format=csv`. Dates are school-local calendar days. */
export const alertListQuery = withPeriod(z
  .object({
    ...listQueryShape,
    ...periodShape,
    format: csvOnly,
    type: queryEnumList([...ALERT_TYPES]),
    severity: queryEnumList([...ALERT_SEVERITIES]),
    status: queryEnumList([...ALERT_STATUSES]),
    entityType: queryEnumList([...ALERT_ENTITY_TYPES]),
    from: z.preprocess(emptyToUndefined, isoDate().optional()),
    to: z.preprocess(emptyToUndefined, isoDate().optional()),
    busId: z.preprocess(emptyToUndefined, uuid().optional()),
    tripId: z.preprocess(emptyToUndefined, uuid().optional()),
    /** staff_profiles id. */
    staffId: z.preprocess(emptyToUndefined, uuid().optional()),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: 'The start date must not be after the end date', path: ['from'] }));
export type AlertListQuery = z.infer<typeof alertListQuery>;

/** PATCH /school/alerts/:id — `review` needs a note; `escalate` / `close` take an optional one. */
export const alertActionBody = z
  .object({
    action: z.enum(ALERT_ACTIONS),
    note: optionalText(1000),
  })
  .refine((b) => b.action !== 'review' || Boolean(b.note), { message: 'A note is required to review an alert', path: ['note'] });
export type AlertActionBody = z.infer<typeof alertActionBody>;

// ── DTOs ─────────────────────────────────────────────────────────────────────
export type AlertDeliveryChannel = 'email' | 'push' | 'sms';
/** sent: delivered to the provider · logged: no SMTP configured (written to the server log) · skipped: channel unavailable. */
export type AlertDeliveryStatus = 'pending' | 'sent' | 'logged' | 'failed' | 'skipped';

/** One recipient × channel of an escalation (alert_recipients from the school settings). */
export interface AlertDelivery {
  channel: AlertDeliveryChannel;
  /** School admin (alert recipient with a userId) or null for an external contact. */
  userId: string | null;
  name: string | null;
  /** E-mail address / masked phone; push deliveries name the admin. */
  target: string | null;
  status: AlertDeliveryStatus;
  /** Why it was skipped / failed (e.g. PUSH_DISABLED, NO_DEVICES, SMS_NOT_SUPPORTED, SMTP_FAILED). */
  reason: string | null;
  attemptedAt: string | null;
}

export interface AlertEscalation {
  escalatedAt: string;
  escalatedBy: string | null;
  /** Recipients matching the alert (minSeverity + alertTypes of each recipient). */
  recipientCount: number;
  deliveries: AlertDelivery[];
}

export interface AlertDto {
  id: string;
  alertType: AlertType;
  severity: AlertSeverity;
  status: AlertStatus;
  title: string;
  entityType: AlertEntityType | null;
  entityId: string | null;
  busId: string | null;
  busCode: string | null;
  tripId: string | null;
  tripDate: string | null;
  tripDirection: Direction | null;
  tripStatus: TripStatus | null;
  routeCode: string | null;
  staffId: string | null;
  staffName: string | null;
  /** Producer details (thresholds, readings, distances …); `escalation` is exposed separately. */
  details: Record<string, unknown>;
  escalation: AlertEscalation | null;
  /** Set when the system closed the alert because its cause went away (document renewed, service logged …). */
  resolvedAt: string | null;
  reviewedBy: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  escalatedBy: string | null;
  escalatedByName: string | null;
  escalatedAt: string | null;
  closedBy: string | null;
  closedByName: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AlertStatusCounts = Record<AlertStatus, number>;

/** List meta of GET /school/alerts: pagination + counts per status for the other filters (tabs, bell badge). */
export interface AlertListMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  counts: AlertStatusCounts;
}

/** `alert:new` payload (room school:{id}:alerts). */
export interface AlertNewEvent {
  id: string;
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  tripId: string | null;
  busId: string | null;
  entityType: AlertEntityType | null;
  entityId: string | null;
  createdAt: string;
}

/** `alert:updated` payload (room school:{id}:alerts). */
export interface AlertUpdatedEvent {
  id: string;
  type: AlertType;
  severity: AlertSeverity;
  status: AlertStatus;
  /** review | escalate | close (admin) or resolve (system). */
  action: AlertAction | 'resolve';
  updatedAt: string;
}
