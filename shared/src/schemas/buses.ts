// Buses module schemas (BP §6.2 fleet, §8.3 Buses + Bus documents, §13.3 Buses). Shared by the
// backend validators and the web admin forms. Unknown keys (e.g. school_id) are stripped.
import { z } from 'zod';
import { ASSIGNMENT_ROLES, BUS_DOCUMENT_TYPES, BUS_STATUSES, FUEL_TYPES, VERIFICATION_STATUSES, type AssignmentRole, type BusDocumentType, type BusStatus, type FuelType, type VerificationStatus } from '../enums.js';
import { exportFormat, isoDate, isoDateTime, listQueryShape, optionalText, queryBool, queryEnumList, text, uuid } from './common.js';

const emptyToUndefined = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? undefined : v);

export const VEHICLE_TYPES = ['bus', 'mini_bus', 'van', 'car', 'other'] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

/** Document expiry badge: `expiring` = expires within BUS_DOCUMENT_EXPIRING_DAYS (school-local days). */
export const BUS_DOCUMENT_EXPIRY_STATUSES = ['valid', 'expiring', 'expired', 'none'] as const;
export type BusDocumentExpiryStatus = (typeof BUS_DOCUMENT_EXPIRY_STATUSES)[number];
export const BUS_DOCUMENT_EXPIRING_DAYS = 30;

/** Images per bus (gallery in the admin panel and the parent app). */
export const MAX_BUS_IMAGES = 12;

/** Registration plate: upper-cased, spaces/hyphens/dots removed ('ka-01 ab 1234' → 'KA01AB1234'). */
export const registrationNo = () =>
  z
    .string({ required_error: 'Required', invalid_type_error: 'Must be text' })
    .transform((s) => s.toUpperCase().replace(/[\s.\-]+/g, ''))
    .pipe(z.string().regex(/^[A-Z0-9]{4,20}$/, 'Must be 4–20 letters or digits (spaces and hyphens are ignored)'));

const nullableEnum = <T extends [string, ...string[]]>(values: T) => z.preprocess((v) => (v === '' ? null : v), z.enum(values).nullable().optional());
const nullableInt = (min: number, max: number) => z.preprocess((v) => (v === '' ? null : v), z.number({ invalid_type_error: 'Must be a number' }).int().min(min).max(max).nullable().optional());
const odometer = () => z.number({ invalid_type_error: 'Must be a number' }).finite().min(0).max(9_999_999.9);

const busFields = {
  code: text(40),
  displayName: optionalText(120),
  vehicleType: nullableEnum([...VEHICLE_TYPES]),
  makeModel: optionalText(120),
  manufactureYear: nullableInt(1980, 2100),
  color: optionalText(40),
  capacity: nullableInt(1, 200),
  registrationNo: registrationNo(),
  fuelType: nullableEnum([...FUEL_TYPES]),
  status: z.enum(BUS_STATUSES).optional(),
  /** Initial or corrected odometer reading (km); trips keep it current afterwards. */
  lastKnownOdometer: odometer().nullable().optional(),
  notes: optionalText(2000),
};

export const createBusBody = z.object(busFields);
export type CreateBusBody = z.infer<typeof createBusBody>;

export const updateBusBody = z
  .object(busFields)
  .partial()
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'Provide at least one field to change' });
export type UpdateBusBody = z.infer<typeof updateBusBody>;

export const busStatusBody = z.object({ status: z.enum(BUS_STATUSES), reason: optionalText(500) });
export type BusStatusBody = z.infer<typeof busStatusBody>;

export const busListQuery = z.object({
  ...listQueryShape,
  format: exportFormat.refine((f) => f !== 'pdf', 'Supported formats: json, csv'),
  status: queryEnumList([...BUS_STATUSES]),
  fuelType: queryEnumList([...FUEL_TYPES]),
  vehicleType: queryEnumList([...VEHICLE_TYPES]),
  /** true → buses with an open primary driver assignment; false → buses without one. */
  hasPrimaryDriver: queryBool(),
  /** Buses with at least one current document in that expiry state. */
  documentStatus: z.preprocess(emptyToUndefined, z.enum(['expired', 'expiring']).optional()),
});
export type BusListQuery = z.infer<typeof busListQuery>;

// ── staff assignment ─────────────────────────────────────────────────────────
/** Body key per assignment role (null closes the open assignment, an id replaces it). */
export const ASSIGNMENT_ROLE_KEYS = {
  primaryDriverId: 'primary_driver',
  backupDriverId: 'backup_driver',
  conductorId: 'conductor',
  backupConductorId: 'backup_conductor',
} as const satisfies Record<string, AssignmentRole>;
export type AssignmentRoleKey = keyof typeof ASSIGNMENT_ROLE_KEYS;

const staffRef = () => z.preprocess((v) => (v === '' ? null : v), uuid().nullable().optional());

export const assignStaffBody = z
  .object({
    primaryDriverId: staffRef(),
    backupDriverId: staffRef(),
    conductorId: staffRef(),
    backupConductorId: staffRef(),
    /** When the change takes effect (default now; never in the future). */
    effectiveFrom: isoDateTime().optional(),
    note: optionalText(500),
  })
  .superRefine((b, ctx) => {
    const keys = Object.keys(ASSIGNMENT_ROLE_KEYS) as AssignmentRoleKey[];
    if (keys.every((k) => b[k] === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide at least one of primaryDriverId, backupDriverId, conductorId, backupConductorId' });
    }
    const seen = new Map<string, AssignmentRoleKey>();
    for (const k of keys) {
      const id = b[k];
      if (!id) continue;
      if (seen.has(id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [k], message: `The same staff member is already given as ${seen.get(id)}` });
      else seen.set(id, k);
    }
  });
export type AssignStaffBody = z.infer<typeof assignStaffBody>;

export const assignmentHistoryQuery = z.object({
  page: listQueryShape.page,
  limit: listQueryShape.limit,
  sort: listQueryShape.sort,
  format: exportFormat.refine((f) => f !== 'pdf', 'Supported formats: json, csv'),
  role: queryEnumList([...ASSIGNMENT_ROLES]),
  staffId: z.preprocess(emptyToUndefined, uuid().optional()),
  /** true → open assignments only; false → closed ones only. */
  current: queryBool(),
});
export type AssignmentHistoryQuery = z.infer<typeof assignmentHistoryQuery>;

// ── images ───────────────────────────────────────────────────────────────────
const sortOrder = () => z.number({ invalid_type_error: 'Must be a number' }).int().min(0).max(10_000);

export const addBusImageBody = z.object({ fileId: uuid(), caption: optionalText(200), sortOrder: sortOrder().optional() });
export type AddBusImageBody = z.infer<typeof addBusImageBody>;

export const updateBusImageBody = z
  .object({ caption: optionalText(200), sortOrder: sortOrder().optional() })
  .refine((b) => b.caption !== undefined || b.sortOrder !== undefined, { message: 'Provide caption or sortOrder' });
export type UpdateBusImageBody = z.infer<typeof updateBusImageBody>;

export const reorderBusImagesBody = z.object({
  imageIds: z
    .array(uuid())
    .min(1)
    .max(MAX_BUS_IMAGES)
    .refine((ids) => new Set(ids).size === ids.length, 'Image ids must be distinct'),
});
export type ReorderBusImagesBody = z.infer<typeof reorderBusImagesBody>;

// ── documents ────────────────────────────────────────────────────────────────
const nullableDate = () => z.preprocess((v) => (v === '' ? null : v), isoDate().nullable().optional());
const datesInOrder = (b: { startDate?: string | null; expiryDate?: string | null }) => !b.startDate || !b.expiryDate || b.expiryDate >= b.startDate;
const DATES_MESSAGE = { message: 'The expiry date cannot be before the start date', path: ['expiryDate'] };

const documentFields = {
  title: optionalText(200),
  issuer: optionalText(200),
  docNumber: optionalText(100),
  startDate: nullableDate(),
  expiryDate: nullableDate(),
  /** A file uploaded with category bus_document for this bus (POST /files/upload or /files/upload-url). */
  fileId: z.preprocess((v) => (v === '' ? null : v), uuid().nullable().optional()),
  /** Parents may see the validity (status + expiry date). Default true. */
  visibleToParentsStatus: z.boolean().optional(),
  /** Parents may open the file. Default false. */
  visibleToParentsFile: z.boolean().optional(),
};

export const createBusDocumentBody = z.object({ docType: z.enum(BUS_DOCUMENT_TYPES), ...documentFields }).refine(datesInOrder, DATES_MESSAGE);
export type CreateBusDocumentBody = z.infer<typeof createBusDocumentBody>;

/** PUT /school/bus-documents/:docId — a new current version; the old one stays as history. */
export const replaceBusDocumentBody = z.object(documentFields).refine(datesInOrder, DATES_MESSAGE);
export type ReplaceBusDocumentBody = z.infer<typeof replaceBusDocumentBody>;

/** PATCH /school/bus-documents/:docId — corrects metadata of the same version (no new file). */
export const updateBusDocumentBody = z
  .object({ title: documentFields.title, issuer: documentFields.issuer, docNumber: documentFields.docNumber, startDate: documentFields.startDate, expiryDate: documentFields.expiryDate })
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'Provide at least one field to change' })
  .refine(datesInOrder, DATES_MESSAGE);
export type UpdateBusDocumentBody = z.infer<typeof updateBusDocumentBody>;

export const busDocumentVisibilityBody = z
  .object({ visibleToParentsStatus: z.boolean().optional(), visibleToParentsFile: z.boolean().optional() })
  .refine((b) => b.visibleToParentsStatus !== undefined || b.visibleToParentsFile !== undefined, { message: 'Provide visibleToParentsStatus or visibleToParentsFile' });
export type BusDocumentVisibilityBody = z.infer<typeof busDocumentVisibilityBody>;

export const verifyBusDocumentBody = z
  .object({ status: z.enum(VERIFICATION_STATUSES), note: optionalText(500) })
  .refine((b) => b.status !== 'rejected' || Boolean(b.note), { message: 'A note is required when rejecting a document', path: ['note'] });
export type VerifyBusDocumentBody = z.infer<typeof verifyBusDocumentBody>;

export const busDocumentsQuery = z.object({
  docType: queryEnumList([...BUS_DOCUMENT_TYPES]),
  /** Include replaced (non-current) versions. */
  includeHistory: queryBool(),
});
export type BusDocumentsQuery = z.infer<typeof busDocumentsQuery>;

// ── response DTOs ────────────────────────────────────────────────────────────
export interface BusStaffRef {
  assignmentId: string;
  staffId: string;
  fullName: string;
  phone: string | null;
  validFrom: string;
}

export interface BusCurrentStaff {
  primaryDriver: BusStaffRef | null;
  backupDriver: BusStaffRef | null;
  conductor: BusStaffRef | null;
  backupConductor: BusStaffRef | null;
}

export interface BusListItem {
  id: string;
  code: string;
  displayName: string | null;
  vehicleType: VehicleType | null;
  makeModel: string | null;
  manufactureYear: number | null;
  color: string | null;
  capacity: number | null;
  registrationNo: string;
  fuelType: FuelType | null;
  status: BusStatus;
  lastKnownOdometer: number | null;
  odometerUpdatedAt: string | null;
  notes: string | null;
  primaryDriverName: string | null;
  conductorName: string | null;
  imageCount: number;
  coverThumbnailUrl: string | null;
  expiredDocuments: number;
  expiringDocuments: number;
  hasActiveTrip: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BusImageDto {
  id: string;
  busId: string;
  fileId: string;
  caption: string | null;
  sortOrder: number;
  contentType: string | null;
  url: string | null;
  thumbnailUrl: string | null;
  createdAt: string;
}

export interface BusDocumentDto {
  id: string;
  busId: string;
  docType: BusDocumentType;
  title: string | null;
  issuer: string | null;
  docNumber: string | null;
  startDate: string | null;
  expiryDate: string | null;
  expiryStatus: BusDocumentExpiryStatus;
  daysToExpiry: number | null;
  file: { id: string; fileName: string | null; contentType: string; sizeBytes: number | null; hasThumbnail: boolean } | null;
  verificationStatus: VerificationStatus;
  verifiedBy: string | null;
  verifiedByName: string | null;
  verifiedAt: string | null;
  verificationNote: string | null;
  visibleToParentsStatus: boolean;
  visibleToParentsFile: boolean;
  isCurrent: boolean;
  replacedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BusDetail extends BusListItem {
  images: BusImageDto[];
  staff: BusCurrentStaff;
  documents: BusDocumentDto[];
  activeTripId: string | null;
}

export interface BusAssignmentHistoryItem {
  id: string;
  role: AssignmentRole;
  staffId: string;
  staffName: string;
  staffType: 'driver' | 'conductor';
  validFrom: string;
  validTo: string | null;
  isCurrent: boolean;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
}
