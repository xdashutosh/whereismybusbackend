// Bus documents (BP §6.2 bus_documents, §12): insurance, fitness, pollution, permit, RC, …
// Replacing keeps history (old row is_current = false, replaced_by → new row); deleting is soft.
// The expiry badge is computed against the school-local date (app_local_date()).
import { BUS_DOCUMENT_EXPIRING_DAYS } from '@wimb/shared';
import type { Tx } from '../../db/tenant.js';
import type { BusDocumentRow } from './dto.js';

const EXPIRING_DAYS = Number(BUS_DOCUMENT_EXPIRING_DAYS);

const SELECT = `select d.id, d.bus_id, d.doc_type, d.title, d.issuer, d.doc_number, d.start_date, d.expiry_date, d.file_id,
    d.verification_status, d.verified_by, u.full_name as verified_by_name, d.verified_at, d.verification_note,
    d.visible_to_parents_status, d.visible_to_parents_file, d.is_current, d.replaced_by, d.created_at, d.updated_at,
    case when d.expiry_date is null then 'none'
         when d.expiry_date < today.day then 'expired'
         when d.expiry_date <= today.day + ${EXPIRING_DAYS} then 'expiring'
         else 'valid' end as expiry_status,
    (d.expiry_date - today.day) as days_to_expiry,
    f.original_name as file_name, f.mime as file_mime, f.size_bytes as file_size, (f.thumb_key is not null) as file_has_thumb
  from bus_documents d
  cross join (select app_local_date() as day) today
  left join files f on f.id = d.file_id
  left join users u on u.id = d.verified_by`;

const ORDER = `order by array_position(array['insurance', 'fitness', 'pollution', 'permit', 'rc', 'safety_inspection', 'other'], d.doc_type),
  d.is_current desc, d.created_at desc, d.id`;

export function listForBus(tx: Tx, busId: string, f: { docTypes?: string[]; includeHistory?: boolean } = {}): Promise<BusDocumentRow[]> {
  return tx.many<BusDocumentRow>(
    `${SELECT} where d.bus_id = $1 and d.deleted_at is null and ($2::boolean or d.is_current)
       and ($3::text[] is null or d.doc_type = any ($3)) ${ORDER}`,
    [busId, f.includeHistory ?? false, f.docTypes ?? null],
  );
}

/** A live document whose bus is live (null otherwise). */
export function findDocument(tx: Tx, docId: string): Promise<BusDocumentRow | null> {
  return tx.maybeOne<BusDocumentRow>(
    `${SELECT} where d.id = $1 and d.deleted_at is null and exists (select 1 from buses b where b.id = d.bus_id and b.deleted_at is null)`,
    [docId],
  );
}

/** Locks a live document of a live bus for a write and returns it. */
export function lockDocument(tx: Tx, docId: string): Promise<BusDocumentRow | null> {
  return tx.maybeOne<BusDocumentRow>(
    `${SELECT} where d.id = $1 and d.deleted_at is null and exists (select 1 from buses b where b.id = d.bus_id and b.deleted_at is null)
     for update of d`,
    [docId],
  );
}

/** Every version linked to `docId` through replaced_by (older and newer), newest first. */
export function versions(tx: Tx, docId: string): Promise<BusDocumentRow[]> {
  return tx.many<BusDocumentRow>(
    `with recursive older as (
       select x.id from bus_documents x where x.replaced_by = $1
       union select p.id from bus_documents p join older o on p.replaced_by = o.id
     ), newer as (
       select x.replaced_by as id from bus_documents x where x.id = $1 and x.replaced_by is not null
       union select n.replaced_by from bus_documents n join newer w on n.id = w.id where n.replaced_by is not null
     )
     ${SELECT} where d.id in (select id from older union select id from newer union select $1::uuid) and d.deleted_at is null
     order by d.created_at desc, d.id`,
    [docId],
  );
}

export interface DocumentValues {
  title?: string | null;
  issuer?: string | null;
  docNumber?: string | null;
  startDate?: string | null;
  expiryDate?: string | null;
  fileId?: string | null;
  visibleToParentsStatus?: boolean;
  visibleToParentsFile?: boolean;
}

/** Inserts a current document (optionally with a pre-generated id) and returns its id. */
export async function insertDocument(tx: Tx, busId: string, docType: string, v: DocumentValues, id: string | null = null): Promise<string> {
  const row = await tx.one<{ id: string }>(
    `insert into bus_documents (id, school_id, bus_id, doc_type, title, issuer, doc_number, start_date, expiry_date, file_id,
                                visible_to_parents_status, visible_to_parents_file, created_by)
     values (coalesce($1::uuid, uuid_v7()), nullif(current_setting('app.school_id', true), '')::uuid, $2, $3, $4, $5, $6, $7, $8, $9,
             coalesce($10::boolean, true), coalesce($11::boolean, false), nullif(current_setting('app.actor_id', true), '')::uuid)
     returning id`,
    [id, busId, docType, v.title ?? null, v.issuer ?? null, v.docNumber ?? null, v.startDate ?? null, v.expiryDate ?? null, v.fileId ?? null,
      v.visibleToParentsStatus ?? null, v.visibleToParentsFile ?? null],
  );
  return row.id;
}

/** Retires the current version and reserves the id of its successor (same statement). */
export async function retireForReplacement(tx: Tx, docId: string): Promise<string> {
  const row = await tx.one<{ replaced_by: string }>(
    `update bus_documents set is_current = false, replaced_by = uuid_v7(), updated_at = now()
      where id = $1 and is_current and deleted_at is null returning replaced_by`,
    [docId],
  );
  return row.replaced_by;
}

const META_COLUMNS = { title: 'title', issuer: 'issuer', docNumber: 'doc_number', startDate: 'start_date', expiryDate: 'expiry_date' } as const;

export async function updateMetadata(tx: Tx, docId: string, v: Partial<Record<keyof typeof META_COLUMNS, string | null>>): Promise<void> {
  const entries = (Object.keys(META_COLUMNS) as (keyof typeof META_COLUMNS)[]).filter((k) => v[k] !== undefined);
  if (!entries.length) return;
  await tx.query(
    `update bus_documents set ${entries.map((k, i) => `${META_COLUMNS[k]} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1`,
    [docId, ...entries.map((k) => v[k])],
  );
}

export async function setVisibility(tx: Tx, docId: string, v: { visibleToParentsStatus?: boolean; visibleToParentsFile?: boolean }): Promise<void> {
  await tx.query(
    `update bus_documents set visible_to_parents_status = coalesce($2, visible_to_parents_status),
            visible_to_parents_file = coalesce($3, visible_to_parents_file), updated_at = now() where id = $1`,
    [docId, v.visibleToParentsStatus ?? null, v.visibleToParentsFile ?? null],
  );
}

export async function setVerification(tx: Tx, docId: string, status: string, note: string | null): Promise<void> {
  await tx.query(
    `update bus_documents
        set verification_status = $2,
            verified_by = case when $2 = 'pending' then null else nullif(current_setting('app.actor_id', true), '')::uuid end,
            verified_at = case when $2 = 'pending' then null else now() end,
            verification_note = $3, updated_at = now()
      where id = $1`,
    [docId, status, note],
  );
}

export async function softDeleteDocument(tx: Tx, docId: string): Promise<void> {
  await tx.query('update bus_documents set deleted_at = now(), updated_at = now() where id = $1 and deleted_at is null', [docId]);
}
