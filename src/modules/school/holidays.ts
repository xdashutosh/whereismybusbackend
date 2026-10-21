// Holiday calendar (contract §8/§9, BP §19 #10, §20 #4): CRUD /school/holidays. Holidays stop
// generate-daily-trips and "trip not started" alerts for the covered days (all trips, or only the
// morning/afternoon direction). Dates are school-local calendar days; end_date is inclusive.
import { holidayRangeIssues, type CreateHolidayBody, type HolidayDto, type UpdateHolidayBody } from '@wimb/shared';
import type { Request, Response } from 'express';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { audit, changedFields } from '../../shared/audit.js';
import { createCsvWriter, type CsvColumn } from '../../shared/csv.js';
import { list as sendList } from '../../shared/envelope.js';
import { assertFound, duplicate, validationError } from '../../shared/errors.js';
import { listMeta, parsePagination, parseSort } from '../../shared/pagination.js';
import * as repo from './holidayRepository.js';
import type { HolidayListQuery } from './schemas.js';

const SORT = {
  allowed: { startDate: 'h.start_date', endDate: 'h.end_date', name: 'h.name', createdAt: 'h.created_at' },
  defaultSort: 'startDate',
  tiebreaker: 'h.id',
};

const dayCount = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

export function toDto(r: repo.HolidayRow): HolidayDto {
  return {
    id: r.id,
    name: r.name,
    startDate: r.start_date,
    endDate: r.end_date,
    appliesTo: r.applies_to,
    days: dayCount(r.start_date, r.end_date),
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const CSV_COLUMNS: CsvColumn<HolidayDto>[] = [
  { header: 'Name', key: 'name' },
  { header: 'Start date', key: 'startDate' },
  { header: 'End date', key: 'endDate' },
  { header: 'Days', key: 'days' },
  { header: 'Applies to', key: 'appliesTo' },
];

/** from/to/year → one inclusive [from, to] window (intersection). */
function window(q: HolidayListQuery): repo.HolidayFilter {
  const bounds = { from: q.from, to: q.to };
  if (q.year) {
    const yFrom = `${q.year}-01-01`;
    const yTo = `${q.year}-12-31`;
    bounds.from = bounds.from && bounds.from > yFrom ? bounds.from : yFrom;
    bounds.to = bounds.to && bounds.to < yTo ? bounds.to : yTo;
  }
  if (bounds.from && bounds.to && bounds.from > bounds.to) throw validationError('Invalid date range.', [{ path: 'to', message: 'Must be on or after "from"' }]);
  return { from: bounds.from, to: bounds.to, appliesTo: q.appliesTo, q: q.q };
}

/** GET /school/holidays (JSON page or CSV). */
export async function list(req: Request, res: Response, q: HolidayListQuery): Promise<void> {
  const filter = window(q);
  const { orderBy } = parseSort(q.sort, SORT);
  if (q.format === 'csv') {
    const rows = await withRequestTenant(req, (tx) => repo.exportRows(tx, filter, orderBy), { readOnly: true });
    const csv = createCsvWriter<HolidayDto>(res, { fileName: 'holidays.csv', columns: CSV_COLUMNS });
    await csv.writeAll(rows.map(toDto));
    await csv.end();
    return;
  }
  const { page, limit, offset } = parsePagination(q);
  const { rows, total } = await withRequestTenant(req, (tx) => repo.page(tx, filter, { orderBy, limit, offset }), { readOnly: true });
  sendList(res, rows.map((r) => toDto(r as repo.HolidayRow)), listMeta({ page, limit, total }));
}

/** GET /school/holidays/:id */
export function get(req: Request, id: string): Promise<HolidayDto> {
  return withRequestTenant(req, async (tx) => toDto(assertFound(await repo.find(tx, id), 'The holiday was not found.')), { readOnly: true });
}

const duplicateHoliday = () => duplicate('A holiday with this name already starts on that day.', [{ path: 'name', message: 'Already exists for this start date' }]);

/** POST /school/holidays */
export function create(req: Request, body: CreateHolidayBody): Promise<HolidayDto> {
  return withRequestTenant(req, async (tx) => {
    await repo.lockCalendar(tx);
    if (await repo.duplicateExists(tx, body.name, body.startDate)) throw duplicateHoliday();
    const row = await repo.insert(tx, { name: body.name, startDate: body.startDate, endDate: body.endDate ?? body.startDate, appliesTo: body.appliesTo });
    const dto = toDto(row);
    await audit.log(tx, { action: 'holiday.create', entityType: 'school_holiday', entityId: row.id, new: { name: dto.name, startDate: dto.startDate, endDate: dto.endDate, appliesTo: dto.appliesTo } });
    return dto;
  });
}

/** PATCH /school/holidays/:id */
export function update(req: Request, id: string, body: UpdateHolidayBody): Promise<HolidayDto> {
  return withRequestTenant(req, async (tx) => {
    await repo.lockCalendar(tx);
    const before = toDto(assertFound(await repo.find(tx, id, { lock: true }), 'The holiday was not found.'));
    const next = {
      name: body.name ?? before.name,
      startDate: body.startDate ?? before.startDate,
      endDate: body.endDate ?? (body.startDate && body.startDate > before.endDate ? body.startDate : before.endDate),
      appliesTo: body.appliesTo ?? before.appliesTo,
    };
    const issues = holidayRangeIssues(next.startDate, next.endDate);
    if (issues.length) throw validationError('Invalid holiday dates.', issues);
    if ((next.name.toLowerCase() !== before.name.toLowerCase() || next.startDate !== before.startDate) && (await repo.duplicateExists(tx, next.name, next.startDate, id))) {
      throw duplicateHoliday();
    }
    const after = toDto(await repo.update(tx, id, next));
    const pickAudit = (d: HolidayDto) => ({ name: d.name, startDate: d.startDate, endDate: d.endDate, appliesTo: d.appliesTo });
    const diff = changedFields(pickAudit(before), pickAudit(after));
    if (Object.keys(diff.new).length) await audit.log(tx, { action: 'holiday.update', entityType: 'school_holiday', entityId: id, ...diff });
    return after;
  });
}

/** DELETE /school/holidays/:id */
export function remove(req: Request, id: string): Promise<void> {
  return withRequestTenant(req, async (tx) => {
    const before = toDto(assertFound(await repo.find(tx, id, { lock: true }), 'The holiday was not found.'));
    await repo.remove(tx, id);
    await audit.log(tx, { action: 'holiday.delete', entityType: 'school_holiday', entityId: id, old: { name: before.name, startDate: before.startDate, endDate: before.endDate, appliesTo: before.appliesTo } });
  });
}
