// Fuel module schemas and DTOs (BP §6.2 fuel_logs, §8.3 Fuel/Maintenance, §13.3 Fuel: log, bill image,
// per-bus mileage trends). Request schemas are shared by the backend validators and the web admin;
// the DTO interfaces describe the responses. Unknown keys (e.g. school_id) are stripped.
import { z } from 'zod';
import { FUEL_TYPES, type FuelType } from '../enums.js';
import { exportFormat, isoDate, listQueryShape, optionalText, periodShape, queryBool, queryEnumList, uuid, withPeriod } from './common.js';

const emptyToUndefined = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const csvOnly = exportFormat.refine((f) => f !== 'pdf', 'Supported formats: json, csv');
const num = (msg = 'Must be a number') => z.number({ required_error: 'Required', invalid_type_error: msg }).finite();
const nullableEnum = <T extends [string, ...string[]]>(values: T) => z.preprocess((v) => (v === '' ? null : v), z.enum(values).nullable().optional());
const optionalDate = () => z.preprocess(emptyToUndefined, isoDate().optional());
const optionalUuid = () => z.preprocess(emptyToUndefined, uuid().optional());

/** Upper bounds that keep values inside the numeric columns and catch typing slips. */
export const FUEL_LOG_LIMITS = Object.freeze({ maxLitres: 5000, maxCost: 9_999_999.99, maxOdometer: 9_999_999.9 });

/**
 * Unit of a fuel log's quantity (the `litres` field): kilograms for CNG, kWh for electric buses, litres
 * for every other fuel (diesel, petrol, hybrid, other). Quantities of different units are never added
 * together: totals are given per unit (FuelUnitTotal); cost and cost per km stay comparable.
 */
export const FUEL_UNITS = ['L', 'kg', 'kWh'] as const;
export type FuelUnit = (typeof FUEL_UNITS)[number];

/** Quantity unit of a fuel type (a log without its own fuel type uses the bus's). */
export function fuelUnitOf(fuelType: string | null | undefined): FuelUnit {
  if (fuelType === 'cng') return 'kg';
  if (fuelType === 'electric') return 'kWh';
  return 'L';
}

/** Totals of the fills in one quantity unit. */
export interface FuelUnitTotal {
  unit: FuelUnit;
  fills: number;
  /** Σ quantity in `unit`. */
  quantity: number;
  cost: number;
  /** cost / quantity (2 decimals), null without quantity. */
  avgPricePerUnit: number | null;
}

/** `meta.totals` of GET /school/fuel-logs: every matching log (not just the page). */
export interface FuelLogTotals {
  fills: number;
  cost: number;
  /** The single quantity unit of the matches, null when they mix units (or there are none). */
  unit: FuelUnit | null;
  /** Σ quantity when all matches share one unit, else null (see byUnit). */
  quantity: number | null;
  /** @deprecated Same as `quantity` (kept for older clients; null when units are mixed). */
  litres: number | null;
  /** One entry per unit present, in FUEL_UNITS order. */
  byUnit: FuelUnitTotal[];
}

/** Odometer reading in km (one decimal is stored). */
export const logOdometer = () => num().min(0).max(FUEL_LOG_LIMITS.maxOdometer);
/** Amount in the school's currency (two decimals are stored). */
export const moneyAmount = () => num().min(0).max(FUEL_LOG_LIMITS.maxCost);

/**
 * Non-blocking odometer checks run on every create/update of a fuel or maintenance log (the log is
 * saved; the response carries `warnings`). Readings of the same bus come from fuel logs, maintenance
 * logs and trip odometer evidence (start/end readings), compared by calendar day with the NEAREST
 * neighbours only (so one mistyped entry flags itself and one neighbour, not the whole history).
 *   ODOMETER_BELOW_PREVIOUS  lower than the previous reading (latest earlier day, highest of that day)
 *   ODOMETER_ABOVE_NEXT      higher than the next reading (earliest later day, lowest of that day; back-dated entry)
 *   ODOMETER_BELOW_BUS       lower than the bus's last known odometer although the log is dated after it was recorded
 *   POSSIBLE_DUPLICATE       another log of the bus on the same day with the same litres (fuel) / service type (maintenance)
 */
export const LOG_WARNING_CODES = ['ODOMETER_BELOW_PREVIOUS', 'ODOMETER_ABOVE_NEXT', 'ODOMETER_BELOW_BUS', 'POSSIBLE_DUPLICATE'] as const;
export type LogWarningCode = (typeof LOG_WARNING_CODES)[number];

/** Per-row odometer flags shown in lists (same rules as the first two warnings). */
export const ODOMETER_FLAGS = ['below_previous', 'above_next'] as const;
export type OdometerFlag = (typeof ODOMETER_FLAGS)[number];

export interface LogWarning {
  code: LogWarningCode;
  message: string;
  details: Record<string, unknown>;
}

// ── requests ─────────────────────────────────────────────────────────────────
const fuelLogFields = {
  busId: uuid(),
  /** School-local calendar day of the fill; never in the future. */
  fuelDate: isoDate(),
  odometer: logOdometer().nullable().optional(),
  /** Quantity in the fuel's unit: litres, kg for CNG, kWh for electric buses (see fuelUnitOf). */
  litres: num().positive('Must be greater than 0').max(FUEL_LOG_LIMITS.maxLitres),
  cost: moneyAmount(),
  /** Defaults to the bus's fuel type. */
  fuelType: nullableEnum([...FUEL_TYPES]),
  station: optionalText(200),
  /** files.id of an uploaded `fuel_bill` (entity: the bus, or this fuel log); null removes it. */
  billFileId: uuid().nullable().optional(),
  notes: optionalText(2000),
};

export const createFuelLogBody = z.object(fuelLogFields);
export type CreateFuelLogBody = z.infer<typeof createFuelLogBody>;

export const updateFuelLogBody = z
  .object(fuelLogFields)
  .partial()
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'Provide at least one field to change' });
export type UpdateFuelLogBody = z.infer<typeof updateFuelLogBody>;

const dateRange = <T extends { from?: string; to?: string }>(q: T) => !q.from || !q.to || q.from <= q.to;
const rangeMessage = { message: 'The start date must not be after the end date', path: ['from'] };

/** GET /school/fuel-logs — filters, sort, page, `format=csv`. */
export const fuelLogListQuery = withPeriod(z
  .object({
    ...listQueryShape,
    ...periodShape,
    format: csvOnly,
    busId: optionalUuid(),
    fuelType: queryEnumList([...FUEL_TYPES]),
    from: optionalDate(),
    to: optionalDate(),
    /** true → only logs with an odometer flag (below_previous / above_next). */
    flagged: queryBool(),
    hasBill: queryBool(),
  })
  .refine(dateRange, rangeMessage));
export type FuelLogListQuery = z.infer<typeof fuelLogListQuery>;

/** GET /school/fuel-logs/mileage-trend — one bus, fill by fill and per month. */
export const mileageTrendQuery = z.object({ busId: uuid(), from: optionalDate(), to: optionalDate() }).refine(dateRange, rangeMessage);
export type MileageTrendQuery = z.infer<typeof mileageTrendQuery>;

/** GET /school/fuel-logs/mileage-summary — one row per bus with fuel logs in the period. */
export const mileageSummaryQuery = z.object({ format: csvOnly, from: optionalDate(), to: optionalDate(), q: listQueryShape.q }).refine(dateRange, rangeMessage);
export type MileageSummaryQuery = z.infer<typeof mileageSummaryQuery>;

// ── responses ────────────────────────────────────────────────────────────────
export interface LogFileDto {
  id: string;
  fileName: string | null;
  contentType: string;
  sizeBytes: number | null;
  hasThumbnail: boolean;
}

export interface FuelLogDto {
  id: string;
  busId: string;
  busCode: string;
  busRegistrationNo: string;
  fuelDate: string;
  odometer: number | null;
  /** Quantity in `unit` (litres, kg for CNG, kWh for electric). */
  litres: number;
  cost: number;
  /** cost / quantity (price per `unit`), 2 decimals. */
  pricePerLitre: number;
  fuelType: FuelType | null;
  /** Unit of `litres`: from the log's fuel type, else the bus's. */
  unit: FuelUnit;
  station: string | null;
  notes: string | null;
  bill: LogFileDto | null;
  /**
   * km since the mileage base: the earlier fuel log of the bus with the highest reading (null for the
   * first reading, a fill without a reading, or a reading not above the base).
   */
  distanceKm: number | null;
  /** Litres of every fill after the base up to this one (fills without a reading included). */
  spanLitres: number | null;
  /** Cost of those fills. */
  spanCost: number | null;
  /** Fill-to-fill mileage: distanceKm / spanLitres. */
  kmPerLitre: number | null;
  /** spanCost / distanceKm. */
  costPerKm: number | null;
  odometerFlags: OdometerFlag[];
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

export type FuelLogWriteDto = FuelLogDto & { warnings: LogWarning[] };

export interface MileageTotals {
  fills: number;
  litres: number;
  cost: number;
  /** Sum of the fill-to-fill distances of the fills inside the period. */
  distanceKm: number;
  /** distanceKm / Σ spanLitres of the fills that have a distance. */
  kmPerLitre: number | null;
  /** Σ spanCost / distanceKm. */
  costPerKm: number | null;
  avgPricePerLitre: number | null;
}

export interface MileagePoint {
  fuelLogId: string;
  fuelDate: string;
  odometer: number | null;
  litres: number;
  cost: number;
  distanceKm: number | null;
  spanLitres: number | null;
  spanCost: number | null;
  kmPerLitre: number | null;
  costPerKm: number | null;
  odometerFlags: OdometerFlag[];
}

export interface MileageTrendDto {
  bus: { id: string; code: string; registrationNo: string; fuelType: FuelType | null; lastKnownOdometer: number | null };
  from: string | null;
  to: string | null;
  totals: MileageTotals;
  points: MileagePoint[];
  /** 'YYYY-MM' buckets in date order. */
  monthly: (MileageTotals & { month: string })[];
}

export interface MileageSummaryRow extends MileageTotals {
  busId: string;
  busCode: string;
  registrationNo: string;
  fuelType: FuelType | null;
  firstFuelDate: string;
  lastFuelDate: string;
  flaggedLogs: number;
}
