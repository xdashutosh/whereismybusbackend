// CSV export (contract §2 Reports, BP §16): RFC 4180 quoting, UTF-8 BOM for Excel, CRLF rows and
// the formula-injection guard — any text cell starting with = + - @ TAB or CR gets a leading '.
// Finite numbers are written as-is (their text can never form a formula; guarding them would
// corrupt negatives). The streaming writer respects backpressure.
import { once } from 'node:events';
import type { Response } from 'express';
import { contentDisposition } from './storage.js';

const FORMULA_START = /^[=+\-@\t\r]/;

export interface CsvColumn<R> {
  header: string;
  key?: keyof R & string;
  value?: (row: R) => unknown;
}

/** Applies the formula-injection guard to one value and returns its string form. */
export function guardCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'bigint') return value.toString();
  let s: string;
  if (value instanceof Date) s = Number.isNaN(value.getTime()) ? '' : value.toISOString();
  else if (Array.isArray(value)) s = value.map((v: unknown) => (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : v === null || v === undefined ? '' : JSON.stringify(v))).join('; ');
  else if (typeof value === 'object') s = JSON.stringify(value);
  else if (typeof value === 'string') s = value;
  else s = typeof value === 'boolean' ? String(value) : '';
  return FORMULA_START.test(s) ? `'${s}` : s;
}

/** Guarded + quoted CSV field. */
export function csvField(value: unknown): string {
  const s = guardCell(value);
  return /[",\r\n;]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(values: readonly unknown[]): string {
  return values.map(csvField).join(',');
}

function cellsOf<R>(columns: readonly CsvColumn<R>[], row: R): unknown[] {
  return columns.map((c) => (c.value ? c.value(row) : c.key ? (row as Record<string, unknown>)[c.key] : ''));
}

/** Whole CSV as a string (small payloads, tests, attachments). */
export function toCsv<R>(columns: readonly CsvColumn<R>[], rows: readonly R[], { bom = true } = {}): string {
  const lines = [csvLine(columns.map((c) => c.header))];
  for (const row of rows) lines.push(csvLine(cellsOf(columns, row)));
  return `${bom ? '\uFEFF' : ''}${lines.join('\r\n')}\r\n`;
}

/**
 * Streaming writer bound to an HTTP response:
 *   const csv = createCsvWriter(res, { fileName: 'buses.csv', columns });
 *   await csv.writeAll(rows); await csv.end();
 */
export function createCsvWriter<R>(res: Response, { fileName = 'export.csv', columns, bom = true }: { fileName?: string; columns: readonly CsvColumn<R>[]; bom?: boolean }) {
  if (!columns.length) throw new TypeError('createCsvWriter requires columns');
  let started = false;
  let count = 0;
  const push = async (chunk: string) => {
    if (!res.write(chunk)) await once(res, 'drain');
  };
  const start = async () => {
    if (started) return;
    started = true;
    if (!res.headersSent) {
      res.status(200);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', contentDisposition(fileName));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
    }
    await push(`${bom ? '\uFEFF' : ''}${csvLine(columns.map((c) => c.header))}\r\n`);
  };
  const writer = {
    async write(row: R) {
      await start();
      count += 1;
      await push(`${csvLine(cellsOf(columns, row))}\r\n`);
    },
    async writeAll(rows: Iterable<R>) {
      for (const row of rows) await writer.write(row);
    },
    async end(): Promise<number> {
      await start();
      res.end();
      return count;
    },
    get rowCount() {
      return count;
    },
  };
  return writer;
}
