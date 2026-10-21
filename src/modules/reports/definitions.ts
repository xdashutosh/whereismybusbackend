// Report definitions: title, columns (one list drives the JSON `columns`, the CSV header and the PDF
// table), totals and page orientation for every report kind. Totals are sums of the listed columns;
// ratio columns are recomputed from those sums (never averaged averages).
import type { ReportColumn, ReportColumnType, ReportKind } from '@wimb/shared';

export interface ReportDefinition {
  title: string;
  /** Short description printed under the PDF title. */
  description: string;
  /** `pdf: false` leaves a column out of the PDF table (kept in JSON and CSV). */
  columns: readonly (ReportColumn & { pdf?: boolean })[];
  /** Columns summed into `totals`. */
  sum: readonly string[];
  /** Ratio totals recomputed from the sums. */
  ratios?: (t: Record<string, number>) => Record<string, number | null>;
  /** Totals that need the rows themselves (e.g. per-unit ratios over the buses of one unit). */
  rowTotals?: (rows: readonly Record<string, unknown>[], sums: Record<string, number>) => Record<string, number | null>;
  landscape: boolean;
}

const col = (key: string, label: string, type: ReportColumnType, extra: { pdf?: boolean } = {}) => ({ key, label, type, ...extra });

const ratio = (num: number | undefined, den: number | undefined, digits = 2): number | null => {
  if (num === undefined || den === undefined || !den) return null;
  const f = 10 ** digits;
  return Math.round((num / den) * f) / f;
};

const BUS = [col('busCode', 'Bus', 'text'), col('registrationNo', 'Registration', 'text')];

/** Fuel report unit → [quantity key, cost key, total-key suffix]. */
const FUEL_UNIT_KEYS = [
  ['L', 'litres', 'litresCost', 'Litre'],
  ['kg', 'kg', 'kgCost', 'Kg'],
  ['kWh', 'kwh', 'kwhCost', 'Kwh'],
] as const;

/**
 * Distance columns shared by the fuel and cost-per-km reports (repository.ts FUEL_DISTANCE_COLS). The PDF
 * keeps the distance used and its source; both measurements stay in JSON and CSV.
 */
const FUEL_DISTANCE = [
  col('odometerKm', 'Odometer km between fills', 'km', { pdf: false }),
  col('tripKm', 'Trip km', 'km', { pdf: false }),
  col('distanceKm', 'Distance km', 'km'),
  col('distanceSource', 'Distance from', 'text'),
];

/**
 * Per-unit totals of the fuel report: avgPricePer{Litre,Kg,Kwh} = Σ cost / Σ quantity of that unit;
 * kmPer{Litre,Kg,Kwh} = Σ distance / Σ fuel burnt over it (kmQuantity) over the buses whose fills all
 * use that unit (a bus without fills or with mixed units has no mileage). avgPricePerUnit / kmPerUnit (the table's totals
 * row) only when every fill of the report uses one unit — otherwise null, never a mixed-unit figure.
 */
function fuelUnitTotals(rows: readonly Record<string, unknown>[], sums: Record<string, number>): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  const present: string[] = [];
  for (const [unit, qtyKey, costKey, suffix] of FUEL_UNIT_KEYS) {
    if ((sums[qtyKey] ?? 0) > 0) present.push(unit);
    out[`avgPricePer${suffix}`] = ratio(sums[costKey], sums[qtyKey]);
    let km = 0;
    let qty = 0;
    for (const r of rows) {
      const units = r.units as readonly string[] | undefined;
      if (units?.length === 1 && units[0] === unit) {
        km += Number(r.distanceKm ?? 0);
        qty += Number(r.kmQuantity ?? 0);
      }
    }
    out[`kmPer${suffix}`] = ratio(km, qty);
  }
  const single = present.length === 1 ? FUEL_UNIT_KEYS.find(([u]) => u === present[0])! : null;
  out.avgPricePerUnit = single ? out[`avgPricePer${single[3]}`]! : null;
  out.kmPerUnit = single ? out[`kmPer${single[3]}`]! : null;
  return out;
}

export const DEFINITIONS: Readonly<Record<ReportKind, ReportDefinition>> = Object.freeze({
  'bus-distance': {
    title: 'Bus distance',
    description: 'Distance covered by each bus over trips that ran (odometer distance, GPS distance when no odometer distance was recorded).',
    columns: [
      ...BUS,
      col('busStatus', 'Bus status', 'text'),
      col('trips', 'Trips', 'int'),
      col('schoolTrips', 'School trips', 'int'),
      col('nonSchoolTrips', 'Non-school trips', 'int'),
      col('activeDays', 'Active days', 'int'),
      col('odometerKm', 'Odometer km', 'km'),
      col('gpsKm', 'GPS km', 'km'),
      col('distanceKm', 'Distance km', 'km'),
      col('avgKmPerTrip', 'Avg km / trip', 'km'),
      col('firstTripDate', 'First trip', 'date'),
      col('lastTripDate', 'Last trip', 'date'),
    ],
    sum: ['trips', 'schoolTrips', 'nonSchoolTrips', 'odometerKm', 'gpsKm', 'distanceKm'],
    ratios: (t) => ({ avgKmPerTrip: ratio(t.distanceKm, t.trips, 1) }),
    landscape: true,
  },
  fuel: {
    title: 'Fuel',
    description:
      'Fuel filled per bus (fuel logs by fill date). Distance = odometer km between fills (fill-to-fill, as on the Fuel page), or trip km when fewer than two fills have odometer readings; km / unit and cost / km use the fuel burnt over that distance. Quantities are per unit (litres; kg for CNG; kWh for electric) and never added across units; cost and cost per km compare all buses.',
    columns: [
      ...BUS,
      col('fuelType', 'Fuel type', 'text'),
      col('units', 'Unit', 'list'),
      col('fills', 'Fills', 'int'),
      col('litres', 'Litres', 'decimal'),
      col('kg', 'CNG kg', 'decimal'),
      col('kwh', 'kWh', 'decimal'),
      col('cost', 'Cost', 'money'),
      col('avgPricePerUnit', 'Avg price / unit', 'money'),
      ...FUEL_DISTANCE,
      col('kmPerUnit', 'Km / unit', 'decimal'),
      col('fuelCostPerKm', 'Fuel cost / km', 'money'),
      col('lastFillDate', 'Last fill', 'date'),
    ],
    sum: ['fills', 'litres', 'kg', 'kwh', 'litresCost', 'kgCost', 'kwhCost', 'cost', 'odometerKm', 'tripKm', 'distanceKm', 'kmCost'],
    ratios: (t) => ({ fuelCostPerKm: ratio(t.kmCost, t.distanceKm) }),
    rowTotals: fuelUnitTotals,
    landscape: true,
  },
  maintenance: {
    title: 'Maintenance',
    description: 'Services logged per bus (by service date) with their cost, and the earliest next due date of the bus.',
    columns: [
      ...BUS,
      col('services', 'Services', 'int'),
      col('totalCost', 'Total cost', 'money'),
      col('avgCost', 'Avg cost', 'money'),
      col('unpricedServices', 'Without cost', 'int'),
      col('serviceTypes', 'Service types', 'list'),
      col('lastServiceDate', 'Last service', 'date'),
      col('lastServiceType', 'Last service type', 'text'),
      col('nextDueDate', 'Next due', 'date'),
    ],
    sum: ['services', 'totalCost', 'unpricedServices'],
    ratios: (t) => ({ avgCost: ratio(t.totalCost, (t.services ?? 0) - (t.unpricedServices ?? 0)) }),
    landscape: true,
  },
  'cost-per-km': {
    title: 'Cost per km',
    description:
      'Fuel and maintenance cost per km of each bus. Distance = odometer km between fills (fill-to-fill), or trip km when fewer than two fills have odometer readings; fuel / km uses the fuel burnt over that distance.',
    columns: [
      ...BUS,
      ...FUEL_DISTANCE,
      col('fuelCost', 'Fuel cost', 'money'),
      col('maintenanceCost', 'Maintenance cost', 'money'),
      col('totalCost', 'Total cost', 'money'),
      col('fuelCostPerKm', 'Fuel / km', 'money'),
      col('maintenanceCostPerKm', 'Maintenance / km', 'money'),
      col('costPerKm', 'Cost / km', 'money'),
    ],
    sum: ['odometerKm', 'tripKm', 'distanceKm', 'kmCost', 'fuelCost', 'maintenanceCost', 'totalCost'],
    ratios: (t) => ({
      fuelCostPerKm: ratio(t.kmCost, t.distanceKm),
      maintenanceCostPerKm: ratio(t.maintenanceCost, t.distanceKm),
      costPerKm: ratio((t.kmCost ?? 0) + (t.maintenanceCost ?? 0), t.distanceKm),
    }),
    landscape: true,
  },
  'service-due': {
    title: 'Service due',
    description: 'Next service of each bus in service and service type (latest log), most urgent first.',
    columns: [
      ...BUS,
      col('serviceType', 'Service', 'text'),
      col('status', 'Status', 'text'),
      col('dueBy', 'Due by', 'text'),
      col('lastServiceDate', 'Last service', 'date'),
      col('lastServiceOdometer', 'Odometer at service', 'km'),
      col('vendor', 'Vendor', 'text'),
      col('nextDueDate', 'Next due date', 'date'),
      col('daysToDue', 'Days to due', 'int'),
      col('nextDueKm', 'Next due km', 'km'),
      col('currentOdometer', 'Current odometer', 'km'),
      col('kmToDue', 'Km to due', 'km'),
    ],
    sum: [],
    landscape: true,
  },
  'non-school-usage': {
    title: 'Non-school usage',
    description: 'Non-school trips logged by drivers, newest first.',
    columns: [
      col('tripDate', 'Date', 'date'),
      ...BUS,
      col('driverName', 'Driver', 'text'),
      col('conductorName', 'Conductor', 'text', { pdf: false }),
      col('purpose', 'Purpose', 'text'),
      col('status', 'Status', 'text'),
      col('startedAt', 'Started', 'datetime'),
      col('endedAt', 'Ended', 'datetime'),
      col('durationMin', 'Duration (min)', 'int'),
      col('startOdometer', 'Start odometer', 'km', { pdf: false }),
      col('endOdometer', 'End odometer', 'km', { pdf: false }),
      col('distanceKm', 'Distance km', 'km'),
      col('alerts', 'Alerts', 'int'),
    ],
    sum: ['durationMin', 'distanceKm', 'alerts'],
    landscape: true,
  },
  'trip-summary': {
    title: 'Trip summary',
    description: 'Trips per bus by outcome. On time = started within the school’s grace minutes of the planned start; completion rate = completed / (completed + auto-closed + missed).',
    columns: [
      ...BUS,
      col('trips', 'Trips', 'int'),
      col('schoolTrips', 'School', 'int'),
      col('completed', 'Completed', 'int'),
      col('autoClosed', 'Auto-closed', 'int'),
      col('missed', 'Missed', 'int'),
      col('cancelled', 'Cancelled', 'int'),
      col('inProgress', 'In progress', 'int'),
      col('scheduled', 'Scheduled', 'int'),
      col('nonSchoolTrips', 'Non-school', 'int'),
      col('onTimeStarts', 'On time', 'int'),
      col('lateStarts', 'Late', 'int'),
      col('avgStartDelayMin', 'Avg delay (min)', 'decimal'),
      col('completionRatePct', 'Completion %', 'percent'),
      col('distanceKm', 'Distance km', 'km'),
      col('alerts', 'Alerts', 'int'),
    ],
    sum: ['trips', 'schoolTrips', 'completed', 'autoClosed', 'missed', 'cancelled', 'inProgress', 'scheduled', 'nonSchoolTrips', 'onTimeStarts', 'lateStarts', 'distanceKm', 'alerts'],
    ratios: (t) => {
      const due = (t.completed ?? 0) + (t.autoClosed ?? 0) + (t.missed ?? 0);
      return { completionRatePct: due ? Math.round((1000 * (t.completed ?? 0)) / due) / 10 : null };
    },
    landscape: true,
  },
});

/** Totals of `rows` for a report: sums rounded to 2 decimals plus recomputed ratios. */
export function computeTotals(def: ReportDefinition, rows: readonly Record<string, unknown>[]): Record<string, number | null> {
  const sums: Record<string, number> = {};
  for (const key of def.sum) {
    let s = 0;
    for (const r of rows) {
      const v = r[key];
      if (typeof v === 'number' && Number.isFinite(v)) s += v;
    }
    sums[key] = Math.round(s * 100) / 100;
  }
  return { ...sums, ...(def.ratios ? def.ratios(sums) : {}), ...(def.rowTotals ? def.rowTotals(rows, sums) : {}) };
}
