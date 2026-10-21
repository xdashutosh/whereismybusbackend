// Request schemas of the fuel module. Body/query schemas are shared with the web admin
// (@wimb/shared → shared/src/schemas/fuel.ts); path params live here.
import { uuid } from '@wimb/shared';
import { z } from 'zod';

export {
  createFuelLogBody,
  fuelLogListQuery,
  mileageSummaryQuery,
  mileageTrendQuery,
  updateFuelLogBody,
  type CreateFuelLogBody,
  type FuelLogListQuery,
  type MileageSummaryQuery,
  type MileageTrendQuery,
  type UpdateFuelLogBody,
} from '@wimb/shared';

export const fuelLogParams = z.object({ id: uuid() });
export type FuelLogParams = z.infer<typeof fuelLogParams>;
