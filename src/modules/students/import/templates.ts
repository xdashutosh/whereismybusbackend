// Import templates (GET /school/students/import/template, /school/parents/import/template):
// the canonical header plus two example rows, as CSV (UTF-8 BOM for Excel) or XLSX (bold header,
// phone/admission columns stored as text so Excel keeps leading '+' and zeros).
import ExcelJS from 'exceljs';
import { PARENT_IMPORT_COLUMNS, STUDENT_IMPORT_COLUMNS } from '@wimb/shared';
import type { Response } from 'express';
import { toCsv, type CsvColumn } from '../../../shared/csv.js';
import { contentDisposition } from '../../../shared/storage.js';

type Example = Record<string, string>;

const STUDENT_EXAMPLES: Example[] = [
  {
    admission_no: 'ADM-2026-001', full_name: 'Aarav Sharma', class_name: '5', section: 'A', roll_no: '12', notes: '',
    parent1_name: 'Priya Sharma', parent1_phone: '+919845012345', parent1_email: 'priya.sharma@example.com', parent1_relation: 'mother',
    parent2_name: 'Rohit Sharma', parent2_phone: '+919845012346', parent2_email: '', parent2_relation: 'father',
  },
  {
    admission_no: 'ADM-2026-002', full_name: 'Diya Sharma', class_name: '3', section: 'B', roll_no: '7', notes: 'Sibling of ADM-2026-001',
    parent1_name: 'Priya Sharma', parent1_phone: '+919845012345', parent1_email: '', parent1_relation: 'mother',
    parent2_name: '', parent2_phone: '', parent2_email: '', parent2_relation: '',
  },
];

const PARENT_EXAMPLES: Example[] = [
  { phone: '+919845012345', full_name: 'Priya Sharma', email: 'priya.sharma@example.com', relation: 'mother', alternate_phone: '', student_admission_nos: 'ADM-2026-001;ADM-2026-002' },
  { phone: '+919900112233', full_name: 'Imran Khan', email: '', relation: 'guardian', alternate_phone: '+919900112234', student_admission_nos: 'ADM-2026-010' },
];

const TEXT_COLUMNS = /phone|admission/;

export type TemplateKind = 'students' | 'parents';

function spec(kind: TemplateKind): { columns: readonly string[]; examples: Example[]; fileBase: string } {
  return kind === 'students'
    ? { columns: STUDENT_IMPORT_COLUMNS, examples: STUDENT_EXAMPLES, fileBase: 'students-import-template' }
    : { columns: PARENT_IMPORT_COLUMNS, examples: PARENT_EXAMPLES, fileBase: 'parents-import-template' };
}

export function templateCsv(kind: TemplateKind): string {
  const { columns, examples } = spec(kind);
  const cols: CsvColumn<Example>[] = columns.map((c) => ({ header: c, value: (r) => r[c] ?? '' }));
  return toCsv(cols, examples);
}

export async function templateXlsx(kind: TemplateKind): Promise<Buffer> {
  const { columns, examples } = spec(kind);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Where Is My Bus';
  const ws = wb.addWorksheet(kind === 'students' ? 'Students' : 'Parents');
  ws.columns = columns.map((c) => ({ header: c, key: c, width: Math.max(14, c.length + 4), style: TEXT_COLUMNS.test(c) ? { numFmt: '@' } : {} }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const e of examples) ws.addRow(Object.fromEntries(columns.map((c) => [c, e[c] ?? ''])));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Sends the template in the requested format. */
export async function sendTemplate(res: Response, kind: TemplateKind, format: 'csv' | 'xlsx'): Promise<void> {
  const { fileBase } = spec(kind);
  if (format === 'xlsx') {
    const body = await templateXlsx(kind);
    res.status(200).setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', contentDisposition(`${fileBase}.xlsx`));
    res.send(body);
    return;
  }
  res.status(200).setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', contentDisposition(`${fileBase}.csv`));
  res.send(templateCsv(kind));
}
