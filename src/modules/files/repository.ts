// SQL of the files module. Every statement runs in the caller's tenant transaction, so RLS
// (tenant_isolation + the parent_scope policy on files) limits what is visible.
import type { FileCategory } from '@wimb/shared';
import type { Tx } from '../../db/tenant.js';
import type { FileEntityType, FileRecord } from './hooks.js';

const COLUMNS = `id, school_id, key, thumb_key, category, entity_type, entity_id, mime, size_bytes, sha256, original_name,
  metadata, status, uploaded_by, uploader_type, created_at, updated_at`;

export function findFile(tx: Tx, id: string): Promise<FileRecord | null> {
  return tx.maybeOne<FileRecord>(`select ${COLUMNS} from files where id = $1`, [id]);
}

/** Locks a file row for completion. */
export function lockFile(tx: Tx, id: string): Promise<FileRecord | null> {
  return tx.maybeOne<FileRecord>(`select ${COLUMNS} from files where id = $1 for update`, [id]);
}

export interface NewFile {
  key: string;
  thumbKey: string | null;
  category: FileCategory;
  entityType: FileEntityType;
  entityId: string;
  mime: string;
  sizeBytes: number;
  sha256: string | null;
  originalName: string | null;
  metadata: Record<string, unknown>;
  status: 'pending' | 'uploaded';
  uploaderType: 'user' | 'parent_account' | 'platform_user' | 'system';
}

/** Inserts a file row of the current school (school_id from the transaction context). */
export function insertFile(tx: Tx, f: NewFile): Promise<FileRecord> {
  return tx.one<FileRecord>(
    `insert into files (school_id, key, thumb_key, category, entity_type, entity_id, mime, size_bytes, sha256, original_name, metadata, status, uploaded_by, uploader_type)
     values (nullif(current_setting('app.school_id', true), '')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11,
             nullif(current_setting('app.actor_id', true), '')::uuid, $12)
     returning ${COLUMNS}`,
    [f.key, f.thumbKey, f.category, f.entityType, f.entityId, f.mime, f.sizeBytes, f.sha256, f.originalName, JSON.stringify(f.metadata), f.status, f.uploaderType],
  );
}

export function markUploaded(
  tx: Tx,
  id: string,
  u: { key: string; mime: string; sizeBytes: number; sha256: string; thumbKey: string | null; metadata: Record<string, unknown> },
): Promise<FileRecord> {
  return tx.one<FileRecord>(
    `update files set status = 'uploaded', key = $7, mime = $2, size_bytes = $3, sha256 = $4, thumb_key = $5, metadata = metadata || $6::jsonb
      where id = $1 and status = 'pending'
      returning ${COLUMNS}`,
    [id, u.mime, u.sizeBytes, u.sha256, u.thumbKey, JSON.stringify(u.metadata), u.key],
  );
}

/** True while `key` is the key of a pending (not yet completed) upload of the current school. */
export async function isPendingKey(tx: Tx, key: string): Promise<boolean> {
  return (await tx.maybeOne(`select 1 from files where key = $1 and status = 'pending'`, [key])) !== null;
}

export async function markRejected(tx: Tx, id: string, reason: string): Promise<void> {
  await tx.query(`update files set status = 'rejected', metadata = metadata || jsonb_build_object('rejectedReason', $2::text) where id = $1 and status = 'pending'`, [id, reason]);
}

const ENTITY_SQL: Partial<Record<FileEntityType, string>> = {
  bus: 'select 1 from buses where id = $1 and deleted_at is null',
  staff: 'select 1 from staff_profiles where id = $1 and deleted_at is null',
  student: 'select 1 from students where id = $1 and deleted_at is null',
  trip: 'select 1 from trips where id = $1',
  fuel_log: 'select 1 from fuel_logs where id = $1',
  maintenance_log: 'select 1 from maintenance_logs where id = $1',
};

/** True when the entity exists in the current school (RLS) — school: the school itself. */
export async function entityExists(tx: Tx, type: FileEntityType, id: string): Promise<boolean> {
  if (type === 'school') return id === tx.ctx.schoolId;
  const sql = ENTITY_SQL[type];
  if (!sql) return true; // import / report: free-standing entities
  return (await tx.maybeOne(sql, [id])) !== null;
}

/**
 * Staff ownership default (drivers/conductors): a bus they are currently assigned to, or a trip
 * of such a bus / on which they are the driver or conductor.
 */
export async function staffOwnsEntity(tx: Tx, type: FileEntityType, id: string, userId: string): Promise<boolean> {
  const mine = `select sp.id from staff_profiles sp where sp.user_id = $2 and sp.deleted_at is null`;
  const myBuses = `select bsa.bus_id from bus_staff_assignments bsa
                    where bsa.staff_id in (${mine}) and bsa.valid_from <= now() and (bsa.valid_to is null or bsa.valid_to > now())`;
  if (type === 'bus') return (await tx.maybeOne(`select 1 where $1::uuid in (${myBuses})`, [id, userId])) !== null;
  if (type === 'trip') {
    return (
      (await tx.maybeOne(
        `select 1 from trips t where t.id = $1 and (t.driver_staff_id in (${mine}) or t.conductor_staff_id in (${mine}) or t.bus_id in (${myBuses}))`,
        [id, userId],
      )) !== null
    );
  }
  return false;
}
