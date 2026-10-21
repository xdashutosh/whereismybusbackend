// Student assignments (BP §8.3 Assignments, §13.3 "bus → route → stop per direction", §19 #8).
// Rules for a target {busId, routeId, stopId} of a direction:
//   · bus, route and stop exist in this school (404 otherwise — foreign ids look missing)
//   · the bus is not retired, the route is active and runs in that direction
//   · the stop belongs to the route, and the bus serves the route (open bus ↔ route assignment or
//     a live schedule) — 400 VALIDATION_ERROR with the offending field otherwise
// A change starts on `effectiveFrom` (school-local, default today, never in the past): rows not
// ended by then are closed at that date, a new open row starts on it; identical targets are left
// alone. null ends the direction's assignment. History is never rewritten.
import type { AssignmentWarning, BulkAssignmentResult, Direction, StudentAssignmentDto, StudentAssignmentResult } from '@wimb/shared';
import { DIRECTIONS } from '@wimb/shared';
import type { Request, Response } from 'express';
import type { Tx } from '../../db/tenant.js';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { audit } from '../../shared/audit.js';
import { list as sendList } from '../../shared/envelope.js';
import { notFound, validationError } from '../../shared/errors.js';
import { logger as rootLogger } from '../../shared/logger.js';
import { listMeta, parsePagination } from '../../shared/pagination.js';
import { realtime } from '../../shared/realtime.js';
import * as repo from './assignmentsRepository.js';
import { byDirection, toAssignmentDto } from './dto.js';
import * as studentsRepo from './repository.js';
import type { AssignmentTarget, BulkAssignmentBody, StudentAssignmentBody, StudentAssignmentHistoryQuery } from './schemas.js';

const MAX_DAYS_AHEAD = 366;

const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** effectiveFrom (default today) within [today, today + 366 days]. */
async function effectiveDate(tx: Tx, requested: string | undefined): Promise<string> {
  const today = await repo.localToday(tx);
  const date = requested ?? today;
  if (date < today) throw validationError('The change cannot start in the past.', [{ path: 'effectiveFrom', message: `Must be ${today} (today) or later` }]);
  if (date > addDays(today, MAX_DAYS_AHEAD)) throw validationError('The change starts too far ahead.', [{ path: 'effectiveFrom', message: 'Must be within a year from today' }]);
  return date;
}

/** Validates a target (see header) → the bus code/capacity for warnings. */
export async function validateTarget(tx: Tx, direction: Direction, t: AssignmentTarget, date: string, pathPrefix: string = direction): Promise<{ busCode: string }> {
  const c = await repo.checkTarget(tx, t, date);
  const at = (field: string) => `${pathPrefix}.${field}`;
  if (!c.bus_id) throw notFound('Bus not found.', { field: at('busId') });
  if (!c.route_id) throw notFound('Route not found.', { field: at('routeId') });
  if (!c.stop_id) throw notFound('Stop not found.', { field: at('stopId') });
  const issues: { path: string; message: string }[] = [];
  if (c.bus_status === 'retired') issues.push({ path: at('busId'), message: 'The bus is retired' });
  if (c.route_direction !== direction) issues.push({ path: at('routeId'), message: `The route runs in the ${c.route_direction} direction, not ${direction}` });
  else if (!c.route_active) issues.push({ path: at('routeId'), message: 'The route is inactive' });
  if (c.stop_route_id !== c.route_id) issues.push({ path: at('stopId'), message: 'The stop does not belong to the route' });
  if (!c.bus_serves_route) issues.push({ path: at('busId'), message: 'The bus does not serve this route (assign the bus to the route or add a schedule first)' });
  if (issues.length) throw validationError('The assignment is not valid.', issues);
  return { busCode: c.bus_code ?? '' };
}

async function capacityWarnings(tx: Tx, targets: { direction: Direction; busId: string }[], date: string): Promise<AssignmentWarning[]> {
  const out: AssignmentWarning[] = [];
  for (const t of targets) {
    const o = await repo.capacityOverflow(tx, t.busId, t.direction, date);
    if (o) out.push({ code: 'BUS_OVER_CAPACITY', busId: o.bus_id, busCode: o.code, direction: t.direction, capacity: o.capacity, assigned: o.assigned });
  }
  return out;
}

const log = rootLogger.child({ module: 'students.assignments' });

/**
 * After commit: parents whose child moved bus/direction (or lost the assignment) are re-checked in
 * the trip rooms they joined (realtime.revalidateActors). Best effort — the periodic socket sweep is
 * the backstop.
 */
async function revalidateParents(parentIds: readonly string[]): Promise<void> {
  if (!parentIds.length) return;
  try {
    await realtime.revalidateActors(parentIds);
  } catch (err) {
    log.warn({ err }, 'Parent room revalidation could not be requested');
  }
}

const sameTarget = (row: repo.OpenAssignmentRow, t: AssignmentTarget) => row.bus_id === t.busId && row.route_id === t.routeId && row.stop_id === t.stopId;

const viewOf = (rows: repo.OpenAssignmentRow[]) => rows.map((r) => ({ busId: r.bus_id, routeId: r.route_id, stopId: r.stop_id, validFrom: r.valid_from, validTo: r.valid_to }));

/** PUT /school/students/:id/assignment */
export async function assign(req: Request, studentId: string, body: StudentAssignmentBody): Promise<StudentAssignmentResult> {
  const { result, parentIds } = await withRequestTenant(req, async (tx) => {
    if (!(await studentsRepo.lockStudent(tx, studentId))) throw notFound('Student not found.');
    const date = await effectiveDate(tx, body.effectiveFrom);
    const changed: Direction[] = [];
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const assigned: { direction: Direction; busId: string }[] = [];
    for (const direction of DIRECTIONS) {
      const target = body[direction];
      if (target === undefined) continue;
      if (target) await validateTarget(tx, direction, target, date);
      const rows = await repo.effectiveRows(tx, [studentId], direction, date);
      // Unchanged: the only row still running on `date` already is exactly this target.
      if (target && rows.length === 1 && sameTarget(rows[0]!, target) && rows[0]!.valid_from <= date && rows[0]!.valid_to === null) continue;
      if (!target && rows.length === 0) continue;
      await repo.closeFrom(tx, [studentId], direction, date);
      if (target) {
        await repo.openFrom(tx, [studentId], direction, target, date);
        assigned.push({ direction, busId: target.busId });
      }
      changed.push(direction);
      before[direction] = viewOf(rows);
      after[direction] = target ?? null;
    }
    if (changed.length) {
      await audit.log(tx, { action: 'student.assignment_change', entityType: 'student', entityId: studentId, old: before, new: { effectiveFrom: date, ...after } });
    }
    const effective = (await repo.effectiveForStudent(tx, studentId)).map(toAssignmentDto);
    const result: StudentAssignmentResult = {
      studentId,
      effectiveFrom: date,
      changed,
      assignments: byDirection(effective),
      effectiveAssignments: effective,
      warnings: await capacityWarnings(tx, assigned, date),
    };
    return { result, parentIds: changed.length ? await repo.linkedParentIds(tx, [studentId]) : [] };
  });
  await revalidateParents(parentIds);
  return result;
}

/** POST /school/assignments/bulk — the same change for many students in one transaction. */
export async function bulkAssign(req: Request, body: BulkAssignmentBody): Promise<BulkAssignmentResult> {
  const { result, parentIds } = await withRequestTenant(req, async (tx) => {
    const found = new Set((await studentsRepo.lockStudents(tx, body.studentIds)).map((r) => r.id));
    const missing = body.studentIds.filter((id) => !found.has(id));
    if (missing.length) throw notFound(`${missing.length} of the selected students were not found.`, { studentIds: missing });
    const date = await effectiveDate(tx, body.effectiveFrom);
    const directions: BulkAssignmentResult['directions'] = [];
    const assigned: { direction: Direction; busId: string }[] = [];
    for (const direction of DIRECTIONS) {
      const target = body[direction];
      if (target === undefined) continue;
      if (target) await validateTarget(tx, direction, target, date);
      const rows = await repo.effectiveRows(tx, body.studentIds, direction, date);
      const byStudent = new Map<string, repo.OpenAssignmentRow[]>();
      for (const r of rows) byStudent.set(r.student_id, [...(byStudent.get(r.student_id) ?? []), r]);
      const unchanged = body.studentIds.filter((id) => {
        const own = byStudent.get(id) ?? [];
        if (!target) return own.length === 0;
        return own.length === 1 && sameTarget(own[0]!, target) && own[0]!.valid_from <= date && own[0]!.valid_to === null;
      });
      const skip = new Set(unchanged);
      const toChange = body.studentIds.filter((id) => !skip.has(id));
      const ended = toChange.length ? await repo.closeFrom(tx, toChange, direction, date) : 0;
      const opened = target ? await repo.openFrom(tx, toChange, direction, target, date) : 0;
      if (target && opened) assigned.push({ direction, busId: target.busId });
      directions.push({ direction, assigned: opened, ended, unchanged: unchanged.length });
    }
    await audit.log(tx, {
      action: 'student.assignment_bulk',
      entityType: 'student',
      entityId: null,
      new: { effectiveFrom: date, studentIds: body.studentIds, morning: body.morning, afternoon: body.afternoon, directions },
    });
    const result: BulkAssignmentResult = { effectiveFrom: date, students: body.studentIds.length, directions, warnings: await capacityWarnings(tx, assigned, date) };
    const anyChange = directions.some((d) => d.assigned > 0 || d.ended > 0);
    return { result, parentIds: anyChange ? await repo.linkedParentIds(tx, body.studentIds) : [] };
  });
  await revalidateParents(parentIds);
  return result;
}

/** GET /school/students/:id/assignment-history */
export async function history(req: Request, res: Response, studentId: string, q: StudentAssignmentHistoryQuery): Promise<void> {
  const { page, limit, offset } = parsePagination(q);
  const { rows, total } = await withRequestTenant(
    req,
    async (tx) => {
      if (!(await studentsRepo.findListRow(tx, studentId))) throw notFound('Student not found.');
      return repo.history(tx, studentId, { direction: q.direction, limit, offset });
    },
    { readOnly: true },
  );
  const items: StudentAssignmentDto[] = (rows as { a: Parameters<typeof toAssignmentDto>[0] }[]).map((r) => toAssignmentDto(r.a));
  sendList(res, items, listMeta({ page, limit, total }));
}
