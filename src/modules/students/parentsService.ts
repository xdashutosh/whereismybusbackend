// Parents service (BP §4.6, §8.3 Parents, §13.3; contract §4, §6). A parent is identified
// globally by its E.164 mobile number (parent_accounts, created or reused through
// ensure_parent_account — never revealing whether another school knows the number); the school's
// view of the parent (name, e-mail, relation, active flag) is its school_parents row, which is the
// id used by the API. Deactivating or deleting a parent, and resetting its access, end its sessions
// and disconnect its sockets (parentSessions.ts). Every write is audited in its transaction.
import type { ParentDetail, ParentListItem, ResetParentAccessResult, StudentParentLinkDto } from '@wimb/shared';
import type { Request, Response } from 'express';
import type { Tx } from '../../db/tenant.js';
import { PG_ERROR, isPgError } from '../../db/pool.js';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { audit, changedFields } from '../../shared/audit.js';
import { createCsvWriter, type CsvColumn } from '../../shared/csv.js';
import { list as sendList } from '../../shared/envelope.js';
import { duplicate, invalidState, notFound } from '../../shared/errors.js';
import { listMeta, parsePagination, parseSort } from '../../shared/pagination.js';
import { maskPhone } from '../../shared/phone.js';
import { parentAuditView, toParentLinkDto, toParentListItem, type ParentListRow, type SchoolParentRow } from './dto.js';
import { disconnectParentSockets, resetParentSessions, revokeParentSessionsQuietly } from './parentSessions.js';
import * as repo from './parentsRepository.js';
import * as studentsRepo from './repository.js';
import type { CreateParentBody, ParentInput, ParentListQuery, ResetParentAccessBody, StudentParentLinkBody, UpdateParentBody } from './schemas.js';

const SORT = {
  allowed: { fullName: 'lower(sp.full_name)', phone: 'pa.phone', childCount: 'ch.child_count', isActive: 'sp.is_active', createdAt: 'sp.created_at', updatedAt: 'sp.updated_at' },
  defaultSort: 'fullName',
  tiebreaker: 'sp.id',
};

const CSV_COLUMNS: CsvColumn<ParentListItem>[] = [
  { header: 'Name', key: 'fullName' },
  { header: 'Mobile', key: 'phone' },
  { header: 'E-mail', key: 'email' },
  { header: 'Relation', key: 'relation' },
  { header: 'Alternate phone', key: 'alternatePhone' },
  { header: 'Active', value: (r) => (r.isActive ? 'yes' : 'no') },
  { header: 'Signed in', value: (r) => (r.hasSignedIn ? 'yes' : 'no') },
  { header: 'Children', value: (r) => r.children.map((c) => (c.admissionNo ? `${c.fullName} (${c.admissionNo})` : c.fullName)) },
  { header: 'Created (UTC)', key: 'createdAt' },
];

/** GET /school/parents — JSON page or CSV export. */
export async function list(req: Request, res: Response, q: ParentListQuery): Promise<void> {
  const { orderBy } = parseSort(q.sort, SORT);
  const filter: repo.ParentFilter = { q: q.q, isActive: q.isActive, hasChildren: q.hasChildren, studentId: q.studentId };
  if (q.format === 'csv') {
    const rows = await withRequestTenant(req, (tx) => repo.exportRows(tx, filter, orderBy), { readOnly: true });
    const csv = createCsvWriter<ParentListItem>(res, { fileName: 'parents.csv', columns: CSV_COLUMNS });
    await csv.writeAll(rows.map(toParentListItem));
    await csv.end();
    return;
  }
  const { page, limit, offset } = parsePagination(q);
  const { rows, total } = await withRequestTenant(req, (tx) => repo.page(tx, filter, { orderBy, limit, offset }), { readOnly: true });
  sendList(res, (rows as ParentListRow[]).map(toParentListItem), listMeta({ page, limit, total }));
}

async function detail(tx: Tx, id: string): Promise<ParentDetail> {
  const row = await repo.findListRow(tx, id);
  if (!row) throw notFound('Parent not found.');
  return toParentListItem(row);
}

/** GET /school/parents/:id */
export function get(req: Request, id: string): Promise<ParentDetail> {
  return withRequestTenant(req, (tx) => detail(tx, id), { readOnly: true });
}

/**
 * Registers a parent in this school by phone: creates or reuses the global identity, then creates
 * the school's row (or restores a deleted one). `reuseLive` returns an existing live row instead of
 * refusing it (linking flows). → the row and whether it was created/restored.
 */
export async function registerParent(tx: Tx, input: ParentInput, { reuseLive = false }: { reuseLive?: boolean } = {}): Promise<{ row: SchoolParentRow; created: boolean }> {
  const accountId = await repo.ensureAccount(tx, input.phone, input.fullName);
  const existing = await repo.schoolRowOfAccount(tx, accountId);
  const values: repo.ParentValues = { fullName: input.fullName, email: input.email, relation: input.relation, alternatePhone: input.alternatePhone, isActive: input.isActive };
  if (existing && existing.deleted_at === null) {
    if (reuseLive) return { row: existing, created: false };
    throw duplicate('A parent with this mobile number is already registered in your school.', { parentId: existing.id });
  }
  const row = existing ? await repo.restoreSchoolParent(tx, existing.id, values) : await repo.insertSchoolParent(tx, accountId, values);
  await audit.log(tx, { action: existing ? 'parent.restore' : 'parent.create', entityType: 'parent', entityId: row.id, new: parentAuditView(row, input.phone) });
  return { row, created: true };
}

/** POST /school/parents */
export async function create(req: Request, body: CreateParentBody): Promise<ParentDetail> {
  return withRequestTenant(req, async (tx) => detail(tx, (await registerParent(tx, body)).row.id));
}

/** Phone correction through the definer function with friendly errors. */
async function changePhone(tx: Tx, accountId: string, phone: string): Promise<void> {
  try {
    await repo.updatePhone(tx, accountId, phone);
  } catch (err) {
    if (isPgError(err, PG_ERROR.RAISE_EXCEPTION)) {
      throw invalidState('This mobile number is also registered by another school, so it cannot be changed here. Register the new number as a separate parent and link the children to it.', { reason: 'SHARED_PARENT' });
    }
    if (isPgError(err, PG_ERROR.UNIQUE_VIOLATION)) throw duplicate('Another parent already uses this mobile number.');
    throw err;
  }
}

/** PATCH /school/parents/:id */
export async function update(req: Request, id: string, body: UpdateParentBody): Promise<ParentDetail> {
  const result = await withRequestTenant(req, async (tx) => {
    const before = await repo.lockParent(tx, id);
    if (!before) throw notFound('Parent not found.');
    const sharedElsewhere = await repo.usedElsewhere(tx, before.parent_account_id);
    const phoneChanged = body.phone !== undefined && body.phone !== before.phone;
    if (phoneChanged) await changePhone(tx, before.parent_account_id, body.phone!);
    const { phone: _phone, ...fields } = body;
    const after = Object.values(fields).some((v) => v !== undefined) ? await repo.updateSchoolParent(tx, id, fields) : before;
    const diff = changedFields(parentAuditView(before, before.phone), parentAuditView(after, phoneChanged ? body.phone : before.phone));
    if (Object.keys(diff.new).length) await audit.log(tx, { action: 'parent.update', entityType: 'parent', entityId: id, ...diff });
    return { item: await detail(tx, id), deactivated: before.is_active && !after.is_active, phoneChanged, accountId: before.parent_account_id, sharedElsewhere };
  });
  // A new number (only possible for a parent of this school alone) or a deactivation ends the
  // parent's sessions (contract §6) — never those of a parent who uses another school.
  if (result.phoneChanged) await revokeParentSessionsQuietly(result.accountId, 'parent_phone_changed');
  else if (result.deactivated) await endParentAccessHere(result.accountId, result.sharedElsewhere, 'parent_deactivated');
  return result.item;
}

/** DELETE /school/parents/:id — soft delete; the parent's links in this school are removed. */
export async function remove(req: Request, id: string): Promise<{ id: string; deleted: true }> {
  const { accountId, sharedElsewhere } = await withRequestTenant(req, async (tx) => {
    const parent = await repo.lockParent(tx, id);
    if (!parent) throw notFound('Parent not found.');
    const shared = await repo.usedElsewhere(tx, parent.parent_account_id);
    const linksRemoved = await repo.softDeleteParent(tx, id, parent.parent_account_id);
    await audit.log(tx, { action: 'parent.delete', entityType: 'parent', entityId: id, old: parentAuditView(parent, parent.phone), new: { linksRemoved } });
    return { accountId: parent.parent_account_id, sharedElsewhere: shared };
  });
  await endParentAccessHere(accountId, sharedElsewhere, 'parent_removed');
  return { id, deleted: true as const };
}

/**
 * POST /school/parents/:id/reset-access — the parent signs in again with an OTP on every device:
 * all sessions are revoked (sockets disconnected) and a failed-password lock is cleared. The
 * global identity is not otherwise changed (a password fallback is set by the parent itself).
 * Sessions and the lock are global, so they are reset only while the parent uses no OTHER school
 * (school_parent_used_elsewhere, migration 854): a school must never sign out, or unlock, a parent
 * who uses another school — any school can register any number. `sharedAccount` is reported only
 * when the parent has used this school too (otherwise the response would reveal another school's
 * parent: it then reads exactly like a number nobody has used).
 */
export async function resetAccess(req: Request, id: string, body: ResetParentAccessBody): Promise<ResetParentAccessResult> {
  const parent = await withRequestTenant(
    req,
    async (tx) => {
      const p = await repo.findParent(tx, id);
      if (!p) throw notFound('Parent not found.');
      return { ...p, activeChildren: await repo.activeChildCount(tx, p.parent_account_id), sharedElsewhere: await repo.usedElsewhere(tx, p.parent_account_id) };
    },
    { readOnly: true },
  );
  const reset = parent.sharedElsewhere ? { revokedSessionIds: [] } : await resetParentSessions(parent.parent_account_id, 'parent_access_reset');
  const blockers: string[] = [];
  if (!parent.is_active) blockers.push('PARENT_INACTIVE');
  if (!parent.account_active) blockers.push('ACCOUNT_INACTIVE');
  if (parent.activeChildren === 0) blockers.push('NO_ACTIVE_CHILD');
  const sharedAccount = parent.sharedElsewhere && parent.used_here;
  // The lock is cleared and audited in one school transaction (school_clear_parent_lockout only
  // touches a parent linked to this school and used by no other school).
  return withRequestTenant(req, async (tx) => {
    const unlocked = parent.sharedElsewhere ? false : await repo.clearParentLockout(tx, parent.parent_account_id);
    const result: ResetParentAccessResult = { parentId: id, revokedSessions: reset.revokedSessionIds.length, otpReady: blockers.length === 0, blockers, unlocked, sharedAccount };
    await audit.log(tx, {
      action: 'parent.reset_access',
      entityType: 'parent',
      entityId: id,
      new: { phone: maskPhone(parent.phone), reason: body.reason ?? null, revokedSessions: result.revokedSessions, unlocked, signInReady: result.otpReady, blockers, sharedElsewhere: parent.sharedElsewhere },
    });
    return result;
  });
}

/**
 * POST /school/parents/:id/sessions/revoke — signs the parent out on every device (BP §5.2 force
 * logout, e.g. a lost phone) without changing anything else (links, lockout, OTP access). A parent
 * account that another school also uses keeps its global sessions (one school cannot sign a parent
 * out of another school — the same rule as reset-access); its sockets are re-authorised instead and
 * the result says sharedAccount: true.
 */
export async function revokeSessions(req: Request, id: string): Promise<{ parentId: string; revokedSessions: number; sharedAccount: boolean }> {
  const parent = await withRequestTenant(
    req,
    async (tx) => {
      const p = await repo.findParent(tx, id);
      if (!p) throw notFound('Parent not found.');
      return { accountId: p.parent_account_id, phone: p.phone, sharedElsewhere: await repo.usedElsewhere(tx, p.parent_account_id) };
    },
    { readOnly: true },
  );
  let revokedSessions = 0;
  if (parent.sharedElsewhere) await disconnectParentSockets([parent.accountId]);
  else revokedSessions = (await resetParentSessions(parent.accountId, 'admin_signout')).revokedSessionIds.length;
  await withRequestTenant(req, (tx) =>
    audit.log(tx, { action: 'parent.sessions_revoke', entityType: 'parent', entityId: id, new: { phone: maskPhone(parent.phone), revokedSessions, sharedElsewhere: parent.sharedElsewhere } }),
  );
  return { parentId: id, revokedSessions, sharedAccount: parent.sharedElsewhere };
}

/**
 * After a deactivation/removal committed in this school: a parent who uses no other school is signed
 * out everywhere; a parent who uses another school keeps its (global) sessions — this school's change
 * already blocks it here (every request re-checks the active links) — and only its sockets are
 * re-authorised.
 */
async function endParentAccessHere(accountId: string, sharedElsewhere: boolean, reason: string): Promise<void> {
  if (sharedElsewhere) await disconnectParentSockets([accountId]);
  else await revokeParentSessionsQuietly(accountId, reason);
}

// ── links (POST /school/students/:id/parents, DELETE /school/students/:id/parents/:parentId) ──
async function linkedParents(tx: Tx, studentId: string): Promise<StudentParentLinkDto[]> {
  return (await repo.linksOfStudent(tx, studentId)).map(toParentLinkDto);
}

/** Links a parent (existing id, or create-or-reuse by phone) to a student, or unlinks it. */
export async function changeLink(req: Request, studentId: string, body: StudentParentLinkBody): Promise<StudentParentLinkDto[]> {
  const result = await withRequestTenant(req, async (tx) => {
    if (!(await studentsRepo.lockStudent(tx, studentId))) throw notFound('Student not found.');
    if (body.action === 'unlink') return unlinkIn(tx, studentId, body.parentId!);
    let parent: SchoolParentRow | null;
    if (body.parentId) {
      parent = await repo.lockParent(tx, body.parentId);
      if (!parent) throw notFound('Parent not found.', { field: 'parentId' });
    } else {
      parent = (await registerParent(tx, body.parent!, { reuseLive: true })).row;
    }
    const relation = body.relation ?? body.parent?.relation ?? null;
    const isNew = await repo.upsertLink(tx, studentId, parent.parent_account_id, relation);
    await repo.normalizePrimary(tx, [studentId], body.isPrimary ? { studentId, accountId: parent.parent_account_id } : null);
    await audit.log(tx, {
      action: isNew ? 'student.parent_link' : 'student.parent_link_update',
      entityType: 'student',
      entityId: studentId,
      new: { parentId: parent.id, relation, isPrimary: body.isPrimary ?? null },
    });
    return { parents: await linkedParents(tx, studentId), disconnect: [] as string[] };
  });
  if (result.disconnect.length) await disconnectParentSockets(result.disconnect);
  return result.parents;
}

async function unlinkIn(tx: Tx, studentId: string, parentId: string) {
  const parent = await repo.findParent(tx, parentId);
  if (!parent) throw notFound('Parent not found.', { field: 'parentId' });
  const removed = await repo.deleteLink(tx, studentId, parent.parent_account_id);
  if (!removed) throw notFound('This parent is not linked to the student.', { field: 'parentId' });
  if (removed.was_primary) await repo.normalizePrimary(tx, [studentId]);
  await audit.log(tx, { action: 'student.parent_unlink', entityType: 'student', entityId: studentId, old: { parentId, wasPrimary: removed.was_primary } });
  return { parents: await linkedParents(tx, studentId), disconnect: [parent.parent_account_id] };
}

/** DELETE /school/students/:id/parents/:parentId */
export function unlink(req: Request, studentId: string, parentId: string): Promise<StudentParentLinkDto[]> {
  return changeLink(req, studentId, { action: 'unlink', parentId, relation: undefined, isPrimary: undefined });
}
