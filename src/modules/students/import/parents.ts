// Parent import (BP §13.3 Parents "import"): one row per parent keyed by mobile number, with an
// optional ';'-separated list of children (student_admission_nos) to link. Same flow as the
// student import: plan (no writes) → preview, or commit everything in one transaction.
//   · phone already registered in this school → update (given values replace) or skip
//   · deleted in this school → restored; unknown here → registered (global identity reused/created)
//   · unknown admission numbers are row errors; links are added, never removed; a link becomes the
//     child's primary when the child has none yet
import type { ImportOnExisting, ImportRowPreview, ImportSummary } from '@wimb/shared';
import type { Tx } from '../../../db/tenant.js';
import { insertLinks, writeParents, type LinkWrite, type ParentWrite } from './commit.js';
import { emailCell, emptySummary, phoneCell, RowErrors, same, textCell } from './common.js';
import type { ParsedSheet } from './parse.js';

const MAX_CHILDREN_PER_ROW = 10;

export function parentColumn(h: string): string | null {
  const map: Record<string, string> = {
    phone: 'phone', mobile: 'phone', mobile_no: 'phone', phone_number: 'phone', mobile_number: 'phone',
    full_name: 'full_name', name: 'full_name', parent_name: 'full_name',
    email: 'email', e_mail: 'email', email_address: 'email',
    relation: 'relation', relationship: 'relation',
    alternate_phone: 'alternate_phone', alternate_mobile: 'alternate_phone', alt_phone: 'alternate_phone',
    student_admission_nos: 'student_admission_nos', admission_nos: 'student_admission_nos', admission_no: 'student_admission_nos',
    children: 'student_admission_nos', student_admission_no: 'student_admission_nos',
  };
  return map[h] ?? null;
}

interface PlanRow {
  row: number;
  phone: string;
  name: string | null;
  email: string | null;
  relation: string | null;
  alternatePhone: string | null;
  admissionNos: string[];
  action: ImportRowPreview['action'];
  existing: { id: string; account_id: string; full_name: string; email: string | null; relation: string | null; alternate_phone: string | null; deleted: boolean } | null;
}

export interface ParentImportPlan {
  errors: RowErrors;
  rows: PlanRow[];
  studentIdOf: Map<string, string>;
  /** "studentId|phone" links that already exist. */
  existingLinks: Set<string>;
  /** students that already have a primary parent. */
  primary: Set<string>;
  summary: ImportSummary;
}

export async function planParentImport(tx: Tx, sheet: ParsedSheet, onExisting: ImportOnExisting): Promise<ParentImportPlan> {
  const errors = new RowErrors();
  if (!sheet.columns.includes('phone')) errors.add(1, null, 'The header must contain the column phone (download the template).');
  const rows: PlanRow[] = [];
  const seen = new Map<string, number>();
  for (const { row, values } of sheet.rows) {
    if (!(values.phone ?? '').trim()) errors.add(row, 'phone', 'Required');
    const phone = phoneCell(errors, row, 'phone', values.phone);
    if (phone) {
      const first = seen.get(phone);
      if (first !== undefined) errors.add(row, 'phone', `Duplicate of row ${first}`);
      else seen.set(phone, row);
    }
    const admissionNos = [...new Set((values.student_admission_nos ?? '').split(/[;,|\n]/).map((s) => s.trim()).filter(Boolean))];
    if (admissionNos.length > MAX_CHILDREN_PER_ROW) errors.add(row, 'student_admission_nos', `At most ${MAX_CHILDREN_PER_ROW} children per row`);
    if (admissionNos.some((a) => a.length > 40)) errors.add(row, 'student_admission_nos', 'Admission numbers are at most 40 characters');
    const alternatePhone = phoneCell(errors, row, 'alternate_phone', values.alternate_phone);
    rows.push({
      row,
      phone: phone ?? '',
      name: textCell(errors, row, 'full_name', values.full_name, 200),
      email: emailCell(errors, row, 'email', values.email),
      relation: textCell(errors, row, 'relation', values.relation, 40),
      alternatePhone,
      admissionNos,
      action: 'create',
      existing: null,
    });
  }
  const phones = rows.map((r) => r.phone).filter(Boolean);
  const existing = new Map(
    (await tx.many<NonNullable<PlanRow['existing']> & { phone: string }>(
      `select pa.phone, sp.id, pa.id as account_id, sp.full_name, sp.email, sp.relation, sp.alternate_phone, sp.deleted_at is not null as deleted
         from school_parents sp join parent_accounts pa on pa.id = sp.parent_account_id where pa.phone = any ($1::text[])`,
      [phones],
    )).map((p) => [p.phone, p]),
  );
  const allAdmission = [...new Set(rows.flatMap((r) => r.admissionNos))];
  const studentIdOf = new Map(
    (await tx.many<{ id: string; admission_no: string }>('select id, admission_no from students where deleted_at is null and admission_no = any ($1::text[])', [allAdmission])).map((s) => [s.admission_no, s.id]),
  );
  const links = await tx.many<{ student_id: string; phone: string; is_primary: boolean }>(
    'select l.student_id, pa.phone, l.is_primary from student_parents l join parent_accounts pa on pa.id = l.parent_account_id where l.student_id = any ($1::uuid[])',
    [[...studentIdOf.values()]],
  );
  const existingLinks = new Set(links.map((l) => `${l.student_id}|${l.phone}`));
  const primary = new Set(links.filter((l) => l.is_primary).map((l) => l.student_id));

  const summary = emptySummary(sheet.rows.length);
  for (const r of rows) {
    const unknown = r.admissionNos.filter((a) => !studentIdOf.has(a));
    if (unknown.length) errors.add(r.row, 'student_admission_nos', `Unknown admission number${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
    r.existing = existing.get(r.phone) ?? null;
    if (!r.existing && !r.name && r.phone) errors.add(r.row, 'full_name', 'Required for a parent who is new to the school');
    if (errors.has(r.row)) {
      r.action = 'error';
      continue;
    }
    const ex = r.existing;
    if (!ex || ex.deleted) r.action = 'create';
    else if (onExisting === 'skip') r.action = 'skip';
    else {
      const changed =
        (r.name !== null && !same(r.name, ex.full_name)) ||
        (r.email !== null && !same(r.email, ex.email)) ||
        (r.relation !== null && !same(r.relation, ex.relation)) ||
        (r.alternatePhone !== null && !same(r.alternatePhone, ex.alternate_phone));
      r.action = changed ? 'update' : 'unchanged';
    }
    if (r.action === 'skip') {
      summary.skip += 1;
      continue;
    }
    summary[r.action] += 1;
    if (r.action === 'create') summary.parentsCreated += 1;
    if (r.action === 'update') summary.parentsUpdated += 1;
    for (const a of r.admissionNos) if (!existingLinks.has(`${studentIdOf.get(a)}|${r.phone}`)) summary.links += 1;
  }
  return { errors, rows, studentIdOf, existingLinks, primary, summary };
}

export function previewParentRows(plan: ParentImportPlan): ImportRowPreview[] {
  return plan.rows.map((r) => ({ row: r.row, action: r.action, key: r.phone || null, name: r.name ?? r.existing?.full_name ?? null, links: r.admissionNos }));
}

export async function commitParentImport(tx: Tx, plan: ParentImportPlan): Promise<void> {
  const active = plan.rows.filter((r) => r.action !== 'error' && r.action !== 'skip');
  const writes: ParentWrite[] = active.map((r) => ({
    phone: r.phone,
    name: r.name,
    email: r.email,
    relation: r.relation,
    alternatePhone: r.alternatePhone,
    kind: !r.existing ? 'create' : r.existing.deleted ? 'restore' : r.action === 'update' ? 'update' : 'none',
    schoolParentId: r.existing?.id ?? null,
    accountId: r.existing?.account_id ?? null,
  }));
  const accountOf = await writeParents(tx, writes);
  const hasPrimary = new Set(plan.primary);
  const links: LinkWrite[] = [];
  for (const r of active) {
    for (const a of r.admissionNos) {
      const studentId = plan.studentIdOf.get(a)!;
      if (plan.existingLinks.has(`${studentId}|${r.phone}`)) continue;
      const isPrimary = !hasPrimary.has(studentId);
      if (isPrimary) hasPrimary.add(studentId);
      links.push({ studentId, accountId: accountOf.get(r.phone)!, relation: r.relation, isPrimary });
    }
  }
  await insertLinks(tx, links);
}
