// Bus images and the file rows they link (BP §6.2 bus_images, §12). RLS-scoped via the caller's tx.
import type { Tx } from '../../db/tenant.js';
import type { BusImageRow } from './dto.js';

const IMAGE_SELECT = `bi.id, bi.bus_id, bi.file_id, bi.caption, bi.sort_order, bi.created_at,
  f.key as file_key, f.thumb_key as file_thumb_key, f.mime as file_mime
  from bus_images bi left join files f on f.id = bi.file_id`;

export function listImages(tx: Tx, busId: string): Promise<BusImageRow[]> {
  return tx.many<BusImageRow>(`select ${IMAGE_SELECT} where bi.bus_id = $1 order by bi.sort_order, bi.created_at, bi.id`, [busId]);
}

export function findImage(tx: Tx, busId: string, imageId: string): Promise<BusImageRow | null> {
  return tx.maybeOne<BusImageRow>(`select ${IMAGE_SELECT} where bi.bus_id = $1 and bi.id = $2`, [busId, imageId]);
}

export interface FileLinkRow extends Record<string, unknown> {
  id: string;
  category: string;
  entity_type: string | null;
  entity_id: string | null;
  status: string;
  in_bus_images: boolean;
  in_bus_documents: boolean;
}

/** A file of the current school plus where it is already linked (null when not visible). */
export function findFileLink(tx: Tx, fileId: string): Promise<FileLinkRow | null> {
  return tx.maybeOne<FileLinkRow>(
    `select f.id, f.category, f.entity_type, f.entity_id, f.status,
            exists (select 1 from bus_images bi where bi.file_id = f.id) as in_bus_images,
            exists (select 1 from bus_documents bd where bd.file_id = f.id) as in_bus_documents
       from files f where f.id = $1`,
    [fileId],
  );
}

export async function countImages(tx: Tx, busId: string): Promise<number> {
  return (await tx.one<{ n: number }>('select count(*)::int as n from bus_images where bus_id = $1', [busId])).n;
}

/** Appends an image (sort order = given, else after the last one) and returns it with its file. */
export async function insertImage(tx: Tx, busId: string, v: { fileId: string; caption: string | null; sortOrder: number | null }): Promise<BusImageRow> {
  const { id } = await tx.one<{ id: string }>(
    `insert into bus_images (school_id, bus_id, file_id, caption, sort_order, created_by)
     values (nullif(current_setting('app.school_id', true), '')::uuid, $1, $2, $3,
             coalesce($4::int, (select coalesce(max(x.sort_order) + 1, 0) from bus_images x where x.bus_id = $1)),
             nullif(current_setting('app.actor_id', true), '')::uuid)
     returning id`,
    [busId, v.fileId, v.caption, v.sortOrder],
  );
  return (await findImage(tx, busId, id))!;
}

export async function updateImage(tx: Tx, busId: string, imageId: string, v: { caption?: string | null; sortOrder?: number }): Promise<void> {
  await tx.query(
    `update bus_images set caption = case when $3::boolean then $4 else caption end, sort_order = coalesce($5::int, sort_order)
      where bus_id = $1 and id = $2`,
    [busId, imageId, v.caption !== undefined, v.caption ?? null, v.sortOrder ?? null],
  );
}

/** Applies the order of `imageIds` (0, 1, 2, …) in one statement; returns the rows touched. */
export async function reorderImages(tx: Tx, busId: string, imageIds: string[]): Promise<number> {
  const res = await tx.query(
    `update bus_images bi set sort_order = o.ord - 1
       from unnest($2::uuid[]) with ordinality as o(id, ord)
      where bi.bus_id = $1 and bi.id = o.id`,
    [busId, imageIds],
  );
  return res.rowCount ?? 0;
}

/** Removes the image and retires its file row (status 'deleted'); returns the keys to delete. */
export function deleteImage(tx: Tx, busId: string, imageId: string) {
  return tx.maybeOne<{ file_id: string; key: string | null; thumb_key: string | null }>(
    `with del as (delete from bus_images where bus_id = $1 and id = $2 returning file_id),
          f as (update files set status = 'deleted', updated_at = now() where id in (select file_id from del) returning id, key, thumb_key)
     select del.file_id, f.key, f.thumb_key from del left join f on f.id = del.file_id`,
    [busId, imageId],
  );
}
