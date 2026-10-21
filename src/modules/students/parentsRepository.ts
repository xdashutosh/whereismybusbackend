// Parent SQL (BP §4.6, §6.2 PARENTS): parent_accounts is the GLOBAL identity (unique E.164 phone,
// shared across schools, read-only for schools — created/reused only through
// ensure_parent_account(), phone corrected only through school_update_parent_phone()); everything
// the school knows (name, e-mail, relation) lives in its own school_parents row, and links to its
// students in student_parents. The API identifies a parent by its school_parents.id, so the global
// account id never leaves the server.
import type { Tx } from '../../db/tenant.js';
import { escapeLike, MAX_EXPORT_ROWS, pagedQuery } from '../../shared/pagination.js';
import type { ParentListRow, SchoolParentRow, StudentParentLinkRow } from './dto.js';

const SP_COLUMNS = `sp.id, sp.school_id, sp.parent_account_id, sp.full_name, sp.email, sp.relation, sp.alternate_phone, sp.is_active,
  sp.deleted_at, sp.created_at, sp.updated_at`;

const LIST_SELECT = `${SP_COLUMNS}, pa.phone, coalesce(st.has_signed_in, false) as has_signed_in, ch.child_count, ch.children`;

// school_parent_sign_in_state() (SECURITY DEFINER, migration 015): flags only — the app role cannot
// read the global identity's last sign-in or lockout columns.
const LIST_FROM = `from school_parents sp
  join parent_accounts pa on pa.id = sp.parent_account_id
  left join school_parent_sign_in_state() st on st.parent_account_id = sp.parent_account_id
  left join lateral (
    select count(*)::int as child_count,
           jsonb_agg(jsonb_build_object('studentId', s.id, 'fullName', s.full_name, 'admissionNo', s.admission_no,
                                        'className', s.class_name, 'section', s.section,
                                        'relation', coalesce(l.relation, sp.relation), 'isPrimary', l.is_primary)
                     order by s.full_name, s.id) as children
      from student_parents l join students s on s.id = l.student_id and s.deleted_at is null
     where l.school_id = sp.school_id and l.parent_account_id = sp.parent_account_id) ch on true`;

export interface ParentFilter {
  q?: string;
  isActive?: boolean;
  hasChildren?: boolean;
  studentId?: string;
}

function where(f: ParentFilter): { sql: string; params: unknown[] } {
  const q = f.q?.trim() ? escapeLike(f.q.trim()) : null;
  const digits = f.q ? f.q.replace(/\D/g, '') : '';
  return {
    sql: `sp.deleted_at is null
      and ($1::text is null or sp.full_name ilike '%' || $1 || '%' or sp.email ilike '%' || $1 || '%'
           or ($2::text <> '' and (pa.phone like '%' || $2 || '%' or sp.alternate_phone like '%' || $2 || '%')))
      and ($3::boolean is null or sp.is_active = $3)
      and ($4::boolean is null or (coalesce(ch.child_count, 0) > 0) = $4)
      and ($5::uuid is null or exists (select 1 from student_parents l2 where l2.student_id = $5 and l2.parent_account_id = sp.parent_account_id))`,
    params: [q, digits.length >= 3 ? digits : '', f.isActive ?? null, f.hasChildren ?? null, f.studentId ?? null],
  };
}

export function page(tx: Tx, f: ParentFilter, o: { orderBy: string; limit: number; offset: number }) {
  const w = where(f);
  return pagedQuery<ParentListRow>(tx, { select: LIST_SELECT, from: LIST_FROM, where: w.sql, params: w.params, ...o });
}

export function exportRows(tx: Tx, f: ParentFilter, orderBy: string): Promise<ParentListRow[]> {
  const w = where(f);
  return tx.many<ParentListRow>(`select ${LIST_SELECT} ${LIST_FROM} where ${w.sql} ${orderBy} limit ${MAX_EXPORT_ROWS}`, w.params);
}

export function findListRow(tx: Tx, id: string): Promise<ParentListRow | null> {
  return tx.maybeOne<ParentListRow>(`select ${LIST_SELECT} ${LIST_FROM} where sp.id = $1 and sp.deleted_at is null`, [id]);
}

/** Locks a live school parent (with its phone) for a write. */
export function lockParent(tx: Tx, id: string): Promise<(SchoolParentRow & { phone: string }) | null> {
  return tx.maybeOne<SchoolParentRow & { phone: string }>(
    `select ${SP_COLUMNS}, pa.phone from school_parents sp join parent_accounts pa on pa.id = sp.parent_account_id
      where sp.id = $1 and sp.deleted_at is null for update of sp`,
    [id],
  );
}

/** Global identity for a phone (created when new). Caller: school admin context. */
export async function ensureAccount(tx: Tx, phone: string, displayName: string | null): Promise<string> {
  return (await tx.one<{ id: string }>('select ensure_parent_account($1, $2) as id', [phone, displayName])).id;
}

/** Global identities for many phones in one statement → phone → account id. */
export async function ensureAccounts(tx: Tx, phones: readonly string[], names: readonly (string | null)[]): Promise<Map<string, string>> {
  if (!phones.length) return new Map();
  const rows = await tx.many<{ phone: string; id: string }>(
    'select p.phone, ensure_parent_account(p.phone, p.name) as id from unnest($1::text[], $2::text[]) as p(phone, name)',
    [phones, names],
  );
  return new Map(rows.map((r) => [r.phone, r.id]));
}

/** This school's row for an account, live or deleted (locked). */
export function schoolRowOfAccount(tx: Tx, accountId: string): Promise<SchoolParentRow | null> {
  return tx.maybeOne<SchoolParentRow>(`select ${SP_COLUMNS} from school_parents sp where sp.parent_account_id = $1 for update`, [accountId]);
}

export interface ParentValues {
  fullName: string;
  email?: string | null;
  relation?: string | null;
  alternatePhone?: string | null;
  isActive?: boolean;
}

export function insertSchoolParent(tx: Tx, accountId: string, v: ParentValues): Promise<SchoolParentRow> {
  return tx.one<SchoolParentRow>(
    `insert into school_parents (school_id, parent_account_id, full_name, email, relation, alternate_phone, is_active, created_by)
     values (nullif(current_setting('app.school_id', true), '')::uuid, $1, $2, $3, $4, $5, coalesce($6, true),
             nullif(current_setting('app.actor_id', true), '')::uuid)
     returning *`,
    [accountId, v.fullName, v.email ?? null, v.relation ?? null, v.alternatePhone ?? null, v.isActive ?? null],
  );
}

/** Brings a deleted school parent back with fresh details (links were removed on delete). */
export function restoreSchoolParent(tx: Tx, id: string, v: ParentValues): Promise<SchoolParentRow> {
  return tx.one<SchoolParentRow>(
    `update school_parents set deleted_at = null, full_name = $2, email = $3, relation = $4, alternate_phone = $5,
            is_active = coalesce($6, true), updated_at = now()
      where id = $1 returning *`,
    [id, v.fullName, v.email ?? null, v.relation ?? null, v.alternatePhone ?? null, v.isActive ?? null],
  );
}

const PARENT_FIELD_COLUMNS = { fullName: 'full_name', email: 'email', relation: 'relation', alternatePhone: 'alternate_phone', isActive: 'is_active' } as const;

export function updateSchoolParent(tx: Tx, id: string, v: Partial<ParentValues>): Promise<SchoolParentRow> {
  const entries = (Object.keys(PARENT_FIELD_COLUMNS) as (keyof typeof PARENT_FIELD_COLUMNS)[]).filter((k) => v[k] !== undefined).map((k) => [PARENT_FIELD_COLUMNS[k], v[k]] as const);
  const sets = entries.map(([c], i) => `${c} = $${i + 2}`);
  return tx.one<SchoolParentRow>(`update school_parents set ${[...sets, 'updated_at = now()'].join(', ')} where id = $1 returning *`, [id, ...entries.map(([, x]) => x)]);
}

/** Corrects the global phone (only for a parent of this school alone — see the definer function). */
export async function updatePhone(tx: Tx, accountId: string, phone: string): Promise<void> {
  await tx.query('select school_update_parent_phone($1, $2)', [accountId, phone]);
}

/** Soft delete + removal of the parent's links in this school → links removed. */
export async function softDeleteParent(tx: Tx, id: string, accountId: string): Promise<number> {
  const row = await tx.one<{ links_removed: number }>(
    `with unlinked as (delete from student_parents where parent_account_id = $2 returning 1),
          del as (update school_parents set deleted_at = now(), is_active = false, updated_at = now() where id = $1 returning 1)
     select (select count(*)::int from unlinked) as links_removed`,
    [id, accountId],
  );
  return row.links_removed;
}

/** Live school parent by id (no lock) with its account id. */
export function findParent(tx: Tx, id: string): Promise<(SchoolParentRow & { phone: string; account_active: boolean; is_locked: boolean; used_here: boolean }) | null> {
  return tx.maybeOne(
    `select ${SP_COLUMNS}, pa.phone, pa.is_active as account_active, coalesce(st.is_locked, false) as is_locked,
            sp.first_signed_in_at is not null as used_here
       from school_parents sp join parent_accounts pa on pa.id = sp.parent_account_id
       left join school_parent_sign_in_state() st on st.parent_account_id = sp.parent_account_id
      where sp.id = $1 and sp.deleted_at is null`,
    [id],
  );
}

/**
 * Whether the parent (linked to this school) uses ANOTHER school (school_parent_used_elsewhere,
 * migration 854). Its global sessions and sign-in lock are then not this school's to reset.
 */
export async function usedElsewhere(tx: Tx, accountId: string): Promise<boolean> {
  return (await tx.one<{ shared: boolean }>('select school_parent_used_elsewhere($1) as shared', [accountId])).shared;
}

/** Clears a failed-sign-in lock of a parent linked to this school → whether anything was cleared. */
export async function clearParentLockout(tx: Tx, accountId: string): Promise<boolean> {
  return (await tx.one<{ cleared: boolean }>('select school_clear_parent_lockout($1) as cleared', [accountId])).cleared;
}

/** Active children (live, active students) the parent is linked to in this school. */
export async function activeChildCount(tx: Tx, accountId: string): Promise<number> {
  return (await tx.one<{ n: number }>(
    'select count(*)::int as n from student_parents l join students s on s.id = l.student_id and s.deleted_at is null and s.is_active where l.parent_account_id = $1',
    [accountId],
  )).n;
}

// ── links ────────────────────────────────────────────────────────────────────
export function linksOfStudent(tx: Tx, studentId: string): Promise<StudentParentLinkRow[]> {
  return tx.many<StudentParentLinkRow>(
    `select sp.id, l.parent_account_id, sp.full_name, pa.phone, sp.email, coalesce(l.relation, sp.relation) as relation,
            l.is_primary, sp.is_active, l.created_at as linked_at
       from student_parents l
       join school_parents sp on sp.school_id = l.school_id and sp.parent_account_id = l.parent_account_id and sp.deleted_at is null
       join parent_accounts pa on pa.id = l.parent_account_id
      where l.student_id = $1
      order by l.is_primary desc, l.created_at, sp.id`,
    [studentId],
  );
}

/** Creates or updates a link (relation only replaced when given) → whether it was new. */
export async function upsertLink(tx: Tx, studentId: string, accountId: string, relation: string | null): Promise<boolean> {
  const row = await tx.one<{ inserted: boolean }>(
    `insert into student_parents (school_id, student_id, parent_account_id, relation, is_primary, created_by)
     values (nullif(current_setting('app.school_id', true), '')::uuid, $1, $2, $3, false, nullif(current_setting('app.actor_id', true), '')::uuid)
     on conflict (student_id, parent_account_id) do update set relation = coalesce(excluded.relation, student_parents.relation)
     returning (xmax = 0) as inserted`,
    [studentId, accountId, relation],
  );
  return row.inserted;
}

export async function deleteLink(tx: Tx, studentId: string, accountId: string): Promise<{ was_primary: boolean } | null> {
  return tx.maybeOne<{ was_primary: boolean }>('delete from student_parents where student_id = $1 and parent_account_id = $2 returning is_primary as was_primary', [studentId, accountId]);
}

/**
 * Keeps exactly one primary parent per child: `primary` becomes the primary when given; otherwise
 * the current primary stays, or the earliest linked parent is promoted.
 */
export async function normalizePrimary(tx: Tx, studentIds: readonly string[], primary: { studentId: string; accountId: string } | null = null): Promise<void> {
  await tx.query(
    `with chosen as (
       select distinct on (l.student_id) l.student_id, l.parent_account_id
         from student_parents l
        where l.student_id = any ($1::uuid[])
        order by l.student_id,
                 (l.student_id = $2::uuid and l.parent_account_id = $3::uuid) desc,
                 l.is_primary desc, l.created_at, l.parent_account_id)
     update student_parents l set is_primary = (l.parent_account_id = c.parent_account_id)
       from chosen c
      where l.student_id = c.student_id and l.is_primary is distinct from (l.parent_account_id = c.parent_account_id)`,
    [studentIds, primary?.studentId ?? null, primary?.accountId ?? null],
  );
}
