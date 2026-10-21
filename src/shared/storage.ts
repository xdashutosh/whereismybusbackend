// Object storage (contract §2 Files, BP §12). Drivers:
//   s3    — S3-compatible (Linode Object Storage, possibly a shared bucket): private objects,
//           presigned PUT for mobile uploads, server-side put for proxied web uploads, presigned
//           GET (60–300 s) for every download.
//   local — files under backend/storage/ (tests/dev). Upload/download URLs point at an API route
//           (chosen by the files module) carrying an HMAC-signed, short-lived token.
// Every key starts with S3_KEY_PREFIX; school files use
//   <prefix>schools/{school_id}/{category}/{entity_id}/{uuid}.{ext}
// and every operation refuses keys outside the prefix. Secrets never leave this module.
import crypto from 'node:crypto';
import { createReadStream, type Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { FileCategory } from '@wimb/shared';
import config, { type Config } from '../config/index.js';
import { hmacSign, safeEqual } from './crypto.js';
import { logger as rootLogger } from './logger.js';

export const MIN_URL_TTL_SECONDS = 60;
export const MAX_URL_TTL_SECONDS = 300;
export const DEFAULT_URL_TTL_SECONDS = 120;
const log = rootLogger.child({ module: 'storage' });
const STAGING_SUFFIX = '.part';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type StorageConfig = Config['storage'];

export interface ObjectHead {
  key: string;
  size: number;
  contentType: string;
  checksum: string | null;
  lastModified: Date | null;
}

export interface SignedUrl {
  url: string;
  expiresAt: Date;
}

export interface SignedUpload extends SignedUrl {
  method: 'PUT';
  /** Headers the client must send with the PUT (they are part of the signature). */
  headers: Record<string, string>;
}

export interface PutInput {
  key: string;
  body: Buffer;
  contentType: string;
  checksum?: string | null;
}

export interface ListedObject {
  key: string;
  size: number;
  lastModified: Date | null;
}

interface Driver {
  readonly name: 's3' | 'local';
  /** Every object whose key starts with `keyPrefix` (pages of at most 1000; order unspecified). */
  listObjects(keyPrefix: string): AsyncIterable<ListedObject[]>;
  putObject(input: PutInput): Promise<{ key: string; size: number }>;
  getDownloadUrl(key: string, opts: { expiresInSec: number; fileName?: string; localPath?: string }): Promise<SignedUrl>;
  getUploadUrl(key: string, opts: { expiresInSec: number; contentType: string; contentLength?: number; localPath?: string }): Promise<SignedUpload>;
  deleteObject(key: string): Promise<void>;
  headObject(key: string): Promise<ObjectHead | null>;
  getObjectStream(key: string): Promise<{ stream: Readable; size: number; contentType: string } | null>;
  healthCheck(): Promise<{ ok: boolean; driver: string; latencyMs?: number; error?: string }>;
  close(): Promise<void>;
}

/** Safe file name: letters, digits, dot, dash, underscore; max 100 chars; never empty. */
export function sanitizeFileName(name: unknown, fallback = 'file'): string {
  const base = (
    (typeof name === 'string' ? name : '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .split(/[\\/]/)
      .pop() ?? ''
  )
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._]+/, '')
    .slice(-100);
  return base || fallback;
}

/** Content-Disposition with an ASCII fallback and RFC 5987 UTF-8 name. */
export function contentDisposition(fileName: string, type: 'attachment' | 'inline' = 'attachment'): string {
  const original = String(fileName || 'download');
  return `${type}; filename="${sanitizeFileName(original, 'download')}"; filename*=UTF-8''${encodeURIComponent(original)}`;
}

export function clampTtl(seconds: number | undefined): number {
  const s = Math.round(Number(seconds ?? DEFAULT_URL_TTL_SECONDS));
  return Math.min(MAX_URL_TTL_SECONDS, Math.max(MIN_URL_TTL_SECONDS, Number.isFinite(s) ? s : DEFAULT_URL_TTL_SECONDS));
}

function assertKey(prefix: string, key: string): void {
  if (typeof key !== 'string' || !key.startsWith(prefix) || key.includes('..') || key.includes('//') || key.length > 1024) {
    throw new TypeError('Storage key outside the configured prefix');
  }
}

// ── local signed tokens ──────────────────────────────────────────────────────
type LocalTokenPurpose = 'download' | 'upload';

export function signLocalToken(purpose: LocalTokenPurpose, data: { k: string; e: number; n?: string | null; t?: string; l?: number }): string {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  return `${payload}.${hmacSign(payload, `storage-${purpose}`)}`;
}

/** Verifies a local upload/download token → { key, fileName, contentType, maxBytes } or null. */
export function verifyLocalToken(token: unknown, purpose: LocalTokenPurpose, { now = Date.now() } = {}) {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  if (!safeEqual(token.slice(dot + 1), hmacSign(payload, `storage-${purpose}`))) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { k?: unknown; e?: unknown; n?: unknown; t?: unknown; l?: unknown };
    if (typeof d.k !== 'string' || typeof d.e !== 'number' || !Number.isInteger(d.e) || d.e * 1000 < now) return null;
    return {
      key: d.k,
      fileName: typeof d.n === 'string' ? d.n : null,
      contentType: typeof d.t === 'string' ? d.t : null,
      maxBytes: typeof d.l === 'number' ? d.l : null,
    };
  } catch {
    return null;
  }
}

// ── local driver ─────────────────────────────────────────────────────────────
function createLocalDriver(cfg: StorageConfig): Driver {
  const root = path.resolve(cfg.localDir);
  const fileOf = (key: string) => {
    const file = path.resolve(root, key);
    if (!file.startsWith(root + path.sep)) throw new TypeError('Storage key escapes the storage directory');
    return file;
  };
  const requireLocalPath = (p: string | undefined, op: string): string => {
    if (!p) throw new TypeError(`local storage: ${op} requires localPath (the API route that serves it)`);
    return p;
  };
  const driver: Driver = {
    name: 'local',
    async *listObjects(keyPrefix) {
      // Walk the directory that contains the prefix, then filter by the full key prefix.
      const dir = keyPrefix.endsWith('/') ? keyPrefix : path.posix.dirname(keyPrefix);
      const start = path.resolve(root, dir);
      if (start !== root && !start.startsWith(root + path.sep)) throw new TypeError('Storage prefix escapes the storage directory');
      let page: ListedObject[] = [];
      const stack = [start];
      while (stack.length) {
        const current = stack.pop()!;
        let entries: Dirent[];
        try {
          entries = await fs.readdir(current, { withFileTypes: true });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw err;
        }
        for (const e of entries) {
          const full = path.join(current, e.name);
          if (e.isDirectory()) {
            stack.push(full);
            continue;
          }
          if (!e.isFile() || e.name.endsWith('.meta.json')) continue;
          const key = path.relative(root, full).split(path.sep).join('/');
          if (!key.startsWith(keyPrefix)) continue;
          const st = await fs.stat(full).catch(() => null);
          if (!st) continue;
          page.push({ key, size: st.size, lastModified: st.mtime });
          if (page.length >= 1000) {
            yield page;
            page = [];
          }
        }
      }
      if (page.length) yield page;
    },
    async putObject({ key, body, contentType, checksum }) {
      const file = fileOf(key);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, body);
      await fs.writeFile(`${file}.meta.json`, JSON.stringify({ contentType, checksum: checksum ?? null }));
      return { key, size: body.length };
    },
    async getDownloadUrl(key, { expiresInSec, fileName, localPath }) {
      const expiresAt = new Date(Date.now() + expiresInSec * 1000);
      const token = signLocalToken('download', { k: key, e: Math.floor(expiresAt.getTime() / 1000), n: fileName ?? null });
      return { url: `${requireLocalPath(localPath, 'getDownloadUrl')}?token=${encodeURIComponent(token)}`, expiresAt };
    },
    async getUploadUrl(key, { expiresInSec, contentType, contentLength, localPath }) {
      const expiresAt = new Date(Date.now() + expiresInSec * 1000);
      const token = signLocalToken('upload', { k: key, e: Math.floor(expiresAt.getTime() / 1000), t: contentType, ...(contentLength ? { l: contentLength } : {}) });
      return {
        url: `${requireLocalPath(localPath, 'getUploadUrl')}?token=${encodeURIComponent(token)}`,
        expiresAt,
        method: 'PUT',
        headers: { 'Content-Type': contentType },
      };
    },
    async deleteObject(key) {
      const file = fileOf(key);
      await fs.rm(file, { force: true });
      await fs.rm(`${file}.meta.json`, { force: true });
    },
    async headObject(key) {
      const file = fileOf(key);
      try {
        const st = await fs.stat(file);
        let meta: { contentType?: string; checksum?: string | null } = {};
        try {
          meta = JSON.parse(await fs.readFile(`${file}.meta.json`, 'utf8')) as typeof meta;
        } catch {
          meta = {};
        }
        return { key, size: st.size, contentType: meta.contentType ?? 'application/octet-stream', checksum: meta.checksum ?? null, lastModified: st.mtime };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
    async getObjectStream(key) {
      const head = await driver.headObject(key);
      if (!head) return null;
      return { stream: createReadStream(fileOf(key)), size: head.size, contentType: head.contentType };
    },
    async healthCheck() {
      const started = performance.now();
      try {
        await fs.mkdir(root, { recursive: true });
        await fs.access(root, fs.constants.W_OK);
        return { ok: true, driver: 'local', latencyMs: Math.round(performance.now() - started) };
      } catch (err) {
        return { ok: false, driver: 'local', error: (err as NodeJS.ErrnoException).code ?? 'STORAGE_ERROR' };
      }
    },
    async close() {},
  };
  return driver;
}

// ── s3 driver ────────────────────────────────────────────────────────────────
async function createS3Driver(cfg: StorageConfig): Promise<Driver> {
  const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand, HeadBucketCommand, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
  const client = new S3Client({
    region: cfg.region ?? undefined,
    endpoint: cfg.endpoint ?? undefined,
    credentials: { accessKeyId: cfg.accessKeyId ?? '', secretAccessKey: cfg.secretAccessKey ?? '' },
    // S3-compatible providers (Linode) do not support the SDK's default CRC32 request checksums.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 3,
  });
  const Bucket = cfg.bucket ?? '';
  const isNotFound = (err: unknown) => {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
  };
  return {
    name: 's3',
    async *listObjects(keyPrefix) {
      let ContinuationToken: string | undefined;
      do {
        const res = await client.send(new ListObjectsV2Command({ Bucket, Prefix: keyPrefix, ContinuationToken, MaxKeys: 1000 }));
        const page = (res.Contents ?? []).filter((o) => o.Key).map((o) => ({ key: o.Key!, size: o.Size ?? 0, lastModified: o.LastModified ?? null }));
        if (page.length) yield page;
        ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (ContinuationToken);
    },
    async putObject({ key, body, contentType, checksum }) {
      await client.send(
        new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType, ContentLength: body.length, Metadata: checksum ? { sha256: checksum } : undefined }),
      );
      return { key, size: body.length };
    },
    async getDownloadUrl(key, { expiresInSec, fileName }) {
      const command = new GetObjectCommand({ Bucket, Key: key, ResponseContentDisposition: fileName ? contentDisposition(fileName) : undefined });
      return { url: await getSignedUrl(client, command, { expiresIn: expiresInSec }), expiresAt: new Date(Date.now() + expiresInSec * 1000) };
    },
    async getUploadUrl(key, { expiresInSec, contentType, contentLength }) {
      const command = new PutObjectCommand({ Bucket, Key: key, ContentType: contentType, ContentLength: contentLength });
      // Content-Type and (when declared) Content-Length are signed: the PUT must match both.
      const signableHeaders = new Set(contentLength ? ['content-type', 'content-length'] : ['content-type']);
      const url = await getSignedUrl(client, command, { expiresIn: expiresInSec, signableHeaders });
      return {
        url,
        expiresAt: new Date(Date.now() + expiresInSec * 1000),
        method: 'PUT',
        headers: { 'Content-Type': contentType, ...(contentLength ? { 'Content-Length': String(contentLength) } : {}) },
      };
    },
    async deleteObject(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
    async headObject(key) {
      try {
        const res = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return {
          key,
          size: res.ContentLength ?? 0,
          contentType: res.ContentType ?? 'application/octet-stream',
          checksum: res.Metadata?.sha256 ?? null,
          lastModified: res.LastModified ?? null,
        };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    async getObjectStream(key) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket, Key: key }));
        return { stream: res.Body as Readable, size: res.ContentLength ?? 0, contentType: res.ContentType ?? 'application/octet-stream' };
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
    },
    async healthCheck() {
      const started = performance.now();
      try {
        await client.send(new HeadBucketCommand({ Bucket }), { abortSignal: AbortSignal.timeout(5000) });
        return { ok: true, driver: 's3', latencyMs: Math.round(performance.now() - started) };
      } catch (err) {
        return { ok: false, driver: 's3', error: (err as { name?: string }).name ?? 'STORAGE_ERROR' };
      }
    },
    async close() {
      client.destroy();
    },
  };
}

export interface SchoolKeyInput {
  schoolId: string;
  category: FileCategory;
  entityId: string;
  extension: string;
}

export type Storage = ReturnType<typeof createStorage>;

/** Creates a storage facade (driver created lazily on first use). */
export function createStorage(cfg: StorageConfig = config.storage) {
  const prefix = cfg.keyPrefix;
  let driverPromise: Promise<Driver> | null = null;
  const driver = () => (driverPromise ??= cfg.driver === 'local' ? Promise.resolve(createLocalDriver(cfg)) : createS3Driver(cfg));
  const keyed = async (key: string) => {
    assertKey(prefix, key);
    return driver();
  };

  return {
    driverName: cfg.driver,
    keyPrefix: prefix,
    configured: cfg.configured,
    /** keyFor('platform', 'exports', 'x.csv') → '<prefix>platform/exports/x.csv'. */
    keyFor(...parts: string[]): string {
      const segs = parts.map((p) => String(p).replace(/^\/+|\/+$/g, '')).filter(Boolean);
      if (!segs.length || segs.some((s) => s.split('/').includes('..'))) throw new TypeError('Invalid storage key parts');
      return `${prefix}${segs.join('/')}`;
    },
    /** BP §12 key: <prefix>schools/{schoolId}/{category}/{entityId}/{uuid}.{ext}. */
    schoolObjectKey({ schoolId, category, entityId, extension }: SchoolKeyInput): string {
      if (!UUID_RE.test(schoolId) || !UUID_RE.test(entityId)) throw new TypeError('schoolObjectKey requires UUID schoolId and entityId');
      if (!/^[a-z0-9]{1,8}$/.test(extension)) throw new TypeError('Invalid file extension');
      return `${prefix}schools/${schoolId.toLowerCase()}/${category}/${entityId.toLowerCase()}/${crypto.randomUUID()}.${extension}`;
    },
    /**
     * Staging target of a presigned upload: '<key>.part'. Clients PUT here; POST /files/:id/complete
     * validates the staged bytes and the server writes the final object itself, so a replayed upload
     * URL can never overwrite a validated file. Staging objects are never served.
     */
    uploadStagingKey(key: string): string {
      assertKey(prefix, key);
      if (key.endsWith(STAGING_SUFFIX)) throw new TypeError('Already a staging key');
      return `${key}${STAGING_SUFFIX}`;
    },
    /** The pending file key a staging key belongs to, or null when `key` is not a staging key. */
    keyOfStaging(key: string): string | null {
      return typeof key === 'string' && key.endsWith(STAGING_SUFFIX) ? key.slice(0, -STAGING_SUFFIX.length) : null;
    },
    /** School id embedded in a school object key (authorization cross-check), or null. */
    schoolIdOfKey(key: string): string | null {
      if (!key.startsWith(`${prefix}schools/`)) return null;
      const id = key.slice(prefix.length + 'schools/'.length).split('/')[0] ?? '';
      return UUID_RE.test(id) ? id : null;
    },
    /** Pages of objects under a key prefix (which must lie inside S3_KEY_PREFIX). */
    async *listObjects(keyPrefix: string): AsyncIterable<ListedObject[]> {
      if (typeof keyPrefix !== 'string' || !keyPrefix.startsWith(prefix) || keyPrefix.split('/').includes('..')) {
        throw new TypeError('Storage prefix outside S3_KEY_PREFIX');
      }
      yield* (await driver()).listObjects(keyPrefix);
    },
    /**
     * Deletes staging objects ('<key>.part', presigned uploads that were never completed) older than
     * `olderThanMs` under `<prefix>schools/` → { scanned, deleted }. At most `limit` deletions per call.
     */
    async deleteStaleStagingObjects({ olderThanMs, now = Date.now(), limit = 5000 }: { olderThanMs: number; now?: number; limit?: number }) {
      const cutoff = now - olderThanMs;
      let scanned = 0;
      let deleted = 0;
      for await (const page of this.listObjects(`${prefix}schools/`)) {
        for (const o of page) {
          scanned += 1;
          if (!o.key.endsWith(STAGING_SUFFIX) || !o.lastModified || o.lastModified.getTime() >= cutoff) continue;
          if (deleted >= limit) return { scanned, deleted, truncated: true };
          await (await driver()).deleteObject(o.key);
          deleted += 1;
        }
      }
      return { scanned, deleted, truncated: false };
    },
    /** Server-side upload (proxied web uploads). */
    async putObject(input: PutInput) {
      if (!Buffer.isBuffer(input.body)) throw new TypeError('putObject body must be a Buffer');
      return (await keyed(input.key)).putObject(input);
    },
    /** Presigned PUT for mobile uploads (TTL clamped to 60–300 s). */
    async getUploadUrl(key: string, opts: { contentType: string; contentLength?: number; expiresInSec?: number; localPath?: string }) {
      return (await keyed(key)).getUploadUrl(key, { ...opts, expiresInSec: clampTtl(opts.expiresInSec) });
    },
    /** Presigned GET (TTL clamped to 60–300 s). */
    async getDownloadUrl(key: string, opts: { expiresInSec?: number; fileName?: string; localPath?: string } = {}) {
      return (await keyed(key)).getDownloadUrl(key, { ...opts, expiresInSec: clampTtl(opts.expiresInSec) });
    },
    async deleteObject(key: string) {
      return (await keyed(key)).deleteObject(key);
    },
    /** Best-effort delete (after failed transactions): logs instead of throwing. */
    async deleteObjectQuietly(key: string): Promise<boolean> {
      try {
        await (await keyed(key)).deleteObject(key);
        return true;
      } catch (err) {
        log.warn({ key, err: { message: (err as Error).message } }, 'Object deletion failed');
        return false;
      }
    },
    async headObject(key: string) {
      return (await keyed(key)).headObject(key);
    },
    async getObjectStream(key: string) {
      return (await keyed(key)).getObjectStream(key);
    },
    async healthCheck() {
      try {
        return await (await driver()).healthCheck();
      } catch (err) {
        return { ok: false, driver: cfg.driver, error: (err as { name?: string }).name ?? 'STORAGE_ERROR' };
      }
    },
    verifyLocalToken,
    async close() {
      if (driverPromise) await (await driverPromise).close();
    },
  };
}

/** Process-wide storage (tests always get the local driver, see config). */
export const storage = createStorage(config.storage);
export default storage;
