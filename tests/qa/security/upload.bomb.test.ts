// Decompression bomb through the student/parent import (BP §16 "upload mime/size/magic-byte checks").
// A tiny XLSX (zip) used to inflate to hundreds of MB inside the API process: exceljs loads the whole
// workbook in memory BEFORE the row-count check. zipGuard.ts now inflates every entry as a counted
// stream first and refuses past the limits. The bomb is built in memory with jszip (exceljs' own
// dependency): 1000 rows × one 200 000-char cell → ~240 KB zipped, ~200 MB of XML.
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSheet } from '../../../src/modules/students/import/parse.js';
import { assertZipWithinLimits, XLSX_IMPORT_LIMITS } from '../../../src/modules/students/import/zipGuard.js';
import { closeDb } from '../../helpers/db.js';
import { api, buildWorld, call, type World } from './world.js';

function workbookZip(sheetXml: Buffer | string, extra: Record<string, Buffer | string> = {}): JSZip {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  z.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  z.file('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>');
  z.file('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
  z.file('xl/worksheets/sheet1.xml', sheetXml);
  for (const [name, data] of Object.entries(extra)) z.file(name, data);
  return z;
}

function bombSheet(rows: number, cellChars: number): Buffer {
  const big = 'A'.repeat(cellChars);
  const parts = ['<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'];
  for (let i = 1; i <= rows; i++) parts.push(`<row r="${i}"><c r="A${i}" t="inlineStr"><is><t>${big}</t></is></c></row>`);
  parts.push('</sheetData></worksheet>');
  return Buffer.from(parts.join(''));
}

const deflate = (z: JSZip) => z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
const bombXlsx = (rows = 1000, cellChars = 200_000) => deflate(workbookZip(bombSheet(rows, cellChars)));

const errorOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (err) {
    return err as { code?: string; message: string };
  }
};

let w: World;
beforeAll(async () => {
  w = await buildWorld();
});
afterAll(closeDb);

describe('XLSX import decompression bomb', () => {
  it('a ~240 KB workbook is refused before it is inflated (RSS growth stays small)', async () => {
    const buf = await bombXlsx();
    const up = await request(w.t.app).post(api('/files/upload')).set('Authorization', `Bearer ${w.adminA.accessToken}`).field('category', 'import').attach('file', buf, 'students.xlsx');
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    global.gc?.();
    const base = process.memoryUsage().rss;
    let peak = base;
    const iv = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 20);
    const res = await call(w.t, 'post', '/school/students/import', w.adminA.accessToken, { body: { fileId: up.body.data.id, dryRun: true } });
    clearInterval(iv);
    peak = Math.max(peak, process.memoryUsage().rss);
    const growthMb = Math.round((peak - base) / 1048576);
    expect(res.status, JSON.stringify(res.body)).toBe(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_FILE');
    expect(res.body.error.message).toMatch(/too large when unpacked/);
    expect(growthMb).toBeLessThan(100);

    // The parent import uses the same parser.
    const parents = await call(w.t, 'post', '/school/parents/import', w.adminA.accessToken, { body: { fileId: up.body.data.id, dryRun: true } });
    expect(parents.body.error?.code).toBe('UNSUPPORTED_FILE');
  });
});

describe('zipGuard', () => {
  it('accepts a normal exceljs workbook and parses it', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Students');
    ws.addRow(['Admission No', 'Full Name', 'Class']);
    for (let i = 1; i <= 200; i++) ws.addRow([`A-${i}`, `Student ${i}`, '8']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    await expect(assertZipWithinLimits(buf)).resolves.toBeUndefined();
    const sheet = await parseSheet(buf, (h) => (['admission_no', 'full_name', 'class'].includes(h) ? h : null));
    expect(sheet.rows).toHaveLength(200);
  });

  it('counts the real inflated bytes, not the sizes declared in the zip headers', async () => {
    const buf = await bombXlsx(200, 200_000); // ~40 MB of XML in one entry
    // Forge every declared uncompressed size to 1 byte (central directory + local headers).
    for (let i = 0; i + 4 <= buf.length; i++) {
      const sig = buf.readUInt32LE(i);
      if (sig === 0x02014b50) buf.writeUInt32LE(1, i + 24);
      else if (sig === 0x04034b50) buf.writeUInt32LE(1, i + 22);
    }
    expect((await errorOf(assertZipWithinLimits(buf)))?.code).toBe('UNSUPPORTED_FILE');
  });

  it('enforces the total across entries and the entry count', async () => {
    const chunk = Buffer.alloc(10 * 1024 * 1024, 0x41); // 10 MB per entry: under the entry cap
    const many = await deflate(workbookZip('<worksheet/>', { 'xl/media/a.bin': chunk, 'xl/media/b.bin': chunk, 'xl/media/c.bin': chunk, 'xl/media/d.bin': chunk }));
    expect((await errorOf(assertZipWithinLimits(many)))?.message).toMatch(/too large when unpacked/);
    const tiny = Object.fromEntries(Array.from({ length: XLSX_IMPORT_LIMITS.maxEntries }, (_, i) => [`xl/x/${i}.xml`, 'x']));
    const crowded = await deflate(workbookZip('<worksheet/>', tiny));
    expect((await errorOf(assertZipWithinLimits(crowded)))?.code).toBe('UNSUPPORTED_FILE');
    // Stored (uncompressed) entries count too.
    const stored = await workbookZip('<worksheet/>', { 'xl/media/big.bin': Buffer.alloc(XLSX_IMPORT_LIMITS.maxEntryBytes + 1) }).generateAsync({ type: 'nodebuffer', compression: 'STORE' });
    expect((await errorOf(assertZipWithinLimits(stored)))?.code).toBe('UNSUPPORTED_FILE');
  });

  it('refuses a truncated or corrupt archive as unreadable', async () => {
    const buf = await bombXlsx(2, 10);
    expect((await errorOf(assertZipWithinLimits(buf.subarray(0, buf.length - 30))))?.message).toMatch(/could not be read/);
    const corrupt = Buffer.from(buf);
    corrupt.writeUInt32LE(0, 0); // first local file header signature
    expect((await errorOf(assertZipWithinLimits(corrupt)))?.code).toBe('UNSUPPORTED_FILE');
  });
});
