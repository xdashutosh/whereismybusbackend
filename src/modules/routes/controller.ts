// HTTP layer of the routes module: read req.valid, call the service, send the envelope.
import type { Request, Response } from 'express';
import { created, ok } from '../../shared/envelope.js';
import { validated } from '../../shared/validate.js';
import * as assignments from './assignmentsService.js';
import * as schedules from './schedulesService.js';
import type * as s from './schemas.js';
import * as service from './service.js';
import * as stops from './stopsService.js';

const routeId = (req: Request) => validated<s.RouteParams>(req, 'params').id;
const stopParams = (req: Request) => validated<s.StopParams>(req, 'params');
const scheduleId = (req: Request) => validated<s.ScheduleParams>(req, 'params').id;

// ── routes ───────────────────────────────────────────────────────────────────
export const list = (req: Request, res: Response) => service.list(req, res, validated<s.RouteListQuery>(req, 'query'));
export async function get(req: Request, res: Response) {
  ok(res, await service.get(req, routeId(req)));
}
export async function create(req: Request, res: Response) {
  created(res, await service.create(req, validated<s.CreateRouteBody>(req, 'body')));
}
export async function update(req: Request, res: Response) {
  ok(res, await service.update(req, routeId(req), validated<s.UpdateRouteBody>(req, 'body')));
}
export async function remove(req: Request, res: Response) {
  ok(res, await service.remove(req, routeId(req)));
}
export async function recomputePolyline(req: Request, res: Response) {
  ok(res, await service.recompute(req, routeId(req)));
}

// ── stops ────────────────────────────────────────────────────────────────────
export async function listStops(req: Request, res: Response) {
  ok(res, await stops.list(req, routeId(req)));
}
export async function getStop(req: Request, res: Response) {
  const p = stopParams(req);
  ok(res, await stops.get(req, p.id, p.stopId));
}
export async function createStop(req: Request, res: Response) {
  created(res, await stops.create(req, routeId(req), validated<s.CreateStopBody>(req, 'body')));
}
export async function updateStop(req: Request, res: Response) {
  const p = stopParams(req);
  ok(res, await stops.update(req, p.id, p.stopId, validated<s.UpdateStopBody>(req, 'body')));
}
export async function removeStop(req: Request, res: Response) {
  const p = stopParams(req);
  ok(res, await stops.remove(req, p.id, p.stopId));
}
export async function reorderStops(req: Request, res: Response) {
  ok(res, await stops.reorder(req, routeId(req), validated<s.ReorderStopsBody>(req, 'body')));
}

// ── bus ↔ route assignments ──────────────────────────────────────────────────
export async function assignBus(req: Request, res: Response) {
  ok(res, await assignments.assign(req, routeId(req), validated<s.AssignRouteBusBody>(req, 'body')));
}
export async function unassignBus(req: Request, res: Response) {
  ok(res, await assignments.unassign(req, routeId(req), validated<s.UnassignRouteBusBody>(req, 'body')));
}
export const routeBusAssignments = (req: Request, res: Response) =>
  assignments.history(req, res, validated<s.BusRouteAssignmentQuery>(req, 'query'), routeId(req));
export const busRouteAssignments = (req: Request, res: Response) => assignments.history(req, res, validated<s.BusRouteAssignmentQuery>(req, 'query'));

// ── trip schedules ───────────────────────────────────────────────────────────
export const listSchedules = (req: Request, res: Response) => schedules.list(req, res, validated<s.TripScheduleListQuery>(req, 'query'));
export async function getSchedule(req: Request, res: Response) {
  ok(res, await schedules.get(req, scheduleId(req)));
}
export async function createSchedule(req: Request, res: Response) {
  created(res, await schedules.create(req, validated<s.CreateTripScheduleBody>(req, 'body')));
}
export async function updateSchedule(req: Request, res: Response) {
  ok(res, await schedules.update(req, scheduleId(req), validated<s.UpdateTripScheduleBody>(req, 'body')));
}
export async function removeSchedule(req: Request, res: Response) {
  ok(res, await schedules.remove(req, scheduleId(req)));
}
