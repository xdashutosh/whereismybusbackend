// Student and parent imports (BP §8.3 "CSV with dry-run preview and error report", §13.3 wizard;
// contract §10): templates (CSV/XLSX), dry-run preview with row errors and nothing written,
// commit refused while any row is invalid, commit in one transaction (students, parents with
// global identity reuse, links with a primary parent), onExisting=skip, XLSX input, plan limit,
// file checks (category, other school) and isolation (the same admission numbers in both schools).
import ExcelJS from 'exceljs';
import { STUDENT_IMPORT_COLUMNS } from '@wimb/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { buildApp, loginSchoolAdmin, passwordHash, type TestApp } from './helpers/authApp.js';

let t: TestApp;
let fx: f.TwoSchoolFixture;
let adminA: string;
let adminB: string;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const api = (path: string) => `/api/v1${path}`;

async function upload(token: string, content: Buffer | string, name = 'students.csv'): Promise<string> {
  const res = await request(t.app).post(api('/files/upload')).set(auth(token)).field('category', 'import').attach('file', Buffer.from(content), name);
  if (res.status !== 201) throw new Error(`upload failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.id as string;
}
const importStudents = (token: string, body: Record<string, unknown>) => request(t.app).post(api('/school/students/import')).set(auth(token)).send(body);
const importParents = (token: string, body: Record<string, unknown>) => request(t.app).post(api('/school/parents/import')).set(auth(token)).send(body);
const count = async (sql: string, params: unknown[] = []) => (await ownerQuery<{ n: number }>(sql, params)).rows[0]!.n;

const HEADER = 'Admission No,Name,Class,Section,Roll,Parent 1 Name,Parent 1 Phone,Parent 1 Email,Parent 1 Relation,Parent 2 Name,Parent 2 Phone,Unknown Column';

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  fx = await f.twoSchoolFixture();
  await ownerQuery('update users set password_hash = $1 where id = any ($2)', [await passwordHash(), [fx.a.admin.id, fx.b.admin.id]]);
  adminA = (await loginSchoolAdmin(t.app, String(fx.a.admin.email))).accessToken;
  adminB = (await loginSchoolAdmin(t.app, String(fx.b.admin.email))).accessToken;
});
afterAll(closeDb);

describe('templates', () => {
  it('serves CSV and XLSX templates with the canonical columns', async () => {
    const csv = await request(t.app).get(api('/school/students/import/template')).set(auth(adminA));
    expect(csv.status).toBe(200);
    expect(csv.headers['content-disposition']).toContain('students-import-template.csv');
    expect(csv.text.replace(/^\uFEFF/, '').split('\r\n')[0]).toBe(STUDENT_IMPORT_COLUMNS.join(','));
    const xlsx = await request(t.app).get(api('/school/parents/import/template?format=xlsx')).set(auth(adminA)).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(xlsx.headers['content-type']).toContain('spreadsheetml');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.body as ArrayBuffer);
    expect(wb.worksheets[0]!.getRow(1).getCell(1).value).toBe('phone');
  });
});

describe('student import', () => {
  const rows = [
    HEADER,
    'ADM-001,Aarav Sharma,6,A,1,,,,,,,ignored', // existing → update (class 5 → 6)
    'ADM-001,Duplicate Row,6,A,2,,,,,,,', // duplicate admission number
    'ADM-200,Riya Das,4,B,3,Anita Das,98450 66001,anita@example.com,mother,,__PRIYA__,',
    'ADM-201,Rohan Das,2,B,4,,+919845066001,,mother,,,', // sibling: parent named on another row
    'ADM-202,,2,B,5,,,,,,,', // missing name
    'ADM-203,Bad Phone,2,B,6,Someone,12345,,,,,', // invalid phone
    'ADM-204,No Parent Name,2,B,7,,+919845066002,,,,,', // new parent without a name
  ];
  const fileText = () => rows.join('\n').replace('__PRIYA__', String(fx.a.parent.phone));
  let badFile: string;

  it('previews a dry run with per-row actions and every row error, writing nothing', async () => {
    badFile = await upload(adminA, fileText());
    const before = await count('select count(*)::int as n from students');
    const res = await importStudents(adminA, { fileId: badFile });
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d).toMatchObject({ dryRun: true, committed: false, format: 'csv', ignoredColumns: ['Unknown Column'] });
    expect(d.columns).toEqual(['admission_no', 'full_name', 'class_name', 'section', 'roll_no', 'parent1_name', 'parent1_phone', 'parent1_email', 'parent1_relation', 'parent2_name', 'parent2_phone']);
    expect(d.errors).toEqual([
      { row: 3, field: 'admission_no', message: 'Duplicate of row 2' },
      { row: 6, field: 'full_name', message: 'Required' },
      { row: 7, field: 'parent1_phone', message: 'Must be a valid mobile number' },
      { row: 8, field: 'parent1_name', message: 'Required for a parent who is new to the school' },
    ]);
    expect(d.summary).toMatchObject({ totalRows: 7, validRows: 3, errorRows: 4, create: 2, update: 1, unchanged: 0, skip: 0, parentsCreated: 1, links: 3 });
    expect(d.rows.map((r: { row: number; action: string }) => [r.row, r.action])).toEqual([
      [2, 'update'], [3, 'error'], [4, 'create'], [5, 'create'], [6, 'error'], [7, 'error'], [8, 'error'],
    ]);
    expect(await count('select count(*)::int as n from students')).toBe(before);
  });

  it('refuses to commit while rows have errors (400 with the report), nothing written', async () => {
    const res = await importStudents(adminA, { fileId: badFile, dryRun: false });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.errors).toHaveLength(4);
    expect(await count("select count(*)::int as n from students where admission_no like 'ADM-20%'")).toBe(0);
    expect(await count("select count(*)::int as n from parent_accounts where phone = '+919845066001'")).toBe(0);
  });

  it('commits a valid file in one transaction: students, parents (global identity reused), links', async () => {
    const sharedPhone = String(fx.b.parent.phone); // a parent of school B only
    const text = [
      HEADER,
      'ADM-001,Aarav Sharma,6,A,1,,,,,,,',
      `ADM-200,Riya Das,4,B,3,Anita Das,98450 66001,anita@example.com,mother,,${String(fx.a.parent.phone)},`,
      'ADM-201,Rohan Das,2,B,4,,+919845066001,,mother,,,',
      `ADM-205,Zoya Khan,1,C,9,Farah Khan,${sharedPhone},,mother,,,`,
    ].join('\r\n');
    const fileId = await upload(adminA, text);
    const accountsBefore = await count('select count(*)::int as n from parent_accounts');
    const res = await importStudents(adminA, { fileId, dryRun: false });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ dryRun: false, committed: true, errors: [] });
    expect(res.body.data.summary).toMatchObject({ create: 3, update: 1, parentsCreated: 2, links: 4 });
    expect(await count('select count(*)::int as n from parent_accounts')).toBe(accountsBefore + 1); // only Anita is new globally
    const students = await ownerQuery<{ admission_no: string; class_name: string; school_id: string }>(
      "select admission_no, class_name, school_id from students where admission_no in ('ADM-001', 'ADM-200', 'ADM-201', 'ADM-205') and school_id = $1 order by admission_no",
      [fx.a.school.id],
    );
    expect(students.rows.map((s) => [s.admission_no, s.class_name])).toEqual([['ADM-001', '6'], ['ADM-200', '4'], ['ADM-201', '2'], ['ADM-205', '1']]);
    const links = await ownerQuery<{ admission_no: string; phone: string; is_primary: boolean; relation: string | null }>(
      `select s.admission_no, pa.phone, l.is_primary, l.relation from student_parents l join students s on s.id = l.student_id
         join parent_accounts pa on pa.id = l.parent_account_id where s.admission_no in ('ADM-200', 'ADM-201', 'ADM-205') order by 1, 3 desc`,
    );
    expect(links.rows).toEqual([
      { admission_no: 'ADM-200', phone: '+919845066001', is_primary: true, relation: 'mother' },
      { admission_no: 'ADM-200', phone: String(fx.a.parent.phone), is_primary: false, relation: null },
      { admission_no: 'ADM-201', phone: '+919845066001', is_primary: true, relation: 'mother' },
      { admission_no: 'ADM-205', phone: sharedPhone, is_primary: true, relation: 'mother' },
    ]);
    // School A got its own profile for B's parent; B's profile is untouched.
    const profiles = await ownerQuery<{ school_id: string; full_name: string }>(
      'select sp.school_id, sp.full_name from school_parents sp join parent_accounts pa on pa.id = sp.parent_account_id where pa.phone = $1 order by sp.created_at',
      [sharedPhone],
    );
    expect(profiles.rows).toEqual([{ school_id: fx.b.school.id, full_name: 'Priya Sharma' }, { school_id: fx.a.school.id, full_name: 'Farah Khan' }]);
    expect(await count("select count(*)::int as n from audit_logs where action = 'student.import' and entity_id = $1", [fileId])).toBe(1);
  });

  it('re-importing is idempotent and onExisting=skip leaves existing students alone', async () => {
    const text = [HEADER, 'ADM-200,Riya Das,4,B,3,Anita Das,+919845066001,,,,,', 'ADM-001,Aarav Renamed,7,A,1,,,,,,,'].join('\n');
    const fileId = await upload(adminA, text);
    const res = await importStudents(adminA, { fileId, onExisting: 'skip', dryRun: false });
    expect(res.status).toBe(200);
    expect(res.body.data.summary).toMatchObject({ create: 0, update: 0, skip: 2, links: 0, parentsCreated: 0 });
    expect((await ownerQuery('select full_name, class_name from students where id = $1', [fx.a.student.id])).rows).toEqual([{ full_name: 'Aarav Sharma', class_name: '6' }]);
    const again = await importStudents(adminA, { fileId: await upload(adminA, [HEADER, 'ADM-200,Riya Das,4,B,3,Anita Das,+919845066001,,,,,'].join('\n')) });
    expect(again.body.data.summary).toMatchObject({ unchanged: 1, links: 0, parentsCreated: 0, parentsUpdated: 0 });
  });

  it('imports XLSX files (numeric cells) and keeps admission numbers per school', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Students');
    ws.addRow(['admission_no', 'full_name', 'class_name', 'parent1_name', 'parent1_phone']);
    ws.addRow([200, 'Numeric Admission', 3, 'Kiran Rao', 9845066003]);
    ws.addRow(['ADM-200', 'Riya In B', '4', '', '']);
    const fileId = await upload(adminB, Buffer.from(await wb.xlsx.writeBuffer()), 'students.xlsx');
    const res = await importStudents(adminB, { fileId, dryRun: false });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ format: 'xlsx', committed: true, summary: { create: 2 } });
    const rowsB = await ownerQuery<{ admission_no: string }>("select admission_no from students where school_id = $1 and admission_no in ('200', 'ADM-200') order by 1", [fx.b.school.id]);
    expect(rowsB.rows.map((r) => r.admission_no)).toEqual(['200', 'ADM-200']);
    expect(await count("select count(*)::int as n from students where admission_no = 'ADM-200'")).toBe(2);
  });

  it('checks the file (category, other school, empty header) and the plan limit', async () => {
    const fileB = await upload(adminB, `${HEADER}\nADM-900,From B,1,A,1,,,,,,,`);
    expect((await importStudents(adminA, { fileId: fileB })).status).toBe(404);
    const photo = await f.file(fx.a.school.id, { category: 'student_photo', entity_type: 'student', entity_id: fx.a.student.id });
    expect((await importStudents(adminA, { fileId: photo.id })).status).toBe(400);
    const noKey = await importStudents(adminA, { fileId: await upload(adminA, 'name,class\nOnly Name,1') });
    expect(noKey.body.data.errors[0]).toMatchObject({ row: 1, field: null });
    await ownerQuery('update school_subscriptions set max_students = (select count(*) from students where school_id = $1 and deleted_at is null and is_active) where school_id = $1', [fx.a.school.id]);
    const over = await importStudents(adminA, { fileId: await upload(adminA, `${HEADER}\nADM-901,Over Limit,1,A,1,,,,,,,`), dryRun: false });
    expect(over.status).toBe(403);
    expect(await count("select count(*)::int as n from students where admission_no = 'ADM-901'")).toBe(0);
    await ownerQuery('update school_subscriptions set max_students = null where school_id = $1', [fx.a.school.id]);
  });
});

describe('parent import', () => {
  it('previews, refuses unknown children, then commits parents and links', async () => {
    const text = [
      'phone,full_name,email,relation,student_admission_nos',
      `${String(fx.a.parent.phone)},Priya S. Sharma,,mother,ADM-002`,
      '+919845066010,Imran Khan,imran@example.com,guardian,ADM-002;ADM-200',
      '+919845066011,Unknown Child Parent,,,ADM-999',
      '+919845066010,Duplicate,,,',
    ].join('\n');
    const bad = await importParents(adminA, { fileId: await upload(adminA, text, 'parents.csv') });
    expect(bad.status).toBe(200);
    expect(bad.body.data.errors).toEqual([
      { row: 5, field: 'phone', message: 'Duplicate of row 3' },
      { row: 4, field: 'student_admission_nos', message: 'Unknown admission number: ADM-999' },
    ]);
    expect(bad.body.data.summary).toMatchObject({ update: 1, create: 1, links: 3 });
    const good = text.split('\n').slice(0, 3).join('\n');
    const res = await importParents(adminA, { fileId: await upload(adminA, good, 'parents.csv'), dryRun: false });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ committed: true, summary: { update: 1, create: 1, parentsCreated: 1, parentsUpdated: 1, links: 3 } });
    expect((await ownerQuery('select full_name from school_parents where id = $1', [fx.a.schoolParent.id])).rows).toEqual([{ full_name: 'Priya S. Sharma' }]);
    const diya = await ownerQuery<{ phone: string; is_primary: boolean }>(
      'select pa.phone, l.is_primary from student_parents l join parent_accounts pa on pa.id = l.parent_account_id where l.student_id = $1 order by l.is_primary desc',
      [fx.a.otherStudent.id],
    );
    expect(diya.rows).toEqual([{ phone: String(fx.a.parent.phone), is_primary: true }, { phone: '+919845066010', is_primary: false }]);
    expect(await count("select count(*)::int as n from audit_logs where action = 'parent.import'")).toBe(1);
  });
});
