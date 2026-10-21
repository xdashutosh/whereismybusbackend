// Row → JSON mappers of the buses module (DB snake_case → API camelCase, contract §5). Storage
// keys never leave the server: images carry short-lived signed URLs, documents a file reference
// that clients resolve through GET /files/:id/url.
import type {
  AssignmentRole,
  BusAssignmentHistoryItem,
  BusCurrentStaff,
  BusDocumentDto,
  BusDocumentExpiryStatus,
  BusDocumentType,
  BusImageDto,
  BusListItem,
  BusStaffRef,
  BusStatus,
  FuelType,
  VehicleType,
  VerificationStatus,
} from '@wimb/shared';
import type { BusListRow } from './repository.js';

export function toBusListItem(r: BusListRow, coverThumbnailUrl: string | null): BusListItem {
  return {
    id: r.id,
    code: r.code,
    displayName: r.display_name,
    vehicleType: r.vehicle_type as VehicleType | null,
    makeModel: r.make_model,
    manufactureYear: r.manufacture_year,
    color: r.color,
    capacity: r.capacity,
    registrationNo: r.registration_no,
    fuelType: r.fuel_type as FuelType | null,
    status: r.status as BusStatus,
    lastKnownOdometer: r.last_known_odometer,
    odometerUpdatedAt: r.odometer_updated_at,
    notes: r.notes,
    primaryDriverName: r.primary_driver_name,
    conductorName: r.conductor_name,
    imageCount: r.image_count ?? 0,
    coverThumbnailUrl,
    expiredDocuments: r.expired_documents ?? 0,
    expiringDocuments: r.expiring_documents ?? 0,
    hasActiveTrip: r.active_trip_id !== null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Audit snapshot of a bus (plain columns only). */
export function busAuditView(r: Record<string, unknown>) {
  return {
    code: r.code,
    displayName: r.display_name,
    vehicleType: r.vehicle_type,
    makeModel: r.make_model,
    manufactureYear: r.manufacture_year,
    color: r.color,
    capacity: r.capacity,
    registrationNo: r.registration_no,
    fuelType: r.fuel_type,
    status: r.status,
    lastKnownOdometer: r.last_known_odometer,
    notes: r.notes,
  };
}

export interface BusImageRow extends Record<string, unknown> {
  id: string;
  bus_id: string;
  file_id: string;
  caption: string | null;
  sort_order: number;
  created_at: string;
  file_key: string | null;
  file_thumb_key: string | null;
  file_mime: string | null;
}

export function toImageDto(r: BusImageRow, urls: { url: string | null; thumbnailUrl: string | null }): BusImageDto {
  return {
    id: r.id,
    busId: r.bus_id,
    fileId: r.file_id,
    caption: r.caption,
    sortOrder: r.sort_order,
    contentType: r.file_mime,
    url: urls.url,
    thumbnailUrl: urls.thumbnailUrl,
    createdAt: r.created_at,
  };
}

export interface BusDocumentRow extends Record<string, unknown> {
  id: string;
  bus_id: string;
  doc_type: string;
  title: string | null;
  issuer: string | null;
  doc_number: string | null;
  start_date: string | null;
  expiry_date: string | null;
  file_id: string | null;
  verification_status: string;
  verified_by: string | null;
  verified_by_name: string | null;
  verified_at: string | null;
  verification_note: string | null;
  visible_to_parents_status: boolean;
  visible_to_parents_file: boolean;
  is_current: boolean;
  replaced_by: string | null;
  created_at: string;
  updated_at: string;
  expiry_status: string;
  days_to_expiry: number | null;
  file_name: string | null;
  file_mime: string | null;
  file_size: number | null;
  file_has_thumb: boolean | null;
}

export function toDocumentDto(r: BusDocumentRow): BusDocumentDto {
  return {
    id: r.id,
    busId: r.bus_id,
    docType: r.doc_type as BusDocumentType,
    title: r.title,
    issuer: r.issuer,
    docNumber: r.doc_number,
    startDate: r.start_date,
    expiryDate: r.expiry_date,
    expiryStatus: r.expiry_status as BusDocumentExpiryStatus,
    daysToExpiry: r.days_to_expiry,
    file: r.file_id
      ? { id: r.file_id, fileName: r.file_name, contentType: r.file_mime ?? 'application/octet-stream', sizeBytes: r.file_size, hasThumbnail: Boolean(r.file_has_thumb) }
      : null,
    verificationStatus: r.verification_status as VerificationStatus,
    verifiedBy: r.verified_by,
    verifiedByName: r.verified_by_name,
    verifiedAt: r.verified_at,
    verificationNote: r.verification_note,
    visibleToParentsStatus: r.visible_to_parents_status,
    visibleToParentsFile: r.visible_to_parents_file,
    isCurrent: r.is_current,
    replacedBy: r.replaced_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Audit snapshot of a document (no file key, no joined names). */
export function documentAuditView(r: BusDocumentRow | Record<string, unknown>) {
  return {
    busId: r.bus_id,
    docType: r.doc_type,
    title: r.title,
    issuer: r.issuer,
    docNumber: r.doc_number,
    startDate: r.start_date,
    expiryDate: r.expiry_date,
    fileId: r.file_id,
    verificationStatus: r.verification_status,
    visibleToParentsStatus: r.visible_to_parents_status,
    visibleToParentsFile: r.visible_to_parents_file,
    isCurrent: r.is_current,
    replacedBy: r.replaced_by,
  };
}

export interface AssignmentRow extends Record<string, unknown> {
  id: string;
  assignment_role: string;
  staff_id: string;
  staff_name: string;
  staff_phone: string | null;
  staff_type: string;
  valid_from: string;
  valid_to: string | null;
  is_current: boolean;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
}

const STAFF_SLOT: Record<AssignmentRole, keyof BusCurrentStaff> = {
  primary_driver: 'primaryDriver',
  backup_driver: 'backupDriver',
  conductor: 'conductor',
  backup_conductor: 'backupConductor',
};

/** Current assignments → one slot per role. */
export function toCurrentStaff(rows: AssignmentRow[]): BusCurrentStaff {
  const out: BusCurrentStaff = { primaryDriver: null, backupDriver: null, conductor: null, backupConductor: null };
  for (const r of rows) {
    const ref: BusStaffRef = { assignmentId: r.id, staffId: r.staff_id, fullName: r.staff_name, phone: r.staff_phone, validFrom: r.valid_from };
    out[STAFF_SLOT[r.assignment_role as AssignmentRole]] ??= ref;
  }
  return out;
}

export function toHistoryItem(r: AssignmentRow): BusAssignmentHistoryItem {
  return {
    id: r.id,
    role: r.assignment_role as AssignmentRole,
    staffId: r.staff_id,
    staffName: r.staff_name,
    staffType: r.staff_type as 'driver' | 'conductor',
    validFrom: r.valid_from,
    validTo: r.valid_to,
    isCurrent: r.is_current,
    createdBy: r.created_by,
    createdByName: r.created_by_name,
    createdAt: r.created_at,
  };
}
