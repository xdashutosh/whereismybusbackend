// Parent scope (BP §4.3, §4.6, §15.3; contract §4): actor_role = 'parent' inside a validated
// school context sees only linked students, their links and live assignments, the assigned bus /
// route / stops / school trips, staff assigned to that bus, parent-visible documents and files,
// and its own preferences and inbox. Everything is read-only except the parent's own rows.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant, type TenantContext } from '../src/db/tenant.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as F from './helpers/factories.js';
import { contexts, twoSchoolFixture, type TwoSchoolFixture } from './helpers/factories.js';

let f: TwoSchoolFixture;
let parentA: TenantContext;

const ids = async (ctx: TenantContext, sql: string, params: unknown[] = []) =>
  (await withTenant(ctx, (tx) => tx.many<{ id: string }>(sql, params), { readOnly: true })).map((r) => r.id).sort();
const count = async (ctx: TenantContext, table: string) =>
  (await withTenant(ctx, (tx) => tx.one<{ n: number }>(`select count(*)::int as n from ${table}`), { readOnly: true })).n;

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  f = await twoSchoolFixture();
  parentA = contexts.parent(f.a.parent.id, f.a.school.id);
  // Parents only ever see verified bus documents (migration 856); the fixture's insurance is verified.
  await ownerQuery("update bus_documents set verification_status = 'verified' where id = $1", [f.a.busDocument.id]);
});

afterAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  await closeDb();
});

describe('parent visibility inside its school', () => {
  it('sees only the linked child, its own links and the child’s live assignment', async () => {
    expect(await ids(parentA, 'select id from students')).toEqual([f.a.student.id]);
    expect(await ids(parentA, 'select student_id as id from student_parents')).toEqual([f.a.student.id]);
    expect(await withTenant(parentA, (tx) => tx.many('select parent_account_id from student_parents'))).toEqual([{ parent_account_id: f.a.parent.id }]);
    expect(await ids(parentA, 'select id from school_parents')).toEqual([f.a.schoolParent.id]);
    expect(await ids(parentA, 'select id from student_assignments')).toEqual([f.a.assignment.id]);
  });

  it('sees the assigned bus, route, stops and school trips only (not bus R2 or non-school trips)', async () => {
    expect(await ids(parentA, 'select id from buses')).toEqual([f.a.bus.id]);
    expect(await ids(parentA, 'select id from routes')).toEqual([f.a.route.id]);
    expect(await ids(parentA, 'select id from stops')).toEqual([f.a.stop1.id, f.a.stop2.id].sort());
    expect(await ids(parentA, 'select id from trips')).toEqual([f.a.trip.id]);
    expect(await ids(parentA, 'select id from trip_schedules')).toEqual([f.a.schedule.id]);
    expect(await count(parentA, 'bus_route_assignments')).toBe(1);
    expect(await count(parentA, 'trip_stop_events')).toBe(1);
    const points = await withTenant(parentA, (tx) => tx.many<{ trip_id: string }>('select distinct trip_id from location_points'));
    expect(points).toEqual([{ trip_id: f.a.trip.id }]);
  });

  it('sees staff assigned to that bus and only parent-visible documents and files', async () => {
    expect(await ids(parentA, 'select id from staff_profiles')).toEqual([f.a.driver.id, f.a.conductor.id].sort());
    expect(await count(parentA, 'bus_staff_assignments')).toBe(2);
    expect(await ids(parentA, 'select id from staff_documents')).toEqual([f.a.driverDocument.id]);
    expect(await ids(parentA, 'select id from bus_documents')).toEqual([f.a.busDocument.id]);
    expect(await ids(parentA, 'select id from bus_images')).toEqual([f.a.busImage.id]);
    expect(await ids(parentA, 'select id from files')).toEqual([f.a.busImage.file_id as string]);
  });

  it('sees school-wide settings, holidays and parent announcements', async () => {
    expect(await count(parentA, 'school_settings')).toBe(1);
    expect(await count(parentA, 'school_holidays')).toBe(1);
    expect(await ids(parentA, 'select id from announcements')).toEqual([f.a.announcement.id]);
    expect(await ids(parentA, 'select id from schools')).toEqual([f.a.school.id]);
  });

  it('never sees operational or private tables', async () => {
    for (const t of ['users', 'alerts', 'fuel_logs', 'maintenance_logs', 'trip_odometer_evidence', 'notification_events',
      'school_subscriptions', 'audit_logs', 'devices', 'sessions', 'idempotency_keys', 'platform_users', 'otp_codes']) {
      expect(await count(parentA, t), t).toBe(0);
    }
  });

  it('sees its own preferences, inbox and account only', async () => {
    expect(await count(parentA, 'notification_preferences')).toBe(1);
    expect(await ids(parentA, 'select id from parent_notifications')).toEqual([f.a.parentNotification.id]);
    expect(await ids(parentA, 'select id from parent_accounts')).toEqual([f.a.parent.id]);
    const shared = contexts.parent(f.sharedParent.id, f.a.school.id);
    expect(await count(shared, 'parent_notifications')).toBe(0);
    expect(await count(shared, 'notification_preferences')).toBe(0);
  });
});

describe('document verification backstop (migration 856)', () => {
  it('pending/rejected bus documents and their files stay hidden; verified ones with a file flag are visible', async () => {
    const sid = f.a.school.id;
    const created: string[] = [];
    const doc = async (docType: string, status: string, o: Record<string, unknown> = {}) => {
      const file = await F.file(sid, { category: 'bus_document', entity_type: 'bus', entity_id: f.a.bus.id });
      const d = await F.busDocument(sid, f.a.bus.id, { doc_type: docType, verification_status: status, visible_to_parents_status: true, visible_to_parents_file: true, file_id: file.id, ...o });
      created.push(d.id);
      return { doc: d.id, file: file.id };
    };
    try {
      const pending = await doc('fitness', 'pending');
      const rejected = await doc('pollution', 'rejected');
      const verified = await doc('other', 'verified', { visible_to_parents_status: false });
      const replaced = await doc('other', 'verified', { is_current: false });
      const visibleDocs = await ids(parentA, 'select id from bus_documents');
      expect(visibleDocs).toEqual([f.a.busDocument.id, verified.doc].sort());
      const visibleFiles = await ids(parentA, "select id from files where category = 'bus_document'");
      expect(visibleFiles).toEqual([verified.file]);
      for (const hidden of [pending, rejected, replaced]) {
        expect(visibleDocs).not.toContain(hidden.doc);
        expect(visibleFiles).not.toContain(hidden.file);
      }
    } finally {
      await ownerQuery('delete from bus_documents where id = any($1::uuid[])', [created]);
    }
  });

  it('unverified staff documents keep their "not verified" status row but never expose a file; file-only unverified rows are hidden', async () => {
    const sid = f.a.school.id;
    const created: string[] = [];
    const doc = async (docType: string, status: string, o: Record<string, unknown> = {}) => {
      const file = await F.file(sid, { category: 'staff_document', entity_type: 'staff', entity_id: f.a.conductor.id });
      const d = await F.staffDocument(sid, f.a.conductor.id, { doc_type: docType, verification_status: status, visible_to_parents_file: true, file_id: file.id, ...o });
      created.push(d.id);
      return { doc: d.id, file: file.id };
    };
    try {
      const pendingWithStatus = await doc('training', 'pending', { visible_to_parents_status: true });
      const rejectedFileOnly = await doc('first_aid', 'rejected', { visible_to_parents_status: false });
      const pendingFileOnly = await doc('child_safety', 'pending', { visible_to_parents_status: false });
      const verifiedFileOnly = await doc('other', 'verified', { visible_to_parents_status: false });
      const deleted = await doc('other', 'verified', { visible_to_parents_status: true, deleted_at: new Date().toISOString() });
      const visibleDocs = await ids(parentA, 'select id from staff_documents');
      expect(visibleDocs).toEqual([f.a.driverDocument.id, pendingWithStatus.doc, verifiedFileOnly.doc].sort());
      for (const hidden of [rejectedFileOnly, pendingFileOnly, deleted]) expect(visibleDocs).not.toContain(hidden.doc);
      expect(await ids(parentA, "select id from files where category = 'staff_document'")).toEqual([verifiedFileOnly.file]);
    } finally {
      await ownerQuery('delete from staff_documents where id = any($1::uuid[])', [created]);
    }
  });
});

describe('parent across schools (X-School-Id)', () => {
  it('a parent with children in A and B sees each school’s child only in that school’s context', async () => {
    expect(await ids(contexts.parent(f.sharedParent.id, f.a.school.id), 'select id from students')).toEqual([f.a.student.id]);
    expect(await ids(contexts.parent(f.sharedParent.id, f.b.school.id), 'select id from students')).toEqual([f.b.student.id]);
    expect(await ids(contexts.parent(f.sharedParent.id, f.b.school.id), 'select id from buses')).toEqual([f.b.bus.id]);
  });

  it('a parent in a school without its children sees nothing; without a school only its inbox', async () => {
    const wrong = contexts.parent(f.a.parent.id, f.b.school.id);
    for (const t of ['students', 'buses', 'routes', 'stops', 'trips', 'location_points', 'staff_profiles', 'files']) {
      expect(await count(wrong, t), t).toBe(0);
    }
    const global = contexts.parent(f.a.parent.id, null);
    expect(await count(global, 'students')).toBe(0);
    expect(await count(global, 'buses')).toBe(0);
    expect(await ids(global, 'select id from parent_notifications')).toEqual([f.a.parentNotification.id]);
  });
});

describe('parent writes', () => {
  it('cannot modify school data (update rejected, delete affects nothing)', async () => {
    await expect(withTenant(parentA, (tx) => tx.query("update students set full_name = 'Changed' where id = $1", [f.a.student.id]))).rejects.toMatchObject({ code: '42501' });
    await expect(withTenant(parentA, (tx) => tx.query("update buses set code = 'R9' where id = $1", [f.a.bus.id]))).rejects.toMatchObject({ code: '42501' });
    const del = await withTenant(parentA, (tx) => tx.query('delete from student_parents where student_id = $1', [f.a.student.id]));
    expect(del.rowCount).toBe(0);
    await expect(withTenant(parentA, (tx) => tx.query("insert into students (school_id, full_name) values ($1, 'X')", [f.a.school.id]))).rejects.toMatchObject({ code: '42501' });
  });

  it('can update its own notification preferences but not another parent’s', async () => {
    const own = await withTenant(parentA, (tx) => tx.query('update notification_preferences set trip_delayed = false where student_id = $1', [f.a.student.id]));
    expect(own.rowCount).toBe(1);
    await expect(
      withTenant(parentA, (tx) => tx.query("insert into notification_preferences (school_id, parent_account_id, student_id, direction) values ($1, $2, $3, 'afternoon')", [f.a.school.id, f.sharedParent.id, f.a.student.id])),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('can register its own device and session (no school), never for someone else', async () => {
    const global = contexts.parent(f.a.parent.id, null);
    await withTenant(global, (tx) => tx.query("insert into devices (owner_type, owner_id, device_uid, platform, app_name) values ('parent_account', $1, 'parent-phone-1', 'android', 'parent_app')", [f.a.parent.id]));
    expect(await count(global, 'devices')).toBe(1);
    await expect(
      withTenant(global, (tx) => tx.query("insert into devices (owner_type, owner_id, device_uid, platform) values ('parent_account', $1, 'x', 'ios')", [f.sharedParent.id])),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('marks its inbox read across schools through parent_notifications_mark_read()', async () => {
    const global = contexts.parent(f.a.parent.id, null);
    expect(await withTenant(global, (tx) => tx.one<{ n: number }>('select parent_notifications_mark_read() as n'))).toEqual({ n: 1 });
    const { rows } = await ownerQuery<{ read_at: string | null }>('select read_at from parent_notifications where id = $1', [f.a.parentNotification.id]);
    expect(rows[0]!.read_at).not.toBeNull();
    await expect(withTenant(contexts.schoolAdmin(f.a.school.id, f.a.admin.id), (tx) => tx.query('select parent_notifications_mark_read()'))).rejects.toMatchObject({ code: '42501' });
  });

  it('may append audit rows for its own actions but never read the audit log', async () => {
    await withTenant(parentA, (tx) => tx.query("insert into audit_logs (school_id, actor_type, actor_id, action) values ($1, 'parent_account', $2, 'notification_preferences.update')", [f.a.school.id, f.a.parent.id]));
    expect(await count(parentA, 'audit_logs')).toBe(0);
  });
});
