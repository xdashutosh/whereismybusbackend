// Files service (BP §12, contract §2 Files). Keys: <prefix>schools/{school_id}/{category}/{entity_id}/{uuid}.{ext}.
//   createUploadUrl  mobile: authorize → pending files row → presigned PUT (≤ 300 s, size/type bound)
//                    to the STAGING key '<key>.part' (storage.uploadStagingKey), never the served key
//   complete         read the staged object, sniff magic bytes, size, sha256, EXIF strip/thumbnail →
//                    the server writes the validated bytes to a fresh final key (files.key) and
//                    deletes the staging object, so replaying the upload URL cannot alter the file
//   webUpload        web: multipart through the API → validated/processed → stored → files row
//   fileUrl          authorize (school + role + category hooks) → presigned GET (60–300 s)
// Unauthorized reads answer 404 (never reveal that a file exists in another scope).
import crypto from 'node:crypto';
import type { FileCategory } from '@wimb/shared';
import type { Request } from 'express';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { audit } from '../../shared/audit.js';
import { type AppError, forbidden, invalidState, notFound, payloadTooLarge, unauthenticated, unsupportedFile, validationError } from '../../shared/errors.js';
import { storage } from '../../shared/storage.js';
import { FILE_TYPES, inspectFile, UPLOAD_KINDS, type DetectedType } from '../../shared/uploads.js';
import { withSchoolSystem, type Tx } from '../../db/tenant.js';
import { FILE_CATEGORY_SPECS, fileHooks, type FileCategorySpec, type FileEntityType, type FileRecord } from './hooks.js';
import { prepareStoredObject, readAll, thumbKeyOf } from './processing.js';
import * as repo from './repository.js';
import type { CaptureMetadata, CompleteBody, FileUrlQuery, UploadUrlBody, WebUploadFields } from './schemas.js';
import { localUploadUrl, signedDownload } from './urls.js';

export const UPLOAD_URL_TTL_SECONDS = 300;

export function toDto(f: FileRecord) {
  const { declaredSha256: _d, rejectedReason, ...metadata } = f.metadata ?? {};
  return {
    id: f.id,
    category: f.category,
    entityType: f.entity_type,
    entityId: f.entity_id,
    contentType: f.mime,
    sizeBytes: f.size_bytes,
    sha256: f.sha256,
    fileName: f.original_name,
    status: f.status,
    hasThumbnail: f.thumb_key !== null,
    metadata,
    ...(rejectedReason ? { rejectedReason } : {}),
    uploadedBy: f.uploaded_by,
    createdAt: f.created_at,
  };
}
export type FileDto = ReturnType<typeof toDto>;

function ctxOf(req: Request) {
  const auth = req.auth;
  const schoolId = req.tenant?.schoolId;
  if (!auth || !schoolId) throw unauthenticated();
  return { auth, schoolId };
}

interface Target {
  category: FileCategory;
  spec: FileCategorySpec;
  entityType: FileEntityType;
  entityId: string;
}

function resolveTarget(schoolId: string, input: { category: FileCategory; entityType?: FileEntityType; entityId?: string }): Target {
  const spec = FILE_CATEGORY_SPECS[input.category];
  const entityType = input.entityType ?? spec.entityTypes[0]!;
  if (!spec.entityTypes.includes(entityType)) {
    throw validationError('This category cannot be attached to that entity type.', [{ path: 'entityType', message: `Allowed: ${spec.entityTypes.join(', ')}` }]);
  }
  let entityId = input.entityId;
  if (!entityId) {
    if (!spec.entityOptional) throw validationError('entityId is required for this category.', [{ path: 'entityId', message: 'Required' }]);
    entityId = entityType === 'school' ? schoolId : crypto.randomUUID();
  }
  return { category: input.category, spec, entityType, entityId };
}

function assertUploadRole(req: Request, t: Target): void {
  if (!t.spec.uploadRoles.includes(ctxOf(req).auth.role)) throw forbidden('You are not allowed to upload files of this category.');
}

/** Category role + entity in this school + staff ownership + module hooks. */
async function authorizeUpload(tx: Tx, req: Request, t: Target): Promise<void> {
  const { auth, schoolId } = ctxOf(req);
  assertUploadRole(req, t);
  if (!(await repo.entityExists(tx, t.entityType, t.entityId))) throw notFound('The record this file belongs to was not found.');
  if ((auth.role === 'driver' || auth.role === 'conductor') && !(await repo.staffOwnsEntity(tx, t.entityType, t.entityId, auth.actorId))) {
    throw forbidden('You are not assigned to this bus or trip.');
  }
  const ok = await fileHooks.allowUpload({ tx, req, auth, schoolId, category: t.category, entityType: t.entityType, entityId: t.entityId });
  if (!ok) throw forbidden('You are not allowed to attach a file to this record.');
}

function captureMeta(m: CaptureMetadata | undefined): Record<string, unknown> {
  return m ? { capture: m } : {};
}

function uploaderType(req: Request): 'user' | 'parent_account' | 'platform_user' {
  return req.auth?.ownerType ?? 'user';
}

/** POST /files/upload-url — mobile presigned PUT. */
export async function createUploadUrl(req: Request, body: UploadUrlBody) {
  const { schoolId } = ctxOf(req);
  const t = resolveTarget(schoolId, body);
  assertUploadRole(req, t);
  const kind = UPLOAD_KINDS[t.spec.kind];
  const detected = (Object.entries(FILE_TYPES) as [DetectedType, { contentType: string; extension: string }][]).find(
    ([type, v]) => kind.types.includes(type) && (v.contentType === body.contentType || (type === 'jpeg' && body.contentType === 'image/jpg')),
  );
  if (!detected) throw unsupportedFile(`Unsupported content type. Allowed: ${kind.types.map((x) => FILE_TYPES[x].contentType).join(', ')}.`);
  if (body.sizeBytes > kind.maxBytes) throw payloadTooLarge('The file is too large.', { maxBytes: kind.maxBytes });
  const [, { contentType, extension }] = detected;
  const key = storage.schoolObjectKey({ schoolId, category: t.category, entityId: t.entityId, extension });
  const file = await withRequestTenant(req, async (tx) => {
    await authorizeUpload(tx, req, t);
    const f = await repo.insertFile(tx, {
      key,
      thumbKey: null,
      category: t.category,
      entityType: t.entityType,
      entityId: t.entityId,
      mime: contentType,
      sizeBytes: body.sizeBytes,
      sha256: null,
      originalName: body.fileName ?? null,
      metadata: { ...captureMeta(body.metadata), ...(body.sha256 ? { declaredSha256: body.sha256 } : {}) },
      status: 'pending',
      uploaderType: uploaderType(req),
    });
    await audit.log(tx, { action: 'file.create', entityType: 'file', entityId: f.id, new: { category: f.category, entityType: f.entity_type, entityId: f.entity_id, sizeBytes: body.sizeBytes, mode: 'presigned' } });
    return f;
  });
  const upload = await storage.getUploadUrl(storage.uploadStagingKey(key), {
    contentType,
    contentLength: body.sizeBytes,
    expiresInSec: UPLOAD_URL_TTL_SECONDS,
    localPath: localUploadUrl(req),
  });
  return { file: toDto(file), upload: { url: upload.url, method: upload.method, headers: upload.headers, expiresAt: upload.expiresAt.toISOString() } };
}

async function reject(req: Request, file: FileRecord, reason: string, err: AppError): Promise<never> {
  await withRequestTenant(req, async (tx) => {
    await repo.markRejected(tx, file.id, reason);
    await audit.log(tx, { action: 'file.reject', entityType: 'file', entityId: file.id, new: { reason, code: err.code } });
  });
  await storage.deleteObjectQuietly(storage.uploadStagingKey(file.key));
  throw err;
}

/** POST /files/:id/complete — validates a presigned upload and finalises it. Idempotent. */
export async function complete(req: Request, id: string, body: CompleteBody): Promise<FileDto> {
  const { auth, schoolId } = ctxOf(req);
  const file = await withRequestTenant(req, (tx) => repo.findFile(tx, id), { readOnly: true });
  if (!file || (auth.role !== 'school_admin' && file.uploaded_by !== auth.actorId) || storage.schoolIdOfKey(file.key) !== schoolId) throw notFound();
  if (file.status === 'uploaded') return toDto(file);
  if (file.status !== 'pending') throw invalidState('This upload was rejected. Request a new upload URL.');
  const spec = FILE_CATEGORY_SPECS[file.category];
  const kind = UPLOAD_KINDS[spec.kind];
  const staging = storage.uploadStagingKey(file.key);
  const head = await storage.headObject(staging);
  if (!head) throw invalidState('The file has not been uploaded yet.');
  if (head.size > kind.maxBytes) return reject(req, file, 'too_large', payloadTooLarge('The uploaded file is too large.', { maxBytes: kind.maxBytes }));
  const object = await storage.getObjectStream(staging);
  if (!object) throw invalidState('The file has not been uploaded yet.');
  const buffer = await readAll(object.stream, kind.maxBytes);
  let inspected;
  try {
    inspected = inspectFile({ buffer, originalname: file.original_name ?? `upload.${file.mime.split('/')[1] ?? 'bin'}` }, spec.kind);
  } catch (err) {
    return reject(req, file, 'invalid_content', err as AppError);
  }
  if (file.size_bytes !== null && file.size_bytes !== inspected.size) {
    return reject(req, file, 'size_mismatch', validationError('The uploaded size does not match the declared size.', [{ path: 'sizeBytes', message: 'Size mismatch' }]));
  }
  const expected = body.sha256 ?? (typeof file.metadata?.declaredSha256 === 'string' ? file.metadata.declaredSha256 : undefined);
  if (expected && expected !== inspected.sha256) {
    return reject(req, file, 'checksum_mismatch', validationError('The file checksum does not match.', [{ path: 'sha256', message: 'Checksum mismatch' }]));
  }
  let stored;
  try {
    stored = await prepareStoredObject(spec, inspected);
  } catch (err) {
    return reject(req, file, 'undecodable_image', err as AppError);
  }
  // The validated bytes go to a fresh server-generated key; the staged object is never served.
  const finalKey = storage.schoolObjectKey({ schoolId, category: file.category, entityId: file.entity_id ?? file.id, extension: stored.extension });
  const thumbKey = stored.thumbnail ? thumbKeyOf(finalKey) : null;
  const discardFinal = async () => {
    await storage.deleteObjectQuietly(finalKey);
    if (thumbKey) await storage.deleteObjectQuietly(thumbKey);
  };
  let updated: FileRecord;
  let won = false;
  try {
    await storage.putObject({ key: finalKey, body: stored.body, contentType: stored.contentType, checksum: stored.sha256 });
    if (thumbKey && stored.thumbnail) await storage.putObject({ key: thumbKey, body: stored.thumbnail, contentType: 'image/webp' });
    updated = await withRequestTenant(req, async (tx) => {
      const locked = await repo.lockFile(tx, id);
      if (!locked) throw notFound();
      if (locked.status === 'uploaded') return locked; // a concurrent complete finished first
      if (locked.status !== 'pending') throw invalidState('This upload was rejected. Request a new upload URL.');
      const f = await repo.markUploaded(tx, id, { key: finalKey, mime: stored.contentType, sizeBytes: stored.size, sha256: stored.sha256, thumbKey, metadata: stored.metadata });
      await audit.log(tx, { action: 'file.upload', entityType: 'file', entityId: id, new: { category: f.category, sizeBytes: f.size_bytes, sha256: f.sha256, mode: 'presigned' } });
      won = true;
      return f;
    });
  } catch (err) {
    await discardFinal();
    throw err;
  }
  if (won) await storage.deleteObjectQuietly(staging);
  else await discardFinal();
  return toDto(updated);
}

/** Local storage driver: true while `stagingKey` still belongs to a pending upload. */
export async function isPendingUploadTarget(stagingKey: string): Promise<boolean> {
  const key = storage.keyOfStaging(stagingKey);
  const schoolId = key ? storage.schoolIdOfKey(key) : null;
  if (!key || !schoolId) return false;
  return withSchoolSystem(schoolId, (tx) => repo.isPendingKey(tx, key), { readOnly: true });
}

/** POST /files/upload — web multipart proxied through the API. */
export async function webUpload(req: Request, fields: WebUploadFields): Promise<FileDto> {
  const { schoolId } = ctxOf(req);
  const t = resolveTarget(schoolId, fields);
  assertUploadRole(req, t);
  if (!req.file) throw validationError('A file is required.', [{ path: 'file', message: 'Upload the file in the "file" field' }]);
  await withRequestTenant(req, (tx) => authorizeUpload(tx, req, t), { readOnly: true });
  const inspected = inspectFile(req.file, t.spec.kind);
  const stored = await prepareStoredObject(t.spec, inspected);
  const key = storage.schoolObjectKey({ schoolId, category: t.category, entityId: t.entityId, extension: stored.extension });
  const thumbKey = stored.thumbnail ? thumbKeyOf(key) : null;
  await storage.putObject({ key, body: stored.body, contentType: stored.contentType, checksum: stored.sha256 });
  try {
    if (thumbKey && stored.thumbnail) await storage.putObject({ key: thumbKey, body: stored.thumbnail, contentType: 'image/webp' });
    const file = await withRequestTenant(req, async (tx) => {
      const f = await repo.insertFile(tx, {
        key,
        thumbKey,
        category: t.category,
        entityType: t.entityType,
        entityId: t.entityId,
        mime: stored.contentType,
        sizeBytes: stored.size,
        sha256: stored.sha256,
        originalName: inspected.safeName,
        metadata: { ...stored.metadata, ...captureMeta(fields.metadata) },
        status: 'uploaded',
        uploaderType: uploaderType(req),
      });
      await audit.log(tx, { action: 'file.upload', entityType: 'file', entityId: f.id, new: { category: f.category, entityType: f.entity_type, entityId: f.entity_id, sizeBytes: f.size_bytes, sha256: f.sha256, mode: 'proxied' } });
      return f;
    });
    return toDto(file);
  } catch (err) {
    await storage.deleteObjectQuietly(key);
    if (thumbKey) await storage.deleteObjectQuietly(thumbKey);
    throw err;
  }
}

/** Read authorization (see hooks.ts header). */
async function canRead(tx: Tx, req: Request, file: FileRecord): Promise<boolean> {
  const { auth, schoolId } = ctxOf(req);
  const c = { tx, req, auth, schoolId, file };
  if (auth.role === 'school_admin') return true;
  if (auth.role === 'driver' || auth.role === 'conductor') return file.uploaded_by === auth.actorId || fileHooks.allowStaffRead(c);
  if (auth.role === 'parent') return fileHooks.allowParentRead(c);
  return false;
}

/** GET /files/:id/url — short-lived presigned GET. */
export async function fileUrl(req: Request, id: string, q: FileUrlQuery) {
  const { schoolId } = ctxOf(req);
  const file = await withRequestTenant(
    req,
    async (tx) => {
      const f = await repo.findFile(tx, id);
      if (!f || f.status !== 'uploaded') return null;
      return (await canRead(tx, req, f)) ? f : null;
    },
    { readOnly: true },
  );
  if (!file) throw notFound();
  const key = q.variant === 'thumbnail' ? file.thumb_key : file.key;
  if (!key || storage.schoolIdOfKey(key) !== schoolId) throw notFound(q.variant === 'thumbnail' ? 'This file has no thumbnail.' : undefined);
  const fileName = q.disposition === 'attachment' ? (file.original_name ?? `file-${file.id}.${file.key.split('.').pop() ?? 'bin'}`) : undefined;
  const signed = await signedDownload(req, key, { expiresInSec: q.ttl ?? 120, fileName });
  return {
    url: signed.url,
    expiresAt: signed.expiresAt.toISOString(),
    contentType: q.variant === 'thumbnail' ? 'image/webp' : file.mime,
    fileName: file.original_name,
    variant: q.variant,
  };
}
