// File authorization hooks for bus images and bus documents (BP §12, docs/api/files.md).
//   school_admin   every uploaded file of the school (files module default)
//   driver/conductor  images and current documents of a bus they are assigned to right now
//                     (drivers carry the bus papers — RC, insurance, permit — on the road)
//   parent         bus_image:    linked to a live bus of one of their children AND
//                                parent_visibility.bus.images
//                  bus_document: linked to a current, live, VERIFIED document of such a bus
//                                with visible_to_parents_file AND (insurance/fitness) the
//                                school's *_file flag (pending/rejected documents: never)
// RLS parent_scope on files/bus_images/bus_documents/buses is the backstop. Registered once at
// import (router.ts imports this module).
import type { Tx } from '../../db/tenant.js';
import { registerFileHooks, type ReadHookContext } from '../files/hooks.js';
import { loadBusVisibility, parentSeesDocumentFile } from './visibility.js';

const STAFF_BUSES = `select bsa.bus_id from bus_staff_assignments bsa join staff_profiles sp on sp.id = bsa.staff_id
  where sp.user_id = $2 and sp.deleted_at is null and bsa.valid_from <= now() and (bsa.valid_to is null or bsa.valid_to > now())`;

async function exists(tx: Tx, sql: string, params: unknown[]): Promise<boolean> {
  return (await tx.maybeOne(sql, params)) !== null;
}

export function staffMayReadBusImage({ tx, auth, file }: ReadHookContext): Promise<boolean> {
  return exists(tx, `select 1 from bus_images bi join buses b on b.id = bi.bus_id and b.deleted_at is null where bi.file_id = $1 and bi.bus_id in (${STAFF_BUSES})`, [file.id, auth.actorId]);
}

export async function parentMayReadBusImage({ tx, file }: ReadHookContext): Promise<boolean> {
  if (!(await loadBusVisibility(tx)).images) return false;
  return exists(tx, 'select 1 from bus_images bi join buses b on b.id = bi.bus_id and b.deleted_at is null where bi.file_id = $1', [file.id]);
}

export function staffMayReadBusDocument({ tx, auth, file }: ReadHookContext): Promise<boolean> {
  return exists(
    tx,
    `select 1 from bus_documents d join buses b on b.id = d.bus_id and b.deleted_at is null
      where d.file_id = $1 and d.is_current and d.deleted_at is null and d.bus_id in (${STAFF_BUSES})`,
    [file.id, auth.actorId],
  );
}

export async function parentMayReadBusDocument({ tx, file }: ReadHookContext): Promise<boolean> {
  const docs = await tx.many<{
    doc_type: string;
    visible_to_parents_status: boolean;
    visible_to_parents_file: boolean;
    file_id: string | null;
    verification_status: string;
    is_current: boolean;
  }>(
    `select d.doc_type, d.visible_to_parents_status, d.visible_to_parents_file, d.file_id, d.verification_status, d.is_current
       from bus_documents d join buses b on b.id = d.bus_id and b.deleted_at is null
      where d.file_id = $1 and d.is_current and d.deleted_at is null`,
    [file.id],
  );
  if (!docs.length) return false;
  const v = await loadBusVisibility(tx);
  return docs.some((d) => parentSeesDocumentFile(v, d));
}

registerFileHooks('bus_image', { authorizeRead: staffMayReadBusImage, parentRead: parentMayReadBusImage });
registerFileHooks('bus_document', { authorizeRead: staffMayReadBusDocument, parentRead: parentMayReadBusDocument });
