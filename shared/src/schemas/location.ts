// Location ingestion payload (BP §9.1). Compact keys are kept on the wire (contract §5).
import { z } from 'zod';
import { latitude, longitude, isoDateTime } from './common.js';

export const MAX_POINTS_PER_BATCH = 500;

/**
 * Device clock vs server clock (BP §14.3 anti-tamper). A difference up to CLOCK_DRIFT_TOLERANCE_MS is
 * normal (latency, NTP jitter) and leaves device timestamps untouched; a larger one is corrected
 * (timestamps rebased onto the server clock) up to CLOCK_DRIFT_MAX_CORRECTION_MS, beyond which the
 * device timestamps are rejected. The driver app uses the same tolerance for its own correction.
 */
export const CLOCK_DRIFT_TOLERANCE_MS = 60_000;
export const CLOCK_DRIFT_MAX_CORRECTION_MS = 24 * 3600_000;

export const locationPoint = z.object({
  t: isoDateTime(),
  lat: latitude(),
  lng: longitude(),
  spd: z.number().finite().min(0).max(300).nullable().optional(),
  hdg: z.number().finite().min(0).max(360).nullable().optional(),
  acc: z.number().finite().min(0).max(10000).nullable().optional(),
  bat: z.number().int().min(0).max(100).nullable().optional(),
  net: z.string().trim().max(16).nullable().optional(),
  mv: z.boolean().nullable().optional(),
});
export type LocationPoint = z.infer<typeof locationPoint>;

export const locationBatch = z.object({
  deviceId: z.string().trim().min(1).max(128).optional(),
  points: z.array(locationPoint).min(1).max(MAX_POINTS_PER_BATCH),
});
export type LocationBatch = z.infer<typeof locationBatch>;
