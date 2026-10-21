// Signed URL helpers (contract §2 Files, BP §12). Downloads are always short-lived presigned GETs
// (60–300 s); keys never leave the server. The local storage driver (dev/tests) signs URLs to the
// files module's own routes, built from the request's origin.
import { API_PREFIX } from '@wimb/shared';
import type { Request } from 'express';
import { storage, type SignedUrl } from '../../shared/storage.js';

export const LOCAL_UPLOAD_PATH = '/files/local/upload';
export const LOCAL_DOWNLOAD_PATH = '/files/local/download';

/**
 * Absolute API origin of the request. Honours trust proxy for protocol and host: behind a trusted
 * reverse proxy (e.g. a Vercel-style /api rewrite) X-Forwarded-Proto/-Host give the origin the browser
 * used, so local-driver URLs stay same-origin. (Production uses S3 presigned URLs instead.)
 */
export function apiOrigin(req: Request): string {
  return `${req.protocol}://${req.host || req.get('host') || 'localhost'}`;
}

export function localUploadUrl(req: Request): string {
  return `${apiOrigin(req)}${API_PREFIX}${LOCAL_UPLOAD_PATH}`;
}

export function localDownloadUrl(req: Request): string {
  return `${apiOrigin(req)}${API_PREFIX}${LOCAL_DOWNLOAD_PATH}`;
}

/** Presigned GET for a stored key (authorization must already have happened). */
export function signedDownload(req: Request, key: string, opts: { expiresInSec?: number; fileName?: string } = {}): Promise<SignedUrl> {
  return storage.getDownloadUrl(key, { ...opts, localPath: localDownloadUrl(req) });
}

/** Signed URL or null (branding images in profiles; failures never break the caller). */
export async function optionalSignedUrl(req: Request, key: string | null | undefined): Promise<string | null> {
  if (!key) return null;
  try {
    return (await signedDownload(req, key, { expiresInSec: 300 })).url;
  } catch {
    return null;
  }
}
