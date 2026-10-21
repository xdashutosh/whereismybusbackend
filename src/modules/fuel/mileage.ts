// Mileage trends (BP §13.3 Fuel: per-bus mileage trends; feeds the fuel report and cost per km).
//   GET /school/fuel-logs/mileage-trend?busId&from&to  one bus: every fill (distance, km/l, cost/km)
//                                                      plus totals and 'YYYY-MM' buckets
//   GET /school/fuel-logs/mileage-summary?from&to&q    one row per bus (JSON array or CSV)
// km/l of a group = Σ distance / Σ span litres of the fills that have a distance (each fill's span
// holds the litres burnt since its mileage base, fills without a reading included); cost/km likewise.
import type { FuelType, MileagePoint, MileageSummaryRow, MileageTotals, MileageTrendDto } from '@wimb/shared';
import type { Request, Response } from 'express';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { createCsvWriter, type CsvColumn } from '../../shared/csv.js';
import { ok } from '../../shared/envelope.js';
import { notFound } from '../../shared/errors.js';
import { num, round, toDto } from './dto.js';
import * as repo from './mileageRepository.js';
import type { MileageSummaryQuery, MileageTrendQuery } from './schemas.js';

interface Acc {
  fills: number;
  litres: number;
  cost: number;
  distanceKm: number;
  litresWithDistance: number;
  costWithDistance: number;
}

const emptyAcc = (): Acc => ({ fills: 0, litres: 0, cost: 0, distanceKm: 0, litresWithDistance: 0, costWithDistance: 0 });

function add(acc: Acc, p: MileagePoint): void {
  acc.fills += 1;
  acc.litres += p.litres;
  acc.cost += p.cost;
  if (p.distanceKm !== null) {
    acc.distanceKm += p.distanceKm;
    acc.litresWithDistance += p.spanLitres ?? 0;
    acc.costWithDistance += p.spanCost ?? 0;
  }
}

export function totalsOf(a: Acc): MileageTotals {
  return {
    fills: a.fills,
    litres: round(a.litres),
    cost: round(a.cost),
    distanceKm: round(a.distanceKm, 1),
    kmPerLitre: a.litresWithDistance > 0 && a.distanceKm > 0 ? round(a.distanceKm / a.litresWithDistance) : null,
    costPerKm: a.distanceKm > 0 ? round(a.costWithDistance / a.distanceKm) : null,
    avgPricePerLitre: a.litres > 0 ? round(a.cost / a.litres) : null,
  };
}

/** GET /school/fuel-logs/mileage-trend */
export async function trend(req: Request, q: MileageTrendQuery): Promise<MileageTrendDto> {
  const { bus, rows } = await withRequestTenant(
    req,
    async (tx) => {
      const bus = await repo.findBus(tx, q.busId);
      if (!bus) throw notFound('Bus not found.');
      return { bus, rows: await repo.trendRows(tx, q.busId, q.from ?? null, q.to ?? null) };
    },
    { readOnly: true },
  );
  const points: MileagePoint[] = rows.map((r) => {
    const d = toDto(r);
    return { fuelLogId: d.id, fuelDate: d.fuelDate, odometer: d.odometer, litres: d.litres, cost: d.cost, distanceKm: d.distanceKm, spanLitres: d.spanLitres, spanCost: d.spanCost, kmPerLitre: d.kmPerLitre, costPerKm: d.costPerKm, odometerFlags: d.odometerFlags };
  });
  const all = emptyAcc();
  const months = new Map<string, Acc>();
  for (const p of points) {
    add(all, p);
    const key = p.fuelDate.slice(0, 7);
    if (!months.has(key)) months.set(key, emptyAcc());
    add(months.get(key)!, p);
  }
  return {
    bus: { id: bus.id, code: bus.code, registrationNo: bus.registration_no, fuelType: (bus.fuel_type as FuelType | null) ?? null, lastKnownOdometer: num(bus.last_known_odometer) },
    from: q.from ?? null,
    to: q.to ?? null,
    totals: totalsOf(all),
    points,
    monthly: [...months.entries()].map(([month, acc]) => ({ month, ...totalsOf(acc) })),
  };
}

function toSummary(r: repo.SummaryRow): MileageSummaryRow {
  return {
    busId: r.bus_id,
    busCode: r.bus_code,
    registrationNo: r.registration_no,
    fuelType: (r.fuel_type as FuelType | null) ?? null,
    firstFuelDate: r.first_fuel_date,
    lastFuelDate: r.last_fuel_date,
    flaggedLogs: Number(r.flagged_logs),
    ...totalsOf({
      fills: Number(r.fills),
      litres: Number(r.litres),
      cost: Number(r.cost),
      distanceKm: num(r.distance_km) ?? 0,
      litresWithDistance: num(r.litres_with_distance) ?? 0,
      costWithDistance: num(r.cost_with_distance) ?? 0,
    }),
  };
}

const SUMMARY_CSV: CsvColumn<MileageSummaryRow>[] = [
  { header: 'Bus', key: 'busCode' },
  { header: 'Registration', key: 'registrationNo' },
  { header: 'Fuel type', key: 'fuelType' },
  { header: 'Fills', key: 'fills' },
  { header: 'Litres', key: 'litres' },
  { header: 'Cost', key: 'cost' },
  { header: 'Distance (km)', key: 'distanceKm' },
  { header: 'km per litre', key: 'kmPerLitre' },
  { header: 'Cost per km', key: 'costPerKm' },
  { header: 'Average price per litre', key: 'avgPricePerLitre' },
  { header: 'First fill', key: 'firstFuelDate' },
  { header: 'Last fill', key: 'lastFuelDate' },
  { header: 'Flagged logs', key: 'flaggedLogs' },
];

/** GET /school/fuel-logs/mileage-summary */
export async function summary(req: Request, res: Response, q: MileageSummaryQuery): Promise<void> {
  const rows = await withRequestTenant(req, (tx) => repo.summaryRows(tx, { from: q.from ?? null, to: q.to ?? null, q: q.q }), { readOnly: true });
  const items = rows.map(toSummary);
  if (q.format === 'csv') {
    const csv = createCsvWriter<MileageSummaryRow>(res, { fileName: 'fuel-mileage.csv', columns: SUMMARY_CSV });
    await csv.writeAll(items);
    await csv.end();
    return;
  }
  ok(res, items);
}
