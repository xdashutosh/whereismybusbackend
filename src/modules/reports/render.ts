// Report output formats (contract §2 Reports): CSV streamed through the shared writer (formula guard,
// BOM, CRLF) and PDF drawn with pdfkit + the shared paginated table (shared/pdf.ts drawTable) under a
// header carrying the school's logo and name. Datetimes are printed in the school's timezone.
import type { ReportColumn, ReportResponse } from '@wimb/shared';
import type { Response } from 'express';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import { createCsvWriter, type CsvColumn } from '../../shared/csv.js';
import { logger as rootLogger } from '../../shared/logger.js';
import { drawTable, type PdfColumn, type PdfDoc } from '../../shared/pdf.js';
import { contentDisposition, storage } from '../../shared/storage.js';
import type { ReportDefinition } from './definitions.js';

const log = rootLogger.child({ module: 'reports' });

const MARGIN = 36;
const MAX_LOGO_BYTES = 5 * 1024 * 1024;

export interface SchoolHeader {
  schoolId: string;
  name: string;
  code: string;
  logoKey: string | null;
}

type Row = Record<string, unknown>;

/** 'YYYY-MM-DD HH:mm' in `timezone` (empty for null / invalid input). */
export function localDateTime(iso: unknown, timezone: string): string {
  if (typeof iso !== 'string' || !iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const p = (t: string) => parts.find((x) => x.type === t)?.value ?? '';
  return `${p('year')}-${p('month')}-${p('day')} ${p('hour')}:${p('minute')}`;
}

/** CSV cell: numbers stay numeric, datetimes become school-local, lists are joined. */
function csvValue(c: ReportColumn, v: unknown, timezone: string): unknown {
  if (v === null || v === undefined) return '';
  if (c.type === 'datetime') return localDateTime(v, timezone);
  if (c.type === 'list') return Array.isArray(v) ? v.join('; ') : v;
  return v;
}

const NUMBER_FORMATS: Partial<Record<ReportColumn['type'], Intl.NumberFormat>> = {
  int: new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }),
  decimal: new Intl.NumberFormat('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 }),
  km: new Intl.NumberFormat('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
  money: new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  percent: new Intl.NumberFormat('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
};

const humanize = (s: string) => (/^[a-z]+(_[a-z]+)*$/.test(s) ? (s.charAt(0).toUpperCase() + s.slice(1)).replace(/_/g, ' ') : s);

const scalarText = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'bigint' ? String(v) : JSON.stringify(v));

/** PDF cell text. */
export function pdfValue(c: ReportColumn, v: unknown, timezone: string): string {
  if (v === null || v === undefined || v === '') return '–';
  if (c.type === 'datetime') return localDateTime(v, timezone) || '–';
  if (c.type === 'list') return Array.isArray(v) ? v.join(', ') || '–' : scalarText(v);
  if (typeof v === 'number') {
    const f = NUMBER_FORMATS[c.type];
    const s = f ? f.format(v) : String(v);
    return c.type === 'percent' ? `${s}%` : s;
  }
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  const text = scalarText(v);
  return c.type === 'text' ? humanize(text) : text;
}

function columnLabel(c: ReportColumn, timezone: string): string {
  return c.type === 'datetime' ? `${c.label} (${timezone})` : c.label;
}

export function fileBaseName(report: ReportResponse): string {
  const range = report.range.from && report.range.to ? `-${report.range.from}_${report.range.to}` : `-${report.generatedAt.slice(0, 10)}`;
  return `${report.report}-report${range}`;
}

/** Streams the report as CSV (one header row, then the rows; no totals row). */
export async function sendCsv(res: Response, report: ReportResponse): Promise<void> {
  const columns: CsvColumn<Row>[] = report.columns.map((c) => ({ header: columnLabel(c, report.timezone), value: (r: Row) => csvValue(c, r[c.key], report.timezone) }));
  const csv = createCsvWriter<Row>(res, { fileName: `${fileBaseName(report)}.csv`, columns });
  await csv.writeAll(report.rows as unknown as Row[]);
  await csv.end();
}

/** School logo as a PNG small enough for the header, or null (no logo, foreign key, unreadable image). */
export async function loadLogoPng(school: SchoolHeader): Promise<Buffer | null> {
  if (!school.logoKey || storage.schoolIdOfKey(school.logoKey) !== school.schoolId) return null;
  try {
    const obj = await storage.getObjectStream(school.logoKey);
    if (!obj) return null;
    if (obj.size > MAX_LOGO_BYTES) {
      obj.stream.destroy();
      return null;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of obj.stream as AsyncIterable<Buffer>) {
      total += chunk.length;
      if (total > MAX_LOGO_BYTES) {
        obj.stream.destroy();
        return null;
      }
      chunks.push(chunk);
    }
    return await sharp(Buffer.concat(chunks)).resize({ width: 240, height: 120, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  } catch (err) {
    log.warn({ err, schoolId: school.schoolId }, 'reports: school logo could not be read; PDF rendered without it');
    return null;
  }
}

function drawHeader(doc: PdfDoc, report: ReportResponse, def: ReportDefinition, school: SchoolHeader, logo: Buffer | null, busLabel: string | null): void {
  const textX = logo ? MARGIN + 92 : MARGIN;
  const width = doc.page.width - MARGIN - textX;
  if (logo) {
    try {
      doc.image(logo, MARGIN, MARGIN, { fit: [80, 44], align: 'center', valign: 'center' });
    } catch (err) {
      log.warn({ err, schoolId: school.schoolId }, 'reports: school logo could not be drawn');
    }
  }
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#1D2D3E').text(school.name, textX, MARGIN, { width });
  doc.font('Helvetica-Bold').fontSize(15).fillColor('#0A6ED1').text(`${def.title} report`, textX, doc.y + 2, { width });
  const meta = [
    report.range.from && report.range.to ? `Period: ${report.range.from} to ${report.range.to}` : report.range.from ? `Due from ${report.range.from}` : report.range.to ? `Due until ${report.range.to}` : 'Status as of today',
    `Bus: ${busLabel ?? 'All buses'}`,
    `Generated: ${localDateTime(report.generatedAt, report.timezone)} (${report.timezone})`,
    `School code: ${school.code}`,
  ];
  doc.font('Helvetica').fontSize(8.5).fillColor('#556B82').text(meta.join('   ·   '), textX, doc.y + 3, { width });
  doc.text(def.description, textX, doc.y + 2, { width });
  if (report.truncated) doc.fillColor('#BB0000').text(`Only the first ${report.rows.length} rows are shown; narrow the date range or pick a bus.`, textX, doc.y + 2, { width });
  doc.x = MARGIN;
  doc.y = Math.max(doc.y, logo ? MARGIN + 48 : 0) + 12;
}

function footer(doc: PdfDoc, text: string): void {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0; // the footer sits inside the bottom margin; never trigger a page break
    const y = doc.page.height - MARGIN + 6;
    const pageLabel = `Page ${i + 1 - range.start} of ${range.count}`;
    doc.font('Helvetica').fontSize(7.5).fillColor('#556B82');
    doc.text(text, MARGIN, y, { lineBreak: false });
    doc.text(pageLabel, doc.page.width - MARGIN - doc.widthOfString(pageLabel), y, { lineBreak: false });
  }
}

const TABLE_FONT = 8.5;
const CELL_PAD = 10;
const MAX_TEXT_WIDTH: Partial<Record<ReportColumn['type'], number>> = { text: 150, list: 200 };

/**
 * Column width weights fitted to the content: the widest header word (headers wrap between words,
 * never inside one) and the widest cell, text columns capped so long values wrap.
 */
function fitWidths(doc: PdfDoc, columns: readonly ReportColumn[], headers: readonly string[], rows: readonly string[][]): number[] {
  return columns.map((c, i) => {
    doc.font('Helvetica-Bold').fontSize(TABLE_FONT);
    let need = Math.max(...headers[i]!.split(/\s+/).map((w) => doc.widthOfString(w)));
    doc.font('Helvetica').fontSize(TABLE_FONT);
    for (const r of rows) need = Math.max(need, Math.min(doc.widthOfString(r[i] ?? ''), MAX_TEXT_WIDTH[c.type] ?? Infinity));
    return need + CELL_PAD;
  });
}

/** Renders the report as a PDF Buffer (header with logo + school name, table, totals row, page numbers). */
export function renderReportPdf(report: ReportResponse, def: ReportDefinition, school: SchoolHeader, logo: Buffer | null, busLabel: string | null): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4', layout: def.landscape ? 'landscape' : 'portrait', margin: MARGIN, bufferPages: true,
      info: { Title: `${def.title} report · ${school.name}`, Producer: 'Where Is My Bus', Creator: 'Where Is My Bus' },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      drawHeader(doc, report, def, school, logo, busLabel);
      const shown = def.columns.filter((c) => c.pdf !== false);
      const rows: string[][] = (report.rows as unknown as Row[]).map((r) => shown.map((c) => pdfValue(c, r[c.key], report.timezone)));
      if (def.sum.length && rows.length) {
        rows.push(shown.map((c, i) => (i === 0 ? 'Total' : c.key in report.totals ? pdfValue(c, report.totals[c.key], report.timezone) : '')));
      }
      const headers = shown.map((c) => columnLabel(c, report.timezone));
      const widths = fitWidths(doc, shown, headers, rows);
      const columns: PdfColumn<string[]>[] = shown.map((c, i) => ({
        header: headers[i]!,
        width: widths[i]!,
        align: ['int', 'decimal', 'km', 'money', 'percent'].includes(c.type) ? 'right' : 'left',
        value: (r) => r[i],
      }));
      drawTable(doc, columns, rows);
      footer(doc, `Where Is My Bus · ${school.name}`);
      doc.end();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** Sends the PDF as an attachment with safe headers. */
export async function sendReportPdf(res: Response, report: ReportResponse, def: ReportDefinition, school: SchoolHeader, busLabel: string | null): Promise<void> {
  const logo = await loadLogoPng(school);
  const buffer = await renderReportPdf(report, def, school, logo, busLabel);
  res.status(200);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', contentDisposition(`${fileBaseName(report)}.pdf`));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(buffer);
}
