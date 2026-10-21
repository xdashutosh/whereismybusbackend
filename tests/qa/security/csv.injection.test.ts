// CSV formula injection in EVERY /school/* CSV export (BP §16): hostile text in every free-text
// column an admin, import or driver can write; no exported cell may start with = + - @ TAB CR.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { modules } from '../../../src/modules/index.js';
import { closeDb, ownerQuery } from '../../helpers/db.js';
import { buildWorld, call, type World } from './world.js';

let w: World;
const GETS: string[] = [];
function walk(stack: unknown[]) {
  for (const l of stack as { route?: { path: string; methods: Record<string, boolean> }; handle?: { stack?: unknown[] } }[]) {
    if (l.route?.methods.get && l.route.path.startsWith('/school/') && !l.route.path.includes(':')) GETS.push(l.route.path);
    else if (l.handle?.stack) walk(l.handle.stack);
  }
}
for (const m of modules) walk((m.router as unknown as { stack: unknown[] }).stack);

const PAYLOADS = ['=HYPERLINK("http://evil.example/x","x")', '+cmd|"/c calc"!A1', '-2+3', '@SUM(A1)', '\t=1+1', '\r=1+1'];

beforeAll(async () => {
  w = await buildWorld();
  const s = w.fx.a.school.id;
  const p = (i: number) => PAYLOADS[i % PAYLOADS.length]!;
  const updates: [string, string][] = [
    ['buses', 'display_name'], ['buses', 'make_model'], ['buses', 'notes'],
    ['staff_profiles', 'full_name'], ['students', 'full_name'], ['students', 'class_name'], ['school_parents', 'full_name'],
    ['routes', 'name'], ['routes', 'description'], ['stops', 'name'], ['alerts', 'title'], ['fuel_logs', 'station'], ['fuel_logs', 'notes'],
    ['maintenance_logs', 'service_type'], ['maintenance_logs', 'vendor'], ['maintenance_logs', 'notes'], ['school_holidays', 'name'],
    ['announcements', 'title'], ['trips', 'purpose'], ['trips', 'driver_name_snapshot'], ['users', 'full_name'], ['trip_schedules', 'name'],
  ];
  let i = 0;
  for (const [table, col] of updates) {
    try {
      await ownerQuery(`update ${table} set ${col} = $1 where school_id = $2`, [p(i++), s]);
    } catch {
      /* column absent in this table: skip */
    }
  }
});
afterAll(closeDb);

function cells(csv: string): string[] {
  const out: string[] = [];
  let cell = '';
  let q = false;
  const src = csv.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (q) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"' && cell === '') q = true;
    else if (ch === ',' || ch === '\n') { out.push(cell.replace(/\r$/, '')); cell = ''; } else cell += ch;
  }
  return out;
}

describe('formula injection guard on every CSV export', () => {
  it('no exported cell starts with = + - @ TAB or CR (numbers excepted)', async () => {
    const bad: string[] = [];
    let exports = 0;
    for (const path of GETS) {
      if (path.includes('template')) continue;
      const res = await call(w.t, 'get', `${path}?format=csv&limit=100`, w.adminA.accessToken);
      if (res.status !== 200 || !String(res.headers['content-type']).includes('text/csv')) continue;
      exports++;
      for (const c of cells(res.text)) if (/^[=+\-@\t\r]/.test(c) && !/^-?\d+(\.\d+)?$/.test(c)) bad.push(`${path}: ${JSON.stringify(c).slice(0, 60)}`);
    }
    console.log(`[evidence] ${exports} CSV exports checked`);
    expect(exports).toBeGreaterThan(10);
    expect(bad).toEqual([]);
  });
});
