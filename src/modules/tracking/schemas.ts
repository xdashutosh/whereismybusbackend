// Request schemas of the tracking module (the ingestion body is shared: @wimb/shared locationIngestBody).
import { idParams, locationIngestBody, queryBool } from '@wimb/shared';
import { z } from 'zod';

export const tripParams = idParams;
export const ingestBody = locationIngestBody;

export const pathQuery = z.object({
  /** Adds the raw points (evenly sampled to MAX_RAW_POINTS) for analysis views. */
  includePoints: queryBool().optional(),
});
export type PathQuery = z.infer<typeof pathQuery>;
