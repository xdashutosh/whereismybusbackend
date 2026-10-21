// Report formats (contract §2 Reports, §5): CSV streaming with the formula-injection guard, BOM,
// school-local datetimes and file names; PDF via pdfkit + the shared table with the school's name and
// logo in the header and a totals row; the 10 000-row cap; date-range defaults in the school's
// timezone (far-east and far-west zones, so the school-local day differs from the UTC day).
import zlib from 'node:zlib';
import type { NonSchoolUsageRow, ReportResponse } from '@wimb/shared';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { storage } from '../src/shared/storage.js';
import { buildApp, loginSchoolAdmin, schoolAdmin, type TestApp } from './helpers/authApp.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { auth, localDay, reportsWorld, type ReportsWorld } from './reports.fixtures.js';

let t: TestApp;
let a: ReportsWorld;
let b: ReportsWorld;

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  a = await reportsWorld(t.app, { name: 'Greenfield Public School' });
  b = await reportsWorld(t.app, { name: 'Lakeside Senior School', scale: 10 });
  // School A has an uploaded logo; formula-like purposes on two more non-school trips.
  const key = storage.schoolObjectKey({ schoolId: a.sid, category: 'school_logo', entityId: a.sid, extension: 'png' });
  const png = await sharp({ create: { width: 64, height: 32, channels: 3, background: '#0070F2' } }).png().toBuffer();
  await storage.putObject({ key, body: png, contentType: 'image/png' });
  const logo = await f.file(a.sid, { key, category: 'school_logo', entity_type: 'school', entity_id: a.sid, mime: 'image/png', size_bytes: png.length });
  await ownerQuery('update schools set logo_file_id = $1 where id = $2', [logo.id, a.sid]);
  const d2 = localDay('Asia/Kolkata', -2);
  await f.trip(a.sid, a.r2.id, { trip_type: 'non_school', direction: null, purpose: '=HYPERLINK("http://evil.example","x")', trip_date: d2, status: 'completed', started_at: `${d2}T10:00:00Z`, ended_at: `${d2}T10:30:00Z`, bus_code_snapshot: 'R2' });
  await f.trip(a.sid, a.r2.id, { trip_type: 'non_school', direction: null, purpose: '+cmd|calc', trip_date: d2, status: 'cancelled', started_at: `${d2}T11:00:00Z`, ended_at: `${d2}T11:05:00Z`, bus_code_snapshot: 'R2' });
});
afterAll(closeDb);

const range = () => ({ from: localDay('Asia/Kolkata', -10), to: localDay('Asia/Kolkata') });
const raw = (token: string, kind: string, query: Record<string, string>) =>
  request(t.app).get(`/api/v1/school/reports/${kind}`).query(query).set(auth(token)).buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });

/** Text drawn in a pdfkit PDF: inflates the content streams and decodes the hex strings of TJ operators. */
function pdfText(pdf: Buffer): string {
  const s = pdf.toString('latin1');
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const start = s.indexOf('stream\n', i);
    if (start < 0) break;
    const end = s.indexOf('\nendstream', start);
    if (end < 0) break;
    const body = pdf.subarray(start + 7, end);
    i = end + 10;
    let text: string;
    try {
      text = zlib.inflateSync(body).toString('latin1');
    } catch {
      continue;
    }
    for (const m of text.matchAll(/\[(.*?)\]\s*TJ/gs)) {
      out.push([...m[1]!.matchAll(/<([0-9a-fA-F]+)>/g)].map((h) => Buffer.from(h[1]!, 'hex').toString('latin1')).join(''));
    }
  }
  return out.join('\n');
}

describe('CSV', () => {
  it('streams a BOM-prefixed CSV with labelled headers and raw numbers', async () => {
    const res = await raw(a.admin.accessToken, 'fuel', { ...range(), format: 'csv' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toContain(`fuel-report-${range().from}_${range().to}.csv`);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = (res.body as Buffer).toString('utf8');
    expect(body.startsWith('﻿')).toBe(true);
    const lines = body.slice(1).trimEnd().split('\r\n');
    expect(lines[0]).toBe('Bus,Registration,Fuel type,Unit,Fills,Litres,CNG kg,kWh,Cost,Avg price / unit,Odometer km between fills,Trip km,Distance km,Distance from,Km / unit,Fuel cost / km,Last fill');
    expect(lines[1]).toBe(`R1,KA01AB1001,diesel,L,2,60,0,0,5800,96.67,500,70.5,500,odometer,25,4,${localDay('Asia/Kolkata', -2)}`);
    expect(lines).toHaveLength(4);
  });

  it('guards formula-like text cells and prints datetimes in the school timezone', async () => {
    const res = await raw(a.admin.accessToken, 'non-school-usage', { ...range(), format: 'csv' });
    const lines = (res.body as Buffer).toString('utf8').slice(1).trimEnd().split('\r\n');
    expect(lines[0]).toContain('Started (Asia/Kolkata),Ended (Asia/Kolkata)');
    expect(lines.some((l) => l.includes(`"'=HYPERLINK(""http://evil.example"",""x"")"`))).toBe(true);
    expect(lines.some((l) => l.includes(`'+cmd|calc`))).toBe(true);
    expect(lines.some((l) => /(^|,)[=+\-@]/.test(l))).toBe(false);
    const picnic = lines.find((l) => l.includes('Picnic'))!;
    expect(picnic).toContain(`${localDay('Asia/Kolkata', -4)} 09:30,${localDay('Asia/Kolkata', -4)} 11:30,120`);
  });

  it('service-due without dates is named after the day; lists join with semicolons', async () => {
    const res = await raw(a.admin.accessToken, 'service-due', { format: 'csv' });
    expect(res.headers['content-disposition']).toMatch(/service-due-report-\d{4}-\d{2}-\d{2}\.csv/);
    const m = await raw(a.admin.accessToken, 'maintenance', { ...range(), format: 'csv' });
    expect((m.body as Buffer).toString('utf8')).toContain('Brake check; Oil change');
  });
});

describe('PDF', () => {
  it('renders the school name, logo, title, period, rows and totals', async () => {
    const res = await raw(a.admin.accessToken, 'cost-per-km', { ...range(), format: 'pdf' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain(`cost-per-km-report-${range().from}_${range().to}.pdf`);
    const pdf = res.body as Buffer;
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1')).toContain('/Subtype /Image');
    const text = pdfText(pdf);
    expect(text).toContain('Greenfield Public School');
    expect(text).toContain('Cost per km report');
    expect(text).toContain(`Period: ${range().from} to ${range().to}`);
    expect(text).toContain('Bus: All buses');
    expect(text).toContain('8.79'); // total cost / km over the odometer distance
    expect(text).toContain('Odometer'); // distance source column
    expect(text).not.toContain('Odometer km between fills'); // raw measurements stay in JSON / CSV
    expect(text).toContain('Total');
    expect(text).toContain('9,300.00');
    expect(text).not.toContain('Lakeside');
    // one page: the footer (page numbers) never spills onto an extra page
    expect(pdf.toString('latin1')).toMatch(/\/Count 1\b/);
    expect(text).toContain('Page 1 of 1');
  });

  it('a school without a logo gets a text-only header; the bus filter and empty results are shown', async () => {
    const res = await raw(b.admin.accessToken, 'non-school-usage', { ...range(), busId: b.r2.id, format: 'pdf' });
    expect(res.status).toBe(200);
    const pdf = res.body as Buffer;
    expect(pdf.toString('latin1')).not.toContain('/Subtype /Image');
    const text = pdfText(pdf);
    expect(text).toContain('Lakeside Senior School');
    expect(text).toContain('Bus: R2');
    expect(text).toContain('No data for the selected filters.');
    expect(text).not.toContain('Total');
  });

  it('humanises statuses and prints local datetimes', async () => {
    const text = pdfText((await raw(a.admin.accessToken, 'service-due', { format: 'pdf' })).body as Buffer);
    expect(text).toContain('Due soon');
    expect(text).toContain('Overdue');
    const ns = pdfText((await raw(a.admin.accessToken, 'non-school-usage', { ...range(), format: 'pdf' })).body as Buffer);
    expect(ns).toContain(`${localDay('Asia/Kolkata', -4)} 09:30`);
    expect(ns.replace(/\n/g, '')).toContain('Started (Asia/Kolkata)');
  });

  it('a foreign or unreadable logo is skipped, never fetched across schools', async () => {
    const foreignKey = storage.schoolObjectKey({ schoolId: a.sid, category: 'school_logo', entityId: a.sid, extension: 'png' });
    const forged = await f.file(b.sid, { key: foreignKey, category: 'school_logo', entity_type: 'school', entity_id: b.sid });
    await ownerQuery('update schools set logo_file_id = $1 where id = $2', [forged.id, b.sid]);
    try {
      const res = await raw(b.admin.accessToken, 'fuel', { ...range(), format: 'pdf' });
      expect(res.status).toBe(200);
      expect((res.body as Buffer).toString('latin1')).not.toContain('/Subtype /Image');
    } finally {
      await ownerQuery('update schools set logo_file_id = null where id = $1', [b.sid]);
    }
  });
});

describe('date ranges in the school timezone', () => {
  for (const tz of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
    it(`defaults to the last 30 school-local days ending today (${tz})`, async () => {
      const school = await f.school({ timezone: tz });
      await f.schoolSubscription(school.id);
      const admin = await loginSchoolAdmin(t.app, String((await schoolAdmin(school.id)).email));
      const bus = await f.bus(school.id, { code: 'R1' });
      const today = localDay(tz);
      const mk = (day: string, km: number) => f.trip(school.id, bus.id, { trip_date: day, status: 'completed', started_at: `${day}T00:30:00Z`, ended_at: `${day}T01:00:00Z`, distance_odometer_km: km });
      await mk(today, 1);
      await mk(localDay(tz, -29), 10);
      await mk(localDay(tz, -30), 100);
      const res = await request(t.app).get('/api/v1/school/reports/bus-distance').set(auth(admin.accessToken));
      expect(res.status).toBe(200);
      const data = res.body.data as ReportResponse;
      expect(data.timezone).toBe(tz);
      expect(data.range).toEqual({ from: localDay(tz, -29), to: today });
      expect(data.totals.distanceKm).toBe(11);
      const onlyTo = await request(t.app).get('/api/v1/school/reports/bus-distance').query({ to: localDay(tz, -1) }).set(auth(admin.accessToken));
      expect((onlyTo.body.data as ReportResponse).range).toEqual({ from: localDay(tz, -30), to: localDay(tz, -1) });
      expect((onlyTo.body.data as ReportResponse).totals.distanceKm).toBe(110);
      const onlyFrom = await request(t.app).get('/api/v1/school/reports/bus-distance').query({ from: today }).set(auth(admin.accessToken));
      expect((onlyFrom.body.data as ReportResponse).range).toEqual({ from: today, to: today });
      const future = await request(t.app).get('/api/v1/school/reports/bus-distance').query({ from: localDay(tz, 5) }).set(auth(admin.accessToken));
      expect((future.body.data as ReportResponse).range).toEqual({ from: localDay(tz, 5), to: localDay(tz, 5) });
    });
  }
});

describe('row cap', () => {
  it('stops at 10 000 rows and flags the report as truncated', async () => {
    const school = await f.school({ timezone: 'Asia/Kolkata' });
    await f.schoolSubscription(school.id);
    const admin = await loginSchoolAdmin(t.app, String((await schoolAdmin(school.id)).email));
    const bus = await f.bus(school.id, { code: 'R1' });
    const day = localDay('Asia/Kolkata', -1);
    await ownerQuery(
      `insert into trips (school_id, bus_id, trip_type, purpose, trip_date, status, started_at, ended_at, distance_odometer_km)
       select $1, $2, 'non_school', 'Errand ' || g, $3::date, 'completed', $3::date + make_interval(secs => g), $3::date + make_interval(secs => g + 60), 1
         from generate_series(1, 10001) g`,
      [school.id, bus.id, day],
    );
    const res = await request(t.app).get('/api/v1/school/reports/non-school-usage').set(auth(admin.accessToken));
    expect(res.status).toBe(200);
    const data = res.body.data as Omit<ReportResponse, 'rows'> & { rows: NonSchoolUsageRow[] };
    expect(data.truncated).toBe(true);
    expect(data.rows).toHaveLength(10000);
    expect(data.totals.distanceKm).toBe(10000);
  });
});
