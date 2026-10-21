// Fuel logs service (BP §8.3 Fuel/Maintenance, §13.3 Fuel; contract §5): list with filters, sort,
// pagination, cost and per-unit quantity totals (litres / kg / kWh) and CSV export; detail; create / edit / soft delete with the bill
// file link, the not-in-the-future rule and non-blocking odometer warnings. Every write is audited
// in its transaction. School admins only.
import type { FuelLogDto, FuelLogTotals, FuelLogWriteDto, FuelUnit, FuelUnitTotal, ListMeta, LogWarning } from '@wimb/shared';
import type { Request, Response } from 'express';
import type { Tx } from '../../db/tenant.js';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { audit, changedFields } from '../../shared/audit.js';
import { createCsvWriter, type CsvColumn } from '../../shared/csv.js';
import { list as sendList } from '../../shared/envelope.js';
import { notFound } from '../../shared/errors.js';
import { listMeta, parsePagination, parseSort } from '../../shared/pagination.js';
import { assertAttachableFile, assertNotFuture } from './attach.js';
import { auditView, num, round, toDto } from './dto.js';
import { odometerWarnings } from './odometer.js';
import * as repo from './repository.js';
import type { CreateFuelLogBody, FuelLogListQuery, UpdateFuelLogBody } from './schemas.js';

const SORT = { allowed: repo.SORT_COLUMNS, defaultSort: '-fuelDate', tiebreaker: 'fl.created_at desc, fl.id' };

const CSV_COLUMNS: CsvColumn<FuelLogDto>[] = [
  { header: 'Date', key: 'fuelDate' },
  { header: 'Bus', key: 'busCode' },
  { header: 'Registration', key: 'busRegistrationNo' },
  { header: 'Odometer (km)', key: 'odometer' },
  { header: 'Quantity', key: 'litres' },
  { header: 'Unit', key: 'unit' },
  { header: 'Cost', key: 'cost' },
  { header: 'Price per unit', key: 'pricePerLitre' },
  { header: 'Fuel type', key: 'fuelType' },
  { header: 'Station', key: 'station' },
  { header: 'Distance since last fill (km)', key: 'distanceKm' },
  { header: 'km per unit', key: 'kmPerLitre' },
  { header: 'Cost per km', key: 'costPerKm' },
  { header: 'Odometer flags', value: (r) => r.odometerFlags.join('; ') },
  { header: 'Bill attached', value: (r) => (r.bill ? 'yes' : 'no') },
  { header: 'Notes', key: 'notes' },
  { header: 'Entered by', key: 'createdByName' },
  { header: 'Created (UTC)', key: 'createdAt' },
];

function filterOf(q: FuelLogListQuery): repo.FuelLogFilter {
  return { busId: q.busId, fuelTypes: q.fuelType, from: q.from, to: q.to, flagged: q.flagged, hasBill: q.hasBill, q: q.q };
}

export interface FuelListMeta extends ListMeta {
  /** Cost and per-unit quantities of every matching log (null on a page past the end). */
  totals: FuelLogTotals | null;
}

const UNIT_KEYS: readonly [FuelUnit, 'l' | 'kg' | 'kwh'][] = [['L', 'l'], ['kg', 'kg'], ['kWh', 'kwh']];

/**
 * meta.totals from the window sums of the first row: quantities per unit (litres, kg, kWh are never
 * added together); `quantity`/`litres` only when every match uses one unit.
 */
export function fuelTotals(row: repo.FuelLogRow | undefined): FuelLogTotals {
  const byUnit: FuelUnitTotal[] = [];
  for (const [unit, k] of UNIT_KEYS) {
    const fills = num(row?.[`total_fills_${k}`]) ?? 0;
    if (!fills) continue;
    const quantity = round(num(row?.[`total_qty_${k}`]) ?? 0);
    const cost = round(num(row?.[`total_cost_${k}`]) ?? 0);
    byUnit.push({ unit, fills, quantity, cost, avgPricePerUnit: quantity > 0 ? round(cost / quantity) : null });
  }
  const single = byUnit.length === 1 ? byUnit[0]! : null;
  return {
    fills: byUnit.reduce((n, u) => n + u.fills, 0),
    cost: round(num(row?.total_cost) ?? 0),
    unit: single?.unit ?? null,
    quantity: single ? single.quantity : byUnit.length ? null : 0,
    litres: single ? single.quantity : byUnit.length ? null : 0,
    byUnit,
  };
}

/** GET /school/fuel-logs — JSON page or CSV export. */
export async function list(req: Request, res: Response, q: FuelLogListQuery): Promise<void> {
  const { orderBy } = parseSort(q.sort, SORT);
  const filter = filterOf(q);
  if (q.format === 'csv') {
    const rows = await withRequestTenant(req, (tx) => repo.exportRows(tx, filter, orderBy), { readOnly: true });
    const csv = createCsvWriter<FuelLogDto>(res, { fileName: 'fuel-logs.csv', columns: CSV_COLUMNS });
    await csv.writeAll(rows.map(toDto));
    await csv.end();
    return;
  }
  const { page, limit, offset } = parsePagination(q);
  const { rows, total } = await withRequestTenant(req, (tx) => repo.page(tx, filter, { orderBy, limit, offset }), { readOnly: true });
  const first = rows[0] as repo.FuelLogRow | undefined;
  const totals = first || total === 0 ? fuelTotals(first) : null;
  const meta: FuelListMeta = { ...listMeta({ page, limit, total }), totals };
  sendList(res, (rows as repo.FuelLogRow[]).map(toDto), meta);
}

/** GET /school/fuel-logs/:id */
export async function get(req: Request, id: string): Promise<FuelLogDto> {
  return withRequestTenant(
    req,
    async (tx) => {
      const row = await repo.find(tx, id);
      if (!row) throw notFound('Fuel log not found.');
      return toDto(row);
    },
    { readOnly: true },
  );
}

async function warningsFor(tx: Tx, row: repo.FuelLogRow): Promise<LogWarning[]> {
  const odometer = num(row.odometer);
  const out = await odometerWarnings(tx, { busId: row.bus_id, day: row.fuel_date, odometer, selfId: row.id });
  const dup = await repo.findDuplicate(tx, { busId: row.bus_id, fuelDate: row.fuel_date, litres: Number(row.litres), selfId: row.id });
  if (dup) {
    out.push({
      code: 'POSSIBLE_DUPLICATE',
      message: `Bus ${row.bus_code} already has a fuel log of ${Number(row.litres)} litres on ${row.fuel_date}.`,
      details: { fuelLogId: dup.id, fuelDate: row.fuel_date, litres: Number(row.litres) },
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

/** POST /school/fuel-logs */
export async function create(req: Request, body: CreateFuelLogBody): Promise<FuelLogWriteDto> {
  return withRequestTenant(req, async (tx) => {
    const bus = await requireBus(tx, body.busId);
    await assertNotFuture(tx, body.fuelDate, 'fuelDate');
    if (body.billFileId) await assertAttachableFile(tx, body.billFileId, { kind: 'fuel_log', busId: bus.id, logId: null, field: 'billFileId' });
    const id = await repo.insert(tx, { ...body, fuelType: body.fuelType === undefined ? bus.fuel_type : body.fuelType });
    const row = (await repo.find(tx, id))!;
    const warnings = await warningsFor(tx, row);
    await audit.log(tx, { action: 'fuel_log.create', entityType: 'fuel_log', entityId: id, new: { ...auditView(row), ...warningCodes(warnings) } });
    return { ...toDto(row), warnings };
  });
}

/** PATCH /school/fuel-logs/:id — corrections (bus, date, reading, amounts, bill, notes). */
export async function update(req: Request, id: string, body: UpdateFuelLogBody): Promise<FuelLogWriteDto> {
  return withRequestTenant(req, async (tx) => {
    const locked = await repo.lock(tx, id);
    if (!locked) throw notFound('Fuel log not found.');
    const before = (await repo.find(tx, id))!;
    const busId = body.busId ?? before.bus_id;
    if (body.busId && body.busId !== before.bus_id) await requireBus(tx, body.busId);
    if (body.fuelDate && body.fuelDate !== before.fuel_date) await assertNotFuture(tx, body.fuelDate, 'fuelDate');
    if (body.billFileId && body.billFileId !== before.bill_file_id) {
      await assertAttachableFile(tx, body.billFileId, { kind: 'fuel_log', busId, logId: id, field: 'billFileId' });
    }
    await repo.update(tx, id, body);
    const after = (await repo.find(tx, id))!;
    const warnings = await warningsFor(tx, after);
    const diff = changedFields(auditView(before), auditView(after));
    if (Object.keys(diff.new).length) {
      await audit.log(tx, { action: 'fuel_log.update', entityType: 'fuel_log', entityId: id, old: diff.old, new: { ...diff.new, ...warningCodes(warnings) } });
    }
    return { ...toDto(after), warnings };
  });
}

/** DELETE /school/fuel-logs/:id — soft delete (the bill file is kept for audit). */
export async function remove(req: Request, id: string): Promise<{ id: string; deleted: true }> {
  return withRequestTenant(req, async (tx) => {
    if (!(await repo.lock(tx, id))) throw notFound('Fuel log not found.');
    const before = (await repo.find(tx, id))!;
    await repo.softDelete(tx, id);
    await audit.log(tx, { action: 'fuel_log.delete', entityType: 'fuel_log', entityId: id, old: auditView(before) });
    return { id, deleted: true as const };
  });
}

