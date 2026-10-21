// Trip schedules (BP §8.3 CRUD /school/trip-schedules, §13.3 Schedules): bus + route + direction +
// planned start + weekdays + validity. An active schedule is rejected when it overlaps another active
// schedule of the same bus on a shared weekday within the estimated duration window (overlap.ts);
// schedule writes of one bus serialise on an advisory lock. Saving an active schedule opens the
// bus ↔ route assignment when missing; edits, deactivation and deletion reconcile the not-yet-started
// trips generated from the schedule (scheduleTrips.ts). Every write is audited.
import type { Direction, TripScheduleItem } from '@wimb/shared';
import type { Request, Response } from 'express';
import type { Tx } from '../../db/tenant.js';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { audit, changedFields } from '../../shared/audit.js';
import { createCsvWriter, type CsvColumn } from '../../shared/csv.js';
import { list as sendList } from '../../shared/envelope.js';
import { conflict, fieldError, invalidState, notFound } from '../../shared/errors.js';
import { listMeta, parsePagination, parseSort } from '../../shared/pagination.js';
import * as assignmentsRepo from './assignmentsRepository.js';
import { endTimeOf, hhmmOf, scheduleAuditView, toScheduleItem, type ScheduleRow } from './dto.js';
import { findConflicts } from './overlap.js';
import { restoreScheduleTrips } from '../trips/index.js';
import { cancelPendingTrips, syncPendingTrips } from './scheduleTrips.js';
import * as repo from './schedulesRepository.js';
import type { CreateTripScheduleBody, TripScheduleListQuery, UpdateTripScheduleBody } from './schemas.js';

const scheduleNotFound = () => notFound('Schedule not found.');

const SORT = {
  allowed: {
    plannedStartTime: 'ts.planned_start_time',
    busCode: 'b.code',
    routeCode: 'r.code',
    direction: 'ts.direction',
    name: 'ts.name',
    isActive: 'ts.is_active',
    validFrom: 'ts.valid_from',
    validTo: 'ts.valid_to',
    createdAt: 'ts.created_at',
  },
  defaultSort: 'busCode,plannedStartTime',
  tiebreaker: 'ts.id',
};

const DAY_NAMES = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const CSV_COLUMNS: CsvColumn<TripScheduleItem>[] = [
  { header: 'Name', key: 'name' },
  { header: 'Bus', key: 'busCode' },
  { header: 'Route', key: 'routeCode' },
  { header: 'Route name', key: 'routeName' },
  { header: 'Direction', key: 'direction' },
  { header: 'Planned start', key: 'plannedStartTime' },
  { header: 'Estimated end', key: 'estimatedEndTime' },
  { header: 'Days', value: (r) => r.daysOfWeek.map((d) => DAY_NAMES[d]).join(' ') },
  { header: 'Valid from', key: 'validFrom' },
  { header: 'Valid to', key: 'validTo' },
  { header: 'Active', value: (r) => (r.isActive ? 'yes' : 'no') },
  { header: 'Created (UTC)', key: 'createdAt' },
];

const filterOf = (q: TripScheduleListQuery): repo.ScheduleFilter => ({
  busId: q.busId,
  routeId: q.routeId,
  directions: q.direction,
  isActive: q.isActive,
  day: q.day,
  validOn: q.validOn,
  q: q.q,
});

/** GET /school/trip-schedules — JSON page or CSV export. */
export async function list(req: Request, res: Response, q: TripScheduleListQuery): Promise<void> {
  const { orderBy } = parseSort(q.sort, SORT);
  const filter = filterOf(q);
  if (q.format === 'csv') {
    const rows = await withRequestTenant(req, (tx) => repo.exportRows(tx, filter, orderBy), { readOnly: true });
    const csv = createCsvWriter<TripScheduleItem>(res, { fileName: 'trip-schedules.csv', columns: CSV_COLUMNS });
    await csv.writeAll(rows.map(toScheduleItem));
    await csv.end();
    return;
  }
  const { page, limit, offset } = parsePagination(q);
  const { rows, total } = await withRequestTenant(req, (tx) => repo.page(tx, filter, { orderBy, limit, offset }), { readOnly: true });
  sendList(res, rows.map((r) => toScheduleItem(r as ScheduleRow)), listMeta({ page, limit, total }));
}

async function item(tx: Tx, id: string): Promise<TripScheduleItem> {
  const row = await repo.findSchedule(tx, id);
  if (!row) throw scheduleNotFound();
  return toScheduleItem(row);
}

/** GET /school/trip-schedules/:id */
export function get(req: Request, id: string): Promise<TripScheduleItem> {
  return withRequestTenant(req, (tx) => item(tx, id), { readOnly: true });
}

interface Plan {
  busId: string;
  routeId: string;
  direction: string;
  plannedStartTime: string;
  daysOfWeek: number[];
  validFrom: string | null;
  validTo: string | null;
  isActive: boolean;
}

/** Validates bus, route and direction of the resulting schedule; rejects same-bus overlaps. */
async function checkPlan(tx: Tx, plan: Omit<Plan, 'direction'> & { direction?: string }, exceptId: string | null, checkBusRoute: boolean): Promise<Plan> {
  await repo.lockBusSchedules(tx, plan.busId);
  const bus = await assignmentsRepo.findBus(tx, plan.busId);
  if (!bus) throw notFound('Bus not found.', { field: 'busId' });
  const route = await repo.findRouteForSchedule(tx, plan.routeId);
  if (!route) throw notFound('Route not found.', { field: 'routeId' });
  if (plan.direction && plan.direction !== route.direction) throw fieldError('direction', `Route ${route.code} runs in the ${route.direction}`);
  if (checkBusRoute && plan.isActive) {
    if (bus.status === 'retired') throw invalidState('A retired bus cannot get active schedules.', { field: 'busId' });
    if (!route.is_active) throw invalidState(`Route ${route.code} is inactive. Activate it first.`, { field: 'routeId' });
  }
  if (plan.validFrom && plan.validTo && plan.validTo < plan.validFrom) throw fieldError('validTo', 'Must not be before validFrom');
  const resolved: Plan = { ...plan, direction: route.direction };
  if (resolved.isActive) {
    const others = await repo.sameBusSchedules(tx, plan.busId, exceptId, plan.validFrom, plan.validTo);
    const conflicts = findConflicts(
      { plannedStartTime: plan.plannedStartTime, durationMin: route.estimated_duration_min, daysOfWeek: plan.daysOfWeek },
      others.map((o) => {
        const start = hhmmOf(o.planned_start_time)!;
        return {
          id: o.id,
          name: o.name,
          routeCode: o.route_code,
          direction: o.direction as Direction,
          plannedStartTime: start,
          durationMin: o.estimated_duration_min,
          daysOfWeek: o.days_of_week.map(Number),
          estimatedEndTime: endTimeOf(start, o.estimated_duration_min),
        };
      }),
    );
    if (conflicts.length) {
      throw conflict(`Bus ${bus.code} already runs another schedule in this time window on a shared weekday.`, {
        reason: 'SCHEDULE_OVERLAP',
        estimatedDurationMin: route.estimated_duration_min,
        estimatedEndTime: endTimeOf(plan.plannedStartTime, route.estimated_duration_min),
        conflicts,
      });
    }
  }
  return resolved;
}

/** Opens the bus ↔ route assignment for an active schedule when there is none (audited). */
async function ensureBusAssigned(tx: Tx, plan: Plan, scheduleId: string): Promise<void> {
  if (!plan.isActive) return;
  if ((await assignmentsRepo.openAssignments(tx, plan.routeId, plan.busId)).length) return;
  const id = await assignmentsRepo.insertAssignment(tx, plan.routeId, plan.busId, 'now');
  await audit.log(tx, { action: 'route.assign_bus', entityType: 'route', entityId: plan.routeId, new: { assignmentId: id, busId: plan.busId, scheduleId, reason: 'schedule' } });
}

/** POST /school/trip-schedules */
export async function create(req: Request, body: CreateTripScheduleBody): Promise<TripScheduleItem> {
  return withRequestTenant(req, async (tx) => {
    const plan = await checkPlan(
      tx,
      { ...body, validFrom: body.validFrom ?? null, validTo: body.validTo ?? null, isActive: body.isActive ?? true },
      null,
      true,
    );
    const id = await repo.insertSchedule(tx, { ...body, direction: plan.direction });
    await ensureBusAssigned(tx, plan, id);
    // Today's run (when still ahead): the 00:05 generation has already passed.
    const trips = plan.isActive ? await restoreScheduleTrips(tx, id) : { restored: 0, created: 0 };
    const created = await item(tx, id);
    await audit.log(tx, { action: 'trip_schedule.create', entityType: 'trip_schedule', entityId: id, new: { ...plan, name: body.name ?? null, tripsCreated: trips.created } });
    return created;
  });
}

const MATERIAL: (keyof UpdateTripScheduleBody)[] = ['busId', 'routeId', 'direction', 'plannedStartTime', 'daysOfWeek', 'validFrom', 'validTo'];

/** PATCH /school/trip-schedules/:id */
export async function update(req: Request, id: string, body: UpdateTripScheduleBody): Promise<TripScheduleItem> {
  return withRequestTenant(req, async (tx) => {
    const before = await repo.lockSchedule(tx, id);
    if (!before) throw scheduleNotFound();
    const routeChanged = body.routeId !== undefined && body.routeId !== before.route_id;
    const merged = {
      busId: body.busId ?? before.bus_id,
      routeId: body.routeId ?? before.route_id,
      direction: body.direction ?? (routeChanged ? undefined : before.direction),
      plannedStartTime: body.plannedStartTime ?? hhmmOf(before.planned_start_time)!,
      daysOfWeek: body.daysOfWeek ?? before.days_of_week.map(Number),
      validFrom: body.validFrom !== undefined ? body.validFrom : before.valid_from,
      validTo: body.validTo !== undefined ? body.validTo : before.valid_to,
      isActive: body.isActive ?? before.is_active,
    };
    const reactivated = merged.isActive && !before.is_active;
    const busOrRouteChanged = merged.busId !== before.bus_id || routeChanged;
    const plan = await checkPlan(tx, merged, id, reactivated || busOrRouteChanged);
    await repo.updateSchedule(tx, id, { ...body, direction: plan.direction });
    await ensureBusAssigned(tx, plan, id);
    const after = await repo.lockSchedule(tx, id);
    const diff = changedFields(scheduleAuditView(before), scheduleAuditView(after!));
    let trips: { cancelled: number; updated: number } = { cancelled: 0, updated: 0 };
    let restored = { restored: 0, created: 0 };
    const material = MATERIAL.some((k) => body[k] !== undefined);
    if (!plan.isActive && before.is_active) trips = { cancelled: await cancelPendingTrips(tx, id, 'Schedule deactivated'), updated: 0 };
    else if (plan.isActive && material) trips = await syncPendingTrips(tx, id, 'Schedule changed');
    // Re-activated, or edited so that it runs on a date again: trips the earlier state cancelled come
    // back and today's missing run is created (not overdue only).
    if (plan.isActive && (reactivated || material)) restored = await restoreScheduleTrips(tx, id);
    if (Object.keys(diff.new).length) {
      const restoredAudit = restored.restored || restored.created ? { tripsRestored: restored.restored, tripsCreated: restored.created } : {};
      await audit.log(tx, { action: 'trip_schedule.update', entityType: 'trip_schedule', entityId: id, old: diff.old, new: { ...diff.new, tripsCancelled: trips.cancelled, tripsUpdated: trips.updated, ...restoredAudit } });
    }
    return item(tx, id);
  });
}

/** DELETE /school/trip-schedules/:id — soft delete; cancels its not-yet-started trips from today on. */
export async function remove(req: Request, id: string): Promise<{ id: string; deleted: true; tripsCancelled: number }> {
  return withRequestTenant(req, async (tx) => {
    const before = await repo.lockSchedule(tx, id);
    if (!before) throw scheduleNotFound();
    await repo.softDeleteSchedule(tx, id);
    const tripsCancelled = await cancelPendingTrips(tx, id, 'Schedule deleted');
    await audit.log(tx, { action: 'trip_schedule.delete', entityType: 'trip_schedule', entityId: id, old: scheduleAuditView(before), new: { tripsCancelled } });
    return { id, deleted: true as const, tripsCancelled };
  });
}
