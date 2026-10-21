// Request schemas of the trips module. Body/query schemas are shared with the web admin and the apps
// (@wimb/shared → shared/src/schemas/trips.ts); path params live here.
import { uuid } from '@wimb/shared';
import { z } from 'zod';

export {
  cancelTripBody,
  correctOdometerBody,
  driverDeviceBody,
  driverTripHistoryQuery,
  endTripBody,
  interruptTripBody,
  reassignTripBody,
  startTripBody,
  tripEventsBody,
  tripListQuery,
  type CancelTripBody,
  type CorrectOdometerBody,
  type DriverDeviceBody,
  type DriverTripHistoryQuery,
  type EndTripBody,
  type InterruptTripBody,
  type ReassignTripBody,
  type StartTripBody,
  type TripEventsBody,
  type TripListQuery,
} from '@wimb/shared';

export const tripParams = z.object({ id: uuid() });
export type TripParams = z.infer<typeof tripParams>;
