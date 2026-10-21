// Request schemas of the alerts module. Query/body schemas are shared with the web admin
// (@wimb/shared → shared/src/schemas/alerts.ts); path params live here.
import { uuid } from '@wimb/shared';
import { z } from 'zod';

export { alertActionBody, alertListQuery, type AlertActionBody, type AlertListQuery } from '@wimb/shared';

export const alertParams = z.object({ id: uuid() });
export type AlertParams = z.infer<typeof alertParams>;
