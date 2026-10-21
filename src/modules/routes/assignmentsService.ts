// Bus ↔ route assignments with history (BP §6.2 bus_route_assignments, §13.3): assign opens a window
// from now (or a past effectiveFrom), unassign closes it; re-assigning an assigned bus is a no-op.
// A bus may serve several routes (e.g. its morning and afternoon routes) and a route several buses.
// The route row is locked, so concurrent changes of one route serialise; the exclusion constraint
// bus_route_assignments_no_overlap is the database backstop against overlapping history.
import type { AssignRouteBusResult, BusRouteAssignmentItem } from '@wimb/shared';
import type { Request, Response } from 'express';
import type { Tx } from '../../db/tenant.js';
import { registerConstraintError } from '../../middleware/errorHandler.js';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { audit } from '../../shared/audit.js';
import { createCsvWriter, type CsvColumn } from '../../shared/csv.js';
import { list as sendList } from '../../shared/envelope.js';
import { conflict, fieldError, invalidState, notFound } from '../../shared/errors.js';
import { listMeta, parsePagination, parseSort } from '../../shared/pagination.js';
import * as assignmentsRepo from './assignmentsRepository.js';
import { toAssignmentItem, toBusRefs, type AssignmentRow } from './dto.js';
import * as repo from './repository.js';
import type { AssignRouteBusBody, BusRouteAssignmentQuery, UnassignRouteBusBody } from './schemas.js';
import { routeNotFound } from './service.js';

registerConstraintError('bus_route_assignments_no_overlap', 'CONFLICT', 'The bus was already assigned to this route during that period.');

/** Clock skew tolerated for client-supplied effective times (ms). */
const FUTURE_TOLERANCE_MS = 60_000;

function assertNotFuture(field: string, value: string | undefined): void {
  if (value && Date.parse(value) > Date.now() + FUTURE_TOLERANCE_MS) throw fieldError(field, 'Cannot be in the future');
}

async function currentBuses(tx: Tx, routeId: string) {
  const row = await repo.findListRow(tx, routeId);
  return toBusRefs(row?.buses ?? []);
}

/** POST /school/routes/:id/assign-bus */
export async function assign(req: Request, routeId: string, body: AssignRouteBusBody): Promise<AssignRouteBusResult> {
  assertNotFuture('effectiveFrom', body.effectiveFrom);
  // 'now' is PostgreSQL's input literal for the transaction start time (= now()).
  const at = body.effectiveFrom ?? 'now';
  return withRequestTenant(req, async (tx) => {
    const route = await repo.lockRoute(tx, routeId);
    if (!route) throw routeNotFound();
    const bus = await assignmentsRepo.findBus(tx, body.busId);
    if (!bus) throw notFound('Bus not found.', { field: 'busId' });
    const open = await assignmentsRepo.openAssignments(tx, routeId, body.busId);
    if (open.length) return { action: 'unchanged' as const, assignment: toAssignmentItem(open[0]!), buses: await currentBuses(tx, routeId) };
    if (!route.is_active) throw invalidState('The route is inactive. Activate it before assigning buses.');
    if (bus.status === 'retired') throw invalidState('A retired bus cannot be assigned to a route.');
    const id = await assignmentsRepo.insertAssignment(tx, routeId, body.busId, at);
    const row = await assignmentsRepo.findAssignment(tx, id);
    await audit.log(tx, {
      action: 'route.assign_bus',
      entityType: 'route',
      entityId: routeId,
      new: { assignmentId: id, busId: body.busId, busCode: bus.code, validFrom: row.valid_from, note: body.note ?? null },
    });
    return { action: 'assigned' as const, assignment: toAssignmentItem(row), buses: await currentBuses(tx, routeId) };
  });
}

/** POST /school/routes/:id/unassign-bus — blocked while active schedules of this bus+route remain. */
export async function unassign(req: Request, routeId: string, body: UnassignRouteBusBody): Promise<AssignRouteBusResult> {
  assertNotFuture('effectiveTo', body.effectiveTo);
  const at = body.effectiveTo ?? 'now';
  return withRequestTenant(req, async (tx) => {
    if (!(await repo.lockRoute(tx, routeId))) throw routeNotFound();
    const open = await assignmentsRepo.openAssignments(tx, routeId, body.busId);
    const current = open[0];
    if (!current) {
      if (!(await assignmentsRepo.findBus(tx, body.busId))) throw notFound('Bus not found.', { field: 'busId' });
      throw invalidState('The bus is not assigned to this route.');
    }
    if (body.effectiveTo && Date.parse(body.effectiveTo) < Date.parse(current.valid_from)) {
      throw fieldError('effectiveTo', `Must not be before the assignment started (${current.valid_from})`);
    }
    const schedules = await assignmentsRepo.liveSchedules(tx, routeId, body.busId);
    if (schedules > 0) throw conflict('Active schedules use this bus on this route. Deactivate or move them first.', { schedules });
    await assignmentsRepo.closeAssignment(tx, current.id, at);
    const row = await assignmentsRepo.findAssignment(tx, current.id);
    await audit.log(tx, {
      action: 'route.unassign_bus',
      entityType: 'route',
      entityId: routeId,
      old: { assignmentId: current.id, busId: body.busId, busCode: current.bus_code, validFrom: current.valid_from },
      new: { validTo: row.valid_to, note: body.note ?? null },
    });
    return { action: 'unassigned' as const, assignment: toAssignmentItem(row), buses: await currentBuses(tx, routeId) };
  });
}

const HISTORY_SORT = {
  allowed: { validFrom: 'a.valid_from', validTo: 'a.valid_to', busCode: 'b.code', routeCode: 'r.code', createdAt: 'a.created_at' },
  defaultSort: '-validFrom',
  tiebreaker: 'a.id',
};

const HISTORY_CSV: CsvColumn<BusRouteAssignmentItem>[] = [
  { header: 'Bus', key: 'busCode' },
  { header: 'Bus name', key: 'busName' },
  { header: 'Route', key: 'routeCode' },
  { header: 'Route name', key: 'routeName' },
  { header: 'Direction', key: 'direction' },
  { header: 'From (UTC)', key: 'validFrom' },
  { header: 'To (UTC)', key: 'validTo' },
  { header: 'Current', value: (r) => (r.isCurrent ? 'yes' : 'no') },
  { header: 'Assigned by', key: 'createdByName' },
];

/**
 * GET /school/bus-route-assignments (filters) and GET /school/routes/:id/bus-assignments (one route,
 * 404 when it does not exist) — JSON page or CSV.
 */
export async function history(req: Request, res: Response, q: BusRouteAssignmentQuery, routeId?: string): Promise<void> {
  const { orderBy } = parseSort(q.sort, HISTORY_SORT);
  const filter = { routeId: routeId ?? q.routeId, busId: q.busId, directions: q.direction, current: q.current };
  const ensureRoute = async (tx: Tx) => {
    if (routeId && !(await repo.findRoute(tx, routeId))) throw routeNotFound();
  };
  if (q.format === 'csv') {
    const rows = await withRequestTenant(
      req,
      async (tx) => {
        await ensureRoute(tx);
        return assignmentsRepo.historyExport(tx, filter, orderBy);
      },
      { readOnly: true },
    );
    const csv = createCsvWriter<BusRouteAssignmentItem>(res, { fileName: 'bus-route-assignments.csv', columns: HISTORY_CSV });
    await csv.writeAll(rows.map(toAssignmentItem));
    await csv.end();
    return;
  }
  const { page, limit, offset } = parsePagination(q);
  const { rows, total } = await withRequestTenant(
    req,
    async (tx) => {
      await ensureRoute(tx);
      return assignmentsRepo.historyPage(tx, filter, { orderBy, limit, offset });
    },
    { readOnly: true },
  );
  sendList(res, rows.map((r) => toAssignmentItem(r as AssignmentRow)), listMeta({ page, limit, total }));
}
