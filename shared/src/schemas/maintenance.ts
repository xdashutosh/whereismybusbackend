// Maintenance module schemas and DTOs (BP §6.2 maintenance_logs, §7.3 maintenance-due-scan, §8.3
// Fuel/Maintenance, §13.3 Maintenance: log, invoice, next due, due list). Shared by the backend
// validators and the web admin. Unknown keys (e.g. school_id) are stripped.
import { z } from 'zod';
import { exportFormat, isoDate, listQueryShape, optionalText, periodShape, queryBool, queryEnumList, text, uuid, withPeriod } from './common.js';
import { moneyAmount, logOdometer, type LogFileDto, type LogWarning, type OdometerFlag } from './fuel.js';

const emptyToUndefined = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const csvOnly = exportFormat.refine((f) => f !== 'pdf', 'Supported formats: json, csv');
const optionalDate = () => z.preprocess(emptyToUndefined, isoDate().optional());

/** Suggested service types for the web form (free text up to 100 characters is accepted). */
export const MAINTENANCE_SERVICE_TYPES = [
  'Oil change',
  'General service',
  'Brake inspection',
  'Tyre replacement',
  'Tyre rotation',
  'Battery replacement',
  'Air filter',
  'Coolant flush',
  'Clutch overhaul',
  'Wheel alignment',
  'AC service',
  'Body repair',
  'Fire extinguisher refill',
  'Speed governor calibration',
  'GPS device check',
] as const;

/**
 * Due state of a log (the same rules as maintenance-due-scan, BP §7.3; the lead window is
 * SERVICE_DUE_LEAD_DAYS / SERVICE_DUE_LEAD_KM from the alerts schemas):
 *   completed  a newer log of the same bus and service type exists (the service was done again)
 *   overdue    next due date before today, or the bus odometer ≥ next due km
 *   due_soon   next due date within the lead days, or the bus odometer within the lead km
 *   scheduled  next due date / km set, further away
 *   none       no next due date or km
 */
export const MAINTENANCE_DUE_STATUSES = ['overdue', 'due_soon', 'scheduled', 'completed', 'none'] as const;
export type MaintenanceDueStatus = (typeof MAINTENANCE_DUE_STATUSES)[number];
/** Statuses the due list can show (latest log per bus + service type, buses in service). */
export const DUE_LIST_STATUSES = ['overdue', 'due_soon', 'scheduled'] as const;
export type DueListStatus = (typeof DUE_LIST_STATUSES)[number];

// ── requests ─────────────────────────────────────────────────────────────────
const maintenanceLogFields = {
  busId: uuid(),
  serviceType: text(100),
  /** School-local calendar day of the service; never in the future. */
  serviceDate: isoDate(),
  cost: moneyAmount().nullable().optional(),
  odometer: logOdometer().nullable().optional(),
  vendor: optionalText(200),
  notes: optionalText(2000),
  /** files.id of an uploaded `maintenance_invoice` (entity: the bus, or this log); null removes it. */
  invoiceFileId: uuid().nullable().optional(),
  /** Must be after the service date. */
  nextDueDate: isoDate().nullable().optional(),
  /** Must be above the odometer reading of this service. */
  nextDueKm: logOdometer().nullable().optional(),
};

const dueAfterService = (b: { serviceDate?: string; nextDueDate?: string | null }) => !b.serviceDate || !b.nextDueDate || b.nextDueDate > b.serviceDate;
const dueKmAboveOdometer = (b: { odometer?: number | null; nextDueKm?: number | null }) => b.odometer == null || b.nextDueKm == null || b.nextDueKm > b.odometer;
const dueDateMessage = { message: 'The next due date must be after the service date', path: ['nextDueDate'] };
const dueKmMessage = { message: 'The next due km must be above the odometer reading', path: ['nextDueKm'] };

export const createMaintenanceLogBody = z.object(maintenanceLogFields).refine(dueAfterService, dueDateMessage).refine(dueKmAboveOdometer, dueKmMessage);
export type CreateMaintenanceLogBody = z.infer<typeof createMaintenanceLogBody>;

/** Partial update; the date/km rules are re-checked against the stored values by the service. */
export const updateMaintenanceLogBody = z
  .object(maintenanceLogFields)
  .partial()
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'Provide at least one field to change' })
  .refine(dueAfterService, dueDateMessage)
  .refine(dueKmAboveOdometer, dueKmMessage);
export type UpdateMaintenanceLogBody = z.infer<typeof updateMaintenanceLogBody>;

const dateRange = <T extends { from?: string; to?: string }>(q: T) => !q.from || !q.to || q.from <= q.to;
const rangeMessage = { message: 'The start date must not be after the end date', path: ['from'] };

/** GET /school/maintenance-logs — filters, sort, page, `format=csv`. */
export const maintenanceLogListQuery = withPeriod(z
  .object({
    ...listQueryShape,
    ...periodShape,
    format: csvOnly,
    busId: z.preprocess(emptyToUndefined, uuid().optional()),
    /** Exact service type (case-insensitive); `q` searches type, vendor and notes. */
    serviceType: z.preprocess(emptyToUndefined, z.string().trim().max(100).optional()),
    dueStatus: queryEnumList([...MAINTENANCE_DUE_STATUSES]),
    from: optionalDate(),
    to: optionalDate(),
    flagged: queryBool(),
    hasInvoice: queryBool(),
  })
  .refine(dateRange, rangeMessage));
export type MaintenanceLogListQuery = z.infer<typeof maintenanceLogListQuery>;

/** GET /school/maintenance-logs/due — default status overdue + due_soon. */
export const maintenanceDueQuery = z.object({
  ...listQueryShape,
  format: csvOnly,
  status: queryEnumList([...DUE_LIST_STATUSES]),
  busId: z.preprocess(emptyToUndefined, uuid().optional()),
});
export type MaintenanceDueQuery = z.infer<typeof maintenanceDueQuery>;

// ── responses ────────────────────────────────────────────────────────────────
export interface MaintenanceLogDto {
  id: string;
  busId: string;
  busCode: string;
  busRegistrationNo: string;
  /** buses.last_known_odometer (drives the km rule). */
  busOdometer: number | null;
  serviceType: string;
  serviceDate: string;
  cost: number | null;
  odometer: number | null;
  vendor: string | null;
  notes: string | null;
  invoice: LogFileDto | null;
  nextDueDate: string | null;
  nextDueKm: number | null;
  dueStatus: MaintenanceDueStatus;
  /** Days from today (school-local) to nextDueDate; negative when overdue. */
  daysToDue: number | null;
  /** nextDueKm − bus odometer; negative when overdue. */
  kmToDue: number | null;
  odometerFlags: OdometerFlag[];
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

export type MaintenanceLogWriteDto = MaintenanceLogDto & { warnings: LogWarning[] };

export interface MaintenanceDueItem {
  maintenanceLogId: string;
  busId: string;
  busCode: string;
  registrationNo: string;
  busStatus: string;
  busOdometer: number | null;
  serviceType: string;
  lastServiceDate: string;
  lastServiceOdometer: number | null;
  vendor: string | null;
  nextDueDate: string | null;
  nextDueKm: number | null;
  daysToDue: number | null;
  kmToDue: number | null;
  status: DueListStatus;
  /** What makes it due: the date, the km reading, or neither (scheduled). */
  reason: 'date' | 'km' | null;
}
