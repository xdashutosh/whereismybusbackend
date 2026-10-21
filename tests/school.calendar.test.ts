// Holiday calendar and announcements (contract §8/§9, BP §20 #4/#6): CRUD, validation, duplicate
// guard, filters, CSV, publish windows and states, notification events, feature gating, idempotent
// creates, audit, cross-school isolation (A's token with B's ids → 404) and the helpers trips /
// notifications / driver / parent code use (holiday checks, visible announcements under RLS).
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/tenant.js';
import { holidaysOn, isSchoolHoliday, visibleAnnouncements } from '../src/modules/school/index.js';
import { events } from '../src/shared/events.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { buildApp, loginSchoolAdmin, loginStaff, passwordHash, type TestApp } from './helpers/authApp.js';

let t: TestApp;
let fx: f.TwoSchoolFixture;
let adminA: string;
let adminB: string;
let driverA: string;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const api = (p: string) => `/api/v1/school${p}`;
const paths = (res: request.Response) => (res.body.error.details as { path: string }[]).map((d) => d.path);
const settle = () => new Promise((r) => setTimeout(r, 5));

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  fx = await f.twoSchoolFixture();
  await ownerQuery('update users set password_hash = $1 where id = any ($2)', [await passwordHash(), [fx.a.admin.id, fx.b.admin.id, fx.a.driverUser.id]]);
  adminA = (await loginSchoolAdmin(t.app, String(fx.a.admin.email))).accessToken;
  adminB = (await loginSchoolAdmin(t.app, String(fx.b.admin.email))).accessToken;
  driverA = (await loginStaff(t.app, String(fx.a.school.code), String(fx.a.driverUser.phone))).accessToken;
});
afterAll(closeDb);

describe('holidays', () => {
  let diwaliB: string;
  let created: string;

  beforeAll(async () => {
    diwaliB = (await ownerQuery<{ id: string }>('select id from school_holidays where school_id = $1', [fx.b.school.id])).rows[0]!.id;
    // fixed dates so the year filters below do not depend on the day the suite runs
    await ownerQuery("update school_holidays set start_date = '2026-11-08', end_date = '2026-11-09'");
  });

  it('creates a holiday (endDate defaults to startDate) and audits it', async () => {
    const one = await request(t.app).post(api('/holidays')).set(auth(adminA)).send({ name: 'Republic Day', startDate: '2027-01-26', school_id: fx.b.school.id });
    expect(one.status).toBe(201);
    expect(one.body.data).toMatchObject({ name: 'Republic Day', startDate: '2027-01-26', endDate: '2027-01-26', appliesTo: 'all', days: 1, createdBy: fx.a.admin.id });
    const res = await request(t.app).post(api('/holidays')).set(auth(adminA)).send({ name: 'Winter break', startDate: '2026-12-24', endDate: '2027-01-01', appliesTo: 'all' });
    expect(res.status).toBe(201);
    expect(res.body.data.days).toBe(9);
    created = res.body.data.id as string;
    const row = await ownerQuery<{ school_id: string }>('select school_id from school_holidays where id = $1', [created]);
    expect(row.rows[0]!.school_id).toBe(fx.a.school.id);
    const log = await ownerQuery("select 1 from audit_logs where school_id = $1 and action = 'holiday.create' and entity_id = $2", [fx.a.school.id, created]);
    expect(log.rowCount).toBe(1);
  });

  it('validates dates and refuses duplicates', async () => {
    const order = await request(t.app).post(api('/holidays')).set(auth(adminA)).send({ name: 'Backwards', startDate: '2027-02-10', endDate: '2027-02-01' });
    expect(order.status).toBe(400);
    expect(paths(order)).toEqual(['endDate']);
    const long = await request(t.app).post(api('/holidays')).set(auth(adminA)).send({ name: 'Too long', startDate: '2027-01-01', endDate: '2028-01-02' });
    expect(paths(long)).toEqual(['endDate']);
    const bad = await request(t.app).post(api('/holidays')).set(auth(adminA)).send({ name: '', startDate: '2027-02-30', appliesTo: 'evening' });
    expect(paths(bad)).toEqual(expect.arrayContaining(['name', 'startDate', 'appliesTo']));
    const dup = await request(t.app).post(api('/holidays')).set(auth(adminA)).send({ name: 'winter BREAK', startDate: '2026-12-24' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE');
    // the same holiday in school B is not a duplicate of A's
    expect((await request(t.app).post(api('/holidays')).set(auth(adminB)).send({ name: 'Winter break', startDate: '2026-12-24' })).status).toBe(201);
  });

  it('lists with year / range / appliesTo filters, sorted by start date, own school only', async () => {
    const all = await request(t.app).get(api('/holidays')).set(auth(adminA));
    expect(all.status).toBe(200);
    expect(all.body.meta.total).toBe(3);
    const starts = all.body.data.map((h: { startDate: string }) => h.startDate);
    expect(starts).toEqual([...starts].sort());
    expect(new Set(all.body.data.map((h: { name: string }) => h.name))).toEqual(new Set(['Diwali', 'Winter break', 'Republic Day']));
    const y2027 = await request(t.app).get(api('/holidays?year=2027')).set(auth(adminA));
    expect(y2027.body.data.map((h: { name: string }) => h.name)).toEqual(['Winter break', 'Republic Day']);
    const range = await request(t.app).get(api('/holidays?from=2027-01-02&to=2027-12-31')).set(auth(adminA));
    expect(range.body.data.map((h: { name: string }) => h.name)).toEqual(['Republic Day']);
    const morning = await request(t.app).get(api('/holidays?appliesTo=morning')).set(auth(adminA));
    expect(morning.body.meta.total).toBe(0);
    const badRange = await request(t.app).get(api('/holidays?from=2027-05-01&to=2027-01-01')).set(auth(adminA));
    expect(badRange.status).toBe(400);
    const csv = await request(t.app).get(api('/holidays?format=csv&year=2027')).set(auth(adminA));
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text).toContain('Republic Day');
    expect(csv.text).not.toContain('Diwali');
  });

  it('updates with merged validation and audits the diff', async () => {
    const res = await request(t.app).patch(api(`/holidays/${created}`)).set(auth(adminA)).send({ endDate: '2027-01-03', appliesTo: 'morning' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ startDate: '2026-12-24', endDate: '2027-01-03', appliesTo: 'morning', days: 11 });
    const moved = await request(t.app).patch(api(`/holidays/${created}`)).set(auth(adminA)).send({ startDate: '2027-01-10' });
    expect(moved.body.data).toMatchObject({ startDate: '2027-01-10', endDate: '2027-01-10' });
    const bad = await request(t.app).patch(api(`/holidays/${created}`)).set(auth(adminA)).send({ endDate: '2027-01-01' });
    expect(bad.status).toBe(400);
    const dup = await request(t.app).patch(api(`/holidays/${created}`)).set(auth(adminA)).send({ name: 'Republic Day', startDate: '2027-01-26' });
    expect(dup.status).toBe(409);
    const log = await ownerQuery<{ new_values: Record<string, unknown> }>(
      "select new_values from audit_logs where action = 'holiday.update' and entity_id = $1 order by id limit 1",
      [created],
    );
    expect(log.rows[0]!.new_values).toEqual({ endDate: '2027-01-03', appliesTo: 'morning' });
  });

  it('feeds the holiday helpers used by trip generation (per direction)', async () => {
    const ctx = f.contexts.system(fx.a.school.id);
    expect(await withTenant(ctx, (tx) => isSchoolHoliday(tx, '2027-01-10', 'morning'))).toBe(true);
    expect(await withTenant(ctx, (tx) => isSchoolHoliday(tx, '2027-01-10', 'afternoon'))).toBe(false);
    expect(await withTenant(ctx, (tx) => isSchoolHoliday(tx, '2027-01-26', 'afternoon'))).toBe(true);
    expect(await withTenant(ctx, (tx) => isSchoolHoliday(tx, '2027-01-11'))).toBe(false);
    const list = await withTenant(ctx, (tx) => holidaysOn(tx, '2027-01-10'));
    expect(list.map((h) => h.id)).toEqual([created]);
    expect(await withTenant(f.contexts.system(fx.b.school.id), (tx) => isSchoolHoliday(tx, '2027-01-10', 'morning'))).toBe(false);
  });

  it("returns 404 for another school's holiday on every endpoint", async () => {
    expect((await request(t.app).get(api(`/holidays/${diwaliB}`)).set(auth(adminA))).status).toBe(404);
    expect((await request(t.app).patch(api(`/holidays/${diwaliB}`)).set(auth(adminA)).send({ name: 'Hacked' })).status).toBe(404);
    expect((await request(t.app).delete(api(`/holidays/${diwaliB}`)).set(auth(adminA))).status).toBe(404);
    const still = await ownerQuery<{ name: string }>('select name from school_holidays where id = $1', [diwaliB]);
    expect(still.rows[0]!.name).toBe('Diwali');
    expect((await request(t.app).get(api('/holidays/not-a-uuid')).set(auth(adminA))).status).toBe(400);
  });

  it('deletes (200 { id, deleted }) with an audit row, then 404', async () => {
    const del = await request(t.app).delete(api(`/holidays/${created}`)).set(auth(adminA));
    expect([del.status, del.body.data]).toEqual([200, { id: created, deleted: true }]);
    expect((await request(t.app).get(api(`/holidays/${created}`)).set(auth(adminA))).status).toBe(404);
    const log = await ownerQuery<{ old_values: Record<string, unknown> }>("select old_values from audit_logs where action = 'holiday.delete' and entity_id = $1", [created]);
    expect(log.rows[0]!.old_values).toMatchObject({ name: 'Winter break' });
  });

  it('is refused to drivers', async () => {
    expect((await request(t.app).get(api('/holidays')).set(auth(driverA))).status).toBe(403);
    expect((await request(t.app).post(api('/holidays')).set(auth(driverA)).send({ name: 'X', startDate: '2027-03-01' })).status).toBe(403);
  });
});

describe('announcements', () => {
  let active: string;
  let scheduled: string;
  const fixtureB = () => String(fx.b.announcement.id);

  it('creates an active announcement, audits it and emits announcement.published', async () => {
    const seen: unknown[] = [];
    const off = events.on('announcement.published', (p) => void seen.push(p));
    const res = await request(t.app)
      .post(api('/announcements'))
      .set(auth(adminA))
      .send({ title: 'Bus R1 runs 15 minutes late', body: 'Road works on 80 Feet Road.', audience: 'parents', isPinned: true, school_id: fx.b.school.id });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ title: 'Bus R1 runs 15 minutes late', audience: 'parents', isPinned: true, state: 'active', expiresAt: null, createdBy: fx.a.admin.id, createdByName: 'Anita Rao' });
    active = res.body.data.id as string;
    const row = await ownerQuery<{ school_id: string }>('select school_id from announcements where id = $1', [active]);
    expect(row.rows[0]!.school_id).toBe(fx.a.school.id);
    await settle();
    off();
    expect(seen).toEqual([expect.objectContaining({ schoolId: fx.a.school.id, announcementId: active, audience: 'parents', scheduled: false })]);
    const log = await ownerQuery("select 1 from audit_logs where action = 'announcement.create' and entity_id = $1", [active]);
    expect(log.rowCount).toBe(1);
  });

  it('schedules a future announcement (state scheduled, event flagged)', async () => {
    const seen: { scheduled: boolean }[] = [];
    const off = events.on('announcement.published', (p) => void seen.push(p));
    const publishedAt = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const expiresAt = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const res = await request(t.app).post(api('/announcements')).set(auth(adminA)).send({ title: 'PTM on Saturday', body: 'Buses run at 08:00.', audience: 'all', publishedAt, expiresAt });
    expect(res.status).toBe(201);
    expect(res.body.data.state).toBe('scheduled');
    scheduled = res.body.data.id as string;
    await settle();
    off();
    expect(seen[0]!.scheduled).toBe(true);
  });

  it('validates the publish window', async () => {
    const order = await request(t.app)
      .post(api('/announcements'))
      .set(auth(adminA))
      .send({ title: 'X', body: 'Y', publishedAt: '2027-01-10T08:00:00+05:30', expiresAt: '2027-01-10T07:00:00+05:30' });
    expect(order.status).toBe(400);
    expect(paths(order)).toEqual(['expiresAt']);
    const past = await request(t.app).post(api('/announcements')).set(auth(adminA)).send({ title: 'X', body: 'Y', expiresAt: '2020-01-01T00:00:00Z' });
    expect(paths(past)).toEqual(['expiresAt']);
    const bad = await request(t.app).post(api('/announcements')).set(auth(adminA)).send({ title: '', body: 'x'.repeat(5001), audience: 'teachers', publishedAt: 'tomorrow' });
    expect(paths(bad)).toEqual(expect.arrayContaining(['title', 'body', 'audience', 'publishedAt']));
    const patch = await request(t.app).patch(api(`/announcements/${scheduled}`)).set(auth(adminA)).send({ expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    expect(patch.status).toBe(400);
  });

  it('replays an idempotent create instead of duplicating it', async () => {
    const body = { title: 'Holiday tomorrow', body: 'No buses.', audience: 'all' };
    const first = await request(t.app).post(api('/announcements')).set(auth(adminA)).set('Idempotency-Key', 'ann-create-0001').send(body);
    const again = await request(t.app).post(api('/announcements')).set(auth(adminA)).set('Idempotency-Key', 'ann-create-0001').send(body);
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body.data.id).toBe(first.body.data.id);
    const n = await ownerQuery<{ n: number }>("select count(*)::int as n from announcements where title = 'Holiday tomorrow'");
    expect(n.rows[0]!.n).toBe(1);
  });

  it('lists with state / audience / pinned filters and CSV, own school only', async () => {
    const all = await request(t.app).get(api('/announcements')).set(auth(adminA));
    expect(all.status).toBe(200);
    const ids = all.body.data.map((a: { id: string }) => a.id);
    expect(ids).toContain(active);
    expect(ids).not.toContain(fixtureB());
    const sched = await request(t.app).get(api('/announcements?state=scheduled')).set(auth(adminA));
    expect(sched.body.data.map((a: { id: string }) => a.id)).toEqual([scheduled]);
    const pinned = await request(t.app).get(api('/announcements?pinned=true&audience=parents')).set(auth(adminA));
    expect(pinned.body.data.map((a: { id: string }) => a.id)).toEqual([active]);
    const search = await request(t.app).get(api('/announcements?q=road%20works')).set(auth(adminA));
    expect(search.body.data.map((a: { id: string }) => a.id)).toEqual([active]);
    const csv = await request(t.app).get(api('/announcements?format=csv&state=active,scheduled')).set(auth(adminA));
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text).toContain('PTM on Saturday');
    expect((await request(t.app).get(api('/announcements?state=bogus')).set(auth(adminA))).status).toBe(400);
  });

  it('only published, unexpired announcements for the audience are visible to drivers and parents', async () => {
    const forParents = await withTenant(f.contexts.parent(String(fx.a.parent.id), fx.a.school.id), (tx) => visibleAnnouncements(tx, 'parents'), { readOnly: true });
    const parentIds = forParents.map((a) => a.id);
    expect(parentIds).toContain(active);
    expect(parentIds).not.toContain(scheduled);
    expect(forParents[0]!.isPinned).toBe(true);
    const forDrivers = await withTenant(f.contexts.driver(fx.a.school.id, fx.a.driverUser.id), (tx) => visibleAnnouncements(tx, 'drivers'), { readOnly: true });
    expect(forDrivers.map((a) => a.id)).not.toContain(active);
    expect(forDrivers.every((a) => a.audience !== 'parents')).toBe(true);
  });

  it('updates with an audit diff and an announcement.changed event', async () => {
    const seen: { change: string; changedFields: string[] }[] = [];
    const off = events.on('announcement.changed', (p) => void seen.push(p));
    const res = await request(t.app).patch(api(`/announcements/${active}`)).set(auth(adminA)).send({ title: 'Bus R1 runs 20 minutes late', isPinned: false });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ title: 'Bus R1 runs 20 minutes late', isPinned: false, body: 'Road works on 80 Feet Road.' });
    await settle();
    off();
    expect(seen).toEqual([expect.objectContaining({ change: 'updated', changedFields: ['title', 'isPinned'] })]);
    const ended = await request(t.app).patch(api(`/announcements/${active}`)).set(auth(adminA)).send({ expiresAt: new Date(Date.now() + 1000).toISOString() });
    expect(ended.status).toBe(200);
    expect(ended.body.data.state).toBe('active');
  });

  it("returns 404 for another school's announcement on every endpoint", async () => {
    expect((await request(t.app).get(api(`/announcements/${fixtureB()}`)).set(auth(adminA))).status).toBe(404);
    expect((await request(t.app).patch(api(`/announcements/${fixtureB()}`)).set(auth(adminA)).send({ title: 'Hacked' })).status).toBe(404);
    expect((await request(t.app).delete(api(`/announcements/${fixtureB()}`)).set(auth(adminA))).status).toBe(404);
    const row = await ownerQuery<{ title: string; deleted_at: string | null }>('select title, deleted_at from announcements where id = $1', [fixtureB()]);
    expect(row.rows[0]).toEqual({ title: 'Notice', deleted_at: null });
  });

  it('withdraws (soft delete) with an event, then 404', async () => {
    const seen: { change: string }[] = [];
    const off = events.on('announcement.changed', (p) => void seen.push(p));
    expect((await request(t.app).delete(api(`/announcements/${scheduled}`)).set(auth(adminA))).body).toMatchObject({ success: true, data: { id: scheduled, deleted: true } });
    expect((await request(t.app).get(api(`/announcements/${scheduled}`)).set(auth(adminA))).status).toBe(404);
    const row = await ownerQuery<{ deleted_at: string | null }>('select deleted_at from announcements where id = $1', [scheduled]);
    expect(row.rows[0]!.deleted_at).not.toBeNull();
    await settle();
    off();
    expect(seen).toEqual([expect.objectContaining({ change: 'deleted' })]);
  });

  it('refuses new announcements while the feature is switched off', async () => {
    expect((await request(t.app).put(api('/settings')).set(auth(adminA)).send({ features: { announcements: false } })).status).toBe(200);
    const res = await request(t.app).post(api('/announcements')).set(auth(adminA)).send({ title: 'X', body: 'Y' });
    expect(res.status).toBe(403);
    expect(res.body.error.details).toMatchObject({ reason: 'FEATURE_DISABLED', feature: 'announcements' });
    // school B is unaffected
    expect((await request(t.app).post(api('/announcements')).set(auth(adminB)).send({ title: 'B', body: 'B' })).status).toBe(201);
    await request(t.app).put(api('/settings')).set(auth(adminA)).send({ features: { announcements: true } });
  });

  it('is refused to drivers', async () => {
    expect((await request(t.app).get(api('/announcements')).set(auth(driverA))).status).toBe(403);
  });
});
