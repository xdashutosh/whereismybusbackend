// Request schemas of the privacy module (shared ones come from @wimb/shared).
import { uuid } from '@wimb/shared';
import { z } from 'zod';

export const idParams = z.object({ id: uuid() });
export type IdParams = z.infer<typeof idParams>;
