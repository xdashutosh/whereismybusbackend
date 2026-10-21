// Reports and dashboard schemas and DTOs (BP §8.3 Reports + Dashboard, §13.3 Dashboard / Reports;
// contract §2 Reports, §5 `?format=json|csv|pdf`).
//   GET /school/reports/{kind}?from&to&busId&format   bus-level reports (one aggregate query each)
//   GET /school/dashboard                             today's operations for the school
import { z } from 'zod';
import type { AlertSeverity, AlertStatus, AlertType } from '../enums.js';
import { exportFormat, isoDate, periodShape, uuid, withPeriod } from './common.js';
import type { FuelUnit } from './fuel.js';

const emptyToUndefined = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? undefined : v);

/** Report kinds = the path segment of GET /school/reports/{kind}. */
export const REPORT_KINDS = ['bus-distance', 'fuel', 'maintenance', 'cost-per-km', 'service-due', 'non-school-usage', 'trip-summary'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/** Longest accepted date range (inclusive days). */
export const REPORT_MAX_RANGE_DAYS = 366;
/** Days covered when neither `from` nor `to` is given (ending school-local today). */
export const REPORT_DEFAULT_RANGE_DAYS = 30;

const dayNumber = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) / 86_400_000;

/**
 * Query of every report. `from` / `to` are school-local calendar days (inclusive). Defaults: `to` =
 * school-local today, `from` = `to` − 29 days (service-due: no date filter unless one is given).
 */
export const reportQuery = withPeriod(z
  .object({
    ...periodShape,
    from: z.preprocess(emptyToUndefined, isoDate().optional()),
    to: z.preprocess(emptyToUndefined, isoDate().optional()),
    busId: z.preprocess(emptyToUndefined, uuid().optional()),
    format: exportFormat,
  })
  .superRefine((q, ctx) => {
    if (!q.from || !q.to) return;
    const span = dayNumber(q.to) - dayNumber(q.from);
    if (span < 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['from'], message: 'from must be on or before to' });
    else if (span + 1 > REPORT_MAX_RANGE_DAYS) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: `The date range may cover at most ${REPORT_MAX_RANGE_DAYS} days` });
  }));
export type ReportQuery = z.infer<typeof reportQuery>;

// ── report DTOs ──────────────────────────────────────────────────────────────
/** How a column's values are typed (CSV/PDF formatting, web alignment). */
export type ReportColumnType = 'text' | 'int' | 'decimal' | 'money' | 'km' | 'percent' | 'date' | 'datetime' | 'list';

export interface ReportColumn {
  key: string;
  label: string;
  type: ReportColumnType;
}

export interface BusDistanceRow {
  busId: string;
  busCode: string;
  registrationNo: string | null;
  busStatus: string;
  busDeleted: boolean;
  trips: number;
  schoolTrips: number;
  nonSchoolTrips: number;
  activeDays: number;
  odometerKm: number;
  gpsKm: number;
  distanceKm: number;
  avgKmPerTrip: number | null;
  firstTripDate: string | null;
  lastTripDate: string | null;
}

/** Where the fuel / cost-per-km distance comes from: fuel-log odometer readings, or trips (fallback). */
export type ReportDistanceSource = 'odometer' | 'trips';

export interface FuelRow {
  busId: string;
  busCode: string;
  registrationNo: string | null;
  fuelType: string | null;
  busDeleted: boolean;
  fills: number;
  /** Quantity units of the bus's fills in the range (FUEL_UNITS order; empty without fills). */
  units: FuelUnit[];
  /** Quantity per unit — never added across units: litres, kg (CNG), kWh (electric). */
  litres: number;
  kg: number;
  kwh: number;
  /** Cost of the fills in each unit. */
  litresCost: number;
  kgCost: number;
  kwhCost: number;
  cost: number;
  /** cost / quantity when the fills use one unit (price per that unit), else null. */
  avgPricePerUnit: number | null;
  /** Odometer km between fills (fill-to-fill, the Fuel page mileage method); null when no fill of the range has a distance. */
  odometerKm: number | null;
  /** Distance of the bus's trips that ran in the range. */
  tripKm: number;
  /** Distance the ratios use: odometerKm, else tripKm. */
  distanceKm: number;
  distanceSource: ReportDistanceSource | null;
  /** Fuel burnt over distanceKm: span quantity / cost of the odometer fills, else every fill of the range. */
  kmQuantity: number | null;
  kmCost: number | null;
  /** distanceKm / kmQuantity when the fills use one unit (km per that unit), else null. */
  kmPerUnit: number | null;
  /** kmCost / distanceKm — comparable across fuel types. */
  fuelCostPerKm: number | null;
  lastFillDate: string | null;
}

export interface MaintenanceRow {
  busId: string;
  busCode: string;
  registrationNo: string | null;
  busDeleted: boolean;
  services: number;
  totalCost: number;
  avgCost: number | null;
  unpricedServices: number;
  serviceTypes: string[];
  lastServiceDate: string | null;
  lastServiceType: string | null;
  nextDueDate: string | null;
}

export interface CostPerKmRow {
  busId: string;
  busCode: string;
  registrationNo: string | null;
  busDeleted: boolean;
  /** Same distance columns as FuelRow. */
  odometerKm: number | null;
  tripKm: number;
  distanceKm: number;
  distanceSource: ReportDistanceSource | null;
  kmQuantity: number | null;
  /** Fuel cost over distanceKm (fuelCostPerKm = kmCost / distanceKm). */
  kmCost: number | null;
  fuelCost: number;
  maintenanceCost: number;
  totalCost: number;
  fuelCostPerKm: number | null;
  maintenanceCostPerKm: number | null;
  costPerKm: number | null;
}

export type ServiceDueStatus = 'overdue' | 'due_soon' | 'scheduled';

export interface ServiceDueRow {
  maintenanceLogId: string;
  busId: string;
  busCode: string;
  registrationNo: string | null;
  serviceType: string;
  lastServiceDate: string;
  lastServiceOdometer: number | null;
  vendor: string | null;
  nextDueDate: string | null;
  daysToDue: number | null;
  nextDueKm: number | null;
  currentOdometer: number | null;
  kmToDue: number | null;
  status: ServiceDueStatus;
  /** What makes it due: the date, the odometer, or null while only scheduled. */
  dueBy: 'date' | 'km' | null;
}

export interface NonSchoolUsageRow {
  tripId: string;
  tripDate: string;
  busId: string;
  busCode: string | null;
  registrationNo: string | null;
  driverName: string | null;
  conductorName: string | null;
  purpose: string | null;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMin: number | null;
  startOdometer: number | null;
  endOdometer: number | null;
  distanceKm: number | null;
  alerts: number;
}

export interface TripSummaryRow {
  busId: string;
  busCode: string;
  registrationNo: string | null;
  busDeleted: boolean;
  trips: number;
  schoolTrips: number;
  completed: number;
  autoClosed: number;
  missed: number;
  cancelled: number;
  inProgress: number;
  scheduled: number;
  nonSchoolTrips: number;
  onTimeStarts: number;
  lateStarts: number;
  avgStartDelayMin: number | null;
  completionRatePct: number | null;
  distanceKm: number;
  alerts: number;
}

export interface ReportRowMap {
  'bus-distance': BusDistanceRow;
  fuel: FuelRow;
  maintenance: MaintenanceRow;
  'cost-per-km': CostPerKmRow;
  'service-due': ServiceDueRow;
  'non-school-usage': NonSchoolUsageRow;
  'trip-summary': TripSummaryRow;
}

/** JSON body (`data`) of GET /school/reports/{kind}. */
export interface ReportResponse<K extends ReportKind = ReportKind> {
  report: K;
  title: string;
  /** School-local calendar days actually covered (service-due: null bounds when not filtered). */
  range: { from: string | null; to: string | null };
  busId: string | null;
  timezone: string;
  generatedAt: string;
  columns: ReportColumn[];
  rows: ReportRowMap[K][];
  /** Column key → total (sums; ratios recomputed from the sums). Only columns that have a total. */
  totals: Record<string, number | null>;
  /** True when the row cap (10 000) cut the result. */
  truncated: boolean;
}

// ── dashboard ────────────────────────────────────────────────────────────────
/** Alert types grouped on the dashboard tiles (BP §13.3 Dashboard). */
export const DASHBOARD_ALERT_GROUPS = {
  expiry: ['doc_expiring', 'doc_expired', 'doc_missing'],
  odometer: ['odometer_gap', 'odometer_decrease', 'odometer_gps_mismatch'],
  safety: ['speeding', 'harsh_driving', 'route_deviation', 'long_stop'],
  tripOps: ['trip_not_started', 'trip_auto_closed', 'gps_disabled', 'low_battery', 'no_network', 'non_school_trip', 'location_permission', 'clock_drift'],
  service: ['service_due'],
} as const satisfies Record<string, readonly AlertType[]>;
export type DashboardAlertGroup = keyof typeof DASHBOARD_ALERT_GROUPS;

/** Days ahead counted as "expiring soon" for current documents on the dashboard. */
export const DASHBOARD_EXPIRY_WINDOW_DAYS = 30;
/** Days back of the "recent" alert counters (school-local days, today included). */
export const DASHBOARD_RECENT_DAYS = 7;

/** Counters of one alert group: unresolved (open + escalated), critical among them, raised recently. */
export interface DashboardAlertCounter {
  open: number;
  critical: number;
  recent: number;
}

export interface DashboardRecentAlert {
  id: string;
  alertType: AlertType;
  severity: AlertSeverity;
  status: AlertStatus;
  title: string;
  busId: string | null;
  busCode: string | null;
  createdAt: string;
}

export interface DashboardQuickLink {
  key: 'liveFleet' | 'trips' | 'alerts' | 'buses' | 'maintenance' | 'students' | 'reports';
  label: string;
  /** Web admin route. */
  path: string;
  count: number | null;
  /** Visual hint for the badge. */
  state: 'none' | 'information' | 'positive' | 'critical' | 'negative';
}

/** `data` of GET /school/dashboard. */
export interface SchoolDashboard {
  localDate: string;
  timezone: string;
  generatedAt: string;
  buses: { total: number; active: number; maintenance: number; inactive: number; retired: number; onTripNow: number };
  trips: {
    /** Trips in progress right now (any date). */
    activeNow: number;
    today: {
      total: number;
      /** Scheduled and not yet due (planned start + grace still ahead, or no planned start). */
      upcoming: number;
      /** Missed, or still scheduled past planned start + the school's grace minutes. */
      notStarted: number;
      inProgress: number;
      completed: number;
      autoClosed: number;
      cancelled: number;
      nonSchool: number;
    };
  };
  alerts: {
    /** All unresolved alerts (open + escalated). */
    open: number;
    critical: number;
    byGroup: Record<DashboardAlertGroup, DashboardAlertCounter>;
    latest: DashboardRecentAlert[];
  };
  documents: { expired: number; expiringSoon: number; windowDays: number };
  odometer: { discrepancyTripsRecent: number; recentDays: number };
  people: { students: number; unassignedStudents: number; drivers: number; conductors: number; parents: number };
  quickLinks: DashboardQuickLink[];
}
