// Routes service (BP §8.3 Routes, §13.3 Routes & Stops; contract §2 routing, §5): list with
// filters/sort/pagination/CSV, detail with ordered stops and the planned path, create, edit
// (direction changes only while nothing references the route; deactivation blocked by a trip in
// progress or live schedules), soft delete (blocked by a trip in progress, current/future student
// assignments or live schedules) and the planned-polyline recompute. Every write is audited.
import type { RecomputePolylineResult, RouteDetail, RouteListItem } from '@wimb/shared';
import type { Request, Response } from 'express';
import type { Tx } from '../../db/tenant.js';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { audit, changedFields } from '../../shared/audit.js';
import { createCsvWriter, type CsvColumn } from '../../shared/csv.js';
import { list as sendList } from '../../shared/envelope.js';
import { conflict, invalidState, notFound } from '../../shared/errors.js';
import { listMeta, parsePagination, parseSort } from '../../shared/pagination.js';
import { routeAuditView, routeWarnings, toRouteListItem, toStopDto, type RouteListRow } from './dto.js';
import { buildPath, recomputePolyline, routingSummary } from './polyline.js';
import * as repo from './repository.js';
import type { CreateRouteBody, RouteListQuery, UpdateRouteBody } from './schemas.js';
import * as stopsRepo from './stopsRepository.js';

export const routeNotFound = () => notFound('Route not found.');

const SORT = {
  allowed: {
    code: 'r.code',
    name: 'r.name',
    direction: 'r.direction',
    isActive: 'r.is_active',
    stopCount: 'st.stop_count',
    firstStopTime: 'st.first_stop_time',
    distanceM: 'r.distance_m',
    studentCount: 'stu.student_count',
    createdAt: 'r.created_at',
    updatedAt: 'r.updated_at',
  },
  defaultSort: 'code,direction',
  tiebreaker: 'r.id',
};

const CSV_COLUMNS: CsvColumn<RouteListItem>[] = [
  { header: 'Code', key: 'code' },
  { header: 'Name', key: 'name' },
  { header: 'Direction', key: 'direction' },
  { header: 'Active', value: (r) => (r.isActive ? 'yes' : 'no') },
  { header: 'Stops', key: 'stopCount' },
  { header: 'First stop time', key: 'firstStopTime' },
  { header: 'Last stop time', key: 'lastStopTime' },
  { header: 'Buses', value: (r) => r.buses.map((b) => b.busCode).join(' ') },
  { header: 'Active schedules', key: 'activeScheduleCount' },
  { header: 'Students', key: 'studentCount' },
  { header: 'Distance (km)', value: (r) => (r.distanceM === null ? '' : (r.distanceM / 1000).toFixed(1)) },
  { header: 'Planned path', value: (r) => r.polylineSource ?? '' },
  { header: 'Description', key: 'description' },
  { header: 'Created (UTC)', key: 'createdAt' },
];

const filterOf = (q: RouteListQuery): repo.RouteFilter => ({ directions: q.direction, isActive: q.isActive, hasBus: q.hasBus, busId: q.busId, q: q.q });

/** GET /school/routes — JSON page or CSV export. */
export async function list(req: Request, res: Response, q: RouteListQuery): Promise<void> {
  const { orderBy } = parseSort(q.sort, SORT);
  const filter = filterOf(q);
  if (q.format === 'csv') {
    const rows = await withRequestTenant(req, (tx) => repo.exportRows(tx, filter, orderBy), { readOnly: true });
    const csv = createCsvWriter<RouteListItem>(res, { fileName: 'routes.csv', columns: CSV_COLUMNS });
    await csv.writeAll(rows.map(toRouteListItem));
    await csv.end();
    return;
  }
  const { page, limit, offset } = parsePagination(q);
  const { rows, total } = await withRequestTenant(req, (tx) => repo.page(tx, filter, { orderBy, limit, offset }), { readOnly: true });
  sendList(res, rows.map((r) => toRouteListItem(r as RouteListRow)), listMeta({ page, limit, total }));
}

/** Route detail inside an open transaction (also used after writes). */
export async function detail(tx: Tx, id: string): Promise<RouteDetail> {
  const row = await repo.findListRow(tx, id);
  if (!row) throw routeNotFound();
  const stops = await stopsRepo.listStops(tx, id);
  const school = await repo.schoolLocation(tx);
  const path = buildPath(row.direction, stops, school);
  return {
    ...toRouteListItem(row),
    polylineEncoded: row.polyline_encoded,
    stops: stops.map(toStopDto),
    school,
    activeTripId: row.active_trip_id,
    warnings: routeWarnings(row, stops, path.points.length),
  };
}

/** GET /school/routes/:id */
export function get(req: Request, id: string): Promise<RouteDetail> {
  return withRequestTenant(req, (tx) => detail(tx, id), { readOnly: true });
}

/** POST /school/routes */
export async function create(req: Request, body: CreateRouteBody): Promise<RouteDetail> {
  return withRequestTenant(req, async (tx) => {
    const route = await repo.insertRoute(tx, body);
    await audit.log(tx, { action: 'route.create', entityType: 'route', entityId: route.id, new: routeAuditView(route) });
    return detail(tx, route.id);
  });
}

/** PATCH /school/routes/:id */
export async function update(req: Request, id: string, body: UpdateRouteBody): Promise<RouteDetail> {
  return withRequestTenant(req, async (tx) => {
    const before = await repo.lockRoute(tx, id);
    if (!before) throw routeNotFound();
    const directionChange = body.direction !== undefined && body.direction !== before.direction;
    const deactivate = body.isActive === false && before.is_active;
    if (directionChange || deactivate) {
      const usage = await repo.routeUsage(tx, id);
      if (usage.active_trip_id) throw invalidState('A trip is in progress on this route. End it before changing the route.', { activeTripId: usage.active_trip_id });
      if (directionChange && (usage.any_schedules > 0 || usage.any_student_assignments > 0)) {
        throw conflict('The direction cannot change while schedules or student assignments use this route. Create a new route instead.', {
          schedules: usage.any_schedules,
          studentAssignments: usage.any_student_assignments,
        });
      }
      if (deactivate && usage.live_schedules > 0) {
        throw conflict('Deactivate or move the active schedules of this route first.', { schedules: usage.live_schedules });
      }
    }
    const after = await repo.updateRoute(tx, id, body);
    const diff = changedFields(routeAuditView(before), routeAuditView(after));
    if (Object.keys(diff.new).length) await audit.log(tx, { action: 'route.update', entityType: 'route', entityId: id, ...diff });
    return detail(tx, id);
  });
}

/** DELETE /school/routes/:id — soft delete; stops, trips and assignment history are kept. */
export async function remove(req: Request, id: string): Promise<{ id: string; deleted: true }> {
  return withRequestTenant(req, async (tx) => {
    const route = await repo.lockRoute(tx, id);
    if (!route) throw routeNotFound();
    const usage = await repo.routeUsage(tx, id);
    if (usage.active_trip_id) throw invalidState('A trip is in progress on this route; it cannot be deleted.', { activeTripId: usage.active_trip_id });
    if (usage.student_assignments > 0 || usage.live_schedules > 0) {
      throw conflict('Move the students and schedules of this route to another route before deleting it.', {
        studentAssignments: usage.student_assignments,
        schedules: usage.live_schedules,
      });
    }
    const effects = await repo.softDelete(tx, id, 'Route deleted');
    await audit.log(tx, {
      action: 'route.delete',
      entityType: 'route',
      entityId: id,
      old: routeAuditView(route),
      new: { busAssignmentsClosed: effects.buses_closed, schedulesDeleted: effects.schedules_deleted, tripsCancelled: effects.trips_cancelled },
    });
    return { id, deleted: true as const };
  });
}

/** POST /school/routes/:id/recompute-polyline */
export async function recompute(req: Request, id: string): Promise<RecomputePolylineResult> {
  const points = await withRequestTenant(
    req,
    async (tx) => {
      const route = await repo.findRoute(tx, id);
      if (!route) throw routeNotFound();
      const stops = await stopsRepo.listStops(tx, id);
      return { stops: stops.length, path: buildPath(route.direction, stops, await repo.schoolLocation(tx)) };
    },
    { readOnly: true },
  );
  if (points.path.points.length < 2) {
    throw invalidState('Add at least two stops (or one stop and the school location) before computing the planned path.', { stops: points.stops });
  }
  const outcome = await recomputePolyline(req, id, 'manual', routeNotFound);
  if (!outcome.applied) throw conflict('The stops changed while the planned path was being computed. Please try again.');
  const route = await withRequestTenant(req, (tx) => detail(tx, id), { readOnly: true });
  return { route, routing: routingSummary(outcome)! };
}
