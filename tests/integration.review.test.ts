// Integrator review regressions (contract §5 conventions across the wave-1 modules):
//   1. Every DELETE answers 200 with `{ id, deleted: true }` (holidays, announcements and school admins
//      used to answer 204 while every other module returned the envelope).
//   2. POST /school/admins never stores its response (which can carry a generated temporary password)
//      in the idempotency replay store: a retry with the same key is a fresh request → 409 DUPLICATE.
//   3. Plan limits use ONE rule (platform assertSubscriptionCapacity) for buses and students.
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, loginSchoolAdmin, passwordHash, type TestApp } from './helpers/authApp.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';

let t: TestApp;
let fx: f.TwoSchoolFixture;
let admin: string;
const api = (p: string) => `/api/v1${p}`;
const as = (r: request.Test) => r.set('Authorization', `Bearer ${admin}`);

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  fx = await f.twoSchoolFixture();
  await ownerQuery('update users set password_hash = $1 where id = $2', [await passwordHash(), fx.a.admin.id]);
  admin = (await loginSchoolAdmin(t.app, String(fx.a.admin.email))).accessToken;
});
afterAll(closeDb);

describe('delete envelope', () => {
  it('holidays, announcements and school admins answer 200 { id, deleted: true }', async () => {
    const h = await as(request(t.app).post(api('/school/holidays'))).send({ name: 'Founders Day', startDate: '2027-02-01' });
    const a = await as(request(t.app).post(api('/school/announcements'))).send({ title: 'Notice', body: 'Text', audience: 'parents' });
    const u = await as(request(t.app).post(api('/school/admins'))).send({ fullName: 'Second Admin', email: 'second.admin@review.example' });
    expect([h.status, a.status, u.status]).toEqual([201, 201, 201]);
    for (const [path, id] of [['/school/holidays', h.body.data.id], ['/school/announcements', a.body.data.id], ['/school/admins', u.body.data.admin.id]] as const) {
      const res = await as(request(t.app).delete(api(`${path}/${id}`)));
      expect([res.status, res.body], path).toEqual([200, { success: true, data: { id, deleted: true } }]);
      expect((await as(request(t.app).delete(api(`${path}/${id}`)))).status, `${path} again`).toBe(404);
    }
  });
});

describe('POST /school/admins and the idempotency store', () => {
  it('does not replay a stored temporary password', async () => {
    const key = 'review-admin-create-0001';
    const body = { fullName: 'Transport Desk', email: 'transport.desk@review.example' };
    const first = await as(request(t.app).post(api('/school/admins'))).set('Idempotency-Key', key).send(body);
    expect(first.status).toBe(201);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(typeof first.body.data.temporaryPassword).toBe('string');
    const retry = await as(request(t.app).post(api('/school/admins'))).set('Idempotency-Key', key).send(body);
    expect(retry.headers['idempotent-replayed']).toBeUndefined();
    expect([retry.status, retry.body.error?.code]).toEqual([409, 'DUPLICATE']);
    expect(JSON.stringify(retry.body)).not.toContain(first.body.data.temporaryPassword);
    const stored = await ownerQuery<{ n: number }>("select count(*)::int as n from idempotency_keys where path like '%/school/admins%'");
    expect(stored.rows[0]!.n).toBe(0);
  });
});

describe('plan limits (one rule)', () => {
  it('buses and students report SUBSCRIPTION_LIMIT with the same details shape', async () => {
    const counts = await ownerQuery<{ buses: number; students: number }>(
      'select (select count(*)::int from buses where school_id = $1 and deleted_at is null) as buses, (select count(*)::int from students where school_id = $1 and deleted_at is null and is_active) as students',
      [fx.a.school.id],
    );
    const { buses, students } = counts.rows[0]!;
    await ownerQuery("update school_subscriptions set max_buses = $2, max_students = $3 where school_id = $1 and status = 'active'", [fx.a.school.id, buses, students]);
    try {
      const bus = await as(request(t.app).post(api('/school/buses'))).send({ code: 'R50', registrationNo: 'KA01ZZ5050' });
      const stu = await as(request(t.app).post(api('/school/students'))).send({ fullName: 'Over The Limit' });
      expect([bus.status, bus.body.error.details]).toEqual([403, { reason: 'SUBSCRIPTION_LIMIT', resource: 'buses', limit: buses, used: buses, adding: 1 }]);
      expect([stu.status, stu.body.error.details]).toEqual([403, { reason: 'SUBSCRIPTION_LIMIT', resource: 'students', limit: students, used: students, adding: 1 }]);
    } finally {
      await ownerQuery("update school_subscriptions set max_buses = null, max_students = null where school_id = $1 and status = 'active'", [fx.a.school.id]);
    }
  });
});
