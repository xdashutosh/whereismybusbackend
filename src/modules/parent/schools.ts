// The parent's schools (BP §4.6): parent_children_index() (SECURITY DEFINER, one statement through
// definerQuery — contract §4, deviation 8) lists the schools with an active child link; each school
// must also be active, not deleted and within its plan, exactly as resolveTenant requires for an
// X-School-Id request. Parent principals carry no school, so cross-school views (GET /parent/children,
// the child:{studentId}:live room) resolve the schools here and then work per school in the parent's
// own tenant context.
import type { RequestHandler } from 'express';
import { LRUCache } from 'lru-cache';
import type { Tx } from '../../db/tenant.js';
import { definerQuery } from '../../db/definer.js';
import { withTenant } from '../../db/tenant.js';
import { loadSchoolStateFromDb, runSubscriptionChecks, type SchoolState, type SchoolStateLoader } from '../../middleware/resolveTenant.js';
import { logger as rootLogger } from '../../shared/logger.js';

export interface ParentLink {
  schoolId: string;
  studentId: string;
}

/** Active (school, student) links of a parent account. */
export async function parentLinks(parentId: string): Promise<ParentLink[]> {
  const rows = await definerQuery<{ school_id: string; student_id: string }>('select school_id, student_id from parent_children_index($1::uuid)', [parentId]);
  return rows.map((r) => ({ schoolId: r.school_id, studentId: r.student_id }));
}

/** The school's state when the parent may use it right now (active, not deleted, plan valid), else null. */
export async function usableSchool(schoolId: string, loadSchool: SchoolStateLoader = loadSchoolStateFromDb): Promise<SchoolState | null> {
  const state = await loadSchool(schoolId);
  if (!state || state.deleted || state.status !== 'active') return null;
  try {
    await runSubscriptionChecks(state, null);
    return state;
  } catch {
    return null;
  }
}

/** Runs `fn` in the parent's tenant context of one school (read-only by default). */
export function withParentSchool<T>(parentId: string, school: SchoolState, fn: (tx: Tx) => Promise<T>, opts: { readOnly?: boolean } = {}): Promise<T> {
  return withTenant({ schoolId: school.id, actorId: parentId, role: 'parent' }, fn, {
    readOnly: opts.readOnly ?? true,
    tenant: { tenantMode: school.tenantMode, dbConnectionRef: school.dbConnectionRef },
  });
}

// ── "the parent uses this school" (migration 854: school_parents.first_signed_in_at) ──
// Recorded once per (parent, school) when the parent opens its children list or a per-child view of
// that school. Schools only ever see this per-school flag (never the global last_login_at), and a
// school may end the parent's global sessions or clear its lock only while no OTHER school is used.
const markedSchools = new LRUCache<string, true>({ max: 50_000, ttl: 6 * 60 * 60 * 1000 });
const markLog = rootLogger.child({ module: 'parent.schools' });

/** Marks `school` as used by the parent (best effort, at most one write per process and pair). */
export async function markSchoolUsed(parentId: string, school: Pick<SchoolState, 'id' | 'tenantMode' | 'dbConnectionRef'>): Promise<void> {
  const key = `${parentId}:${school.id}`;
  if (markedSchools.has(key)) return;
  try {
    await withTenant({ schoolId: school.id, actorId: parentId, role: 'parent' }, (tx) => tx.query('select parent_mark_school_used()'), {
      tenant: { tenantMode: school.tenantMode, dbConnectionRef: school.dbConnectionRef },
    });
    markedSchools.set(key, true);
  } catch (err) {
    markLog.warn({ err, schoolId: school.id }, 'Parent school use could not be recorded');
  }
}

/** Route middleware after guards.parent(): records that the parent used the school of X-School-Id. */
export const markTenantSchoolUsed: RequestHandler = async (req, _res, next) => {
  if (req.auth?.role === 'parent' && req.tenant) {
    await markSchoolUsed(req.auth.actorId, { id: req.tenant.schoolId, tenantMode: req.tenant.tenantMode, dbConnectionRef: req.tenant.dbConnectionRef });
  }
  next();
};

/** Test hook: forget which pairs were recorded. */
export function resetMarkedSchools(): void {
  markedSchools.clear();
}
