// 'routes' module router (BP §6.2 ROUTES/STOPS/SCHEDULES, §8.3 Routes/Stops + Schedules, §13.3; contract
// §2 routing, §5). Mounted at /api/v1. School admins only (the /school area guard also applies).
// API: docs/api/routes.md.
//   GET|POST /school/routes · GET|PATCH|DELETE /school/routes/:id · POST /school/routes/:id/recompute-polyline
//   GET|POST /school/routes/:id/stops · PUT /school/routes/:id/stops/reorder
//   GET|PATCH|DELETE /school/routes/:id/stops/:stopId
//   POST /school/routes/:id/assign-bus · POST /school/routes/:id/unassign-bus
//   GET /school/routes/:id/bus-assignments · GET /school/bus-route-assignments
//   GET|POST /school/trip-schedules · GET|PATCH|DELETE /school/trip-schedules/:id
import { Router } from 'express';
import { registerConstraintError } from '../../middleware/errorHandler.js';
import { createGuards, type GuardOptions } from '../../middleware/guards.js';
import { idempotency } from '../../middleware/idempotency.js';
import { validate } from '../../shared/validate.js';
import * as c from './controller.js';
import * as s from './schemas.js';

registerConstraintError('routes_code_uq', 'DUPLICATE', 'A route with this code and direction already exists.');
registerConstraintError('stops_route_sequence_uq', 'CONFLICT', 'Another stop already has this position. Reload the route and try again.');

export function createRoutesRouter(guardOptions: GuardOptions = {}): Router {
  const r = Router();
  const admin = createGuards(guardOptions).schoolAdmin();
  const route = validate({ params: s.routeParams });
  const stop = validate({ params: s.stopParams });
  const schedule = validate({ params: s.scheduleParams });

  r.get('/school/routes', ...admin, validate({ query: s.routeListQuery }), c.list);
  r.post('/school/routes', ...admin, idempotency(), validate({ body: s.createRouteBody }), c.create);
  r.get('/school/routes/:id', ...admin, route, c.get);
  r.patch('/school/routes/:id', ...admin, route, validate({ body: s.updateRouteBody }), c.update);
  r.delete('/school/routes/:id', ...admin, route, c.remove);
  r.post('/school/routes/:id/recompute-polyline', ...admin, route, c.recomputePolyline);

  r.get('/school/routes/:id/stops', ...admin, route, c.listStops);
  r.post('/school/routes/:id/stops', ...admin, idempotency(), route, validate({ body: s.createStopBody }), c.createStop);
  r.put('/school/routes/:id/stops/reorder', ...admin, route, validate({ body: s.reorderStopsBody }), c.reorderStops);
  r.get('/school/routes/:id/stops/:stopId', ...admin, stop, c.getStop);
  r.patch('/school/routes/:id/stops/:stopId', ...admin, stop, validate({ body: s.updateStopBody }), c.updateStop);
  r.delete('/school/routes/:id/stops/:stopId', ...admin, stop, c.removeStop);

  r.post('/school/routes/:id/assign-bus', ...admin, route, validate({ body: s.assignRouteBusBody }), c.assignBus);
  r.post('/school/routes/:id/unassign-bus', ...admin, route, validate({ body: s.unassignRouteBusBody }), c.unassignBus);
  r.get('/school/routes/:id/bus-assignments', ...admin, route, validate({ query: s.busRouteAssignmentQuery }), c.routeBusAssignments);
  r.get('/school/bus-route-assignments', ...admin, validate({ query: s.busRouteAssignmentQuery }), c.busRouteAssignments);

  r.get('/school/trip-schedules', ...admin, validate({ query: s.tripScheduleListQuery }), c.listSchedules);
  r.post('/school/trip-schedules', ...admin, idempotency(), validate({ body: s.createTripScheduleBody }), c.createSchedule);
  r.get('/school/trip-schedules/:id', ...admin, schedule, c.getSchedule);
  r.patch('/school/trip-schedules/:id', ...admin, schedule, validate({ body: s.updateTripScheduleBody }), c.updateSchedule);
  r.delete('/school/trip-schedules/:id', ...admin, schedule, c.removeSchedule);
  return r;
}

export const router: Router = createRoutesRouter();
export default router;
