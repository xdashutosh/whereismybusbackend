// State reconciliation for the daily scan jobs (document-expiry-scan, maintenance-due-scan).
// A scan computes the alerts that SHOULD exist today (`desired`, each with a dedupe key per cause and
// stage, e.g. doc_expiring:{docId}:{threshold}:{expiry}, and a `subject` naming the record) and this
// engine converges the inbox towards it inside one transaction:
//   * raise   desired keys without a LIVE alert (one bulk INSERT … ON CONFLICT DO NOTHING on the
//             alerts_dedupe index). LIVE = open, reviewed, escalated, or closed by an admin and not
//             yet resolved — so repeated scans never duplicate, and an alert an admin closed stays
//             closed while its cause persists.
//   * resolve LIVE alerts of the scan's types whose key is no longer desired: the cause went away
//             (document renewed/removed, service logged) or a later stage replaced it (15-day reminder
//             after the 30-day one, expired after expiring). Open/reviewed/escalated ones are closed by
//             the system (closed_by NULL, review_note = reason); every resolved alert gets
//             details.resolvedAt, so the same cause raises again if it ever comes back.
// Scans of one school are serialised with a transaction-scoped advisory lock; live rows are locked
// FOR UPDATE so an admin action and a scan never interleave. One audit row per run with changes.
import type { AlertSeverity, AlertStatus, AlertType } from '@wimb/shared';
import type { Tx } from '../../db/tenant.js';
import { audit } from '../../shared/audit.js';
import type { AlertUpdate } from './publish.js';
import { ALERT_COLUMNS, toRaised, type RaiseAlertInput, type RaisedAlert, type RaisedAlertRow } from './service.js';

export interface DesiredAlert extends RaiseAlertInput {
  dedupeKey: string;
  /** Record the alert is about ('bus_document:{id}', 'licence:{staffId}', …): a newer desired alert with the same subject supersedes older ones. */
  subject: string;
}

export interface ReconcileOptions {
  /** Job name (advisory lock, audit actor). */
  scan: string;
  /** Alert types owned by the scan. */
  types: readonly AlertType[];
  desired: readonly DesiredAlert[];
  notes: { superseded: string; resolved: string };
  /** Extra audit fields (e.g. localDate). */
  auditContext?: Record<string, unknown>;
}

export interface ReconcileResult {
  raised: RaisedAlert[];
  /** Alerts the system closed in this run (for alert:updated after commit). */
  closed: AlertUpdate[];
  /** Every alert marked resolved (closed now or closed earlier by an admin). */
  resolvedIds: string[];
}

interface LiveRow extends Record<string, unknown> {
  id: string;
  dedupe_key: string;
  status: AlertStatus;
  alert_type: AlertType;
  severity: AlertSeverity;
  subject: string | null;
}

const MAX_AUDIT_IDS = 200;

export async function reconcileScanAlerts(tx: Tx, o: ReconcileOptions): Promise<ReconcileResult> {
  const schoolId = tx.ctx.schoolId;
  if (!schoolId) throw new TypeError('reconcileScanAlerts needs a school context');
  await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`${o.scan}:${schoolId}`]);
  const live = await tx.many<LiveRow>(
    `select id, dedupe_key, status, alert_type, severity, details->>'subject' as subject
       from alerts
      where alert_type = any ($1::text[]) and dedupe_key is not null and not (coalesce(details, '{}'::jsonb) ? 'resolvedAt')
      for update`,
    [o.types],
  );
  const desired = new Map<string, DesiredAlert>();
  for (const d of o.desired) if (!desired.has(d.dedupeKey)) desired.set(d.dedupeKey, d);
  const liveKeys = new Set(live.map((l) => l.dedupe_key));
  const desiredSubjects = new Set([...desired.values()].map((d) => d.subject));

  const toRaise = [...desired.values()].filter((d) => !liveKeys.has(d.dedupeKey));
  const toResolve = live.filter((l) => !desired.has(l.dedupe_key));

  const raised = toRaise.length
    ? (
        await tx.many<RaisedAlertRow>(
          `insert into alerts (school_id, alert_type, severity, entity_type, entity_id, trip_id, bus_id, staff_id, title, details, dedupe_key)
           select nullif(current_setting('app.school_id', true), '')::uuid, x.alert_type, x.severity, x.entity_type, x.entity_id,
                  x.trip_id, x.bus_id, x.staff_id, x.title, coalesce(x.details, '{}'::jsonb), x.dedupe_key
             from jsonb_to_recordset($1::jsonb) as x(alert_type text, severity text, entity_type text, entity_id uuid, trip_id uuid,
                                                     bus_id uuid, staff_id uuid, title text, details jsonb, dedupe_key text)
           on conflict (school_id, dedupe_key) where status in ('open', 'escalated') do nothing
           returning ${ALERT_COLUMNS}`,
          [
            JSON.stringify(
              toRaise.map((d) => ({
                alert_type: d.type,
                severity: d.severity,
                entity_type: d.entity?.type ?? null,
                entity_id: d.entity?.id ?? null,
                trip_id: d.tripId ?? null,
                bus_id: d.busId ?? null,
                staff_id: d.staffId ?? null,
                title: d.title.trim().slice(0, 300) || d.type,
                details: { ...(d.details ?? {}), subject: d.subject },
                dedupe_key: d.dedupeKey,
              })),
            ),
          ],
        )
      ).map(toRaised)
    : [];

  let closed: AlertUpdate[] = [];
  if (toResolve.length) {
    const reasons = toResolve.map((l) => (l.subject && desiredSubjects.has(l.subject) ? 'superseded' : 'resolved'));
    const rows = await tx.many<{ id: string; updated_at: string }>(
      `update alerts a
          set status = 'closed',
              closed_at = case when a.status = 'closed' then a.closed_at else now() end,
              review_note = case when a.status = 'closed' then a.review_note else left(x.note, 1000) end,
              details = coalesce(a.details, '{}'::jsonb) || jsonb_build_object('resolvedAt', now(), 'resolution', x.reason),
              updated_at = now()
         from unnest($1::uuid[], $2::text[], $3::text[]) as x(id, note, reason)
        where a.id = x.id
        returning a.id, a.updated_at`,
      [toResolve.map((l) => l.id), reasons.map((r) => (r === 'superseded' ? o.notes.superseded : o.notes.resolved)), reasons],
    );
    const updatedAt = new Map(rows.map((r) => [r.id, r.updated_at]));
    closed = toResolve
      .filter((l) => l.status !== 'closed')
      .map((l) => ({ schoolId, id: l.id, type: l.alert_type, severity: l.severity, status: 'closed' as const, action: 'resolve' as const, updatedAt: updatedAt.get(l.id) ?? new Date().toISOString() }));
  }

  const resolvedIds = toResolve.map((l) => l.id);
  if (raised.length || resolvedIds.length) {
    await audit.log(tx, {
      action: 'alert.scan',
      entityType: 'alert',
      actorName: o.scan,
      new: {
        scan: o.scan,
        ...(o.auditContext ?? {}),
        raised: raised.length,
        closed: closed.length,
        resolved: resolvedIds.length,
        raisedIds: raised.slice(0, MAX_AUDIT_IDS).map((a) => a.id),
        resolvedIds: resolvedIds.slice(0, MAX_AUDIT_IDS),
      },
    });
  }
  return { raised, closed, resolvedIds };
}
