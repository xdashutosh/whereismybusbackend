// Bus images (BP §8.3 POST /school/buses/:id/images, §12). The image bytes are uploaded first
// through the files module (category bus_image → EXIF stripped, WebP thumbnail); this service
// links the uploaded file to the bus, orders the gallery and signs short-lived URLs.
import { MAX_BUS_IMAGES, type BusImageDto } from '@wimb/shared';
import type { Request } from 'express';
import type { Tx } from '../../db/tenant.js';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { audit } from '../../shared/audit.js';
import { conflict, fieldError, invalidState, notFound, validationError } from '../../shared/errors.js';
import { storage } from '../../shared/storage.js';
import { optionalSignedUrl } from '../files/urls.js';
import { toImageDto, type BusImageRow } from './dto.js';
import * as imagesRepo from './imagesRepository.js';
import * as repo from './repository.js';
import type { AddBusImageBody, ReorderBusImagesBody, UpdateBusImageBody } from './schemas.js';

/** Image rows → DTOs with signed original/thumbnail URLs (keys never leave the server). */
export function signImages(req: Request, rows: BusImageRow[]): Promise<BusImageDto[]> {
  return Promise.all(
    rows.map(async (r) => toImageDto(r, { url: await optionalSignedUrl(req, r.file_key), thumbnailUrl: await optionalSignedUrl(req, r.file_thumb_key) })),
  );
}

async function requireBus(tx: Tx, busId: string, lock = false): Promise<void> {
  const ok = lock ? (await repo.lockBus(tx, busId)) !== null : await repo.busExists(tx, busId);
  if (!ok) throw notFound('Bus not found.');
}

/**
 * Validates that `fileId` is an uploaded file of `category` attached to this bus (files module
 * entity) and not linked anywhere yet. Shared by images and documents.
 */
export async function assertAttachableFile(tx: Tx, fileId: string, busId: string, category: 'bus_image' | 'bus_document'): Promise<void> {
  const f = await imagesRepo.findFileLink(tx, fileId);
  if (!f) throw notFound('File not found.');
  if (f.category !== category) throw fieldError('fileId', `Upload the file with category ${category}.`);
  if (f.entity_type !== 'bus' || f.entity_id !== busId) throw fieldError('fileId', 'The file was uploaded for another record.');
  if (f.status !== 'uploaded') throw invalidState('The file upload is not complete.');
  if (f.in_bus_images || f.in_bus_documents) throw conflict('This file is already attached.');
}

/** GET /school/buses/:id/images */
export async function list(req: Request, busId: string): Promise<BusImageDto[]> {
  const rows = await withRequestTenant(
    req,
    async (tx) => {
      await requireBus(tx, busId);
      return imagesRepo.listImages(tx, busId);
    },
    { readOnly: true },
  );
  return signImages(req, rows);
}

/** POST /school/buses/:id/images — links an uploaded bus_image file. */
export async function add(req: Request, busId: string, body: AddBusImageBody): Promise<BusImageDto> {
  const row = await withRequestTenant(req, async (tx) => {
    await requireBus(tx, busId, true);
    if ((await imagesRepo.countImages(tx, busId)) >= MAX_BUS_IMAGES) throw conflict(`A bus can have at most ${MAX_BUS_IMAGES} images.`, { maxImages: MAX_BUS_IMAGES });
    await assertAttachableFile(tx, body.fileId, busId, 'bus_image');
    const image = await imagesRepo.insertImage(tx, busId, { fileId: body.fileId, caption: body.caption ?? null, sortOrder: body.sortOrder ?? null });
    await audit.log(tx, { action: 'bus_image.add', entityType: 'bus', entityId: busId, new: { imageId: image.id, fileId: image.file_id, caption: image.caption, sortOrder: image.sort_order } });
    return image;
  });
  return (await signImages(req, [row]))[0]!;
}

/** PATCH /school/buses/:id/images/:imageId — caption / sort order. */
export async function update(req: Request, busId: string, imageId: string, body: UpdateBusImageBody): Promise<BusImageDto> {
  const row = await withRequestTenant(req, async (tx) => {
    await requireBus(tx, busId);
    const before = await imagesRepo.findImage(tx, busId, imageId);
    if (!before) throw notFound('Image not found.');
    await imagesRepo.updateImage(tx, busId, imageId, body);
    const after = (await imagesRepo.findImage(tx, busId, imageId))!;
    await audit.log(tx, {
      action: 'bus_image.update',
      entityType: 'bus',
      entityId: busId,
      old: { imageId, caption: before.caption, sortOrder: before.sort_order },
      new: { imageId, caption: after.caption, sortOrder: after.sort_order },
    });
    return after;
  });
  return (await signImages(req, [row]))[0]!;
}

/** PUT /school/buses/:id/images/order — `imageIds` must list every image of the bus once. */
export async function reorder(req: Request, busId: string, body: ReorderBusImagesBody): Promise<BusImageDto[]> {
  const rows = await withRequestTenant(req, async (tx) => {
    await requireBus(tx, busId, true);
    const current = await imagesRepo.listImages(tx, busId);
    const known = new Set(current.map((r) => r.id));
    if (body.imageIds.length !== current.length || body.imageIds.some((id) => !known.has(id))) {
      throw validationError('List every image of this bus exactly once.', [{ path: 'imageIds', message: `Expected the ${current.length} image ids of this bus` }]);
    }
    await imagesRepo.reorderImages(tx, busId, body.imageIds);
    await audit.log(tx, { action: 'bus_image.reorder', entityType: 'bus', entityId: busId, old: { order: current.map((r) => r.id) }, new: { order: body.imageIds } });
    return imagesRepo.listImages(tx, busId);
  });
  return signImages(req, rows);
}

/** DELETE /school/buses/:id/images/:imageId — unlinks the image and deletes its stored objects. */
export async function remove(req: Request, busId: string, imageId: string): Promise<{ id: string; deleted: true }> {
  const removed = await withRequestTenant(req, async (tx) => {
    await requireBus(tx, busId);
    const gone = await imagesRepo.deleteImage(tx, busId, imageId);
    if (!gone) throw notFound('Image not found.');
    await audit.log(tx, { action: 'bus_image.delete', entityType: 'bus', entityId: busId, old: { imageId, fileId: gone.file_id } });
    return gone;
  });
  // After commit: the file row is already 'deleted'; object removal failures are only logged.
  const schoolId = req.tenant?.schoolId;
  for (const key of [removed.key, removed.thumb_key]) {
    if (key && storage.schoolIdOfKey(key) === schoolId) await storage.deleteObjectQuietly(key);
  }
  return { id: imageId, deleted: true as const };
}
