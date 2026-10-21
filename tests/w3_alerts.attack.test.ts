// Wave-3 adversarial tests — alerts inbox, escalation and scans (BP §11.1, §13.3).
// Attacks: another school's alerts through detail / patch / list filters / CSV, role escalation
// (driver, parent), body injection, escalation recipients from another school or with the wrong
// role, push to signed-out / untrusted admin devices, recipients deactivated before delivery,
// concurrent escalation deliveries and concurrent scans (dedupe).
import type { AlertDto } from '@wimb/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deliverEscalation } from '../src/modules/alerts/escalation.js';
import { documentExpiryScan } from '../src/modules/alerts/jobs.js';
import type { EmailMessage, PushMessage } from '../src/shared/notifications/index.js';
import { buildApp, loginParent, type TestApp } from './helpers/authApp.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { drainJobs } from './helpers/trackingWorld.js';
import { alertsWorld, auth, type AlertsWorld } from './alerts.fixtures.js';

let t: TestApp;
let a: AlertsWorld;
let b: AlertsWorld;

const api = (p: string) => `/api/v1${p}`;
const recipientsJson = (list: object[]) => JSON.stringify(list.map((r) => ({ user_id: null, email: null, phone: null, name: null, min_severity: 'info', alert_types: null, ...r })));

function fakeChannels() {
  const mails: EmailMessage[] = [];
  const pushes: PushMessage[] = [];
  return {
    mails,
    pushes,
    channels: {
      email: { send: async (m: EmailMessage) => { mails.push(m); return { delivered: true, transport: 'smtp' as const }; } },
      push: { enabled: true, send: async (m: PushMessage) => { pushes.push(m); return { successCount: m.tokens.length, failureCount: 0, invalidTokens: [], skipped: false }; } },
    } as never,
  };
}

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  a = await alertsWorld(t.app, 'w3-alerts-a');
  b = await alertsWorld(t.app, 'w3-alerts-b');
});
afterAll(async () => {
  await drainJobs();
  await closeDb();
});

describe('cross-school access', () => {
  it('school B\'s admin gets 404 on detail and every PATCH action of a school A alert, and nothing changes', async () => {
    const before = await ownerQuery('select status, review_note, updated_at from alerts where id = $1', [a.tripAlert.id]);
    expect((await request(t.app).get(api(`/school/alerts/${a.tripAlert.id}`)).set(auth(b.admin.accessToken))).status).toBe(404);
    for (const body of [{ action: 'review', note: 'pwned' }, { action: 'escalate' }, { action: 'close', note: 'pwned' }]) {
      const res = await request(t.app).patch(api(`/school/alerts/${a.tripAlert.id}`)).set(auth(b.admin.accessToken)).send(body);
      expect(res.status, body.action).toBe(404);
    }
    const after = await ownerQuery('select status, review_note, updated_at from alerts where id = $1', [a.tripAlert.id]);
    expect(after.rows).toEqual(before.rows);
    const audits = await ownerQuery("select 1 from audit_logs where entity_id = $1 and action like 'alert.%'", [a.tripAlert.id]);
    expect(audits.rowCount).toBe(0);
  });

  it('list filters with school A ids, counts and CSV give school B\'s admin nothing about A', async () => {
    const q = `busId=${a.bus.id}&tripId=${a.trip.id}`;
    const res = await request(t.app).get(api(`/school/alerts?${q}`)).set(auth(b.admin.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.counts).toEqual({ open: 0, reviewed: 0, escalated: 0, closed: 0 });
    const staff = await request(t.app).get(api(`/school/alerts?staffId=${a.driverProfile.id}`)).set(auth(b.admin.accessToken));
    expect(staff.body.data).toEqual([]);
    const csv = await request(t.app).get(api('/school/alerts?format=csv')).set(auth(b.admin.accessToken));
    expect(csv.status).toBe(200);
    expect(csv.text).not.toContain(a.tripAlert.id);
    const ids = (await request(t.app).get(api('/school/alerts?limit=100')).set(auth(b.admin.accessToken))).body.data.map((x: AlertDto) => x.id);
    for (const id of [a.docAlert.id, a.tripAlert.id, a.speedAlert.id, a.closedAlert.id, a.staffAlert.id]) expect(ids).not.toContain(id);
  });

  it('drivers and parents (with an X-School-Id) cannot read or act on alerts', async () => {
    expect((await request(t.app).get(api('/school/alerts')).set(auth(a.driver.accessToken))).status).toBe(403);
    expect((await request(t.app).patch(api(`/school/alerts/${a.tripAlert.id}`)).set(auth(a.driver.accessToken)).send({ action: 'close' })).status).toBe(403);
    const p = await f.parentAccount();
    await f.schoolParent(a.sid, p.id);
    const kid = await f.student(a.sid);
    await f.studentParent(a.sid, kid.id, p.id);
    const parent = await loginParent(t, String(p.phone));
    const res = await request(t.app).get(api('/school/alerts')).set(auth(parent.accessToken)).set('X-School-Id', a.sid);
    expect(res.status).toBe(403);
  });

  it('a PATCH body cannot set status, school or reviewer fields directly', async () => {
    const al = await f.alert(a.sid, { title: 'Injection target', dedupe_key: null });
    const res = await request(t.app).patch(api(`/school/alerts/${al.id}`)).set(auth(a.admin.accessToken))
      .send({ action: 'review', note: 'checked', status: 'closed', schoolId: b.sid, school_id: b.sid, reviewedBy: b.adminUser.id });
    expect([200, 400]).toContain(res.status);
    const { rows } = await ownerQuery<{ status: string; school_id: string; reviewed_by: string | null }>('select status, school_id, reviewed_by from alerts where id = $1', [al.id]);
    expect(rows[0]!.school_id).toBe(a.sid);
    expect(rows[0]!.status).not.toBe('closed');
    expect(rows[0]!.reviewed_by).not.toBe(b.adminUser.id);
  });
});

describe('escalation recipients', () => {
  it('a recipient userId of another school\'s admin, a driver of this school or a deleted admin is skipped — no e-mail, no push', async () => {
    const deleted = await f.user(a.sid, { role: 'school_admin', full_name: 'Deleted Admin', deleted_at: new Date().toISOString() });
    const driverUser = (await ownerQuery<{ user_id: string }>('select user_id from staff_profiles where id = $1', [a.driverProfile.id])).rows[0]!.user_id;
    await f.device({ owner_type: 'user', owner_id: b.adminUser.id, school_id: b.sid, platform: 'web', app_name: 'web_admin', fcm_token: 'tok-b-admin' });
    await f.device({ owner_type: 'user', owner_id: driverUser, school_id: a.sid, fcm_token: 'tok-a-driver' });
    await f.schoolSettings(a.sid, { alert_recipients: recipientsJson([{ user_id: b.adminUser.id }, { user_id: driverUser }, { user_id: deleted.id }]) });
    const al = await f.alert(a.sid, { severity: 'critical', title: 'Cross recipients', dedupe_key: null });
    const res = await request(t.app).patch(api(`/school/alerts/${al.id}`)).set(auth(a.admin.accessToken)).send({ action: 'escalate' });
    expect(res.status).toBe(200);
    const deliveries = (res.body.data as AlertDto).escalation!.deliveries;
    expect(deliveries.every((d) => d.status === 'skipped')).toBe(true);
    const fake = fakeChannels();
    await deliverEscalation({ schoolId: a.sid, alertId: al.id }, { channels: fake.channels });
    expect(fake.mails.map((m) => m.to)).not.toContain(String(b.adminUser.email).toLowerCase());
    expect(fake.pushes.flatMap((p) => p.tokens)).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain(String(b.adminUser.email));
  });
});

describe('escalation delivery hygiene', () => {
  // The escalation snapshot is stored directly (as PATCH {action: escalate} stores it) so no queued job races
  // the direct deliverEscalation calls below.
  const pending = (channel: 'email' | 'push', userId: string | null, target: string | null) => ({ channel, userId, name: 'Recipient', target, status: 'pending', reason: null, attemptedAt: null });
  const escalated = async (title: string, deliveries: object[]) => {
    const details = JSON.stringify({ escalation: { escalatedAt: new Date().toISOString(), escalatedBy: a.adminUser.id, recipientCount: 1, deliveries } });
    return (await f.alert(a.sid, { severity: 'critical', status: 'escalated', title, dedupe_key: null, details })).id;
  };

  it('pushes escalations only to admin devices with a live session — never to signed-out, revoked-session or untrusted devices', async () => {
    const admin = await f.user(a.sid, { role: 'school_admin', full_name: 'Push Admin', email: 'push.admin@greenfield.example' });
    const live = await f.device({ owner_type: 'user', owner_id: admin.id, school_id: a.sid, platform: 'web', app_name: 'web_admin', fcm_token: 'tok-live' });
    await f.session({ owner_type: 'user', owner_id: admin.id, school_id: a.sid, device_id: live.id });
    // Signed out on a shared office PC: the session was revoked, the device row keeps its token.
    const signedOut = await f.device({ owner_type: 'user', owner_id: admin.id, school_id: a.sid, platform: 'web', app_name: 'web_admin', fcm_token: 'tok-signed-out' });
    await f.session({ owner_type: 'user', owner_id: admin.id, school_id: a.sid, device_id: signedOut.id, revoked_at: new Date().toISOString() });
    const expired = await f.device({ owner_type: 'user', owner_id: admin.id, school_id: a.sid, platform: 'web', app_name: 'web_admin', fcm_token: 'tok-expired' });
    await f.session({ owner_type: 'user', owner_id: admin.id, school_id: a.sid, device_id: expired.id, expires_at: new Date(Date.now() - 60_000).toISOString() });
    await f.device({ owner_type: 'user', owner_id: admin.id, school_id: a.sid, platform: 'web', app_name: 'web_admin', fcm_token: 'tok-never-signed-in' });
    const untrusted = await f.device({ owner_type: 'user', owner_id: admin.id, school_id: a.sid, platform: 'android', app_name: 'web_admin', fcm_token: 'tok-untrusted', is_trusted: false });
    await f.session({ owner_type: 'user', owner_id: admin.id, school_id: a.sid, device_id: untrusted.id });
    const id = await escalated('Push hygiene', [pending('push', admin.id, 'Push Admin')]);
    const fake = fakeChannels();
    const out = await deliverEscalation({ schoolId: a.sid, alertId: id }, { channels: fake.channels });
    // Same rule as the notifications module (staffPushTargets / parentPushTokens): trusted device, live session.
    expect(fake.pushes.flatMap((p) => p.tokens).sort()).toEqual(['tok-live']);
    expect(out.map((d) => d.status)).toEqual(['sent']);
  });

  it('an admin with only signed-out devices is recorded as NO_DEVICES and gets no push', async () => {
    const admin = await f.user(a.sid, { role: 'school_admin', full_name: 'Signed Out Admin', email: 'signed.out@greenfield.example' });
    const pc = await f.device({ owner_type: 'user', owner_id: admin.id, school_id: a.sid, platform: 'web', app_name: 'web_admin', fcm_token: 'tok-logged-out-only' });
    await f.session({ owner_type: 'user', owner_id: admin.id, school_id: a.sid, device_id: pc.id, revoked_at: new Date().toISOString() });
    const id = await escalated('Signed-out admin', [pending('push', admin.id, 'Signed Out Admin')]);
    const fake = fakeChannels();
    const out = await deliverEscalation({ schoolId: a.sid, alertId: id }, { channels: fake.channels });
    expect(fake.pushes).toHaveLength(0);
    expect(out.map((d) => [d.status, d.reason])).toEqual([['skipped', 'NO_DEVICES']]);
  });

  it('an admin deactivated between escalation and delivery receives neither the e-mail nor the push', async () => {
    const admin = await f.user(a.sid, { role: 'school_admin', full_name: 'Leaving Admin', email: 'leaving.admin@greenfield.example' });
    const dev = await f.device({ owner_type: 'user', owner_id: admin.id, school_id: a.sid, platform: 'web', app_name: 'web_admin', fcm_token: 'tok-leaving' });
    await f.session({ owner_type: 'user', owner_id: admin.id, school_id: a.sid, device_id: dev.id });
    // Snapshot taken at escalation time, while the admin was active.
    const id = await escalated('Deactivated before delivery', [pending('email', admin.id, 'leaving.admin@greenfield.example'), pending('push', admin.id, 'Leaving Admin')]);
    // Deactivation (BP §5: revokes all sessions) commits before the queued job runs or retries.
    await ownerQuery('update users set is_active = false where id = $1', [admin.id]);
    await ownerQuery("update sessions set revoked_at = now() where owner_type = 'user' and owner_id = $1", [admin.id]);
    const fake = fakeChannels();
    const out = await deliverEscalation({ schoolId: a.sid, alertId: id }, { channels: fake.channels });
    expect(fake.mails.map((m) => m.to)).not.toContain('leaving.admin@greenfield.example');
    expect(fake.pushes.flatMap((p) => p.tokens)).not.toContain('tok-leaving');
    expect(out.map((d) => [d.channel, d.status, d.reason])).toEqual([
      ['email', 'skipped', 'RECIPIENT_INACTIVE'],
      ['push', 'skipped', 'RECIPIENT_INACTIVE'],
    ]);
  });

  it('an admin deleted between escalation and delivery is skipped too, while plain e-mail contacts still get the mail', async () => {
    const admin = await f.user(a.sid, { role: 'school_admin', full_name: 'Deleted Admin', email: 'deleted.admin@greenfield.example' });
    const id = await escalated('Deleted before delivery', [pending('email', admin.id, 'deleted.admin@greenfield.example'), pending('email', null, 'desk@greenfield.example')]);
    await ownerQuery('update users set deleted_at = now() where id = $1', [admin.id]);
    const fake = fakeChannels();
    await deliverEscalation({ schoolId: a.sid, alertId: id }, { channels: fake.channels });
    expect(fake.mails.map((m) => m.to)).toEqual(['desk@greenfield.example']);
  });

  it('two concurrent runs of the escalation job (stalled-job recovery / two workers) send each delivery once', async () => {
    const id = await escalated('Concurrent delivery', [pending('email', null, 'once@greenfield.example')]);
    const fake = fakeChannels();
    await Promise.all([
      deliverEscalation({ schoolId: a.sid, alertId: id }, { channels: fake.channels }),
      deliverEscalation({ schoolId: a.sid, alertId: id }, { channels: fake.channels }),
    ]);
    expect(fake.mails.filter((m) => m.to === 'once@greenfield.example')).toHaveLength(1);
    // A later run (retry) finds nothing left to send.
    await deliverEscalation({ schoolId: a.sid, alertId: id }, { channels: fake.channels });
    expect(fake.mails).toHaveLength(1);
  });

  it('the escalation PATCH queues one delivery job that targets the live admin device only', async () => {
    const admin = await f.user(a.sid, { role: 'school_admin', full_name: 'Queued Admin', email: 'queued.admin@greenfield.example' });
    const live = await f.device({ owner_type: 'user', owner_id: admin.id, school_id: a.sid, platform: 'web', app_name: 'web_admin', fcm_token: 'tok-queued-live' });
    await f.session({ owner_type: 'user', owner_id: admin.id, school_id: a.sid, device_id: live.id });
    await f.device({ owner_type: 'user', owner_id: admin.id, school_id: a.sid, platform: 'web', app_name: 'web_admin', fcm_token: 'tok-queued-stale' });
    await f.schoolSettings(a.sid, { alert_recipients: recipientsJson([{ user_id: admin.id }]) });
    const al = await f.alert(a.sid, { severity: 'critical', title: 'Queued escalation', dedupe_key: null });
    const res = await request(t.app).patch(api(`/school/alerts/${al.id}`)).set(auth(a.admin.accessToken)).send({ action: 'escalate' });
    expect(res.status).toBe(200);
    await drainJobs();
    const { rows } = await ownerQuery<{ deliveries: { channel: string; status: string; reason: string | null }[] }>(
      `select details->'escalation'->'deliveries' as deliveries from alerts where id = $1`,
      [al.id],
    );
    // Push is disabled in tests (no FCM): the live device makes it PUSH_DISABLED, not NO_DEVICES.
    expect(rows[0]!.deliveries.map((d) => [d.channel, d.status, d.reason])).toEqual([
      ['email', 'logged', 'SMTP_NOT_CONFIGURED'],
      ['push', 'skipped', 'PUSH_DISABLED'],
    ]);
  });
});

describe('scan dedupe under concurrency', () => {
  it('three concurrent document-expiry scans raise each alert once', async () => {
    const bus = await f.bus(a.sid, { code: 'SCAN1' });
    await f.busDocument(a.sid, bus.id, { doc_type: 'insurance', expiry_date: f.isoDay(5) });
    await f.busDocument(a.sid, bus.id, { doc_type: 'fitness', expiry_date: f.isoDay(-3) });
    await Promise.all([documentExpiryScan({ schoolId: a.sid }), documentExpiryScan({ schoolId: a.sid }), documentExpiryScan({ schoolId: a.sid })]);
    const { rows } = await ownerQuery<{ dedupe_key: string; n: number }>(
      `select dedupe_key, count(*)::int as n from alerts where school_id = $1 and bus_id = $2 group by dedupe_key`,
      [a.sid, bus.id],
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) expect(r.n, r.dedupe_key).toBe(1);
    const other = await ownerQuery('select 1 from alerts where school_id = $1 and bus_id = $2', [b.sid, bus.id]);
    expect(other.rowCount).toBe(0);
  });
});
