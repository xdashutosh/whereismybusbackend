// Additional school admins (BP §2.1 "then other school admins", §8.3 CRUD /school/admins +
// /:id/reset-access, /activate, /deactivate; §13.3 Users & Roles). Rules:
//   · e-mail is the global sign-in identifier (users_admin_email_uq → 409 DUPLICATE)
//   · new accounts and resets get a temporary password (generated unless given) and must change it
//   · nobody deactivates/deletes/resets themselves; the last active admin can never be deactivated
//     or deleted (all active admin rows are locked first, so concurrent requests are serialised)
//   · deactivation, deletion and reset revoke every session in the same transaction, then
//     disconnect the sockets after commit (BP §5.2/§5.4 — deactivation never deletes history)
import type { SchoolAdminDto } from '@wimb/shared';
import type { Request, Response } from 'express';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { registerConstraintError } from '../../middleware/errorHandler.js';
import { audit, changedFields } from '../../shared/audit.js';
import { hashPassword } from '../../shared/crypto.js';
import { createCsvWriter, type CsvColumn } from '../../shared/csv.js';
import { list as sendList } from '../../shared/envelope.js';
import { assertFound, forbidden, invalidState } from '../../shared/errors.js';
import { listMeta, parsePagination, parseSort } from '../../shared/pagination.js';
import { realtime } from '../../shared/realtime.js';
import { revokeAllSessions } from '../auth/index.js';
import { generateTemporaryPassword, sendAccountMail } from './credentials.js';
import * as repo from './repository.js';
import type { AdminListQuery, CreateAdminBody, DeactivateBody, ResetAccessBody, UpdateAdminBody } from './schemas.js';

registerConstraintError('users_admin_email_uq', 'DUPLICATE', 'This e-mail address is already used by another school admin account.');

const SORT = {
  allowed: { fullName: 'u.full_name', email: 'u.email', createdAt: 'u.created_at', lastLoginAt: 'u.last_login_at', isActive: 'u.is_active' },
  defaultSort: 'fullName',
  tiebreaker: 'u.id',
};

export function toDto(r: repo.AdminRow, selfId: string | null): SchoolAdminDto {
  return {
    id: r.id,
    fullName: r.full_name,
    email: r.email,
    phone: r.phone,
    isActive: r.is_active,
    mustChangePassword: r.must_change_password,
    locked: r.locked,
    lastLoginAt: r.last_login_at,
    passwordChangedAt: r.password_changed_at,
    isSelf: r.id === selfId,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const CSV_COLUMNS: CsvColumn<SchoolAdminDto>[] = [
  { header: 'Name', key: 'fullName' },
  { header: 'E-mail', key: 'email' },
  { header: 'Phone', key: 'phone' },
  { header: 'Status', value: (r) => (r.isActive ? 'active' : 'inactive') },
  { header: 'Must change password', value: (r) => (r.mustChangePassword ? 'yes' : 'no') },
  { header: 'Last sign-in (UTC)', key: 'lastLoginAt' },
  { header: 'Created (UTC)', key: 'createdAt' },
];

const selfOf = (req: Request) => req.auth!.actorId;
const auditView = (d: SchoolAdminDto) => ({ fullName: d.fullName, email: d.email, phone: d.phone, isActive: d.isActive });
const notFoundAdmin = 'The school admin was not found.';

/** GET /school/admins (JSON page or CSV). */
export async function list(req: Request, res: Response, q: AdminListQuery): Promise<void> {
  const filter: repo.AdminFilter = { status: q.status, q: q.q };
  const { orderBy } = parseSort(q.sort, SORT);
  if (q.format === 'csv') {
    const rows = await withRequestTenant(req, (tx) => repo.exportRows(tx, filter, orderBy), { readOnly: true });
    const csv = createCsvWriter<SchoolAdminDto>(res, { fileName: 'school-admins.csv', columns: CSV_COLUMNS });
    await csv.writeAll(rows.map((r) => toDto(r, selfOf(req))));
    await csv.end();
    return;
  }
  const { page, limit, offset } = parsePagination(q);
  const { rows, total } = await withRequestTenant(req, (tx) => repo.page(tx, filter, { orderBy, limit, offset }), { readOnly: true });
  sendList(res, rows.map((r) => toDto(r as repo.AdminRow, selfOf(req))), listMeta({ page, limit, total }));
}

/** GET /school/admins/:id */
export function get(req: Request, id: string): Promise<SchoolAdminDto> {
  return withRequestTenant(req, async (tx) => toDto(assertFound(await repo.find(tx, id), notFoundAdmin), selfOf(req)), { readOnly: true });
}

export interface CredentialResult {
  admin: SchoolAdminDto;
  /** Present only when the server generated the password (shown once; share it securely). */
  temporaryPassword: string | null;
}

/** POST /school/admins */
export async function create(req: Request, body: CreateAdminBody): Promise<CredentialResult> {
  const temporaryPassword = body.password ? null : generateTemporaryPassword();
  const passwordHash = await hashPassword(body.password ?? temporaryPassword!);
  const { admin, schoolName } = await withRequestTenant(req, async (tx) => {
    const id = await repo.insert(tx, { fullName: body.fullName, email: body.email, phone: body.phone ?? null, passwordHash });
    const dto = toDto(assertFound(await repo.find(tx, id)), selfOf(req));
    await audit.log(tx, { action: 'school_admin.create', entityType: 'user', entityId: id, new: { ...auditView(dto), generatedByServer: temporaryPassword !== null } });
    return { admin: dto, schoolName: await repo.schoolName(tx) };
  });
  sendAccountMail({ kind: 'welcome', to: admin.email, fullName: admin.fullName, schoolName, temporaryPassword });
  return { admin, temporaryPassword };
}

/** PATCH /school/admins/:id */
export function update(req: Request, id: string, body: UpdateAdminBody): Promise<SchoolAdminDto> {
  return withRequestTenant(req, async (tx) => {
    const before = toDto(assertFound(await repo.find(tx, id, { lock: true }), notFoundAdmin), selfOf(req));
    await repo.update(tx, id, { full_name: body.fullName, email: body.email, phone: body.phone });
    const after = toDto(assertFound(await repo.find(tx, id)), selfOf(req));
    const diff = changedFields(auditView(before), auditView(after));
    if (Object.keys(diff.new).length) await audit.log(tx, { action: 'school_admin.update', entityType: 'user', entityId: id, ...diff });
    return after;
  });
}

function refuseSelf(req: Request, id: string, what: string): void {
  if (id === selfOf(req)) throw forbidden(`You cannot ${what} your own account.`, { reason: 'SELF' });
}

/** The target stays/becomes inactive: refuse when it is the last active admin. */
async function assertNotLastActive(tx: Parameters<typeof repo.find>[0], id: string): Promise<void> {
  const active = await repo.lockActiveAdmins(tx);
  if (active.includes(id) && active.length <= 1) {
    throw invalidState('The school must keep at least one active school admin.', { reason: 'LAST_ACTIVE_ADMIN' });
  }
}

/** POST /school/admins/:id/deactivate */
export async function deactivate(req: Request, id: string, body: DeactivateBody): Promise<SchoolAdminDto & { revokedSessions: number }> {
  refuseSelf(req, id, 'deactivate');
  const result = await withRequestTenant(req, async (tx) => {
    await assertNotLastActive(tx, id);
    const before = toDto(assertFound(await repo.find(tx, id, { lock: true }), notFoundAdmin), selfOf(req));
    if (!before.isActive) return { dto: before, ids: [] as string[] };
    await repo.setActive(tx, id, false);
    const ids = await revokeAllSessions(tx, 'user', id, 'account_deactivated');
    await audit.log(tx, { action: 'school_admin.deactivate', entityType: 'user', entityId: id, old: { isActive: true }, new: { isActive: false, reason: body.reason ?? null, revokedSessions: ids.length } });
    return { dto: toDto(assertFound(await repo.find(tx, id)), selfOf(req)), ids };
  });
  if (result.ids.length) await realtime.disconnectSessions(result.ids);
  return { ...result.dto, revokedSessions: result.ids.length };
}

/** POST /school/admins/:id/activate */
export function activate(req: Request, id: string): Promise<SchoolAdminDto> {
  return withRequestTenant(req, async (tx) => {
    const before = toDto(assertFound(await repo.find(tx, id, { lock: true }), notFoundAdmin), selfOf(req));
    if (before.isActive) return before;
    await repo.setActive(tx, id, true);
    await audit.log(tx, { action: 'school_admin.activate', entityType: 'user', entityId: id, old: { isActive: false }, new: { isActive: true } });
    return toDto(assertFound(await repo.find(tx, id)), selfOf(req));
  });
}

/** POST /school/admins/:id/reset-access — new temporary password, lockout cleared, signed out everywhere. */
export async function resetAccess(req: Request, id: string, body: ResetAccessBody): Promise<CredentialResult & { revokedSessions: number }> {
  refuseSelf(req, id, 'reset access to');
  const temporaryPassword = body.password ? null : generateTemporaryPassword();
  const passwordHash = await hashPassword(body.password ?? temporaryPassword!);
  const result = await withRequestTenant(req, async (tx) => {
    assertFound(await repo.find(tx, id, { lock: true }), notFoundAdmin);
    await repo.resetPassword(tx, id, passwordHash);
    const ids = await revokeAllSessions(tx, 'user', id, 'access_reset');
    await audit.log(tx, { action: 'school_admin.reset_access', entityType: 'user', entityId: id, new: { forcedChangeAtSignIn: true, generatedByServer: temporaryPassword !== null, revokedSessions: ids.length } });
    return { dto: toDto(assertFound(await repo.find(tx, id)), selfOf(req)), ids, schoolName: await repo.schoolName(tx) };
  });
  if (result.ids.length) await realtime.disconnectSessions(result.ids);
  sendAccountMail({ kind: 'reset', to: result.dto.email, fullName: result.dto.fullName, schoolName: result.schoolName, temporaryPassword });
  return { admin: result.dto, temporaryPassword, revokedSessions: result.ids.length };
}

/** DELETE /school/admins/:id — soft delete (history kept, e-mail freed), sessions revoked. */
export async function remove(req: Request, id: string): Promise<void> {
  refuseSelf(req, id, 'delete');
  const ids = await withRequestTenant(req, async (tx) => {
    await assertNotLastActive(tx, id);
    const before = toDto(assertFound(await repo.find(tx, id, { lock: true }), notFoundAdmin), selfOf(req));
    await repo.softDelete(tx, id);
    const revoked = await revokeAllSessions(tx, 'user', id, 'account_deleted');
    await audit.log(tx, { action: 'school_admin.delete', entityType: 'user', entityId: id, old: auditView(before), new: { revokedSessions: revoked.length } });
    return revoked;
  });
  if (ids.length) await realtime.disconnectSessions(ids);
}

/**
 * POST /school/admins/:id/sessions/revoke — signs the admin out on every device (BP §5.2 force
 * logout) without touching the password: sessions revoked, sockets disconnected, audited.
 */
export async function revokeSessions(req: Request, id: string): Promise<{ id: string; revokedSessions: number }> {
  if (id === selfOf(req)) throw forbidden('Use POST /auth/logout-all to sign yourself out everywhere.', { reason: 'SELF' });
  const ids = await withRequestTenant(req, async (tx) => {
    assertFound(await repo.find(tx, id, { lock: true }), notFoundAdmin);
    const revoked = await revokeAllSessions(tx, 'user', id, 'admin_signout');
    await audit.log(tx, { action: 'school_admin.sessions_revoke', entityType: 'user', entityId: id, new: { revokedSessions: revoked.length } });
    return revoked;
  });
  if (ids.length) await realtime.disconnectSessions(ids);
  return { id, revokedSessions: ids.length };
}
