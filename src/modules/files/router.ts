// 'files' module router (BP §8.3 Files, §12; contract §2). Mounted at /api/v1.
//   POST /files/upload-url        school admins, drivers, conductors — presigned PUT (mobile)
//   POST /files/upload            school admins, drivers, conductors — multipart proxy (web)
//   POST /files/:id/complete      finalise a presigned upload (magic bytes, size, sha256, thumbnails)
//   GET  /files/:id/url           presigned GET (60–300 s); parents via X-School-Id + category hooks
//   PUT  /files/local/upload      local storage driver only (dev/tests): signed-token upload target
//   GET  /files/local/download    local storage driver only: signed-token download
import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { createGuards, type GuardOptions } from '../../middleware/guards.js';
import { idempotency } from '../../middleware/idempotency.js';
import { rateLimits as defaultRateLimits, type RateLimits } from '../../middleware/rateLimits.js';
import { created, ok } from '../../shared/envelope.js';
import { invalidState, notFound, unauthenticated, unsupportedFile } from '../../shared/errors.js';
import { contentDisposition, storage } from '../../shared/storage.js';
import { UPLOAD_KINDS } from '../../shared/uploads.js';
import { parseOrThrow, validate, validated } from '../../shared/validate.js';
import { readAll } from './processing.js';
import { completeBody, fileIdParams, fileUrlQuery, uploadUrlBody, webUploadFields, type CompleteBody, type FileUrlQuery, type UploadUrlBody } from './schemas.js';
import { complete, createUploadUrl, fileUrl, isPendingUploadTarget, webUpload } from './service.js';
import { LOCAL_DOWNLOAD_PATH, LOCAL_UPLOAD_PATH } from './urls.js';

const MAX_UPLOAD_BYTES = Math.max(...Object.values(UPLOAD_KINDS).map((k) => k.maxBytes));

export interface FilesRouterDeps {
  guards?: GuardOptions;
  rateLimits?: RateLimits;
}

/** multipart/form-data: one `file` part (size-capped at the largest kind) + text fields. */
function multipart() {
  const parser = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10, fieldSize: 16 * 1024, parts: 12, headerPairs: 200 },
  }).single('file');
  return (req: Request, res: Response, next: NextFunction) => parser(req, res, (err: unknown) => next(err));
}

export function createFilesRouter({ guards: guardOptions = {}, rateLimits = defaultRateLimits }: FilesRouterDeps = {}): Router {
  const r = Router();
  const g = createGuards(guardOptions);
  const uploaders = g.school('school_admin', 'driver', 'conductor');

  r.post('/files/upload-url', ...uploaders, rateLimits.upload, validate({ body: uploadUrlBody }), idempotency(), async (req, res) => {
    created(res, await createUploadUrl(req, validated<UploadUrlBody>(req, 'body')));
  });
  r.post('/files/upload', ...uploaders, rateLimits.upload, multipart(), idempotency(), async (req, res) => {
    created(res, await webUpload(req, parseOrThrow(webUploadFields, req.body ?? {})));
  });
  r.post('/files/:id/complete', ...uploaders, validate({ params: fileIdParams, body: completeBody }), async (req, res) => {
    ok(res, await complete(req, validated<{ id: string }>(req, 'params').id, validated<CompleteBody>(req, 'body')));
  });
  r.get('/files/:id/url', ...g.schoolMember(), validate({ params: fileIdParams, query: fileUrlQuery }), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    ok(res, await fileUrl(req, validated<{ id: string }>(req, 'params').id, validated<FileUrlQuery>(req, 'query')));
  });

  // ── local storage driver endpoints (signed tokens; never mounted for S3) ─────────────────
  r.put(LOCAL_UPLOAD_PATH, async (req, res) => {
    if (storage.driverName !== 'local') throw notFound();
    const grant = storage.verifyLocalToken(req.query.token, 'upload');
    if (!grant) throw unauthenticated('The upload link is invalid or has expired.');
    // Upload links only ever target a staging key, and only while the upload is still pending.
    if (!(await isPendingUploadTarget(grant.key))) throw invalidState('This upload link is no longer valid.');
    const type = (req.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (grant.contentType && type !== grant.contentType) throw unsupportedFile('The Content-Type does not match the upload link.');
    const body = await readAll(req, grant.maxBytes ?? MAX_UPLOAD_BYTES);
    await storage.putObject({ key: grant.key, body, contentType: grant.contentType ?? 'application/octet-stream' });
    res.status(200).end();
  });
  r.get(LOCAL_DOWNLOAD_PATH, async (req, res) => {
    if (storage.driverName !== 'local') throw notFound();
    const grant = storage.verifyLocalToken(req.query.token, 'download');
    if (!grant) throw unauthenticated('The download link is invalid or has expired.');
    const object = await storage.getObjectStream(grant.key);
    if (!object) throw notFound();
    res.setHeader('Content-Type', object.contentType);
    res.setHeader('Content-Length', String(object.size));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (grant.fileName) res.setHeader('Content-Disposition', contentDisposition(grant.fileName));
    object.stream.pipe(res);
  });
  return r;
}

export const router: Router = createFilesRouter();
export default router;
