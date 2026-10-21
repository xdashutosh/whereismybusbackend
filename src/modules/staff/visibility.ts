// Parent visibility of drivers and conductors (BP §13.3 parent-visibility matrix with live preview,
// §15 driver/conductor cards, §12 files, §16 data minimisation). The school matrix
// (school_settings.parent_visibility.driver|conductor) decides which fields parents see; each
// document additionally carries its own flags (visible_to_parents_status / _file). Never shown:
// address, emergency contacts, identity numbers or documents, licence numbers, login details.
// Document type → matrix flag:
//   licence_front/back   status: licenceValidity · file: licenceFile   (drivers only)
//   character_certificate  characterCertStatus (status and file)
//   police_verification    verification
//   training, first_aid, child_safety  training
//   other                  the document's own flags only
//   identity               never
// Verification: a document's validity (expiry date/status) and its file reach parents only when
// the document is current, not deleted and VERIFIED. A pending or rejected document whose status
// the flags allow stays on the card as "not verified": its verificationStatus, with no validity
// (expiryDate null, expiryStatus 'none') and no file. The licence summary follows the same rule:
// its validity needs a verified licence (profile status, held back while a current licence
// document is not verified — e.g. a renewal waiting for verification).
// RLS parent_scope (staff currently assigned to the child's buses, current non-identity documents
// with a parent flag, files attached to them) is the backstop for the parent API.
import {
  STAFF_DOCUMENT_EXPIRING_DAYS,
  type AssignmentRole,
  type ParentStaffCard,
  type ParentStaffDocument,
  type ParentStaffDocumentHiddenReason,
  type ParentVisibility,
  type StaffDocumentType,
  type StaffExpiryStatus,
  type StaffType,
  type VerificationStatus,
} from '@wimb/shared';
import type { Request } from 'express';
import type { Tx } from '../../db/tenant.js';
import { optionalSignedUrl } from '../files/urls.js';
import { loadParentVisibility } from '../school/index.js';
import * as documentsRepo from './documentsRepository.js';
import type { StaffDocumentRow } from './documentsRepository.js';

export type StaffMatrix = Record<string, boolean>;

/** The matrix section of a staff type (unknown flags read as false). */
export function sectionOf(matrix: ParentVisibility, staffType: StaffType): StaffMatrix {
  return { ...(matrix[staffType] as Record<string, boolean>) };
}

/** Current school's matrix section for a staff type. */
export async function loadStaffMatrix(tx: Tx, staffType: StaffType): Promise<StaffMatrix> {
  return sectionOf(await loadParentVisibility(tx), staffType);
}

const STATUS_FLAG: Partial<Record<StaffDocumentType, string>> = {
  licence_front: 'licenceValidity',
  licence_back: 'licenceValidity',
  character_certificate: 'characterCertStatus',
  police_verification: 'verification',
  training: 'training',
  first_aid: 'training',
  child_safety: 'training',
};
const FILE_FLAG: Partial<Record<StaffDocumentType, string>> = { ...STATUS_FLAG, licence_front: 'licenceFile', licence_back: 'licenceFile' };

/** What the parent rules read from a document row (repository rows never carry deleted documents). */
type DocFlags = Pick<StaffDocumentRow, 'doc_type' | 'visible_to_parents_status' | 'visible_to_parents_file' | 'file_id' | 'verification_status' | 'is_current'> & {
  deleted_at?: string | null;
};

const schoolAllows = (flags: Partial<Record<StaffDocumentType, string>>, m: StaffMatrix, docType: string): boolean => {
  if (docType === 'identity') return false;
  const flag = flags[docType as StaffDocumentType];
  return flag === undefined ? true : m[flag] === true;
};

/** Replaced versions, deleted documents and identity proofs never reach parents. */
const reachesParents = (d: DocFlags): boolean => d.doc_type !== 'identity' && d.is_current && !d.deleted_at;
const isVerified = (d: Pick<DocFlags, 'verification_status'>): boolean => d.verification_status === 'verified';

/** The matrix and the document's own flags allow its status line (whatever its verification). */
const statusAllowed = (m: StaffMatrix, d: DocFlags): boolean => reachesParents(d) && d.visible_to_parents_status && schoolAllows(STATUS_FLAG, m, d.doc_type);

/** May a parent see this document's status/validity? Only a current, not deleted, verified document. */
export function parentSeesStaffDocumentStatus(m: StaffMatrix, d: DocFlags): boolean {
  return statusAllowed(m, d) && isVerified(d);
}

/** Is this document on the parent card as "not verified" (pending/rejected: status only, no validity, no file)? */
export function parentSeesStaffDocumentAsNotVerified(m: StaffMatrix, d: DocFlags): boolean {
  return statusAllowed(m, d) && !isVerified(d);
}

/** May a parent open this document's file? Only a current, not deleted, verified document. */
export function parentSeesStaffDocumentFile(m: StaffMatrix, d: DocFlags): boolean {
  return reachesParents(d) && isVerified(d) && d.file_id !== null && d.visible_to_parents_file && schoolAllows(FILE_FLAG, m, d.doc_type);
}

/** Is this document on the parent card at all (with its validity, as not verified, or for its file)? */
export function parentSeesStaffDocument(m: StaffMatrix, d: DocFlags): boolean {
  return statusAllowed(m, d) || parentSeesStaffDocumentFile(m, d);
}

/** Why a current document is not on the parent card (null when it is shown). */
export function hiddenDocumentReason(m: StaffMatrix, d: DocFlags): ParentStaffDocumentHiddenReason | null {
  if (d.doc_type === 'identity') return 'IDENTITY';
  if (parentSeesStaffDocument(m, d)) return null;
  // The document offers its status, or a file the matrix hides → the school setting hides it.
  // A file the switches and the matrix offer (without the status) that is pending/rejected →
  // NOT_VERIFIED (files of unverified documents are never shown). Otherwise its own flags do.
  if (d.visible_to_parents_status) return 'SCHOOL_SETTING';
  if (d.visible_to_parents_file && d.file_id !== null) return schoolAllows(FILE_FLAG, m, d.doc_type) ? 'NOT_VERIFIED' : 'SCHOOL_SETTING';
  return 'DOCUMENT_FLAGS';
}

const LICENCE_DOCUMENT_TYPES: readonly string[] = ['licence_front', 'licence_back'];

/**
 * The driver's licence verification as parents see it: the profile status (set by verifying a
 * current licence side), held back while a current licence document is not verified — a renewal
 * waiting for verification never inherits the verdict on the version it replaced.
 */
function licenceVerification(p: Pick<ParentProfileRow, 'licence_verification_status'>, documents: DocFlags[]): VerificationStatus {
  const open = documents.filter((d) => d.is_current && !d.deleted_at && LICENCE_DOCUMENT_TYPES.includes(d.doc_type) && !isVerified(d));
  if (open.some((d) => d.verification_status === 'rejected')) return 'rejected';
  if (open.length) return 'pending';
  return p.licence_verification_status as VerificationStatus;
}

/** Profile columns a parent card may draw from (selected by parentProfile()). */
export interface ParentProfileRow extends Record<string, unknown> {
  id: string;
  staff_type: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  is_active: boolean;
  photo_file_id: string | null;
  photo_key: string | null;
  photo_thumb_key: string | null;
  joining_date: string | null;
  experience_years: number | null;
  experience_summary: string | null;
  licence_expiry_date: string | null;
  licence_status: string;
  licence_verification_status: string;
  id_verification_status: string;
}

const PROFILE_SQL = `select sp.id, sp.staff_type, sp.full_name, sp.phone, sp.email::text as email, sp.is_active, sp.photo_file_id,
    pf.key as photo_key, pf.thumb_key as photo_thumb_key, sp.joining_date, sp.experience_years, sp.experience_summary,
    sp.licence_expiry_date,
    case when sp.licence_expiry_date is null then 'none'
         when sp.licence_expiry_date < today.day then 'expired'
         when sp.licence_expiry_date <= today.day + ${Number(STAFF_DOCUMENT_EXPIRING_DAYS)} then 'expiring'
         else 'valid' end as licence_status,
    sp.licence_verification_status, sp.id_verification_status
  from staff_profiles sp
  cross join (select app_local_date() as day) today
  left join files pf on pf.id = sp.photo_file_id and pf.status = 'uploaded'`;

/** A live profile (RLS decides which ones the caller may read). */
export function parentProfile(tx: Tx, staffId: string): Promise<ParentProfileRow | null> {
  return tx.maybeOne<ParentProfileRow>(`${PROFILE_SQL} where sp.id = $1 and sp.deleted_at is null`, [staffId]);
}

/**
 * The card a parent sees for `profile` with the given matrix section and current documents (the
 * same function serves the parent API and the admin parent-preview, so both always agree).
 */
export async function buildParentCard(req: Request, p: ParentProfileRow, m: StaffMatrix, documents: StaffDocumentRow[]): Promise<ParentStaffCard> {
  const isDriver = p.staff_type === 'driver';
  const photo =
    m.photo && p.photo_file_id && p.photo_key
      ? { fileId: p.photo_file_id, url: await optionalSignedUrl(req, p.photo_key), thumbnailUrl: await optionalSignedUrl(req, p.photo_thumb_key) }
      : null;
  const police = documents.find((d) => d.is_current && d.doc_type === 'police_verification');
  const docs: ParentStaffDocument[] = documents
    .filter((d) => parentSeesStaffDocument(m, d))
    .map((d) => {
      // verified → status + validity; pending/rejected → "not verified" (status only); file only → no status
      const valid = parentSeesStaffDocumentStatus(m, d);
      return {
        docType: d.doc_type as StaffDocumentType,
        title: d.title,
        verificationStatus: valid || parentSeesStaffDocumentAsNotVerified(m, d) ? (d.verification_status as VerificationStatus) : null,
        expiryDate: valid ? d.expiry_date : null,
        expiryStatus: (valid ? d.expiry_status : 'none') as StaffExpiryStatus,
        fileId: parentSeesStaffDocumentFile(m, d) ? d.file_id : null,
      };
    });
  const licenceStatus = licenceVerification(p, documents);
  const licenceVerified = licenceStatus === 'verified';
  return {
    id: p.id,
    staffType: p.staff_type as StaffType,
    fullName: p.full_name,
    photo,
    phone: m.phone ? p.phone : null,
    email: m.email ? p.email : null,
    experience: m.experience ? { years: p.experience_years, summary: p.experience_summary, joiningDate: p.joining_date } : null,
    // Validity only for a verified licence; otherwise "not verified" (status without expiry).
    licence:
      isDriver && m.licenceValidity
        ? {
            expiryDate: licenceVerified ? p.licence_expiry_date : null,
            expiryStatus: (licenceVerified ? p.licence_status : 'none') as StaffExpiryStatus,
            verificationStatus: licenceStatus,
          }
        : null,
    verification: m.verification
      ? {
          identity: p.id_verification_status as VerificationStatus,
          policeVerification: police && police.visible_to_parents_status ? (police.verification_status as VerificationStatus) : null,
        }
      : null,
    documents: docs,
  };
}

/**
 * The card of one staff member as a parent sees it (for the parent module's
 * GET /parent/children/:studentId/staff). Must run in the parent's tenant context (X-School-Id
 * resolved): RLS returns null for staff not assigned to the parent's children's buses. Inactive
 * staff are never shown.
 */
export async function parentStaffCard(req: Request, tx: Tx, staffId: string): Promise<ParentStaffCard | null> {
  const p = await parentProfile(tx, staffId);
  if (!p || !p.is_active) return null;
  const m = await loadStaffMatrix(tx, p.staff_type as StaffType);
  return buildParentCard(req, p, m, await documentsRepo.listForStaff(tx, staffId));
}

const ROLE_ORDER: AssignmentRole[] = ['primary_driver', 'conductor', 'backup_driver', 'backup_conductor'];

/** Cards of the staff currently assigned to a bus (primary driver, conductor, backups), parent view. */
export async function parentStaffForBus(req: Request, tx: Tx, busId: string): Promise<(ParentStaffCard & { role: AssignmentRole })[]> {
  const rows = await tx.many<{ staff_id: string; assignment_role: AssignmentRole }>(
    `select a.staff_id, a.assignment_role from bus_staff_assignments a
      where a.bus_id = $1 and a.valid_from <= now() and (a.valid_to is null or a.valid_to > now())`,
    [busId],
  );
  rows.sort((a, b) => ROLE_ORDER.indexOf(a.assignment_role) - ROLE_ORDER.indexOf(b.assignment_role));
  const out: (ParentStaffCard & { role: AssignmentRole })[] = [];
  for (const r of rows) {
    const card = await parentStaffCard(req, tx, r.staff_id);
    if (card) out.push({ ...card, role: r.assignment_role });
  }
  return out;
}
