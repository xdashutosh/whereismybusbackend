// Upload handling (contract §2 Files, BP §12, §16). multer@2 memory storage, one file per request,
// size limits per kind. The declared MIME type is never trusted: content is sniffed by magic bytes
// and must be in the kind's allow-list. Images can be normalised with sharp: auto-orientation,
// EXIF/GPS stripping (parent-visible images) and a thumbnail.
// After uploadSingle(): req.file is an InspectedFile. Multer errors are mapped by errorHandler
// (LIMIT_FILE_SIZE → 413 PAYLOAD_TOO_LARGE, others → 400 VALIDATION_ERROR).
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import sharp, { type OutputInfo } from 'sharp';
import { sha256Hex } from './crypto.js';
import { payloadTooLarge, unsupportedFile, validationError } from './errors.js';
import { sanitizeFileName } from './storage.js';

export const MB = 1024 * 1024;

export type DetectedType = 'jpeg' | 'png' | 'webp' | 'heic' | 'pdf' | 'xlsx' | 'csv';

/** Canonical content type / extension per detected type. */
export const FILE_TYPES: Readonly<Record<DetectedType, { contentType: string; extension: string }>> = Object.freeze({
  jpeg: { contentType: 'image/jpeg', extension: 'jpg' },
  png: { contentType: 'image/png', extension: 'png' },
  webp: { contentType: 'image/webp', extension: 'webp' },
  heic: { contentType: 'image/heic', extension: 'heic' },
  pdf: { contentType: 'application/pdf', extension: 'pdf' },
  xlsx: { contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extension: 'xlsx' },
  csv: { contentType: 'text/csv', extension: 'csv' },
});

export const UPLOAD_KINDS = Object.freeze({
  /** Bus/staff/student photos, school logos. */
  PHOTO: { maxBytes: 5 * MB, types: ['jpeg', 'png', 'webp'] as DetectedType[] },
  /** Odometer evidence (live camera capture; HEIC allowed from iOS). */
  ODOMETER: { maxBytes: 8 * MB, types: ['jpeg', 'png', 'webp', 'heic'] as DetectedType[] },
  /** Bus/staff documents, fuel bills, maintenance invoices. */
  DOCUMENT: { maxBytes: 10 * MB, types: ['jpeg', 'png', 'webp', 'pdf'] as DetectedType[] },
  /** CSV/XLSX imports. */
  IMPORT: { maxBytes: 5 * MB, types: ['csv', 'xlsx'] as DetectedType[] },
});
export type UploadKind = keyof typeof UPLOAD_KINDS;

const startsWith = (buf: Buffer, bytes: readonly number[], offset = 0) =>
  buf.length >= offset + bytes.length && bytes.every((b, i) => buf[offset + i] === b);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

function looksLikeXlsx(buf: Buffer): boolean {
  if (!startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) return false;
  return buf.includes('[Content_Types].xml', 0, 'latin1') && buf.includes('xl/', 0, 'latin1');
}

function looksLikeHeic(buf: Buffer): boolean {
  if (!startsWith(buf, ascii('ftyp'), 4)) return false;
  const brand = buf.subarray(8, 12).toString('latin1');
  return ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand);
}

function looksLikeCsv(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  const sample = buf.subarray(0, Math.min(buf.length, 64 * 1024));
  if (sample.includes(0)) return false;
  let text: string;
  try {
    const end = sample.length === buf.length ? sample.length : Math.max(0, sample.length - 3);
    text = new TextDecoder('utf-8', { fatal: true }).decode(sample.subarray(0, end));
  } catch {
    return false;
  }
  text = text.replace(/^\uFEFF/, '');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) return false;
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  return firstLine.length > 0 && /[,;\t]/.test(firstLine);
}

/** Detects the real file type from content, or null. */
export function sniffFileType(buffer: Buffer | null | undefined): DetectedType | null {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(buffer, ascii('RIFF')) && startsWith(buffer, ascii('WEBP'), 8)) return 'webp';
  if (looksLikeHeic(buffer)) return 'heic';
  if (startsWith(buffer, ascii('%PDF-'))) return 'pdf';
  if (looksLikeXlsx(buffer)) return 'xlsx';
  if (looksLikeCsv(buffer)) return 'csv';
  return null;
}

export interface InspectedFile {
  buffer: Buffer;
  size: number;
  originalName: string;
  safeName: string;
  detectedType: DetectedType;
  contentType: string;
  extension: string;
  sha256: string;
}

/** Validates an in-memory file against a kind (also for buffers received by other means). */
export function inspectFile(file: { buffer?: Buffer; size?: number; originalname?: string } | null | undefined, kind: UploadKind): InspectedFile {
  const spec = UPLOAD_KINDS[kind];
  if (!file?.buffer || file.buffer.length === 0) throw validationError('A non-empty file is required.', [{ path: 'file', message: 'A non-empty file is required' }]);
  if (file.buffer.length > spec.maxBytes) throw payloadTooLarge('The uploaded file is too large.', { maxBytes: spec.maxBytes });
  const detectedType = sniffFileType(file.buffer);
  if (!detectedType || !spec.types.includes(detectedType)) {
    throw unsupportedFile(`Unsupported file type. Allowed: ${spec.types.join(', ').toUpperCase()}.`, { allowed: spec.types, detected: detectedType });
  }
  const { contentType, extension } = FILE_TYPES[detectedType];
  let safeName = sanitizeFileName(file.originalname, `upload.${extension}`);
  if (!safeName.toLowerCase().endsWith(`.${extension}`) && !(extension === 'jpg' && /\.jpe?g$/i.test(safeName))) {
    safeName = `${safeName.replace(/\.[A-Za-z0-9]{1,5}$/, '')}.${extension}`;
  }
  return {
    buffer: file.buffer,
    size: file.buffer.length,
    originalName: String(file.originalname ?? ''),
    safeName,
    detectedType,
    contentType,
    extension,
    sha256: sha256Hex(file.buffer),
  };
}

declare module 'express-serve-static-core' {
  interface Request {
    upload?: InspectedFile;
  }
}

/**
 * Middleware: multipart/form-data with at most one file in `field` (text fields land in req.body);
 * the file is validated for `kind` and exposed as req.upload.
 */
export function uploadSingle(kind: UploadKind, { field = 'file', required = true } = {}): RequestHandler {
  const spec = UPLOAD_KINDS[kind];
  const parser = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: spec.maxBytes, files: 1, fields: 20, fieldSize: 64 * 1024, parts: 25, headerPairs: 200 },
  }).single(field);
  return function uploadMiddleware(req: Request, res: Response, next: NextFunction) {
    parser(req, res, (err: unknown) => {
      if (err) return next(err);
      if (!req.file) {
        if (!required) return next();
        return next(validationError('A file is required.', [{ path: field, message: `Upload the file in the "${field}" field` }]));
      }
      try {
        req.upload = inspectFile(req.file, kind);
        return next();
      } catch (e) {
        return next(e);
      }
    });
  };
}

export interface ProcessedImage {
  /** Normalised image (auto-oriented; metadata stripped unless keepMetadata). */
  buffer: Buffer;
  contentType: string;
  extension: string;
  width: number;
  height: number;
  thumbnail: { buffer: Buffer; contentType: 'image/webp'; extension: 'webp'; width: number; height: number } | null;
}

/**
 * Normalises an image with sharp: honours EXIF orientation, strips EXIF/GPS/ICC metadata
 * (sharp drops metadata unless asked to keep it), re-encodes in the same family (JPEG/PNG/WebP;
 * HEIC → JPEG) and optionally builds a WebP thumbnail that fits `thumbnailSize`.
 * Evidence originals (odometer) should be stored untouched; derive thumbnails from them.
 */
export async function processImage(
  input: Buffer,
  { keepMetadata = false, thumbnailSize = 320, maxDimension = 2560 }: { keepMetadata?: boolean; thumbnailSize?: number | null; maxDimension?: number } = {},
): Promise<ProcessedImage> {
  const type = sniffFileType(input);
  if (!type || !['jpeg', 'png', 'webp', 'heic'].includes(type)) throw unsupportedFile('The file is not a supported image.');
  let pipeline = sharp(input, { failOn: 'error', limitInputPixels: 50_000_000 })
    .rotate()
    .resize({ width: maxDimension, height: maxDimension, fit: 'inside', withoutEnlargement: true });
  if (keepMetadata) pipeline = pipeline.keepMetadata();
  let out: { data: Buffer; info: OutputInfo };
  let contentType: string;
  let extension: string;
  try {
    if (type === 'png') {
      out = await pipeline.png().toBuffer({ resolveWithObject: true });
      [contentType, extension] = ['image/png', 'png'];
    } else if (type === 'webp') {
      out = await pipeline.webp({ quality: 82 }).toBuffer({ resolveWithObject: true });
      [contentType, extension] = ['image/webp', 'webp'];
    } else {
      out = await pipeline.jpeg({ quality: 82, mozjpeg: true }).toBuffer({ resolveWithObject: true });
      [contentType, extension] = ['image/jpeg', 'jpg'];
    }
  } catch {
    throw unsupportedFile('The image could not be decoded.');
  }
  let thumbnail: ProcessedImage['thumbnail'] = null;
  if (thumbnailSize) {
    const t = await sharp(out.data)
      .resize({ width: thumbnailSize, height: thumbnailSize, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 70 })
      .toBuffer({ resolveWithObject: true });
    thumbnail = { buffer: t.data, contentType: 'image/webp', extension: 'webp', width: t.info.width, height: t.info.height };
  }
  return { buffer: out.data, contentType, extension, width: out.info.width, height: out.info.height, thumbnail };
}
