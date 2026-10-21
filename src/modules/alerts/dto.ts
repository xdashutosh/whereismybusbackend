// Row → DTO mapping of the alerts inbox. `details.escalation` (snapshot written at escalation, updated
// by the delivery job) and `details.resolvedAt` (system auto-resolution) are lifted to typed fields.
import type { AlertDelivery, AlertDeliveryChannel, AlertDeliveryStatus, AlertDto, AlertEscalation } from '@wimb/shared';
import type { AlertRow } from './repository.js';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

const CHANNELS: readonly AlertDeliveryChannel[] = ['email', 'push', 'sms'];
const STATUSES: readonly AlertDeliveryStatus[] = ['pending', 'sent', 'logged', 'failed', 'skipped'];

/** Stored escalation snapshot (camelCase JSON inside alerts.details) → typed escalation, or null. */
export function readEscalation(raw: unknown): AlertEscalation | null {
  if (!isRecord(raw) || typeof raw.escalatedAt !== 'string') return null;
  const deliveries: AlertDelivery[] = Array.isArray(raw.deliveries)
    ? raw.deliveries.filter(isRecord).map((d) => ({
        channel: CHANNELS.includes(d.channel as AlertDeliveryChannel) ? (d.channel as AlertDeliveryChannel) : 'email',
        userId: str(d.userId),
        name: str(d.name),
        target: str(d.target),
        status: STATUSES.includes(d.status as AlertDeliveryStatus) ? (d.status as AlertDeliveryStatus) : 'pending',
        reason: str(d.reason),
        attemptedAt: str(d.attemptedAt),
      }))
    : [];
  return {
    escalatedAt: raw.escalatedAt,
    escalatedBy: str(raw.escalatedBy),
    recipientCount: typeof raw.recipientCount === 'number' ? raw.recipientCount : 0,
    deliveries,
  };
}

export function toDto(r: AlertRow): AlertDto {
  const { escalation, ...details } = isRecord(r.details) ? r.details : {};
  return {
    id: r.id,
    alertType: r.alert_type,
    severity: r.severity,
    status: r.status,
    title: r.title,
    entityType: r.entity_type,
    entityId: r.entity_id,
    busId: r.bus_id,
    busCode: r.bus_code,
    tripId: r.trip_id,
    tripDate: r.trip_date,
    tripDirection: r.trip_direction,
    tripStatus: r.trip_status,
    routeCode: r.route_code,
    staffId: r.staff_id,
    staffName: r.staff_name,
    details,
    escalation: readEscalation(escalation),
    resolvedAt: str(details.resolvedAt),
    reviewedBy: r.reviewed_by,
    reviewedByName: r.reviewed_by_name,
    reviewedAt: r.reviewed_at,
    reviewNote: r.review_note,
    escalatedBy: r.escalated_by,
    escalatedByName: r.escalated_by_name,
    escalatedAt: r.escalated_at,
    closedBy: r.closed_by,
    closedByName: r.closed_by_name,
    closedAt: r.closed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
