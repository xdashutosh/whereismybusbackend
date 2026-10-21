// Parent module — children list and per-child access (BP §4.6, §8.5, §15, Appendix B; contract §4):
// GET /parent/children spans schools (one group per school with branding, child cards with bus code,
// route, stop, next pickup and trip status); per-child routes need X-School-Id validated against an
// active link; another school's id, an unlinked child or a spoofed header never reveal anything;
// other roles never reach /parent/*.
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ParentChildrenResponse } from '@wimb/shared';
import { buildApp, loginParent, loginSchoolAdmin, passwordHash, type TestApp } from './helpers/authApp.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { alignFixtureDates, api, asParent, bearer, linkChild, localDate } from './parent.fixtures.js';

let t: TestApp;
let fx: f.TwoSchoolFixture;
let parentA: string;
let shared: string;
let adminA: string;

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  fx = await f.twoSchoolFixture();
  await alignFixtureDates(fx);
  await ownerQuery(`update schools set name = 'Alpha Public School', brand_color = '#0070F2' where id = $1`, [fx.a.school.id]);
  await ownerQuery(`update schools set name = 'Beta International' where id = $1`, [fx.b.school.id]);
  await ownerQuery(`update users set password_hash = $2 where id = $1`, [fx.a.admin.id, await passwordHash()]);
  parentA = (await loginParent(t, String(fx.a.parent.phone))).accessToken;
  shared = (await loginParent(t, String(fx.sharedParent.phone))).accessToken;
  adminA = (await loginSchoolAdmin(t.app, String(fx.a.admin.email))).accessToken;
});

afterAll(closeDb);

describe('GET /parent/children', () => {
  it('groups the children of a two-school parent by school with branding and per-direction bus data', async () => {
    const res = await asParent(t, shared).get('/parent/children');
    expect(res.status).toBe(200);
    const data = res.body.data as ParentChildrenResponse;
    expect(data.schools.map((s) => s.schoolName)).toEqual(['Alpha Public School', 'Beta International']);
    const [a, b] = data.schools;
    expect(a!.schoolId).toBe(fx.a.school.id);
    expect(a!.brandColor).toBe('#0070F2');
    expect(b!.schoolId).toBe(fx.b.school.id);
    for (const [group, world] of [[a!, fx.a], [b!, fx.b]] as const) {
      expect(group.children).toHaveLength(1);
      const child = group.children[0]!;
      expect(child).toMatchObject({ studentId: world.student.id, fullName: 'Aarav Sharma', className: '5', section: 'A' });
      expect(child.directions).toHaveLength(1);
      const dir = child.directions[0]!;
      expect(dir).toMatchObject({
        direction: 'morning',
        busId: world.bus.id,
        busCode: 'R1',
        routeId: world.route.id,
        routeCode: 'R1',
        stop: { id: world.stop1.id, name: 'Stop 1', expectedTime: '07:30:00' },
        trip: { id: world.trip.id, status: 'in_progress' },
      });
      // Running trip without any live point yet → "Location unavailable" (BP §9.4).
      expect(dir.status).toBe('location_unavailable');
      expect(dir.nextDate).toBe(await localDate());
      expect(dir.nextAt).toMatch(/T\d\d:\d\d:00\.000Z$/);
    }
    // Never raw rows: no internal columns leak into the cards.
    expect(JSON.stringify(data)).not.toMatch(/school_id|parent_account_id|notes|admission/);
  });

  it('lists only the caller\'s own children (a single-school parent sees one school)', async () => {
    const res = await asParent(t, parentA).get('/parent/children');
    expect(res.status).toBe(200);
    const data = res.body.data as ParentChildrenResponse;
    expect(data.schools).toHaveLength(1);
    expect(data.schools[0]!.children.map((c) => c.studentId)).toEqual([fx.a.student.id]);
    expect(JSON.stringify(data)).not.toContain(fx.a.otherStudent.id);
  });

  it('shows a linked child without an assignment with no directions, and the next school day after today\'s trip', async () => {
    const extra = await f.student(fx.a.school.id, { full_name: 'Zoya Khan', class_name: '2', section: 'B' });
    await f.studentParent(fx.a.school.id, extra.id, fx.a.parent.id, { is_primary: false });
    const afternoonRoute = await f.route(fx.a.school.id, { code: 'R1A', name: 'Route 1 PM', direction: 'afternoon' });
    const pmStop = await f.stop(fx.a.school.id, afternoonRoute.id, { name: 'Gate', sequence: 1, expected_time: '15:40:00' });
    await f.tripSchedule(fx.a.school.id, fx.a.bus.id, afternoonRoute.id, { direction: 'afternoon', planned_start_time: '15:00:00', days_of_week: [1, 2, 3, 4, 5, 6, 7] });
    await f.studentAssignment(fx.a.school.id, { studentId: fx.a.student.id, busId: fx.a.bus.id, routeId: afternoonRoute.id, stopId: pmStop.id, direction: 'afternoon' }, { valid_from: await localDate() });
    const res = await asParent(t, parentA).get('/parent/children');
    const cards = (res.body.data as ParentChildrenResponse).schools[0]!.children;
    expect(cards.find((c) => c.studentId === extra.id)!.directions).toEqual([]);
    const aarav = cards.find((c) => c.studentId === fx.a.student.id)!;
    expect(aarav.directions.map((d) => d.direction)).toEqual(['morning', 'afternoon']);
    const pm = aarav.directions[1]!;
    // No afternoon trip generated today → the next scheduled day (tomorrow) at the stop's time.
    expect(pm.trip).toBeNull();
    expect(pm.status).toBeNull();
    expect(pm.nextDate).toBe(await localDate('Asia/Kolkata', 1));
    expect(pm.nextAt).toBe(new Date(`${await localDate('Asia/Kolkata', 1)}T15:40:00+05:30`).toISOString());
  });

  it('skips holidays when computing the next pickup', async () => {
    const sid = fx.b.school.id;
    const pmRoute = await f.route(sid, { code: 'R1P', direction: 'afternoon' });
    const pmStop = await f.stop(sid, pmRoute.id, { name: 'Market', sequence: 1, expected_time: '16:05:00' });
    await f.tripSchedule(sid, fx.b.bus.id, pmRoute.id, { direction: 'afternoon', planned_start_time: '15:30:00', days_of_week: [1, 2, 3, 4, 5, 6, 7] });
    const child = await linkChild(sid, fx.sharedParent.id, { busId: fx.b.bus.id, routeId: pmRoute.id, stopId: pmStop.id, direction: 'afternoon' }, { fullName: 'Ishaan Mehta' });
    await f.schoolHoliday(sid, { name: 'Break', start_date: await localDate('Asia/Kolkata', 1), end_date: await localDate('Asia/Kolkata', 2), applies_to: 'afternoon' });
    const res = await asParent(t, shared).get('/parent/children');
    const group = (res.body.data as ParentChildrenResponse).schools.find((s) => s.schoolId === sid)!;
    const card = group.children.find((c) => c.studentId === child.student.id)!;
    expect(card.directions[0]!.nextDate).toBe(await localDate('Asia/Kolkata', 3));
  });

  it('leaves out a suspended school and shows it again once reactivated', async () => {
    await ownerQuery(`update schools set status = 'suspended' where id = $1`, [fx.b.school.id]);
    try {
      const res = await asParent(t, shared).get('/parent/children');
      expect((res.body.data as ParentChildrenResponse).schools.map((s) => s.schoolId)).toEqual([fx.a.school.id]);
    } finally {
      await ownerQuery(`update schools set status = 'active' where id = $1`, [fx.b.school.id]);
    }
  });

  it('refuses other roles and anonymous callers', async () => {
    expect((await request(t.app).get(api('/parent/children'))).status).toBe(401);
    expect((await request(t.app).get(api('/parent/children')).set(bearer(adminA))).status).toBe(403);
    expect((await request(t.app).get(api(`/parent/children/${fx.a.student.id}/tracking`)).set(bearer(adminA))).status).toBe(403);
  });
});

describe('per-child access (X-School-Id)', () => {
  const paths = (id: string) => [`/parent/children/${id}/tracking`, `/parent/children/${id}/bus`, `/parent/children/${id}/staff`, `/parent/children/${id}/notification-preferences`];

  it('requires X-School-Id on per-child routes (400) and validates it as a UUID', async () => {
    for (const p of paths(fx.a.student.id)) {
      expect((await asParent(t, parentA).get(p)).status, p).toBe(400);
      expect((await asParent(t, parentA, 'not-a-uuid').get(p)).status, p).toBe(400);
    }
  });

  it('refuses a school the parent has no active link in (403 FORBIDDEN), whatever the student', async () => {
    for (const p of [...paths(fx.a.student.id), ...paths(fx.b.student.id)]) {
      const res = await asParent(t, parentA, fx.b.school.id).get(p);
      expect(res.status, p).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });

  it('returns 404 for a child of the other school under a valid header (no cross-school ids)', async () => {
    for (const p of paths(fx.b.student.id)) {
      const res = await asParent(t, shared, fx.a.school.id).get(p);
      expect(res.status, p).toBe(404);
    }
    for (const p of paths(fx.a.student.id)) expect((await asParent(t, shared, fx.b.school.id).get(p)).status, p).toBe(404);
  });

  it('returns 404 for an unlinked child of the same school and for unknown ids', async () => {
    for (const p of [...paths(fx.a.otherStudent.id), ...paths('0190a0a0-0000-7000-8000-000000000000')]) {
      const res = await asParent(t, parentA, fx.a.school.id).get(p);
      expect(res.status, p).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    }
  });

  it('serves the same child to the two-school parent through each school\'s own header', async () => {
    expect((await asParent(t, shared, fx.a.school.id).get(`/parent/children/${fx.a.student.id}/tracking`)).status).toBe(200);
    expect((await asParent(t, shared, fx.b.school.id).get(`/parent/children/${fx.b.student.id}/tracking`)).status).toBe(200);
  });

  it('stops serving a child as soon as the link is removed or the school profile deactivated', async () => {
    const child = await linkChild(fx.a.school.id, fx.a.parent.id, { busId: fx.a.bus.id, routeId: fx.a.route.id, stopId: fx.a.stop2.id }, { fullName: 'Meera Nair' });
    const p = `/parent/children/${child.student.id}/bus`;
    expect((await asParent(t, parentA, fx.a.school.id).get(p)).status).toBe(200);
    await ownerQuery('delete from notification_preferences where student_id = $1', [child.student.id]);
    await ownerQuery('delete from student_parents where student_id = $1 and parent_account_id = $2', [child.student.id, fx.a.parent.id]);
    expect((await asParent(t, parentA, fx.a.school.id).get(p)).status).toBe(404);
    await ownerQuery('update school_parents set is_active = false where school_id = $1 and parent_account_id = $2', [fx.a.school.id, fx.a.parent.id]);
    try {
      expect((await asParent(t, parentA, fx.a.school.id).get(`/parent/children/${fx.a.student.id}/bus`)).status).toBe(403);
      const home = await asParent(t, parentA).get('/parent/children');
      expect((home.body.data as ParentChildrenResponse).schools).toEqual([]);
    } finally {
      await ownerQuery('update school_parents set is_active = true where school_id = $1 and parent_account_id = $2', [fx.a.school.id, fx.a.parent.id]);
    }
  });
});
