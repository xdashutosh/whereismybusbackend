// Stops of a route (BP §8.3 CRUD /school/routes/:id/stops, PUT …/stops/reorder; §13.3 map editor).
// Every write locks the route row, so sequences stay 1…n under concurrency; stop codes are unique per
// route (case-insensitive). A change to the geometry (create, delete, reorder, coordinates) refreshes
// the planned path after commit (polyline.ts); the response carries the updated route detail.
import { DEFAULT_ARRIVAL_RADIUS_M, MAX_STOPS_PER_ROUTE, type RouteDetail, type StopDto } from '@wimb/shared';
import type { Request } from 'express';
import type { Tx } from '../../db/tenant.js';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { audit, changedFields } from '../../shared/audit.js';
import { conflict, duplicate, fieldError, invalidState, notFound, validationError } from '../../shared/errors.js';
import { stopAuditView, toStopDto, type RouteRow } from './dto.js';
import { refreshAfterStopChange } from './polyline.js';
import * as repo from './repository.js';
import type { CreateStopBody, ReorderStopsBody, UpdateStopBody } from './schemas.js';
import { detail, routeNotFound } from './service.js';
import * as stopsRepo from './stopsRepository.js';

const stopNotFound = () => notFound('Stop not found.');

export interface StopWriteResult {
  stop: StopDto;
  route: RouteDetail;
}

async function lockedRoute(tx: Tx, routeId: string): Promise<RouteRow> {
  const route = await repo.lockRoute(tx, routeId);
  if (!route) throw routeNotFound();
  return route;
}

async function assertCodeFree(tx: Tx, routeId: string, code: string | null | undefined, exceptId: string | null = null): Promise<number> {
  const stats = await stopsRepo.stopStats(tx, routeId, code ?? null, exceptId);
  if (stats.code_taken_by) throw duplicate('Another stop of this route already uses this code.', [{ path: 'code', message: 'Already used on this route' }]);
  return stats.stop_count;
}

const routeDetail = (req: Request, routeId: string) => withRequestTenant(req, (tx) => detail(tx, routeId), { readOnly: true });

/** GET /school/routes/:id/stops — live stops in sequence order. */
export function list(req: Request, routeId: string): Promise<StopDto[]> {
  return withRequestTenant(
    req,
    async (tx) => {
      if (!(await repo.findRoute(tx, routeId))) throw routeNotFound();
      return (await stopsRepo.listStops(tx, routeId)).map(toStopDto);
    },
    { readOnly: true },
  );
}

/** GET /school/routes/:id/stops/:stopId */
export function get(req: Request, routeId: string, stopId: string): Promise<StopDto> {
  return withRequestTenant(
    req,
    async (tx) => {
      const stop = await stopsRepo.findStop(tx, routeId, stopId);
      if (!stop) throw (await repo.findRoute(tx, routeId)) ? stopNotFound() : routeNotFound();
      return toStopDto(stop);
    },
    { readOnly: true },
  );
}

/** POST /school/routes/:id/stops — inserted at `sequence` (later stops move down) or appended. */
export async function create(req: Request, routeId: string, body: CreateStopBody): Promise<StopWriteResult> {
  const stop = await withRequestTenant(req, async (tx) => {
    await lockedRoute(tx, routeId);
    const count = await assertCodeFree(tx, routeId, body.code);
    if (count >= MAX_STOPS_PER_ROUTE) throw invalidState(`A route can have at most ${MAX_STOPS_PER_ROUTE} stops.`, { maxStops: MAX_STOPS_PER_ROUTE });
    const sequence = body.sequence ?? count + 1;
    if (sequence > count + 1) throw fieldError('sequence', `Must be between 1 and ${count + 1}`);
    const { sequence: _ignored, ...values } = body;
    const row = await stopsRepo.insertStop(tx, routeId, sequence, { arrivalRadiusM: DEFAULT_ARRIVAL_RADIUS_M, ...values });
    await audit.log(tx, { action: 'stop.create', entityType: 'stop', entityId: row.id, new: stopAuditView(row) });
    return toStopDto(row);
  });
  await refreshAfterStopChange(req, routeId);
  return { stop, route: await routeDetail(req, routeId) };
}

/** PATCH /school/routes/:id/stops/:stopId — the position changes only through reorder. */
export async function update(req: Request, routeId: string, stopId: string, body: UpdateStopBody): Promise<StopWriteResult> {
  const { stop, moved } = await withRequestTenant(req, async (tx) => {
    await lockedRoute(tx, routeId);
    const before = await stopsRepo.findStop(tx, routeId, stopId);
    if (!before) throw stopNotFound();
    if (body.code !== undefined) await assertCodeFree(tx, routeId, body.code, stopId);
    const after = await stopsRepo.updateStop(tx, routeId, stopId, body);
    const diff = changedFields(stopAuditView(before), stopAuditView(after));
    if (Object.keys(diff.new).length) await audit.log(tx, { action: 'stop.update', entityType: 'stop', entityId: stopId, ...diff });
    return { stop: toStopDto(after), moved: Number(before.latitude) !== Number(after.latitude) || Number(before.longitude) !== Number(after.longitude) };
  });
  if (moved) await refreshAfterStopChange(req, routeId);
  return { stop, route: await routeDetail(req, routeId) };
}

/** DELETE /school/routes/:id/stops/:stopId — soft delete (blocked by current/future student assignments). */
export async function remove(req: Request, routeId: string, stopId: string): Promise<{ id: string; deleted: true; route: RouteDetail }> {
  await withRequestTenant(req, async (tx) => {
    await lockedRoute(tx, routeId);
    const stop = await stopsRepo.findStop(tx, routeId, stopId);
    if (!stop) throw stopNotFound();
    const students = await stopsRepo.stopStudentAssignments(tx, stopId);
    if (students > 0) throw conflict('Students are assigned to this stop. Move them to another stop first.', { studentAssignments: students });
    await stopsRepo.softDeleteStop(tx, routeId, stopId);
    await audit.log(tx, { action: 'stop.delete', entityType: 'stop', entityId: stopId, old: stopAuditView(stop) });
  });
  await refreshAfterStopChange(req, routeId);
  return { id: stopId, deleted: true as const, route: await routeDetail(req, routeId) };
}

/** PUT /school/routes/:id/stops/reorder — `stopIds` must list every live stop of the route exactly once. */
export async function reorder(req: Request, routeId: string, body: ReorderStopsBody): Promise<RouteDetail> {
  const changed = await withRequestTenant(req, async (tx) => {
    await lockedRoute(tx, routeId);
    const stops = await stopsRepo.listStops(tx, routeId);
    const live = new Set(stops.map((s) => s.id));
    const unknown = body.stopIds.filter((id) => !live.has(id));
    const listed = new Set(body.stopIds);
    const missing = stops.filter((s) => !listed.has(s.id)).map((s) => s.id);
    if (unknown.length || missing.length) {
      throw validationError('stopIds must contain every stop of the route exactly once.', [
        ...unknown.map((id) => ({ path: 'stopIds', message: `Unknown stop ${id}` })),
        ...missing.map((id) => ({ path: 'stopIds', message: `Missing stop ${id}` })),
      ]);
    }
    const updated = await stopsRepo.applyOrder(tx, routeId, body.stopIds);
    if (updated > 0) {
      await audit.log(tx, {
        action: 'stop.reorder',
        entityType: 'route',
        entityId: routeId,
        old: { stopIds: stops.map((s) => s.id) },
        new: { stopIds: body.stopIds },
      });
    }
    return updated > 0;
  });
  if (changed) await refreshAfterStopChange(req, routeId);
  return routeDetail(req, routeId);
}
