// School admin accounts (users.role = 'school_admin') of the current school. RLS limits every
// statement to app.school_id; deleted accounts (deleted_at) are invisible to the API.
import type { Tx } from '../../db/tenant.js';
import { escapeLike, MAX_EXPORT_ROWS, pagedQuery } from '../../shared/pagination.js';

const SCHOOL = "nullif(current_setting('app.school_id', true), '')::uuid";

export interface AdminRow extends Record<string, unknown> {
  id: string;
  full_name: string;
  email: string;
  phone: string | null;
  is_active: boolean;
  must_change_password: boolean;
  locked: boolean;
  last_login_at: string | null;
  password_changed_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface AdminFilter {
  status?: 'active' | 'inactive' | 'all';
  q?: string;
}

const COLUMNS = `u.id, u.full_name, u.email::text as email, u.phone, u.is_active, u.must_change_password,
  coalesce(u.locked_until > now(), false) as locked, u.last_login_at, u.password_changed_at, u.created_by, u.created_at, u.updated_at`;
const BASE = "u.role = 'school_admin' and u.deleted_at is null";
const OWN = "role = 'school_admin' and deleted_at is null";

function where(f: AdminFilter) {
  return {
    sql: `${BASE}
      and ($1::text is null or $1 = 'all' or u.is_active = ($1 = 'active'))
      and ($2::text is null or u.full_name ilike '%' || $2 || '%' or u.email::text ilike '%' || $2 || '%' or coalesce(u.phone, '') like '%' || $2 || '%')`,
    params: [f.status ?? null, f.q ? escapeLike(f.q) : null],
  };
}

export function page(tx: Tx, f: AdminFilter, o: { orderBy: string; limit: number; offset: number }) {
  const w = where(f);
  return pagedQuery<AdminRow>(tx, { select: COLUMNS, from: 'from users u', where: w.sql, params: w.params, ...o });
}

export function exportRows(tx: Tx, f: AdminFilter, orderBy: string): Promise<AdminRow[]> {
  const w = where(f);
  return tx.many<AdminRow>(`select ${COLUMNS} from users u where ${w.sql} ${orderBy} limit ${MAX_EXPORT_ROWS}`, w.params);
}

export function find(tx: Tx, id: string, { lock = false } = {}): Promise<AdminRow | null> {
  return tx.maybeOne<AdminRow>(`select ${COLUMNS} from users u where u.id = $1 and ${BASE}${lock ? ' for update' : ''}`, [id]);
}

/**
 * Locks every ACTIVE admin row of the school (in id order, so concurrent callers queue instead of
 * deadlocking) → their ids. Two admins deactivating each other at the same time are serialised, so
 * the school can never lose its last active admin.
 */
export async function lockActiveAdmins(tx: Tx): Promise<string[]> {
  const rows = await tx.many<{ id: string }>(`select u.id from users u where ${BASE} and u.is_active order by u.id for update`);
  return rows.map((r) => r.id);
}

export async function insert(tx: Tx, a: { fullName: string; email: string; phone: string | null; passwordHash: string }): Promise<string> {
  const row = await tx.one<{ id: string }>(
    `insert into users (school_id, role, full_name, email, phone, password_hash, must_change_password, is_active, created_by)
     values (${SCHOOL}, 'school_admin', $1, $2, $3, $4, true, true, $5)
     returning id`,
    [a.fullName, a.email, a.phone, a.passwordHash, tx.ctx.actorId],
  );
  return row.id;
}

export async function update(tx: Tx, id: string, cols: { full_name?: string; email?: string; phone?: string | null }): Promise<void> {
  const entries = Object.entries(cols).filter(([, v]) => v !== undefined);
  if (!entries.length) return;
  const set = entries.map(([c], i) => `${c} = $${i + 2}`).join(', ');
  await tx.query(`update users set ${set}, updated_at = now() where id = $1 and ${OWN}`, [id, ...entries.map(([, v]) => v)]);
}

export async function setActive(tx: Tx, id: string, active: boolean): Promise<void> {
  await tx.query(`update users set is_active = $2, updated_at = now() where id = $1 and ${OWN}`, [id, active]);
}

/** New temporary password: forces a change at the next sign-in and clears any lockout. */
export async function resetPassword(tx: Tx, id: string, passwordHash: string): Promise<void> {
  await tx.query(
    `update users set password_hash = $2, must_change_password = true, failed_login_count = 0, locked_until = null, updated_at = now()
      where id = $1 and ${OWN}`,
    [id, passwordHash],
  );
}

export async function softDelete(tx: Tx, id: string): Promise<void> {
  await tx.query(
    `update users set deleted_at = now(), is_active = false, updated_at = now() where id = $1 and ${OWN}`,
    [id],
  );
}

/** School name for welcome / reset e-mails. */
export async function schoolName(tx: Tx): Promise<string> {
  return (await tx.maybeOne<{ name: string }>(`select name from schools where id = ${SCHOOL}`))?.name ?? 'your school';
}
