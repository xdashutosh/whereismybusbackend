// Spreadsheet parsing for the student/parent imports: CSV (RFC 4180: quotes, doubled quotes,
// CR/LF/CRLF, UTF-8 BOM; delimiter ',' ';' or TAB detected from the header line) and XLSX (first
// worksheet, via exceljs). Header names are normalised ('Parent 1 Phone' → parent1_phone) and
// mapped through aliases; values are trimmed strings ('' = empty). A leading apostrophe that our
// own CSV exports add before = + - @ (formula guard) is removed again.
import ExcelJS from 'exceljs';
import { IMPORT_MAX_ROWS } from '@wimb/shared';
import { unsupportedFile, validationError } from '../../../shared/errors.js';
import { assertZipWithinLimits } from './zipGuard.js';

export interface ParsedRow {
  /** Spreadsheet row number (header = 1). */
  row: number;
  values: Record<string, string>;
}

export interface ParsedSheet {
  format: 'csv' | 'xlsx';
  /** Recognised canonical columns, in file order. */
  columns: string[];
  /** Header cells that matched no known column. */
  ignoredColumns: string[];
  rows: ParsedRow[];
}

const MAX_CELL_LENGTH = 5000;

/** 'Parent 1 Phone' → 'parent_1_phone'; 'Admission No.' → 'admission_no'. */
export function normalizeHeader(h: string): string {
  return h
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Removes the formula guard apostrophe of our CSV exports and trims. */
export function cleanCell(v: string): string {
  const s = v.split(String.fromCharCode(0)).join('').trim();
  return /^'[=+\-@]/.test(s) ? s.slice(1) : s;
}

/** RFC 4180 CSV → rows of raw cells. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, '');
  const firstLine = src.slice(0, Math.max(0, src.search(/\r|\n/)) || src.length);
  const counts = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length - 1] as const);
  const delimiter = counts.reduce((best, c) => (c[1] > best[1] ? c : best), counts[0]!)[0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && cell.trim() === '') {
      quoted = true;
      cell = '';
      i += 1;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
      i += 1;
    } else if (ch === '\r' || ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += ch === '\r' && src[i + 1] === '\n' ? 2 : 1;
    } else {
      cell += ch;
      i += 1;
    }
  }
  if (quoted) throw validationError('The CSV file has an unterminated quoted value.');
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** exceljs cell value → string. */
function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('richText' in v && Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    if ('text' in v && typeof v.text === 'string') return v.text;
    if ('result' in v) return cellText((v as { result?: ExcelJS.CellValue }).result ?? null);
    if ('error' in v) return '';
  }
  return '';
}

/** First worksheet of an XLSX workbook → rows of raw cells. */
export async function parseXlsx(buf: Buffer): Promise<string[][]> {
  // Refuse decompression bombs before exceljs inflates the whole workbook in memory.
  await assertZipWithinLimits(buf);
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch {
    throw unsupportedFile('The spreadsheet could not be read. Save it as .xlsx or .csv and try again.');
  }
  const ws = wb.worksheets[0];
  if (!ws) return [];
  if (ws.actualRowCount > IMPORT_MAX_ROWS + 1) throw tooManyRows();
  const rows: string[][] = [];
  const width = ws.columnCount;
  ws.eachRow({ includeEmpty: true }, (r, n) => {
    const cells: string[] = [];
    for (let c = 1; c <= width; c += 1) cells.push(cellText(r.getCell(c).value));
    rows[n - 1] = cells;
  });
  for (let i = 0; i < rows.length; i += 1) rows[i] ??= [];
  return rows;
}

const tooManyRows = () => validationError(`The file has more than ${IMPORT_MAX_ROWS} rows. Split it into smaller files.`, [{ path: 'fileId', message: `At most ${IMPORT_MAX_ROWS} rows per file` }]);

const isXlsx = (buf: Buffer) => buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;

/**
 * Parses a CSV/XLSX buffer. `resolveColumn` maps a normalised header to its canonical column (or
 * null to ignore it); duplicate columns are refused. Fully empty rows are skipped.
 */
export async function parseSheet(buf: Buffer, resolveColumn: (normalized: string) => string | null): Promise<ParsedSheet> {
  const format = isXlsx(buf) ? 'xlsx' : 'csv';
  let raw: string[][];
  if (format === 'xlsx') raw = await parseXlsx(buf);
  else {
    const text = buf.toString('utf8');
    if (text.includes('�')) throw unsupportedFile('The CSV file must be UTF-8 encoded (in Excel: Save As → "CSV UTF-8").');
    raw = parseCsv(text);
  }
  const headerIndex = raw.findIndex((r) => r.some((c) => c.trim() !== ''));
  if (headerIndex < 0) throw validationError('The file is empty.', [{ path: 'fileId', message: 'No header row found' }]);
  const header = raw[headerIndex]!;
  const columns: string[] = [];
  const ignoredColumns: string[] = [];
  const indexOf = new Map<string, number>();
  header.forEach((h, i) => {
    const label = h.replace(/^\uFEFF/, '').trim();
    if (!label) return;
    const col = resolveColumn(normalizeHeader(label));
    if (!col) {
      ignoredColumns.push(label);
      return;
    }
    if (indexOf.has(col)) throw validationError(`The column "${label}" appears twice.`, [{ path: 'fileId', message: `Duplicate column ${col}` }]);
    indexOf.set(col, i);
    columns.push(col);
  });
  const rows: ParsedRow[] = [];
  for (let i = headerIndex + 1; i < raw.length; i += 1) {
    const cells = raw[i]!;
    if (!cells.some((c) => c.trim() !== '')) continue;
    if (rows.length >= IMPORT_MAX_ROWS) throw tooManyRows();
    const values: Record<string, string> = {};
    for (const [col, idx] of indexOf) values[col] = cleanCell(cells[idx] ?? '').slice(0, MAX_CELL_LENGTH);
    rows.push({ row: i + 1, values });
  }
  return { format, columns, ignoredColumns, rows };
}
