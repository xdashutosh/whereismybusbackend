// Alert escalation (BP §11.1): PATCH {action: escalate} matches the school's alert recipients
// (minSeverity, alertTypes, active admins only), stores the delivery plan and the 'alert-escalation'
// job delivers it through the e-mail and push adapters (results stored, FCM tokens pruned, failed
// deliveries retried without re-sending successful ones). Recipients never cross schools.
import type { AlertDto } from '@wimb/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deliverEscalation } from '../src/modules/alerts/escalation.js';
import { channels } from '../src/shared/notifications/index.js';
import type { EmailMessage, PushMessage } from '../src/shared/notifications/index.js';
import { buildApp, schoolAdmin, type TestApp } from './helpers/authApp.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { drainJobs } from './helpers/trackingWorld.js';
import { alertsWorld, auditRows, auth, type AlertsWorld } from './alerts.fixtures.js';

let t: TestApp;
let a: AlertsWorld;
let b: AlertsWorld;
let leaver: f.TenantRow;

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  a = await alertsWorld(t.app, 'esc-dev-aaaa');
  b = await alertsWorld(t.app, 'esc-dev-bbbb');
  leaver = await schoolAdmin(a.sid, { full_name: 'Former Admin' });
  // Push needs a trusted device bound to a live session (escalation.ts / liveUserDevice).
  const adminPc = await f.device({ owner_type: 'user', owner_id: a.admin2User.id, school_id: a.sid, platform: 'web', app_name: 'web_admin', fcm_token: 'fcm-token-admin2' });
  await f.session({ owner_type: 'user', owner_id: a.admin2User.id, school_id: a.sid, device_id: adminPc.id });
  const res = await request(t.app)
    .put('/api/v1/school/settings')
    .set(auth(a.admin.accessToken))
    .send({
      alertRecipients: [
        { userId: a.admin2User.id },
        { email: 'transport@greenfield.example', minSeverity: 'critical' },
        { email: 'Fleet@Greenfield.example', name: 'Fleet desk', alertTypes: ['speeding'] },
        { phone: '+919845012345', name: 'Transport head' },
        { userId: leaver.id },
      ],
    });
  expect(res.status).toBe(200);
  await ownerQuery('update users set is_active = false where id = $1', [leaver.id]);
  // School B's recipients must never receive A's escalations.
  await f.schoolSettings(b.sid, { alert_recipients: JSON.stringify([{ user_id: b.admin2User.id, email: null, phone: null, name: null, min_severity: 'info', alert_types: null }]) });
  channels.email.clearSentMessages();
});
afterAll(async () => {
  await drainJobs();
  await closeDb();
});

const escalate = (id: string, note?: string) => request(t.app).patch(`/api/v1/school/alerts/${id}`).set(auth(a.admin.accessToken)).send({ action: 'escalate', ...(note ? { note } : {}) });
const detail = async (id: string) => (await request(t.app).get(`/api/v1/school/alerts/${id}`).set(auth(a.admin.accessToken))).body.data as AlertDto;

describe('escalation recipients', () => {
  it('a warning alert goes to matching recipients only; the job delivers by e-mail and push and stores the results', async () => {
    const res = await escalate(a.docAlert.id, 'Please renew today');
    expect(res.status).toBe(200);
    const esc = (res.body.data as AlertDto).escalation!;
    expect(esc.recipientCount).toBe(3); // admin2, the phone contact, the inactive admin
    expect(esc.deliveries).toEqual([
      expect.objectContaining({ channel: 'email', userId: a.admin2User.id, name: 'Meera Iyer', target: String(a.admin2User.email).toLowerCase(), status: 'pending' }),
      expect.objectContaining({ channel: 'push', userId: a.admin2User.id, target: 'Meera Iyer', status: 'pending' }),
      expect.objectContaining({ channel: 'sms', name: 'Transport head', status: 'skipped', reason: 'SMS_NOT_SUPPORTED' }),
      expect.objectContaining({ channel: 'email', userId: leaver.id, status: 'skipped', reason: 'RECIPIENT_INACTIVE', target: null }),
    ]);
    expect(esc.deliveries[2]!.target).not.toContain('9845012345');

    await drainJobs();
    const after = (await detail(a.docAlert.id)).escalation!;
    expect(after.deliveries.map((d) => [d.channel, d.status, d.reason])).toEqual([
      ['email', 'logged', 'SMTP_NOT_CONFIGURED'],
      ['push', 'skipped', 'PUSH_DISABLED'],
      ['sms', 'skipped', 'SMS_NOT_SUPPORTED'],
      ['email', 'skipped', 'RECIPIENT_INACTIVE'],
    ]);
    expect(after.deliveries[0]!.attemptedAt).toBeTruthy();
    const mails = channels.email.sentMessages();
    expect(mails.map((m) => m.to)).toEqual([String(a.admin2User.email).toLowerCase()]);
    expect(mails[0]!.subject).toBe('[Where Is My Bus] Escalated warning alert: Insurance of bus R1 expires in 20 days');
    expect(mails[0]!.text).toContain('Greenfield Public School');
    expect(mails[0]!.text).toContain('Bus: R1');
    expect(mails[0]!.text).toContain('Escalated by: Anita Rao');
    expect(mails[0]!.text).toContain('Note: Please renew today');
    expect(mails[0]!.text).toContain(`/school/alerts?alert=${a.docAlert.id}`);
    const notify = (await auditRows(a.sid, 'alert.notify')).filter((r) => r.entity_id === a.docAlert.id);
    expect(notify).toEqual([expect.objectContaining({ actor_type: 'system', actor_name: 'alert-escalation', new_values: { sent: 0, logged: 1, failed: 0, skipped: 3 } })]);
  });

  it('critical alerts add the critical-only contact; type filters add the speeding-only contact', async () => {
    channels.email.clearSentMessages();
    await escalate(a.tripAlert.id);
    await drainJobs();
    expect(channels.email.sentMessages().map((m) => m.to).sort()).toEqual([String(a.admin2User.email).toLowerCase(), 'transport@greenfield.example'].sort());

    channels.email.clearSentMessages();
    const speeding = await f.alert(a.sid, { alert_type: 'speeding', severity: 'warning', title: 'Speeding on R1', bus_id: a.bus.id, dedupe_key: null });
    const res = await escalate(speeding.id);
    expect((res.body.data as AlertDto).escalation!.deliveries.filter((d) => d.channel === 'email' && d.status === 'pending').map((d) => d.target)).toEqual([
      String(a.admin2User.email).toLowerCase(),
      'fleet@greenfield.example',
    ]);
    await drainJobs();
    expect(channels.email.sentMessages().map((m) => m.to).sort()).toEqual([String(a.admin2User.email).toLowerCase(), 'fleet@greenfield.example'].sort());
  });

  it('an info alert matches nobody (default minSeverity warning) but is still escalated', async () => {
    const info = await f.alert(a.sid, { alert_type: 'non_school_trip', severity: 'info', dedupe_key: null });
    const res = await escalate(info.id);
    expect(res.body.data).toMatchObject({ status: 'escalated', escalation: { recipientCount: 0, deliveries: [] } });
    await drainJobs();
  });

  it("school B's recipients never receive school A escalations", async () => {
    channels.email.clearSentMessages();
    await escalate(a.closedAlert.id); // closed → refused
    const fresh = await f.alert(a.sid, { severity: 'critical', dedupe_key: null });
    await escalate(fresh.id);
    await drainJobs();
    expect(channels.email.sentMessages().map((m) => m.to)).not.toContain(String(b.admin2User.email).toLowerCase());
  });
});

describe('delivery job', () => {
  const plan = (deliveries: Record<string, unknown>[]) =>
    JSON.stringify({ escalation: { escalatedAt: new Date().toISOString(), escalatedBy: a.adminUser.id, recipientCount: 1, deliveries } });
  const pending = (channel: string, target: string | null, userId: string | null = null) => ({ channel, userId, name: 'Meera Iyer', target, status: 'pending', reason: null, attemptedAt: null });

  it('sends through the adapters, records results and prunes FCM tokens reported invalid', async () => {
    const phone = await f.device({ owner_type: 'user', owner_id: a.admin2User.id, school_id: a.sid, platform: 'android', app_name: 'web_admin', fcm_token: 'fcm-token-stale' });
    await f.session({ owner_type: 'user', owner_id: a.admin2User.id, school_id: a.sid, device_id: phone.id });
    const al = await f.alert(a.sid, { status: 'escalated', dedupe_key: null, details: plan([pending('email', 'meera@greenfield.example', a.admin2User.id), pending('push', 'Meera Iyer', a.admin2User.id)]) });
    const sentMail: EmailMessage[] = [];
    const sentPush: PushMessage[] = [];
    const fake = {
      email: { ...channels.email, send: async (m: EmailMessage) => (sentMail.push(m), { delivered: true, transport: 'smtp' as const }) },
      push: { enabled: true, send: async (m: PushMessage) => (sentPush.push(m), { successCount: 1, failureCount: 1, invalidTokens: ['fcm-token-stale'], skipped: false }) },
    };
    const out = await deliverEscalation({ schoolId: a.sid, alertId: al.id }, { channels: fake });
    expect(out.map((d) => [d.channel, d.status])).toEqual([['email', 'sent'], ['push', 'sent']]);
    expect(sentPush[0]).toMatchObject({ title: 'Escalated alert · Document expiring', data: { type: 'alert', schoolId: a.sid, alertId: al.id } });
    expect(sentPush[0]!.tokens.sort()).toEqual(['fcm-token-admin2', 'fcm-token-stale']);
    const { rows } = await ownerQuery<{ fcm_token: string | null }>(`select fcm_token from devices where owner_id = $1 order by fcm_token nulls first`, [a.admin2User.id]);
    expect(rows.map((r) => r.fcm_token)).toEqual([null, 'fcm-token-admin2']);
    expect((await detail(al.id)).escalation!.deliveries.map((d) => d.status)).toEqual(['sent', 'sent']);
    // Running again sends nothing twice.
    await deliverEscalation({ schoolId: a.sid, alertId: al.id }, { channels: fake });
    expect(sentMail).toHaveLength(1);
    expect(sentPush).toHaveLength(1);
  });

  it('a failed SMTP delivery throws (job retry) and the retry re-sends only what failed; no devices → skipped', async () => {
    const al = await f.alert(a.sid, {
      status: 'escalated', dedupe_key: null,
      details: plan([pending('email', 'ok@greenfield.example'), pending('email', 'flaky@greenfield.example'), pending('push', 'Anita Rao', a.adminUser.id)]),
    });
    const sent: string[] = [];
    let flaky = true;
    const fake = {
      email: {
        ...channels.email,
        send: async (m: EmailMessage) => {
          sent.push(m.to);
          const fail = m.to.startsWith('flaky') && flaky;
          return { delivered: !fail, transport: 'smtp' as const };
        },
      },
      push: { enabled: true, send: async () => ({ successCount: 1, failureCount: 0, invalidTokens: [], skipped: false }) },
    };
    await expect(deliverEscalation({ schoolId: a.sid, alertId: al.id }, { channels: fake })).rejects.toThrow(/retried/);
    let d = (await detail(al.id)).escalation!.deliveries;
    expect(d.map((x) => [x.status, x.reason])).toEqual([['sent', null], ['failed', 'SMTP_FAILED'], ['skipped', 'NO_DEVICES']]);
    flaky = false;
    await deliverEscalation({ schoolId: a.sid, alertId: al.id }, { channels: fake });
    d = (await detail(al.id)).escalation!.deliveries;
    expect(d.map((x) => x.status)).toEqual(['sent', 'sent', 'skipped']);
    expect(sent).toEqual(['ok@greenfield.example', 'flaky@greenfield.example', 'flaky@greenfield.example']);
  });

  it('ignores alerts of another school and alerts without an escalation', async () => {
    expect(await deliverEscalation({ schoolId: b.sid, alertId: a.docAlert.id })).toEqual([]);
    expect(await deliverEscalation({ schoolId: a.sid, alertId: a.speedAlert.id })).toEqual([]);
  });
});
