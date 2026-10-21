// Row → JSON mappers of the staff module (DB snake_case → API camelCase, contract §5). Storage keys
// never leave the server (photos carry short-lived signed URLs, documents a file reference resolved
// through GET /files/:id/url). Identity numbers only ever appear masked from their last 4 characters.
import {
  maskIdProof,
  type AssignmentRole,
  type IdProofType,
  type StaffAssignmentItem,
  type StaffBusRef,
  type StaffDetail,
  type StaffDocumentDto,
  type StaffDocumentType,
  type StaffExpiryStatus,
  type StaffListItem,
  type StaffLoginDto,
  type StaffPhotoDto,
  type StaffType,
  type VerificationStatus,
} from '@wimb/shared';
import type { StaffAssignmentRow } from './assignmentsRepository.js';
import type { StaffDocumentRow } from './documentsRepository.js';
import type { StaffDetailRow, StaffListRow } from './repository.js';

const busRefs = (r: StaffListRow): StaffBusRef[] => (r.current_buses ?? []).map((b) => ({ busId: b.busId, busCode: b.busCode, role: b.role as AssignmentRole }));

export function toListItem(r: StaffListRow, photoThumbnailUrl: string | null): StaffListItem {
  return {
    id: r.id,
    staffType: r.staff_type as StaffType,
    fullName: r.full_name,
    phone: r.phone,
    email: r.email,
    photoFileId: r.photo_file_id,
    photoThumbnailUrl,
    joiningDate: r.joining_date,
    experienceYears: r.experience_years,
    idProofType: r.id_proof_type as IdProofType | null,
    idProofMasked: maskIdProof(r.id_proof_type as IdProofType | null, r.id_proof_last4),
    idVerificationStatus: r.id_verification_status as VerificationStatus,
    licenceNo: r.licence_no,
    licenceExpiryDate: r.licence_expiry_date,
    licenceStatus: r.licence_status as StaffExpiryStatus,
    licenceDaysToExpiry: r.licence_days_to_expiry,
    licenceVerificationStatus: r.licence_verification_status as VerificationStatus,
    isActive: r.is_active,
    hasLogin: r.user_id !== null,
    loginPhone: r.login_phone,
    loginUsername: r.login_username,
    currentBuses: busRefs(r),
    expiredDocuments: r.expired_documents ?? 0,
    expiringDocuments: r.expiring_documents ?? 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function toLoginDto(r: StaffDetailRow): StaffLoginDto | null {
  if (!r.user_id) return null;
  return {
    userId: r.user_id,
    phone: r.login_phone,
    username: r.login_username,
    hasPin: Boolean(r.login_has_pin),
    isActive: Boolean(r.login_active),
    mustChangePassword: Boolean(r.login_must_change_password),
    locked: Boolean(r.login_locked),
    lastLoginAt: r.login_last_login_at,
    passwordChangedAt: r.login_password_changed_at,
    activeSessions: r.login_active_sessions ?? 0,
  };
}

export function toAssignmentItem(r: StaffAssignmentRow): StaffAssignmentItem {
  return {
    id: r.id,
    busId: r.bus_id,
    busCode: r.bus_code,
    busName: r.bus_name,
    registrationNo: r.registration_no,
    role: r.assignment_role as AssignmentRole,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    isCurrent: r.is_current,
    createdBy: r.created_by,
    createdByName: r.created_by_name,
    createdAt: r.created_at,
  };
}

export function toDocumentDto(r: StaffDocumentRow): StaffDocumentDto {
  return {
    id: r.id,
    staffId: r.staff_id,
    docType: r.doc_type as StaffDocumentType,
    title: r.title,
    issuer: r.issuer,
    docNumber: r.doc_number,
    issueDate: r.issue_date,
    expiryDate: r.expiry_date,
    expiryStatus: r.expiry_status as StaffExpiryStatus,
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

export function toDetail(
  r: StaffDetailRow,
  extra: { photo: StaffPhotoDto | null; assignments: StaffAssignmentRow[]; documents: StaffDocumentRow[] },
): StaffDetail {
  return {
    ...toListItem(r, extra.photo?.thumbnailUrl ?? extra.photo?.url ?? null),
    address: r.address,
    experienceSummary: r.experience_summary,
    emergencyContactName: r.emergency_contact_name,
    emergencyContactPhone: r.emergency_contact_phone,
    idProofLast4: r.id_proof_last4,
    licenceRto: r.licence_rto,
    licenceIssueDate: r.licence_issue_date,
    photo: extra.photo,
    login: toLoginDto(r),
    currentAssignments: extra.assignments.map(toAssignmentItem),
    documents: extra.documents.map(toDocumentDto),
    activeTripId: r.active_trip_id,
    createdBy: r.created_by,
  };
}

/** Audit snapshot of a profile (no address/emergency details beyond presence, never a full id number). */
export function profileAuditView(d: StaffDetail) {
  return {
    staffType: d.staffType,
    fullName: d.fullName,
    phone: d.phone,
    email: d.email,
    hasAddress: d.address !== null,
    joiningDate: d.joiningDate,
    experienceYears: d.experienceYears,
    emergencyContactName: d.emergencyContactName,
    emergencyContactPhone: d.emergencyContactPhone,
    idProofType: d.idProofType,
    idProofMasked: d.idProofMasked,
    licenceNo: d.licenceNo,
    licenceRto: d.licenceRto,
    licenceIssueDate: d.licenceIssueDate,
    licenceExpiryDate: d.licenceExpiryDate,
    photoFileId: d.photoFileId,
    isActive: d.isActive,
  };
}

/** Audit snapshot of a document (no file key, no joined names). */
export function documentAuditView(r: StaffDocumentRow) {
  return {
    staffId: r.staff_id,
    docType: r.doc_type,
    title: r.title,
    issuer: r.issuer,
    docNumber: r.doc_number,
    issueDate: r.issue_date,
    expiryDate: r.expiry_date,
    fileId: r.file_id,
    verificationStatus: r.verification_status,
    visibleToParentsStatus: r.visible_to_parents_status,
    visibleToParentsFile: r.visible_to_parents_file,
    isCurrent: r.is_current,
    replacedBy: r.replaced_by,
  };
}
