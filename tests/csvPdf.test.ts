// CSV export (formula-injection guard, quoting, streaming) and PDF reports (pdfkit table).
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createCsvWriter, csvField, guardCell, toCsv } from '../src/shared/csv.js';
import { renderPdf, sendPdf } from '../src/shared/pdf.js';

describe('csv', () => {
  it('guards formula-looking cells but not numbers', () => {
    for (const s of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tx', '\rx']) expect(guardCell(s)).toBe(`'${s}`);
    expect(guardCell(-12.5)).toBe('-12.5');
    expect(guardCell(Number.NaN)).toBe('');
    expect(guardCell(null)).toBe('');
    expect(guardCell(true)).toBe('true');
    expect(guardCell(['=a', 'b'])).toBe("'=a; b");
    expect(guardCell({ a: 1 })).toBe('{"a":1}');
    expect(guardCell(new Date('2026-10-17T00:00:00Z'))).toBe('2026-10-17T00:00:00.000Z');
  });

  it('quotes per RFC 4180', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField(' padded')).toBe('" padded"');
    expect(toCsv([{ header: 'Bus', key: 'code' }, { header: 'Km', value: (r: { km: number }) => r.km }], [{ code: 'R1', km: 12 }], { bom: false })).toBe('Bus,Km\r\nR1,12\r\n');
  });

  it('streams with headers, BOM and row count', async () => {
    const app = express();
    let count = -1;
    app.get('/csv', async (_req, res) => {
      const w = createCsvWriter(res, { fileName: 'buses.csv', columns: [{ header: 'Code', key: 'code' as const }] });
      await w.writeAll([{ code: 'R1' }, { code: '=HYPERLINK()' }]);
      count = await w.end();
    });
    const res = await request(app).get('/csv').buffer(true).parse((r, cb) => {
      let data = '';
      r.on('data', (c: Buffer) => (data += c.toString('utf8')));
      r.on('end', () => cb(null, data));
    });
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toContain('buses.csv');
    expect(res.body).toBe("\uFEFFCode\r\nR1\r\n'=HYPERLINK()\r\n");
    expect(count).toBe(2);
  });
});

describe('pdf', () => {
  const columns = [
    { header: 'Bus', value: (r: { i: number }) => `R${r.i}` },
    { header: 'Distance (km)', align: 'right' as const, value: (r: { i: number }) => r.i * 1.5 },
  ];

  it('renders a paginated table report', async () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({ i }));
    const pdf = await renderPdf({ title: 'Bus distance', subtitle: 'Greenwood International School', meta: ['01–31 Oct 2026'], columns, rows });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const pages = (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;
    expect(pages).toBeGreaterThan(1);
  });

  it('keeps the page footer on its page (a one-row report is one page)', async () => {
    const pdf = await renderPdf({ title: 'Bus distance', columns, rows: [{ i: 1 }] });
    const pages = (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;
    expect(pages).toBe(1);
    const many = await renderPdf({ title: 'Bus distance', columns, rows: Array.from({ length: 120 }, (_, i) => ({ i })) });
    const manyPages = (many.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;
    // 120 rows fit on 3 portrait pages; the footers must not add one blank page per page.
    expect(manyPages).toBeLessThanOrEqual(3);
  });

  it('renders an empty report and sends it as an attachment', async () => {
    const app = express();
    app.get('/pdf', (_req, res) => sendPdf(res, 'empty.pdf', { title: 'Nothing', columns, rows: [] }));
    const res = await request(app).get('/pdf').buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain('empty.pdf');
  });
});
