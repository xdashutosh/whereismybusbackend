// Batched writes of the imports (contract §3: one multi-row statement per table and operation,
// inside the caller's single transaction). Plans come from students.ts / parents.ts and are
// error-free when these run.
import type { Tx } from '../../../db/tenant.js';
import { ensureAccounts } from '../parentsRepository.js';

const SCHOOL = "nullif(current_setting('app.school_id', true), '')::uuid";
const ACTOR = "nullif(current_setting('app.actor_id', true), '')::uuid";

export interface StudentWrite {
  admissionNo: string;
  fullName: string;
  className: string | null;
  section: string | null;
  rollNo: string | null;
  notes: string | null;
}

/** Inserts students → admission no → id. */
export async function insertStudents(tx: Tx, rows: readonly StudentWrite[]): Promise<Map<string, string>> {
  if (!rows.length) return new Map();
  const created = await tx.many<{ id: string; admission_no: string }>(
    `insert into students (school_id, admission_no, full_name, class_name, section, roll_no, notes, created_by)
     select ${SCHOOL}, x.a, x.n, x.c, x.s, x.r, x.no, ${ACTOR}
       from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) as x(a, n, c, s, r, no)
     returning id, admission_no`,
    [rows.map((r) => r.admissionNo), rows.map((r) => r.fullName), rows.map((r) => r.className), rows.map((r) => r.section), rows.map((r) => r.rollNo), rows.map((r) => r.notes)],
  );
  return new Map(created.map((c) => [c.admission_no, c.id]));
}

/** Updates existing students: the name always, other columns only when a value is given. */
export async function updateStudents(tx: Tx, rows: readonly (StudentWrite & { id: string })[]): Promise<void> {
  if (!rows.length) return;
  await tx.query(
    `update students s set full_name = x.n, class_name = coalesce(x.c, s.class_name), section = coalesce(x.s, s.section),
            roll_no = coalesce(x.r, s.roll_no), notes = coalesce(x.no, s.notes), updated_at = now()
       from unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) as x(id, n, c, s, r, no)
      where s.id = x.id and s.deleted_at is null`,
    [rows.map((r) => r.id), rows.map((r) => r.fullName), rows.map((r) => r.className), rows.map((r) => r.section), rows.map((r) => r.rollNo), rows.map((r) => r.notes)],
  );
}

export interface ParentWrite {
  phone: string;
  name: string | null;
  email: string | null;
  relation: string | null;
  alternatePhone?: string | null;
  kind: 'create' | 'restore' | 'update' | 'none';
  /** school_parents id (restore/update) and account id of parents the school already has. */
  schoolParentId: string | null;
  accountId: string | null;
}

/**
 * Applies the parent changes → phone → account id for every parent involved. New parents get the
 * global identity through ensure_parent_account (created or reused) and a school_parents row;
 * deleted rows are restored; updates replace only the given values.
 */
export async function writeParents(tx: Tx, parents: readonly ParentWrite[]): Promise<Map<string, string>> {
  const accountOf = new Map<string, string>();
  for (const p of parents) if (p.accountId) accountOf.set(p.phone, p.accountId);
  const creates = parents.filter((p) => p.kind === 'create');
  const ensured = await ensureAccounts(tx, creates.map((p) => p.phone), creates.map((p) => p.name));
  for (const [phone, id] of ensured) accountOf.set(phone, id);
  if (creates.length) {
    await tx.query(
      `insert into school_parents (school_id, parent_account_id, full_name, email, relation, alternate_phone, created_by)
       select ${SCHOOL}, x.id, x.n, x.e, x.r, x.alt, ${ACTOR}
         from unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[]) as x(id, n, e, r, alt)`,
      [creates.map((p) => accountOf.get(p.phone)), creates.map((p) => p.name), creates.map((p) => p.email), creates.map((p) => p.relation), creates.map((p) => p.alternatePhone ?? null)],
    );
  }
  const changes = parents.filter((p) => (p.kind === 'restore' || p.kind === 'update') && p.schoolParentId);
  if (changes.length) {
    await tx.query(
      `update school_parents sp set full_name = coalesce(x.n, sp.full_name), email = coalesce(x.e, sp.email), relation = coalesce(x.r, sp.relation),
              alternate_phone = coalesce(x.alt, sp.alternate_phone),
              is_active = case when x.restore then true else sp.is_active end,
              deleted_at = case when x.restore then null else sp.deleted_at end, updated_at = now()
         from unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[], $6::boolean[]) as x(id, n, e, r, alt, restore)
        where sp.id = x.id`,
      [
        changes.map((p) => p.schoolParentId),
        changes.map((p) => p.name),
        changes.map((p) => p.email),
        changes.map((p) => p.relation),
        changes.map((p) => p.alternatePhone ?? null),
        changes.map((p) => p.kind === 'restore'),
      ],
    );
  }
  return accountOf;
}

export interface LinkWrite {
  studentId: string;
  accountId: string;
  relation: string | null;
  isPrimary: boolean;
}

/** Adds links (existing links are left as they are). */
export async function insertLinks(tx: Tx, links: readonly LinkWrite[]): Promise<number> {
  if (!links.length) return 0;
  const res = await tx.query(
    `insert into student_parents (school_id, student_id, parent_account_id, relation, is_primary, created_by)
     select ${SCHOOL}, x.s, x.p, x.r, x.pr, ${ACTOR}
       from unnest($1::uuid[], $2::uuid[], $3::text[], $4::boolean[]) as x(s, p, r, pr)
     on conflict (student_id, parent_account_id) do nothing`,
    [links.map((l) => l.studentId), links.map((l) => l.accountId), links.map((l) => l.relation), links.map((l) => l.isPrimary)],
  );
  return res.rowCount ?? 0;
}
