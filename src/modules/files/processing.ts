// Content processing of uploaded files (BP §12, §16): magic-byte validation happens in
// shared/uploads.inspectFile; this module decides what is stored. Parent-visible/shareable images
// are re-encoded without EXIF/GPS; evidence originals (odometer) are kept byte-for-byte and only
// get a thumbnail. Every image category gets a WebP thumbnail when the image can be decoded.
import type { Readable } from 'node:stream';
import { sha256Hex } from '../../shared/crypto.js';
import { payloadTooLarge } from '../../shared/errors.js';
import { logger as rootLogger } from '../../shared/logger.js';
import { processImage, type InspectedFile } from '../../shared/uploads.js';
import type { FileCategorySpec } from './hooks.js';

const log = rootLogger.child({ module: 'files.processing' });
const IMAGE_TYPES = new Set(['jpeg', 'png', 'webp', 'heic']);

export interface StoredObject {
  body: Buffer;
  contentType: string;
  extension: string;
  sha256: string;
  size: number;
  /** True when body differs from the received bytes (re-encoded). */
  replaced: boolean;
  thumbnail: Buffer | null;
  metadata: Record<string, unknown>;
}

/** Decides the stored bytes (+ thumbnail) for an inspected upload. */
export async function prepareStoredObject(spec: FileCategorySpec, file: InspectedFile): Promise<StoredObject> {
  const base: StoredObject = {
    body: file.buffer,
    contentType: file.contentType,
    extension: file.extension,
    sha256: file.sha256,
    size: file.size,
    replaced: false,
    thumbnail: null,
    metadata: { detectedType: file.detectedType },
  };
  if (!IMAGE_TYPES.has(file.detectedType)) return base;
  if (spec.stripMetadata) {
    // Throws UNSUPPORTED_FILE when the image cannot be decoded (corrupt or disguised content).
    const img = await processImage(file.buffer, { thumbnailSize: spec.thumbnail ? 320 : null });
    return {
      body: img.buffer,
      contentType: img.contentType,
      extension: img.extension,
      sha256: sha256Hex(img.buffer),
      size: img.buffer.length,
      replaced: true,
      thumbnail: img.thumbnail?.buffer ?? null,
      metadata: { ...base.metadata, width: img.width, height: img.height, exifStripped: true, originalSha256: file.sha256, originalSize: file.size },
    };
  }
  if (spec.thumbnail) {
    try {
      const img = await processImage(file.buffer, { thumbnailSize: 320 });
      return { ...base, thumbnail: img.thumbnail?.buffer ?? null, metadata: { ...base.metadata, width: img.width, height: img.height } };
    } catch (err) {
      // e.g. HEIC without a decoder: the evidence is still accepted, just without a preview.
      log.warn({ type: file.detectedType, err: { message: (err as Error).message } }, 'Thumbnail generation failed');
    }
  }
  return base;
}

/** Reads a stream into memory, refusing more than maxBytes. */
export async function readAll(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > maxBytes) {
      stream.destroy();
      throw payloadTooLarge('The uploaded file is too large.', { maxBytes });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** Thumbnail key next to the object: …/{uuid}.jpg → …/{uuid}.thumb.webp */
export function thumbKeyOf(key: string): string {
  return `${key.replace(/\.[a-z0-9]{1,8}$/, '')}.thumb.webp`;
}
