// Imports (BP §8.3 "POST /school/students/import (CSV, with dry-run preview and error report)",
// §13.3 Parents import; contract §10 wizard with dry-run preview). Flow:
//   1. the web uploads the CSV/XLSX with POST /files/upload (category `import`) → fileId
//   2. POST …/import { fileId, dryRun: true }  → preview: per-row action + every row error
//   3. POST …/import { fileId, dryRun: false } → re-validated inside ONE transaction and applied
//      with batched statements; any row error → 400 VALIDATION_ERROR with the same report and
//      nothing written. The commit is audited (counts + file id); the file stays as evidence.
import type { ImportResult } from '@wimb/shared';
import type { Request } from 'express';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { audit } from '../../shared/audit.js';
import { validationError } from '../../shared/errors.js';
import { buildResult, loadImportFile } from './import/common.js';
import { commitParentImport, parentColumn, planParentImport, previewParentRows } from './import/parents.js';
import { parseSheet } from './import/parse.js';
import { commitStudentImport, planStudentImport, previewRows, studentColumn } from './import/students.js';
import type { ImportBody } from './schemas.js';
import { assertPlanCapacity } from './service.js';

/** Serialises imports per school (transaction-level advisory lock, PgBouncer-safe). */
const IMPORT_LOCK = "select pg_advisory_xact_lock(hashtextextended('wimb:people-import:' || current_setting('app.school_id', true), 0))";

function refuse(result: ImportResult): never {
  throw validationError(`The file has ${result.summary.errorRows} row(s) with errors. Nothing was imported.`, result);
}

/** POST /school/students/import */
export async function importStudents(req: Request, body: ImportBody): Promise<ImportResult> {
  const sheet = await parseSheet(await loadImportFile(req, body.fileId), studentColumn);
  if (body.dryRun) {
    const plan = await withRequestTenant(req, (tx) => planStudentImport(tx, sheet, body.onExisting), { readOnly: true });
    return buildResult(sheet, body.fileId, { dryRun: true, committed: false, summary: plan.summary, errors: plan.errors, rows: previewRows(plan) });
  }
  return withRequestTenant(req, async (tx) => {
    await tx.query(IMPORT_LOCK);
    const plan = await planStudentImport(tx, sheet, body.onExisting);
    const result = buildResult(sheet, body.fileId, { dryRun: false, committed: false, summary: plan.summary, errors: plan.errors, rows: previewRows(plan) });
    if (plan.errors.list.length) refuse(result);
    if (plan.summary.create) await assertPlanCapacity(tx, plan.summary.create);
    await commitStudentImport(tx, plan);
    await audit.log(tx, { action: 'student.import', entityType: 'file', entityId: body.fileId, new: { onExisting: body.onExisting, format: sheet.format, ...plan.summary } });
    return { ...result, committed: true };
  });
}

/** POST /school/parents/import */
export async function importParents(req: Request, body: ImportBody): Promise<ImportResult> {
  const sheet = await parseSheet(await loadImportFile(req, body.fileId), parentColumn);
  if (body.dryRun) {
    const plan = await withRequestTenant(req, (tx) => planParentImport(tx, sheet, body.onExisting), { readOnly: true });
    return buildResult(sheet, body.fileId, { dryRun: true, committed: false, summary: plan.summary, errors: plan.errors, rows: previewParentRows(plan) });
  }
  return withRequestTenant(req, async (tx) => {
    await tx.query(IMPORT_LOCK);
    const plan = await planParentImport(tx, sheet, body.onExisting);
    const result = buildResult(sheet, body.fileId, { dryRun: false, committed: false, summary: plan.summary, errors: plan.errors, rows: previewParentRows(plan) });
    if (plan.errors.list.length) refuse(result);
    await commitParentImport(tx, plan);
    await audit.log(tx, { action: 'parent.import', entityType: 'file', entityId: body.fileId, new: { onExisting: body.onExisting, format: sheet.format, ...plan.summary } });
    return { ...result, committed: true };
  });
}
