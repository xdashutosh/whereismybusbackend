// PDF reports (contract §2 Reports) with pdfkit: a titled document + a paginated table whose header
// row repeats on every page, plus page numbers. renderPdf() returns a Buffer; sendPdf() streams to
// an HTTP response with safe headers.
import type { Response } from 'express';
import PDFDocument from 'pdfkit';
import { contentDisposition } from './storage.js';

export type PdfDoc = InstanceType<typeof PDFDocument>;

export interface PdfColumn<R> {
  header: string;
  /** Relative width weight (default 1). */
  width?: number;
  align?: 'left' | 'right' | 'center';
  value: (row: R) => unknown;
}

export interface PdfReportOptions<R> {
  title: string;
  subtitle?: string;
  /** Lines printed under the title (filters, school name, generated-at). */
  meta?: string[];
  columns: readonly PdfColumn<R>[];
  rows: readonly R[];
  landscape?: boolean;
  /** Footer text left of the page number. */
  footer?: string;
}

const MARGIN = 36;
const FONT_SIZE = 8.5;
const HEADER_FILL = '#EAF1FB';
const RULE = '#D5DADD';

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'string') return v;
  return typeof v === 'boolean' || typeof v === 'bigint' ? String(v) : '';
}

/** Draws a paginated table at the current y position. */
export function drawTable<R>(doc: PdfDoc, columns: readonly PdfColumn<R>[], rows: readonly R[]): void {
  const usable = doc.page.width - MARGIN * 2;
  const totalWeight = columns.reduce((s, c) => s + (c.width ?? 1), 0);
  const widths = columns.map((c) => (usable * (c.width ?? 1)) / totalWeight);
  const pad = 4;
  const bottom = () => doc.page.height - MARGIN - 18;

  const rowHeight = (cells: string[], bold: boolean) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(FONT_SIZE);
    return Math.max(...cells.map((t, i) => doc.heightOfString(t || ' ', { width: widths[i]! - pad * 2 }))) + pad * 2;
  };

  const drawRow = (cells: string[], y: number, h: number, header: boolean) => {
    let x = MARGIN;
    if (header) doc.save().rect(MARGIN, y, usable, h).fill(HEADER_FILL).restore();
    doc.font(header ? 'Helvetica-Bold' : 'Helvetica').fontSize(FONT_SIZE).fillColor('#1D2D3E');
    cells.forEach((t, i) => {
      doc.text(t, x + pad, y + pad, { width: widths[i]! - pad * 2, align: columns[i]!.align ?? 'left' });
      x += widths[i]!;
    });
    doc
      .save()
      .moveTo(MARGIN, y + h)
      .lineTo(MARGIN + usable, y + h)
      .lineWidth(0.5)
      .strokeColor(RULE)
      .stroke()
      .restore();
  };

  const headers = columns.map((c) => c.header);
  const headerH = rowHeight(headers, true);
  let y = doc.y;
  const header = () => {
    drawRow(headers, y, headerH, true);
    y += headerH;
  };
  if (y + headerH > bottom()) {
    doc.addPage();
    y = MARGIN;
  }
  header();
  if (!rows.length) {
    doc.font('Helvetica-Oblique').fontSize(FONT_SIZE).fillColor('#556B82').text('No data for the selected filters.', MARGIN + pad, y + pad);
    y += FONT_SIZE + pad * 3;
  }
  for (const row of rows) {
    const cells = columns.map((c) => cellText(c.value(row)));
    const h = rowHeight(cells, false);
    if (y + h > bottom()) {
      doc.addPage();
      y = MARGIN;
      header();
    }
    drawRow(cells, y, h, false);
    y += h;
  }
  doc.x = MARGIN;
  doc.y = y + 6;
}

function buildReport<R>(doc: PdfDoc, opts: PdfReportOptions<R>): void {
  doc.font('Helvetica-Bold').fontSize(15).fillColor('#0A6ED1').text(opts.title, MARGIN, MARGIN);
  if (opts.subtitle) doc.font('Helvetica').fontSize(10.5).fillColor('#1D2D3E').text(opts.subtitle);
  if (opts.meta?.length) doc.font('Helvetica').fontSize(8.5).fillColor('#556B82').text(opts.meta.join('   ·   '));
  doc.moveDown(0.8);
  drawTable(doc, opts.columns, opts.rows);
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    // The footer sits inside the bottom margin: without this pdfkit would start a new page for it.
    doc.page.margins.bottom = 0;
    const y = doc.page.height - MARGIN + 6;
    const pageLabel = `Page ${i + 1 - range.start} of ${range.count}`;
    doc.font('Helvetica').fontSize(7.5).fillColor('#556B82');
    doc.text(opts.footer ?? 'Where Is My Bus', MARGIN, y, { lineBreak: false });
    doc.text(pageLabel, doc.page.width - MARGIN - doc.widthOfString(pageLabel), y, { lineBreak: false });
  }
}

function newDoc(landscape?: boolean): PdfDoc {
  return new PDFDocument({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margin: MARGIN, bufferPages: true, info: { Producer: 'Where Is My Bus' } });
}

/** Renders a report to a Buffer. */
export function renderPdf<R>(opts: PdfReportOptions<R>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = newDoc(opts.landscape);
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      buildReport(doc, opts);
      doc.end();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** Renders a report and sends it as an attachment. */
export async function sendPdf<R>(res: Response, fileName: string, opts: PdfReportOptions<R>): Promise<void> {
  const buffer = await renderPdf(opts);
  res.status(200);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', contentDisposition(fileName));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(buffer);
}
