// Fixtures of the parent suites: request helpers for parent tokens (X-School-Id per call), the
// two-school fixture with its school trips moved to the school-local date (the fixture uses UTC
// dates), and helpers that link a new child to a parent with a current assignment.
import { HEADERS } from '@wimb/shared';
import request from 'supertest';
import type { TestApp } from './helpers/authApp.js';
import { ownerQuery } from './helpers/db.js';
import * as f from './helpers/factories.js';

export const api = (path: string) => `/api/v1${path}`;
export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** School-local date (Asia/Kolkata by default) n days from today. */
export async function localDate(timezone = 'Asia/Kolkata', offsetDays = 0): Promise<string> {
  const { rows } = await ownerQuery<{ d: string }>(`select ((now() at time zone $1)::date + $2::int)::text as d`, [timezone, offsetDays]);
  return rows[0]!.d;
}

/** Parent-app requests: bearer + optional X-School-Id. */
export function asParent(t: TestApp, token: string, schoolId?: string | null) {
  const h: Record<string, string> = bearer(token);
  if (schoolId) h[HEADERS.SCHOOL_ID] = schoolId;
  return {
    get: (path: string) => request(t.app).get(api(path)).set(h),
    put: (path: string, body: object = {}) => request(t.app).put(api(path)).set(h).send(body),
    post: (path: string, body: object = {}) => request(t.app).post(api(path)).set(h).send(body),
  };
}

/** Moves the fixture's school trips and assignment windows onto the school-local calendar. */
export async function alignFixtureDates(fx: f.TwoSchoolFixture): Promise<void> {
  const today = await localDate();
  const ids = [fx.a.school.id, fx.b.school.id];
  await ownerQuery(`update trips set trip_date = $2::date where school_id = any ($1::uuid[]) and trip_type = 'school'`, [ids, today]);
  await ownerQuery(`update student_assignments set valid_from = $2::date - 30 where school_id = any ($1::uuid[])`, [ids, today]);
}

export interface LinkedChild {
  student: f.TenantRow;
  assignment: f.TenantRow;
}

/** A new active student linked to `parentId` (school profile created when missing) and assigned to bus/route/stop. */
export async function linkChild(
  schoolId: string,
  parentId: string,
  a: { busId: string; routeId: string; stopId: string; direction?: 'morning' | 'afternoon' },
  o: { fullName?: string } = {},
): Promise<LinkedChild> {
  const { rows } = await ownerQuery('select 1 from school_parents where school_id = $1 and parent_account_id = $2', [schoolId, parentId]);
  if (!rows.length) await f.schoolParent(schoolId, parentId);
  const student = await f.student(schoolId, { full_name: o.fullName ?? 'Kavya Iyer' });
  await f.studentParent(schoolId, student.id, parentId);
  const today = await localDate();
  const assignment = await f.studentAssignment(schoolId, { studentId: student.id, busId: a.busId, routeId: a.routeId, stopId: a.stopId, direction: a.direction ?? 'morning' }, { valid_from: today });
  return { student, assignment };
}

/** Ends a student's current assignment(s) today and assigns the new bus/route/stop from today. */
export async function reassign(schoolId: string, studentId: string, a: { busId: string; routeId: string; stopId: string; direction?: 'morning' | 'afternoon' }): Promise<void> {
  const today = await localDate();
  const direction = a.direction ?? 'morning';
  // The current row ends today (valid_to exclusive); one that only starts today is replaced.
  await ownerQuery(`delete from student_assignments where student_id = $1 and trip_direction = $2 and valid_from >= $3::date`, [studentId, direction, today]);
  await ownerQuery(`update student_assignments set valid_to = $3::date where student_id = $1 and trip_direction = $2 and valid_to is null`, [studentId, direction, today]);
  await f.studentAssignment(schoolId, { studentId, busId: a.busId, routeId: a.routeId, stopId: a.stopId, direction }, { valid_from: today });
}

/** Removes every current assignment of a student (ends them today). */
export async function unassign(studentId: string): Promise<void> {
  const today = await localDate();
  await ownerQuery(`delete from student_assignments where student_id = $1 and valid_from >= $2::date`, [studentId, today]);
  await ownerQuery(`update student_assignments set valid_to = $2::date where student_id = $1 and (valid_to is null or valid_to > $2::date)`, [studentId, today]);
}
