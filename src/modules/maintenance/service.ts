// Maintenance logs service (BP §8.3 Fuel/Maintenance, §13.3 Maintenance; contract §5): list with
// filters (incl. due state), sort, pagination, cost total and CSV; detail; create / edit / soft
// delete with the invoice file link, date rules (service day not in the future, next due date after
// it, next due km above the reading) and non-blocking odometer warnings; the due list. Every write is
// audited in its transaction and queues maintenance-due-refresh after commit. School admins only.
import type { ListMeta, LogWarning, MaintenanceDueItem, MaintenanceLogDto, MaintenanceLogWriteDto } from '@wimb/shared';
import type { Request, Response } from 'express';
import type { Tx } from '../../db/tenant.js';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { audit, changedFields } from '../../shared/audit.js';
import { createCsvWriter, type CsvColumn } from '../../shared/csv.js';
import { list as sendList } from '../../shared/envelope.js';
import { fieldError, notFound } from '../../shared/errors.js';
import { listMeta, parsePagination, parseSort } from '../../shared/pagination.js';
import { assertAttachableFile, assertNotFuture } from '../fuel/attach.js';
import { num } from '../fuel/dto.js';
import { odometerWarnings } from '../fuel/odometer.js';
import * as dueRepo from './dueRepository.js';
import { auditView, toDto, toDueItem } from './dto.js';
import { queueDueRefresh } from './jobs.js';
import * as repo from './repository.js';
import type { CreateMaintenanceLogBody, MaintenanceDueQuery, MaintenanceLogListQuery, UpdateMaintenanceLogBody } from './schemas.js';

const SORT = { allowed: repo.SORT_COLUMNS, defaultSort: '-serviceDate', tiebreaker: 'ml.created_at desc, ml.id' };
const DUE_SORT = { allowed: dueRepo.DUE_SORT_COLUMNS, defaultSort: 'status,nextDueDate,kmToDue', tiebreaker: 'b.code, l.id' };
const DEFAULT_DUE_STATUSES = ['overdue', 'due_soon'];

const CSV_COLUMNS: CsvColumn<MaintenanceLogDto>[] = [
  { header: 'Service date', key: 'serviceDate' },
  { header: 'Bus', key: 'busCode' },
  { header: 'Registration', key: 'busRegistrationNo' },
  { header: 'Service type', key: 'serviceType' },
  { header: 'Cost', key: 'cost' },
  { header: 'Odometer (km)', key: 'odometer' },
  { header: 'Vendor', key: 'vendor' },
  { header: 'Next due date', key: 'nextDueDate' },
  { header: 'Next due (km)', key: 'nextDueKm' },
  { header: 'Due status', key: 'dueStatus' },
  { header: 'Days to due', key: 'daysToDue' },
  { header: 'km to due', key: 'kmToDue' },
  { header: 'Odometer flags', value: (r) => r.odometerFlags.join('; ') },
  { header: 'Invoice attached', value: (r) => (r.invoice ? 'yes' : 'no') },
  { header: 'Notes', key: 'notes' },
  { header: 'Entered by', key: 'createdByName' },
  { header: 'Created (UTC)', key: 'createdAt' },
];

const DUE_CSV: CsvColumn<MaintenanceDueItem>[] = [
  { header: 'Status', key: 'status' },
  { header: 'Reason', key: 'reason' },
  { header: 'Bus', key: 'busCode' },
  { header: 'Registration', key: 'registrationNo' },
  { header: 'Bus status', key: 'busStatus' },
  { header: 'Service type', key: 'serviceType' },
  { header: 'Next due date', key: 'nextDueDate' },
  { header: 'Days to due', key: 'daysToDue' },
  { header: 'Next due (km)', key: 'nextDueKm' },
  { header: 'Bus odometer (km)', key: 'busOdometer' },
  { header: 'km to due', key: 'kmToDue' },
  { header: 'Last service', key: 'lastServiceDate' },
  { header: 'Last service odometer (km)', key: 'lastServiceOdometer' },
  { header: 'Vendor', key: 'vendor' },
];

function filterOf(q: MaintenanceLogListQuery): repo.MaintenanceLogFilter {
  return { busId: q.busId, serviceType: q.serviceType, dueStatuses: q.dueStatus, from: q.from, to: q.to, flagged: q.flagged, hasInvoice: q.hasInvoice, q: q.q };
}

export interface MaintenanceListMeta extends ListMeta {
  /** Cost of every matching log (null on a page past the end). */
  totals: { cost: number } | null;
}

/** GET /school/maintenance-logs — JSON page or CSV export. */
export async function list(req: Request, res: Response, q: MaintenanceLogListQuery): Promise<void> {
  const { orderBy } = parseSort(q.sort, SORT);
  const filter = filterOf(q);
  if (q.format === 'csv') {
    const rows = await withRequestTenant(req, (tx) => repo.exportRows(tx, filter, orderBy), { readOnly: true });
    const csv = createCsvWriter<MaintenanceLogDto>(res, { fileName: 'maintenance-logs.csv', columns: CSV_COLUMNS });
    await csv.writeAll(rows.map(toDto));
    await csv.end();
    return;
  }
  const { page, limit, offset } = parsePagination(q);
  const { rows, total } = await withRequestTenant(req, (tx) => repo.page(tx, filter, { orderBy, limit, offset }), { readOnly: true });
  const first = rows[0] as repo.MaintenanceLogRow | undefined;
  const totals = first ? { cost: num(first.total_cost) ?? 0 } : total === 0 ? { cost: 0 } : null;
  const meta: MaintenanceListMeta = { ...listMeta({ page, limit, total }), totals };
  sendList(res, (rows as repo.MaintenanceLogRow[]).map(toDto), meta);
}

/** GET /school/maintenance-logs/due — latest log per bus + service type that is due. */
export async function due(req: Request, res: Response, q: MaintenanceDueQuery): Promise<void> {
  const { orderBy } = parseSort(q.sort, DUE_SORT);
  const filter: dueRepo.DueFilter = { statuses: q.status ?? DEFAULT_DUE_STATUSES, busId: q.busId, q: q.q };
  if (q.format === 'csv') {
    const rows = await withRequestTenant(req, (tx) => dueRepo.exportRows(tx, filter, orderBy), { readOnly: true });
    const csv = createCsvWriter<MaintenanceDueItem>(res, { fileName: 'maintenance-due.csv', columns: DUE_CSV });
    await csv.writeAll(rows.map(toDueItem));
    await csv.end();
    return;
  }
  const { page, limit, offset } = parsePagination(q);
  const { rows, total } = await withRequestTenant(req, (tx) => dueRepo.page(tx, filter, { orderBy, limit, offset }), { readOnly: true });
  sendList(res, (rows as dueRepo.DueRow[]).map(toDueItem), listMeta({ page, limit, total }));
}

/** GET /school/maintenance-logs/:id */
export async function get(req: Request, id: string): Promise<MaintenanceLogDto> {
  return withRequestTenant(
    req,
    async (tx) => {
      const row = await repo.find(tx, id);
      if (!row) throw notFound('Maintenance log not found.');
      return toDto(row);
    },
    { readOnly: true },
  );
}

async function warningsFor(tx: Tx, row: repo.MaintenanceLogRow): Promise<LogWarning[]> {
  const out = await odometerWarnings(tx, { busId: row.bus_id, day: row.service_date, odometer: num(row.odometer), selfId: row.id });
  const dup = await repo.findDuplicate(tx, { busId: row.bus_id, serviceDate: row.service_date, serviceType: row.service_type, selfId: row.id });
  if (dup) {
    out.push({
      code: 'POSSIBLE_DUPLICATE',
      message: `Bus ${row.bus_code} already has a "${row.service_type.trim()}" log on ${row.service_date}.`,
      details: { maintenanceLogId: dup.id, serviceDate: row.service_date, serviceType: row.service_type.trim() },
    });
  }
  return out;
}

const warningCodes = (w: LogWarning[]) => (w.length ? { warnings: w.map((x) => x.code) } : {});

async function requireBus(tx: Tx, busId: string) {
  const bus = await repo.findBus(tx, busId);
  if (!bus) throw notFound('Bus not found.');
  return bus;
}

/** Cross-field rules on the stored + changed values (a partial update may touch one side only). */
function assertDueRules(v: { serviceDate: string; nextDueDate: string | null; odometer: number | null; nextDueKm: number | null }): void {
  if (v.nextDueDate !== null && v.nextDueDate <= v.serviceDate) throw fieldError('nextDueDate', 'The next due date must be after the service date');
  if (v.nextDueKm !== null && v.odometer !== null && v.nextDueKm <= v.odometer) throw fieldError('nextDueKm', 'The next due km must be above the odometer reading');
}

/** POST /school/maintenance-logs */
export async function create(req: Request, body: CreateMaintenanceLogBody): Promise<MaintenanceLogWriteDto> {
  const { dto, schoolId } = await withRequestTenant(req, async (tx) => {
    const bus = await requireBus(tx, body.busId);
    await assertNotFuture(tx, body.serviceDate, 'serviceDate');
    if (body.invoiceFileId) await assertAttachableFile(tx, body.invoiceFileId, { kind: 'maintenance_log', busId: bus.id, logId: null, field: 'invoiceFileId' });
    const id = await repo.insert(tx, body);
    const row = (await repo.find(tx, id))!;
    const warnings = await warningsFor(tx, row);
    await audit.log(tx, { action: 'maintenance_log.create', entityType: 'maintenance_log', entityId: id, new: { ...auditView(row), ...warningCodes(warnings) } });
    return { dto: { ...toDto(row), warnings }, schoolId: tx.ctx.schoolId! };
  });
  await queueDueRefresh(schoolId);
  return dto;
}

/** PATCH /school/maintenance-logs/:id — corrections. */
export async function update(req: Request, id: string, body: UpdateMaintenanceLogBody): Promise<MaintenanceLogWriteDto> {
  const { dto, schoolId, changed } = await withRequestTenant(req, async (tx) => {
    if (!(await repo.lock(tx, id))) throw notFound('Maintenance log not found.');
    const before = (await repo.find(tx, id))!;
    const busId = body.busId ?? before.bus_id;
    if (body.busId && body.busId !== before.bus_id) await requireBus(tx, body.busId);
    if (body.serviceDate && body.serviceDate !== before.service_date) await assertNotFuture(tx, body.serviceDate, 'serviceDate');
    assertDueRules({
      serviceDate: body.serviceDate ?? before.service_date,
      nextDueDate: body.nextDueDate === undefined ? before.next_due_date : body.nextDueDate,
      odometer: body.odometer === undefined ? num(before.odometer) : body.odometer,
      nextDueKm: body.nextDueKm === undefined ? num(before.next_due_km) : body.nextDueKm,
    });
    if (body.invoiceFileId && body.invoiceFileId !== before.invoice_file_id) {
      await assertAttachableFile(tx, body.invoiceFileId, { kind: 'maintenance_log', busId, logId: id, field: 'invoiceFileId' });
    }
    await repo.update(tx, id, body);
    const after = (await repo.find(tx, id))!;
    const warnings = await warningsFor(tx, after);
    const diff = changedFields(auditView(before), auditView(after));
    if (Object.keys(diff.new).length) {
      await audit.log(tx, { action: 'maintenance_log.update', entityType: 'maintenance_log', entityId: id, old: diff.old, new: { ...diff.new, ...warningCodes(warnings) } });
    }
    return { dto: { ...toDto(after), warnings }, schoolId: tx.ctx.schoolId!, changed: Object.keys(diff.new).length > 0 };
  });
  if (changed) await queueDueRefresh(schoolId);
  return dto;
}

/** DELETE /school/maintenance-logs/:id — soft delete (the invoice file is kept for audit). */
export async function remove(req: Request, id: string): Promise<{ id: string; deleted: true }> {
  const schoolId = await withRequestTenant(req, async (tx) => {
    if (!(await repo.lock(tx, id))) throw notFound('Maintenance log not found.');
    const before = (await repo.find(tx, id))!;
    await repo.softDelete(tx, id);
    await audit.log(tx, { action: 'maintenance_log.delete', entityType: 'maintenance_log', entityId: id, old: auditView(before) });
    return tx.ctx.schoolId!;
  });
  await queueDueRefresh(schoolId);
  return { id, deleted: true as const };
}
