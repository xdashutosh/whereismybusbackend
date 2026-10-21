// Shared pieces of the student and parent imports: loading the uploaded file (files module,
// category `import`, this school only), cell validation helpers and the result envelope.
import type { ImportResult, ImportRowError, ImportRowPreview, ImportSummary } from '@wimb/shared';
import type { Request } from 'express';
import { withRequestTenant } from '../../../middleware/resolveTenant.js';
import { fieldError, notFound } from '../../../shared/errors.js';
import { normalizePhone } from '../../../shared/phone.js';
import { storage } from '../../../shared/storage.js';
import { UPLOAD_KINDS } from '../../../shared/uploads.js';
import { readAll } from '../../files/processing.js';
import * as filesRepo from '../../files/repository.js';
import type { ParsedSheet } from './parse.js';

/** Preview rows returned to the client (errors are always returned in full, up to MAX_ERRORS). */
export const MAX_PREVIEW_ROWS = 200;
export const MAX_ERRORS = 1000;

/** Reads the bytes of an uploaded import file of the caller's school. */
export async function loadImportFile(req: Request, fileId: string): Promise<Buffer> {
  const file = await withRequestTenant(req, (tx) => filesRepo.findFile(tx, fileId), { readOnly: true });
  if (!file) throw notFound('File not found.', { field: 'fileId' });
  if (file.category !== 'import') throw fieldError('fileId', 'Upload the spreadsheet with category "import" (POST /files/upload).');
  if (file.status !== 'uploaded') throw fieldError('fileId', 'The file upload is not complete.');
  if (storage.schoolIdOfKey(file.key) !== req.tenant?.schoolId) throw notFound('File not found.', { field: 'fileId' });
  const object = await storage.getObjectStream(file.key);
  if (!object) throw notFound('File not found.', { field: 'fileId' });
  return readAll(object.stream, UPLOAD_KINDS.IMPORT.maxBytes);
}

/** Collects row errors (one list for the whole file). */
export class RowErrors {
  readonly list: ImportRowError[] = [];
  readonly rows = new Set<number>();
  add(row: number, field: string | null, message: string): void {
    this.rows.add(row);
    if (this.list.length < MAX_ERRORS) this.list.push({ row, field, message });
  }
  has(row: number): boolean {
    return this.rows.has(row);
  }
}

/** Trimmed cell or null; adds an error when longer than `max`. */
export function textCell(errors: RowErrors, row: number, field: string, value: string | undefined, max: number): string | null {
  const v = (value ?? '').trim();
  if (!v) return null;
  if (v.length > max) {
    errors.add(row, field, `Must be at most ${max} characters`);
    return null;
  }
  return v;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function emailCell(errors: RowErrors, row: number, field: string, value: string | undefined): string | null {
  const v = (value ?? '').trim().toLowerCase();
  if (!v) return null;
  if (v.length > 254 || !EMAIL_RE.test(v)) {
    errors.add(row, field, 'Must be a valid e-mail address');
    return null;
  }
  return v;
}

export function phoneCell(errors: RowErrors, row: number, field: string, value: string | undefined): string | null {
  const v = (value ?? '').trim();
  if (!v) return null;
  const n = normalizePhone(v);
  if (!n) errors.add(row, field, 'Must be a valid mobile number');
  return n;
}

export function emptySummary(totalRows: number): ImportSummary {
  return { totalRows, validRows: 0, errorRows: 0, create: 0, update: 0, unchanged: 0, skip: 0, parentsCreated: 0, parentsUpdated: 0, links: 0 };
}

export function buildResult(
  sheet: ParsedSheet,
  fileId: string,
  { dryRun, committed, summary, errors, rows }: { dryRun: boolean; committed: boolean; summary: ImportSummary; errors: RowErrors; rows: ImportRowPreview[] },
): ImportResult {
  return {
    dryRun,
    committed,
    fileId,
    format: sheet.format,
    columns: sheet.columns,
    ignoredColumns: sheet.ignoredColumns,
    summary: { ...summary, errorRows: errors.rows.size, validRows: summary.totalRows - errors.rows.size },
    errors: errors.list,
    rows: rows.slice(0, MAX_PREVIEW_ROWS),
  };
}

/** Same value after trimming/normalising (null and '' are equal). */
export const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
