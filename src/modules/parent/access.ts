// Per-child access rules (BP §4.6, §15.3, Appendix B). Every /parent/children/:studentId/* call
// runs after guards.parent(): X-School-Id was validated against an active child link and the tenant
// context is that school with role 'parent'. Inside it:
//   * a student that is not linked to the caller in THIS school is 404 (never 403 — existence is not
//     revealed, BP §16); RLS (parent_scope on students/student_parents) returns no row for it;
//   * tracking, bus and staff need a CURRENT assignment (school-local today) of the child; with a
//     direction the assignment of that direction. A reassignment moves access immediately because
//     every call reads the assignment rows afresh (no cache).
import type { Direction } from '@wimb/shared';
import type { Tx } from '../../db/tenant.js';
import { notFound } from '../../shared/errors.js';
import * as repo from './repository.js';
import { isAssigned, pickDirection, type AssignedRow } from './view.js';

export const NO_ASSIGNMENT = 'NO_ASSIGNMENT';

export interface ChildAccess {
  studentId: string;
  fullName: string;
  /** Current assignments (morning first). */
  assigned: AssignedRow[];
}

/** The linked child with its current assignments, or 404. */
export async function loadChild(tx: Tx, studentId: string): Promise<ChildAccess> {
  const rows = await repo.childRowsFor(tx, studentId);
  const first = rows[0];
  if (!first) throw notFound('Child not found.');
  const assigned = rows.filter(isAssigned).sort((a, b) => (a.direction === b.direction ? 0 : a.direction === 'morning' ? -1 : 1));
  return { studentId: first.student_id, fullName: first.full_name, assigned };
}

/** The assignment to use: the requested direction, or the one that matters now. 404 without one. */
export function assignmentFor(child: ChildAccess, direction?: Direction): AssignedRow {
  const row = direction ? child.assigned.find((r) => r.direction === direction) : pickDirection(child.assigned);
  if (!row) {
    throw notFound(direction ? `No bus is assigned to this child for the ${direction} trip.` : 'No bus is assigned to this child.', { reason: NO_ASSIGNMENT });
  }
  return row;
}
