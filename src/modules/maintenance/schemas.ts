// Request schemas of the maintenance module. Body/query schemas are shared with the web admin
// (@wimb/shared → shared/src/schemas/maintenance.ts); path params live here.
import { uuid } from '@wimb/shared';
import { z } from 'zod';

export {
  createMaintenanceLogBody,
  maintenanceDueQuery,
  maintenanceLogListQuery,
  updateMaintenanceLogBody,
  type CreateMaintenanceLogBody,
  type MaintenanceDueQuery,
  type MaintenanceLogListQuery,
  type UpdateMaintenanceLogBody,
} from '@wimb/shared';

export const maintenanceLogParams = z.object({ id: uuid() });
export type MaintenanceLogParams = z.infer<typeof maintenanceLogParams>;
