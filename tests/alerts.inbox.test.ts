// Alerts inbox (BP §11.1 workflow, §13.3): GET /school/alerts (filters, counts per status, pagination,
// sort, CSV), GET /school/alerts/:id, PATCH /school/alerts/:id review / escalate / close transitions with
// audit, the alerts_dedupe conflict, and tenant isolation of every endpoint (BP §4.9).
import type { AlertDto, AlertListMeta } from '@wimb/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, DEVICE, type TestApp } from './helpers/authApp.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { drainJobs } from './helpers/trackingWorld.js';
import { alertsWorld, auditRows, auth, type AlertsWorld } from './alerts.fixtures.js';

let t: TestApp;
let a: AlertsWorld;
let b: AlertsWorld;

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  a = await alertsWorld(t.app, 'alerts-dev-aaaa');
  b = await alertsWorld(t.app, 'alerts-dev-bbbb');
});
afterAll(async () => {
  await drainJobs();
  await closeDb();
});

const list = (token: string, query: Record<string, string | number> = {}) => request(t.app).get('/api/v1/school/alerts').query(query).set(auth(token));
const patch = (token: string, id: string, body: Record<string, unknown>) => request(t.app).patch(`/api/v1/school/alerts/${id}`).set(auth(token)).send(body);
const ids = (res: request.Response) => (res.body.data as AlertDto[]).map((x) => x.id);

describe('GET /school/alerts', () => {
  it('lists the school alerts newest first with display fields and counts per status', async () => {
    const res = await list(a.admin.accessToken);
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([a.tripAlert.id, a.staffAlert.id, a.docAlert.id, a.speedAlert.id, a.closedAlert.id]);
    const meta = res.body.meta as AlertListMeta;
    expect(meta).toEqual({ page: 1, limit: 20, total: 5, totalPages: 1, counts: { open: 2, reviewed: 1, escalated: 1, closed: 1 } });
    const trip = (res.body.data as AlertDto[])[0]!;
    expect(trip).toMatchObject({
      alertType: 'odometer_gap', severity: 'critical', status: 'open', busId: a.bus.id, busCode: 'R1', tripId: a.trip.id, tripDirection: 'morning',
      routeCode: 'R1', details: { gapKm: 42 }, escalation: null, resolvedAt: null, entityType: 'trip', entityId: a.trip.id,
    });
    expect(trip.tripDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const speeding = (res.body.data as AlertDto[]).find((x) => x.id === a.speedAlert.id)!;
    expect(speeding).toMatchObject({ busCode: 'R2', reviewedBy: a.adminUser.id, reviewedByName: 'Anita Rao', reviewNote: 'Spoke to the driver' });
    expect((res.body.data as AlertDto[]).find((x) => x.id === a.staffAlert.id)).toMatchObject({ staffId: a.driverProfile.id, staffName: 'Ramesh Kumar', escalatedByName: 'Anita Rao' });
  });

  it('filters by status, type, severity, entity, bus, trip, staff, text and school-local dates; counts ignore the status filter', async () => {
    let res = await list(a.admin.accessToken, { status: 'open,escalated' });
    expect(ids(res).sort()).toEqual([a.tripAlert.id, a.docAlert.id, a.staffAlert.id].sort());
    expect(res.body.meta).toMatchObject({ total: 3, counts: { open: 2, reviewed: 1, escalated: 1, closed: 1 } });
    res = await list(a.admin.accessToken, { type: 'speeding,non_school_trip' });
    expect(ids(res)).toEqual([a.speedAlert.id, a.closedAlert.id]);
    expect(res.body.meta.counts).toEqual({ open: 0, reviewed: 1, escalated: 0, closed: 1 });
    expect(ids(await list(a.admin.accessToken, { severity: 'critical' }))).toEqual([a.tripAlert.id, a.staffAlert.id]);
    expect(ids(await list(a.admin.accessToken, { entityType: 'staff' }))).toEqual([a.staffAlert.id]);
    expect(ids(await list(a.admin.accessToken, { busId: a.otherBus.id }))).toEqual([a.speedAlert.id]);
    expect(ids(await list(a.admin.accessToken, { tripId: a.trip.id }))).toEqual([a.tripAlert.id]);
    expect(ids(await list(a.admin.accessToken, { staffId: a.driverProfile.id }))).toEqual([a.staffAlert.id]);
    expect(ids(await list(a.admin.accessToken, { q: 'ramesh' }))).toEqual([a.staffAlert.id]);
    expect(ids(await list(a.admin.accessToken, { q: '100%' }))).toEqual([]);
    const day = (n: number) => new Date(Date.now() - n * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    res = await list(a.admin.accessToken, { from: day(6), to: day(3) });
    expect(ids(res)).toEqual([a.speedAlert.id]);
    expect(ids(await list(a.admin.accessToken, { from: day(0) }))).toEqual([a.tripAlert.id]);
  });

  it('paginates and sorts by whitelisted fields', async () => {
    const p1 = await list(a.admin.accessToken, { limit: 2, sort: '-severity,createdAt' });
    expect(ids(p1)).toEqual([a.staffAlert.id, a.tripAlert.id]);
    expect(p1.body.meta).toMatchObject({ page: 1, limit: 2, total: 5, totalPages: 3 });
    const p3 = await list(a.admin.accessToken, { limit: 2, page: 3, sort: '-severity,createdAt' });
    expect(ids(p3)).toEqual([a.closedAlert.id]);
    const past = await list(a.admin.accessToken, { limit: 2, page: 9 });
    expect(past.body.data).toEqual([]);
    expect(past.body.meta).toMatchObject({ total: 5, counts: { open: 2 } });
    expect(ids(await list(a.admin.accessToken, { sort: 'status,createdAt' }))[0]).toBe(a.docAlert.id);
  });

  it('rejects invalid filters', async () => {
    for (const q of <Record<string, string>[]>[{ type: 'nope' }, { status: 'pending' }, { severity: 'high' }, { sort: 'title' }, { from: '2026-02-30' }, { from: '2026-05-02', to: '2026-05-01' }, { busId: 'x' }, { format: 'pdf' }]) {
      const res = await list(a.admin.accessToken, q);
      expect(res.status, JSON.stringify(q)).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('exports CSV with the same filters', async () => {
    const res = await list(a.admin.accessToken, { format: 'csv', status: 'open' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const lines = res.text.replace(/^\uFEFF/, '').trim().split('\r\n');
    expect(lines[0]).toContain('Raised (UTC),Type,Severity,Status,Title,Bus');
    expect(lines).toHaveLength(3);
    expect(res.text).toContain('Odometer gap of 42 km on R1');
    expect(res.text).not.toContain('Speeding on R2');
  });
});

describe('GET /school/alerts/:id', () => {
  it('returns one alert; unknown ids are 404', async () => {
    const res = await request(t.app).get(`/api/v1/school/alerts/${a.docAlert.id}`).set(auth(a.admin.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: a.docAlert.id, alertType: 'doc_expiring', busCode: 'R1', status: 'open' });
    expect((await request(t.app).get(`/api/v1/school/alerts/${crypto.randomUUID()}`).set(auth(a.admin.accessToken))).status).toBe(404);
    expect((await request(t.app).get('/api/v1/school/alerts/not-a-uuid').set(auth(a.admin.accessToken))).status).toBe(400);
  });
});

describe('PATCH /school/alerts/:id workflow', () => {
  it('open → reviewed (note required, editable) → escalated → closed; closed is final; every step audited', async () => {
    const al = await f.alert(a.sid, { title: 'Fitness of bus R1 expires soon', bus_id: a.bus.id });
    let res = await patch(a.admin.accessToken, al.id, { action: 'review' });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([expect.objectContaining({ path: 'note' })]);
    expect((await patch(a.admin.accessToken, al.id, { action: 'archive', note: 'x' })).status).toBe(400);

    res = await patch(a.admin.accessToken, al.id, { action: 'review', note: 'Renewal requested from the insurer' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'reviewed', reviewNote: 'Renewal requested from the insurer', reviewedBy: a.adminUser.id, reviewedByName: 'Anita Rao' });
    expect(res.body.data.reviewedAt).toBeTruthy();
    res = await patch(a.admin.accessToken, al.id, { action: 'review', note: 'Insurer confirmed for Monday' });
    expect(res.body.data).toMatchObject({ status: 'reviewed', reviewNote: 'Insurer confirmed for Monday' });

    res = await patch(a.admin.accessToken, al.id, { action: 'escalate', note: 'Still not renewed' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'escalated', escalatedBy: a.adminUser.id, reviewNote: 'Still not renewed' });
    expect(res.body.data.escalation).toMatchObject({ escalatedBy: a.adminUser.id, recipientCount: 0, deliveries: [] });
    for (const action of ['review', 'escalate']) {
      res = await patch(a.admin.accessToken, al.id, { action, note: 'again' });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ code: 'INVALID_STATE', details: { status: 'escalated', action } });
    }
    res = await patch(a.admin.accessToken, al.id, { action: 'close' });
    expect(res.body.data).toMatchObject({ status: 'closed', closedBy: a.adminUser.id, closedByName: 'Anita Rao', reviewNote: 'Still not renewed' });
    for (const action of ['review', 'escalate', 'close']) expect((await patch(a.admin.accessToken, al.id, { action, note: 'x' })).status).toBe(409);

    const steps = (await Promise.all(['alert.review', 'alert.escalate', 'alert.close'].map((x) => auditRows(a.sid, x)))).map((rows) => rows.filter((r) => r.entity_id === al.id));
    expect(steps[0]).toHaveLength(2);
    expect(steps[0]![0]).toMatchObject({ old_values: { status: 'open' }, new_values: { status: 'reviewed', note: 'Renewal requested from the insurer' }, actor_id: a.adminUser.id, actor_type: 'user' });
    expect(steps[1]![0]).toMatchObject({ old_values: { status: 'reviewed' }, new_values: { status: 'escalated', recipientCount: 0 } });
    expect(steps[2]![0]).toMatchObject({ old_values: { status: 'escalated' }, new_values: { status: 'closed' } });
    await drainJobs();
  });

  it('open alerts can be closed or escalated directly', async () => {
    const one = await f.alert(a.sid, {});
    const two = await f.alert(a.sid, {});
    expect((await patch(a.admin.accessToken, one.id, { action: 'close', note: 'False alarm' })).body.data).toMatchObject({ status: 'closed', reviewNote: 'False alarm' });
    expect((await patch(a.admin.accessToken, two.id, { action: 'escalate' })).body.data).toMatchObject({ status: 'escalated', reviewNote: null });
    await drainJobs();
  });

  it('escalating a reviewed alert whose cause was raised again answers 409 CONFLICT', async () => {
    const key = `odometer_gps_mismatch:${crypto.randomUUID()}`;
    const reviewed = await f.alert(a.sid, { alert_type: 'odometer_gps_mismatch', status: 'reviewed', dedupe_key: key, review_note: 'checked' });
    await f.alert(a.sid, { alert_type: 'odometer_gps_mismatch', dedupe_key: key });
    const res = await patch(a.admin.accessToken, reviewed.id, { action: 'escalate' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    const { rows } = await ownerQuery<{ status: string }>('select status from alerts where id = $1', [reviewed.id]);
    expect(rows[0]!.status).toBe('reviewed');
  });
});

describe('tenant isolation and roles', () => {
  it("school A never sees or changes school B's alerts (404), and lists only its own", async () => {
    const before = await ownerQuery<{ status: string; updated_at: string }>('select status, updated_at from alerts where id = $1', [b.docAlert.id]);
    expect((await request(t.app).get(`/api/v1/school/alerts/${b.docAlert.id}`).set(auth(a.admin.accessToken))).status).toBe(404);
    for (const action of ['review', 'escalate', 'close']) {
      const res = await patch(a.admin.accessToken, b.docAlert.id, { action, note: 'cross-tenant', schoolId: b.sid, school_id: b.sid });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    }
    const after = await ownerQuery<{ status: string; updated_at: string }>('select status, updated_at from alerts where id = $1', [b.docAlert.id]);
    expect(after.rows).toEqual(before.rows);
    const all = await list(a.admin.accessToken, { limit: 100, school_id: b.sid, schoolId: b.sid });
    const bIds = new Set([b.docAlert.id, b.tripAlert.id, b.speedAlert.id, b.closedAlert.id, b.staffAlert.id]);
    expect(ids(all).some((x) => bIds.has(x))).toBe(false);
    expect(ids(await list(a.admin.accessToken, { busId: b.bus.id }))).toEqual([]);
    expect(ids(await list(b.admin.accessToken, { limit: 100 }))).toEqual(expect.arrayContaining([...bIds]));
  });

  it('drivers, anonymous callers and super admins are refused', async () => {
    expect((await request(t.app).get('/api/v1/school/alerts')).status).toBe(401);
    const asDriver = await request(t.app).get('/api/v1/school/alerts').set({ ...auth(a.driver.accessToken), 'X-Device-Id': DEVICE.deviceId });
    expect(asDriver.status).toBe(403);
    expect((await patch(a.driver.accessToken, a.docAlert.id, { action: 'close' })).status).toBe(403);
  });
});
