// File authorization hooks for staff photos and staff documents (BP §12, docs/api/files.md).
//   school_admin      every uploaded file of the school (files module default)
//   driver/conductor  their own photo and their own live documents (driver app profile)
//   parent            staff_photo:    the current photo of an active staff member the parent may
//                                     see (RLS: assigned to one of their children's buses) AND the
//                                     school matrix flag <staffType>.photo
//                     staff_document: a current, live, VERIFIED, non-identity document of such a
//                                     staff member with visible_to_parents_file AND the matrix
//                                     flag of its type (visibility.ts: licenceFile,
//                                     characterCertStatus, verification, training; 'other'
//                                     follows the document flag) — pending/rejected: never
// Uploads: category roles (school admins) + the staff profile must exist in the caller's school
// (files module), and a deleted or unknown profile is refused by authorizeUpload as well.
// RLS parent_scope on files/staff_profiles/staff_documents is the backstop. Registered once at
// import (router.ts imports this module).
import type { StaffType } from '@wimb/shared';
import type { Tx } from '../../db/tenant.js';
import { registerFileHooks, type ReadHookContext, type UploadHookContext } from '../files/hooks.js';
import { loadParentVisibility } from '../school/index.js';
import { parentSeesStaffDocumentFile, sectionOf } from './visibility.js';

async function exists(tx: Tx, sql: string, params: unknown[]): Promise<boolean> {
  return (await tx.maybeOne(sql, params)) !== null;
}

/** Staff files attach to a live staff profile of the school. */
export function staffEntityUpload({ tx, entityType, entityId }: UploadHookContext): Promise<boolean> {
  if (entityType !== 'staff') return Promise.resolve(false);
  return exists(tx, 'select 1 from staff_profiles where id = $1 and deleted_at is null', [entityId]);
}

export function ownPhoto({ tx, auth, file }: ReadHookContext): Promise<boolean> {
  return exists(tx, 'select 1 from staff_profiles sp where sp.photo_file_id = $1 and sp.user_id = $2 and sp.deleted_at is null', [file.id, auth.actorId]);
}

export async function parentMayReadStaffPhoto({ tx, file }: ReadHookContext): Promise<boolean> {
  const rows = await tx.many<{ staff_type: StaffType }>(
    'select sp.staff_type from staff_profiles sp where sp.photo_file_id = $1 and sp.deleted_at is null and sp.is_active',
    [file.id],
  );
  if (!rows.length) return false;
  const matrix = await loadParentVisibility(tx);
  return rows.some((r) => sectionOf(matrix, r.staff_type).photo === true);
}

export function ownDocument({ tx, auth, file }: ReadHookContext): Promise<boolean> {
  return exists(
    tx,
    `select 1 from staff_documents d join staff_profiles sp on sp.id = d.staff_id and sp.deleted_at is null
      where d.file_id = $1 and d.deleted_at is null and sp.user_id = $2`,
    [file.id, auth.actorId],
  );
}

export async function parentMayReadStaffDocument({ tx, file }: ReadHookContext): Promise<boolean> {
  const docs = await tx.many<{
    staff_type: StaffType;
    doc_type: string;
    visible_to_parents_status: boolean;
    visible_to_parents_file: boolean;
    file_id: string | null;
    verification_status: string;
    is_current: boolean;
  }>(
    `select sp.staff_type, d.doc_type, d.visible_to_parents_status, d.visible_to_parents_file, d.file_id, d.verification_status, d.is_current
       from staff_documents d join staff_profiles sp on sp.id = d.staff_id and sp.deleted_at is null and sp.is_active
      where d.file_id = $1 and d.is_current and d.deleted_at is null`,
    [file.id],
  );
  if (!docs.length) return false;
  const matrix = await loadParentVisibility(tx);
  return docs.some((d) => parentSeesStaffDocumentFile(sectionOf(matrix, d.staff_type), d));
}

registerFileHooks('staff_photo', { authorizeUpload: staffEntityUpload, authorizeRead: ownPhoto, parentRead: parentMayReadStaffPhoto });
registerFileHooks('staff_document', { authorizeUpload: staffEntityUpload, authorizeRead: ownDocument, parentRead: parentMayReadStaffDocument });
