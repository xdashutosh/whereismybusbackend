// Student import (BP §8.3 "CSV with dry-run preview and error report", §13.3 wizard): one row per
// student keyed by admission number, with up to two optional parents (parentN_name/phone/email/
// relation). The plan is computed from the file plus one lookup per table; the commit re-plans
// inside its own transaction and applies everything with batched statements (or nothing).
//   · existing admission number → update (non-empty cells replace values) or skip (onExisting)
//   · parent phone → the school's parent (reused), restored, or newly registered (global identity
//     created or reused through ensure_parent_account); new parents need a name
//   · links are added (never removed); the first parent becomes primary when the child has none
import type { ImportOnExisting, ImportRowPreview, ImportSummary } from '@wimb/shared';
import type { Tx } from '../../../db/tenant.js';
import { insertLinks, insertStudents, updateStudents, writeParents, type LinkWrite } from './commit.js';
import { emailCell, emptySummary, phoneCell, RowErrors, same, textCell } from './common.js';
import type { ParsedSheet } from './parse.js';

const SLOTS = [1, 2] as const;

/** Canonical column of a normalised header (aliases included) or null. */
export function studentColumn(h: string): string | null {
  const direct: Record<string, string> = {
    admission_no: 'admission_no', admission_number: 'admission_no', admission: 'admission_no', adm_no: 'admission_no', admno: 'admission_no',
    full_name: 'full_name', name: 'full_name', student_name: 'full_name', student: 'full_name',
    class_name: 'class_name', class: 'class_name', grade: 'class_name', standard: 'class_name',
    section: 'section', division: 'section',
    roll_no: 'roll_no', roll: 'roll_no', roll_number: 'roll_no',
    notes: 'notes', note: 'notes', remarks: 'notes',
    parent_name: 'parent1_name', parent_phone: 'parent1_phone', parent_mobile: 'parent1_phone', parent_email: 'parent1_email',
    parent_relation: 'parent1_relation', mobile: 'parent1_phone', phone: 'parent1_phone',
  };
  if (direct[h]) return direct[h];
  const m = /^parent_?([12])_?(name|phone|mobile|email|relation)$/.exec(h);
  if (m) return `parent${m[1]}_${m[2] === 'mobile' ? 'phone' : m[2]}`;
  return null;
}

interface PlanParent {
  slot: number;
  phone: string;
  name: string | null;
  email: string | null;
  relation: string | null;
}

interface PlanRow {
  row: number;
  admissionNo: string;
  fullName: string;
  className: string | null;
  section: string | null;
  rollNo: string | null;
  notes: string | null;
  parents: PlanParent[];
  action: ImportRowPreview['action'];
  existingId: string | null;
}

interface ExistingStudent extends Record<string, unknown> {
  id: string;
  admission_no: string;
  full_name: string;
  class_name: string | null;
  section: string | null;
  roll_no: string | null;
  notes: string | null;
}

interface ExistingParent extends Record<string, unknown> {
  phone: string;
  account_id: string;
  id: string;
  full_name: string;
  email: string | null;
  relation: string | null;
  deleted: boolean;
}

/** One school parent to create, restore or update (aggregated over every row naming the phone). */
interface ParentChange {
  phone: string;
  name: string | null;
  email: string | null;
  relation: string | null;
  existing: ExistingParent | null;
  kind: 'create' | 'restore' | 'update' | 'none';
}

export interface StudentImportPlan {
  errors: RowErrors;
  rows: PlanRow[];
  parents: Map<string, ParentChange>;
  /** student id → has a primary parent already. */
  primaryOf: Map<string, boolean>;
  /** "studentId|phone" links that already exist. */
  existingLinks: Set<string>;
  summary: ImportSummary;
}

/** Syntax checks + lookups → the plan (no writes). */
export async function planStudentImport(tx: Tx, sheet: ParsedSheet, onExisting: ImportOnExisting): Promise<StudentImportPlan> {
  const errors = new RowErrors();
  if (!sheet.columns.includes('full_name') || !sheet.columns.includes('admission_no')) {
    errors.add(1, null, 'The header must contain the columns admission_no and full_name (download the template).');
  }
  const seen = new Map<string, number>();
  const rows: PlanRow[] = [];
  for (const { row, values } of sheet.rows) {
    const admissionNo = textCell(errors, row, 'admission_no', values.admission_no, 40);
    const fullName = textCell(errors, row, 'full_name', values.full_name, 200);
    if ((values.admission_no ?? '').trim() === '') errors.add(row, 'admission_no', 'Required');
    if ((values.full_name ?? '').trim() === '') errors.add(row, 'full_name', 'Required');
    if (admissionNo) {
      const first = seen.get(admissionNo);
      if (first !== undefined) errors.add(row, 'admission_no', `Duplicate of row ${first}`);
      else seen.set(admissionNo, row);
    }
    const parents: PlanParent[] = [];
    for (const slot of SLOTS) {
      const p = `parent${slot}`;
      const raw = [values[`${p}_name`], values[`${p}_phone`], values[`${p}_email`], values[`${p}_relation`]];
      if (raw.every((v) => !v?.trim())) continue;
      const phone = phoneCell(errors, row, `${p}_phone`, values[`${p}_phone`]);
      if (!(values[`${p}_phone`] ?? '').trim()) errors.add(row, `${p}_phone`, 'Required when other parent columns are filled');
      const parent: PlanParent = {
        slot,
        phone: phone ?? '',
        name: textCell(errors, row, `${p}_name`, values[`${p}_name`], 200),
        email: emailCell(errors, row, `${p}_email`, values[`${p}_email`]),
        relation: textCell(errors, row, `${p}_relation`, values[`${p}_relation`], 40),
      };
      if (phone && parents.some((x) => x.phone === phone)) errors.add(row, `${p}_phone`, 'The same mobile number is given twice');
      else if (phone) parents.push(parent);
    }
    rows.push({
      row,
      admissionNo: admissionNo ?? '',
      fullName: fullName ?? '',
      className: textCell(errors, row, 'class_name', values.class_name, 40),
      section: textCell(errors, row, 'section', values.section, 20),
      rollNo: textCell(errors, row, 'roll_no', values.roll_no, 20),
      notes: textCell(errors, row, 'notes', values.notes, 2000),
      parents,
      action: 'create',
      existingId: null,
    });
  }

  const admissionNos = rows.map((r) => r.admissionNo).filter(Boolean);
  const phones = [...new Set(rows.flatMap((r) => r.parents.map((p) => p.phone)))];
  const existing = new Map(
    (await tx.many<ExistingStudent>(
      'select id, admission_no, full_name, class_name, section, roll_no, notes from students where deleted_at is null and admission_no = any ($1::text[])',
      [admissionNos],
    )).map((s) => [s.admission_no, s]),
  );
  const existingParents = new Map(
    (await tx.many<ExistingParent>(
      `select pa.phone, pa.id as account_id, sp.id, sp.full_name, sp.email, sp.relation, sp.deleted_at is not null as deleted
         from school_parents sp join parent_accounts pa on pa.id = sp.parent_account_id where pa.phone = any ($1::text[])`,
      [phones],
    )).map((p) => [p.phone, p]),
  );
  const studentIds = [...existing.values()].map((s) => s.id);
  const linkRows = await tx.many<{ student_id: string; phone: string; is_primary: boolean }>(
    'select l.student_id, pa.phone, l.is_primary from student_parents l join parent_accounts pa on pa.id = l.parent_account_id where l.student_id = any ($1::uuid[])',
    [studentIds],
  );
  const existingLinks = new Set(linkRows.map((l) => `${l.student_id}|${l.phone}`));
  const primaryOf = new Map<string, boolean>();
  for (const l of linkRows) if (l.is_primary) primaryOf.set(l.student_id, true);

  // Every name/e-mail/relation given for a phone anywhere in the file (first non-empty wins).
  const given = new Map<string, { name: string | null; email: string | null; relation: string | null }>();
  for (const r of rows) {
    if (errors.has(r.row)) continue;
    for (const p of r.parents) {
      const g = given.get(p.phone) ?? { name: null, email: null, relation: null };
      g.name ??= p.name;
      g.email ??= p.email;
      g.relation ??= p.relation;
      given.set(p.phone, g);
    }
  }
  const summary = emptySummary(sheet.rows.length);
  const parents = new Map<string, ParentChange>();
  for (const r of rows) {
    if (errors.has(r.row)) {
      r.action = 'error';
      continue;
    }
    const ex = existing.get(r.admissionNo);
    if (ex) {
      r.existingId = ex.id;
      if (onExisting === 'skip') r.action = 'skip';
      else {
        const changed =
          !same(ex.full_name, r.fullName) ||
          (r.className !== null && !same(ex.class_name, r.className)) ||
          (r.section !== null && !same(ex.section, r.section)) ||
          (r.rollNo !== null && !same(ex.roll_no, r.rollNo)) ||
          (r.notes !== null && !same(ex.notes, r.notes));
        r.action = changed ? 'update' : 'unchanged';
      }
    }
    if (r.action === 'skip') continue;
    for (const p of r.parents) {
      const ep = existingParents.get(p.phone);
      if (!(ep && !ep.deleted) && !given.get(p.phone)?.name) errors.add(r.row, `parent${p.slot}_name`, 'Required for a parent who is new to the school');
    }
    if (errors.has(r.row)) {
      r.action = 'error';
      continue;
    }
    for (const p of r.parents) {
      if (!parents.has(p.phone)) parents.set(p.phone, { phone: p.phone, ...given.get(p.phone)!, existing: existingParents.get(p.phone) ?? null, kind: 'none' });
      const key = r.existingId ? `${r.existingId}|${p.phone}` : null;
      if (!key || !existingLinks.has(key)) summary.links += 1;
    }
  }
  for (const agg of parents.values()) {
    const ep = agg.existing;
    if (!ep) agg.kind = 'create';
    else if (ep.deleted) agg.kind = 'restore';
    else if (
      onExisting === 'update' &&
      ((agg.name !== null && !same(agg.name, ep.full_name)) || (agg.email !== null && !same(agg.email, ep.email)) || (agg.relation !== null && !same(agg.relation, ep.relation)))
    )
      agg.kind = 'update';
    if (agg.kind === 'create' || agg.kind === 'restore') summary.parentsCreated += 1;
    if (agg.kind === 'update') summary.parentsUpdated += 1;
  }
  for (const r of rows) if (r.action !== 'error') summary[r.action] += 1;
  return { errors, rows, parents, primaryOf, existingLinks, summary };
}

export function previewRows(plan: StudentImportPlan): ImportRowPreview[] {
  return plan.rows.map((r) => ({ row: r.row, action: r.action, key: r.admissionNo || null, name: r.fullName || null, links: r.parents.map((p) => p.phone) }));
}

/** Applies an error-free plan inside the caller's transaction (plan limit checked by the caller). */
export async function commitStudentImport(tx: Tx, plan: StudentImportPlan): Promise<void> {
  const created = await insertStudents(tx, plan.rows.filter((r) => r.action === 'create'));
  await updateStudents(
    tx,
    plan.rows.filter((r) => r.action === 'update').map((r) => ({ ...r, id: r.existingId! })),
  );
  const accountOf = await writeParents(
    tx,
    [...plan.parents.values()].map((p) => ({
      phone: p.phone,
      name: p.name,
      email: p.email,
      relation: p.relation,
      kind: p.kind,
      schoolParentId: p.existing?.id ?? null,
      accountId: p.existing?.account_id ?? null,
    })),
  );
  const links: LinkWrite[] = [];
  const hasPrimary = new Set([...plan.primaryOf.keys()]);
  for (const r of plan.rows) {
    if (r.action === 'error' || r.action === 'skip') continue;
    const studentId = r.existingId ?? created.get(r.admissionNo);
    if (!studentId) continue;
    for (const p of r.parents) {
      if (plan.existingLinks.has(`${studentId}|${p.phone}`)) continue;
      const primary = !hasPrimary.has(studentId);
      if (primary) hasPrimary.add(studentId);
      links.push({ studentId, accountId: accountOf.get(p.phone)!, relation: p.relation, isPrimary: primary });
    }
  }
  await insertLinks(tx, links);
}
