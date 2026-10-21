// Request schemas of the routes module. Body/query schemas are shared with the web admin
// (@wimb/shared → shared/src/schemas/routes.ts); path params live here.
import { uuid } from '@wimb/shared';
import { z } from 'zod';

export {
  assignRouteBusBody,
  busRouteAssignmentQuery,
  createRouteBody,
  createStopBody,
  createTripScheduleBody,
  reorderStopsBody,
  routeListQuery,
  tripScheduleListQuery,
  unassignRouteBusBody,
  updateRouteBody,
  updateStopBody,
  updateTripScheduleBody,
  type AssignRouteBusBody,
  type BusRouteAssignmentQuery,
  type CreateRouteBody,
  type CreateStopBody,
  type CreateTripScheduleBody,
  type ReorderStopsBody,
  type RouteListQuery,
  type TripScheduleListQuery,
  type UnassignRouteBusBody,
  type UpdateRouteBody,
  type UpdateStopBody,
  type UpdateTripScheduleBody,
} from '@wimb/shared';

export const routeParams = z.object({ id: uuid() });
export type RouteParams = z.infer<typeof routeParams>;

export const stopParams = z.object({ id: uuid(), stopId: uuid() });
export type StopParams = z.infer<typeof stopParams>;

export const scheduleParams = z.object({ id: uuid() });
export type ScheduleParams = z.infer<typeof scheduleParams>;
