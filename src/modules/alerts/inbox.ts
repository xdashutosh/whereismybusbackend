// School admin alerts inbox (BP §11.1 workflow, §13.3 Alerts):
//   GET   /school/alerts        filters (type, severity, status, entity, school-local date range, bus,
//                               trip, staff, q), sort, page + counts per status; `format=csv`
//   GET   /school/alerts/:id    one alert
//   PATCH /school/alerts/:id    { action: review | escalate | close, note }
// Workflow: open → reviewed (note required; the note can be edited while reviewed) → escalated / closed;
// open → escalated / closed directly; escalated → closed. Closed alerts are final (409 INVALID_STATE).
// Escalation stores the matching recipients (escalation.ts) and queues the 'alert-escalation' delivery
// job after commit. Every change is audited and published (alert:updated) after commit.
import type { AlertAction, AlertActionBody, AlertDto, AlertListMeta, AlertListQuery, AlertStatus } from '@wimb/shared';
import type { Request, Response } from 'express';
import { registerConstraintError } from '../../middleware/errorHandler.js';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { audit } from '../../shared/audit.js';
import { createCsvWriter, type CsvColumn } from '../../shared/csv.js';
import { assertFound, invalidState } from '../../shared/errors.js';
import { logger as rootLogger } from '../../shared/logger.js';
import { listMeta, MAX_EXPORT_ROWS, parsePagination, parseSort } from '../../shared/pagination.js';
import { toDto } from './dto.js';
import { ALERT_ESCALATION_JOB, planEscalation } from './escalation.js';
import { announceAlertUpdates } from './publish.js';
import * as repo from './repository.js';

const log = rootLogger.child({ module: 'alerts' });

registerConstraintError('alerts_dedupe', 'CONFLICT', 'Another open alert for the same cause already exists.');

const timezoneOf = (req: Request) => req.tenant?.timezone ?? 'Asia/Kolkata';

export async function list(req: Request, q: AlertListQuery): Promise<{ items: AlertDto[]; meta: AlertListMeta }> {
  const { page, limit, offset } = parsePagination(q);
  const { orderBy } = parseSort(q.sort, repo.SORT);
  const r = await withRequestTenant(req, (tx) => repo.page(tx, q, timezoneOf(req), orderBy, limit, offset), { readOnly: true });
  return { items: r.items.map(toDto), meta: { ...listMeta({ page, limit, total: r.total }), counts: r.counts } };
}

const CSV_COLUMNS: CsvColumn<AlertDto>[] = [
  { header: 'Raised (UTC)', key: 'createdAt' },
  { header: 'Type', key: 'alertType' },
  { header: 'Severity', key: 'severity' },
  { header: 'Status', key: 'status' },
  { header: 'Title', key: 'title' },
  { header: 'Bus', key: 'busCode' },
  { header: 'Staff', key: 'staffName' },
  { header: 'Trip date', key: 'tripDate' },
  { header: 'Direction', key: 'tripDirection' },
  { header: 'Route', key: 'routeCode' },
  { header: 'Reviewed by', key: 'reviewedByName' },
  { header: 'Reviewed (UTC)', key: 'reviewedAt' },
  { header: 'Note', key: 'reviewNote' },
  { header: 'Escalated by', key: 'escalatedByName' },
  { header: 'Escalated (UTC)', key: 'escalatedAt' },
  { header: 'Closed by', value: (r) => r.closedByName ?? (r.status === 'closed' ? 'System' : '') },
  { header: 'Closed (UTC)', key: 'closedAt' },
];

export async function exportCsv(req: Request, res: Response, q: AlertListQuery): Promise<void> {
  const { orderBy } = parseSort(q.sort, repo.SORT);
  const rows = await withRequestTenant(req, (tx) => repo.exportRows(tx, q, timezoneOf(req), orderBy, MAX_EXPORT_ROWS), { readOnly: true });
  const csv = createCsvWriter<AlertDto>(res, { fileName: 'alerts.csv', columns: CSV_COLUMNS });
  await csv.writeAll(rows.map(toDto));
  await csv.end();
}

export async function detail(req: Request, id: string): Promise<AlertDto> {
  const row = await withRequestTenant(req, (tx) => repo.findById(tx, id), { readOnly: true });
  return toDto(assertFound(row, 'The alert was not found.'));
}

const ALLOWED_FROM: Readonly<Record<AlertAction, readonly AlertStatus[]>> = Object.freeze({
  review: ['open', 'reviewed'],
  escalate: ['open', 'reviewed'],
  close: ['open', 'reviewed', 'escalated'],
});
const VERB: Readonly<Record<AlertAction, string>> = Object.freeze({ review: 'reviewed', escalate: 'escalated', close: 'closed' });

export async function act(req: Request, id: string, body: AlertActionBody): Promise<AlertDto> {
  const note = body.note ?? null;
  const { dto, schoolId } = await withRequestTenant(req, async (tx) => {
    const current = assertFound(await repo.lockById(tx, id), 'The alert was not found.');
    if (!ALLOWED_FROM[body.action].includes(current.status)) {
      throw invalidState(`A ${current.status} alert cannot be ${VERB[body.action]}.`, { status: current.status, action: body.action });
    }
    let escalation: Record<string, unknown> | undefined;
    if (body.action === 'review') await repo.markReviewed(tx, id, note!);
    else if (body.action === 'close') await repo.markClosed(tx, id, note);
    else {
      const plan = await planEscalation(tx, current);
      escalation = plan as unknown as Record<string, unknown>;
      await repo.markEscalated(tx, id, note, escalation);
    }
    const after = assertFound(await repo.findById(tx, id), 'The alert was not found.');
    await audit.log(tx, {
      action: `alert.${body.action}`,
      entityType: 'alert',
      entityId: id,
      old: { status: current.status },
      new: {
        status: after.status,
        ...(note ? { note } : {}),
        ...(escalation ? { recipientCount: (escalation as { recipientCount: number }).recipientCount } : {}),
      },
    });
    return { dto: toDto(after), schoolId: tx.ctx.schoolId! };
  });
  if (body.action === 'escalate') {
    try {
      const { jobs } = await import('../../jobs/index.js');
      await jobs.enqueue(ALERT_ESCALATION_JOB, { schoolId, alertId: id }, { jobId: `alert-escalation-${id}` });
    } catch (err) {
      log.error({ err, schoolId, alertId: id }, 'Could not queue the alert escalation notifications');
    }
  }
  await announceAlertUpdates([{ schoolId, id, type: dto.alertType, severity: dto.severity, status: dto.status, action: body.action, updatedAt: dto.updatedAt }]);
  return dto;
}
