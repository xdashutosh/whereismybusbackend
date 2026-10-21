// Request schemas of the files module (BP §12, contract §2 Files).
import { CAPTURE_SOURCES, FILE_CATEGORIES, isoDateTime, latitude, longitude, queryInt, uuid } from '@wimb/shared';
import { z } from 'zod';
import { FILE_ENTITY_TYPES } from './hooks.js';

const emptyToUndefined = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? undefined : v);

/** Client-supplied capture metadata (odometer evidence: capture time, GPS, source). Whitelisted. */
export const captureMetadata = z
  .object({
    capturedAt: isoDateTime().optional(),
    latitude: latitude().optional(),
    longitude: longitude().optional(),
    accuracyM: z.number().finite().min(0).max(100000).optional(),
    source: z.enum(CAPTURE_SOURCES).optional(),
  })
  .refine((m) => (m.latitude === undefined) === (m.longitude === undefined), { message: 'latitude and longitude go together', path: ['latitude'] });
export type CaptureMetadata = z.infer<typeof captureMetadata>;

const sha256 = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{64}$/, 'Must be a hex SHA-256')
  .transform((s) => s.toLowerCase());

const target = {
  category: z.enum(FILE_CATEGORIES),
  entityType: z.preprocess(emptyToUndefined, z.enum(FILE_ENTITY_TYPES).optional()),
  entityId: z.preprocess(emptyToUndefined, uuid().optional()),
};

export const uploadUrlBody = z.object({
  ...target,
  contentType: z.string().trim().toLowerCase().max(100),
  sizeBytes: z.number().int().positive(),
  fileName: z.string().trim().max(200).optional(),
  sha256: sha256.optional(),
  metadata: captureMetadata.optional(),
});
export type UploadUrlBody = z.infer<typeof uploadUrlBody>;

/** Multipart text fields of POST /files/upload (metadata as a JSON string). */
export const webUploadFields = z.object({
  ...target,
  metadata: z.preprocess((v) => {
    if (typeof v !== 'string' || v.trim() === '') return undefined;
    try {
      return JSON.parse(v) as unknown;
    } catch {
      return v;
    }
  }, captureMetadata.optional()),
});
export type WebUploadFields = z.infer<typeof webUploadFields>;

export const completeBody = z.object({ sha256: sha256.optional() });
export type CompleteBody = z.infer<typeof completeBody>;

export const fileUrlQuery = z.object({
  variant: z.preprocess(emptyToUndefined, z.enum(['original', 'thumbnail']).default('original')),
  ttl: queryInt(60, 300),
  disposition: z.preprocess(emptyToUndefined, z.enum(['inline', 'attachment']).default('inline')),
});
export type FileUrlQuery = z.infer<typeof fileUrlQuery>;

export const fileIdParams = z.object({ id: uuid() });
