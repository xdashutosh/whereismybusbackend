// Daily alert e-mail digest (BP §11.2 optional admin email digest; school feature emailDigest): off by
// default, one e-mail per recipient address with the unresolved alerts matching its filters, inactive admins
// skipped, at most once per school-local day (failed sends retried), school-scoped, audited, registered as a
// school-local cron job.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JOB_DEFINITIONS } from '../src/jobs/index.js';
import { ALERT_EMAIL_DIGEST_JOB, alertEmailDigest } from '../src/modules/alerts/digest.js';
import type { EmailMessage } from '../src/shared/notifications/index.js';
import { kv } from '../src/shared/kv.js';
import { buildApp, schoolAdmin, type TestApp } from './helpers/authApp.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { alertsWorld, auditRows, type AlertsWorld } from './alerts.fixtures.js';

let t: TestApp;
let a: AlertsWorld;
let b: AlertsWorld;
let inactiveAdmin: f.Row;

function mailbox(fail: (m: EmailMessage) => boolean = () => false) {
  const sent: EmailMessage[] = [];
  return {
    sent,
    channels: {
      email: {
        send: async (m: EmailMessage) => {
          if (fail(m)) return { delivered: false, transport: 'smtp' as const };
          sent.push(m);
          return { delivered: true, transport: 'smtp' as const };
        },
      },
    } as never,
  };
}
const recipient = (o: Record<string, unknown>) => ({ user_id: null, email: null, phone: null, name: null, min_severity: 'info', alert_types: null, ...o });
const setFeature = (sid: string, on: boolean) => ownerQuery(`update school_settings set features = features || jsonb_build_object('email_digest', $2::boolean) where school_id = $1`, [sid, on]);

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  t = buildApp();
  a = await alertsWorld(t.app, 'digest-a-0001');
  b = await alertsWorld(t.app, 'digest-b-0001');
  inactiveAdmin = await schoolAdmin(a.sid, { full_name: 'Gone Admin', is_active: false });
  await f.schoolSettings(a.sid, {
    alert_recipients: JSON.stringify([
      recipient({ user_id: a.admin2User.id, min_severity: 'critical' }),
      recipient({ email: 'Ops@Example.com', alert_types: ['doc_expiring'] }),
      recipient({ email: 'ops@example.com', alert_types: ['odometer_gap'], min_severity: 'critical' }),
      recipient({ user_id: inactiveAdmin.id }),
      recipient({ email: 'nobody@example.com', alert_types: ['service_due'] }),
    ]),
  });
  await f.schoolSettings(b.sid, { alert_recipients: JSON.stringify([recipient({ email: 'b-ops@example.com' })]) });
});
afterAll(closeDb);

describe('alert-email-digest', () => {
  it('is registered as a daily 07:00 school-local job', () => {
    const def = JOB_DEFINITIONS.find((d) => d.name === ALERT_EMAIL_DIGEST_JOB);
    expect(def).toMatchObject({ kind: 'school-cron', cron: '0 7 * * *' });
  });

  it('sends nothing while the school feature is off (the default)', async () => {
    const box = mailbox();
    const r = await alertEmailDigest({ schoolId: a.sid, localDate: '2026-10-01' }, { channels: box.channels });
    expect(r).toMatchObject({ enabled: false, sent: 0 });
    expect(box.sent).toEqual([]);
  });

  it('e-mails each address the unresolved alerts matching its filters, skips inactive admins and empty digests', async () => {
    await setFeature(a.sid, true);
    const box = mailbox();
    const r = await alertEmailDigest({ schoolId: a.sid, localDate: '2026-10-02' }, { channels: box.channels });
    expect(r).toMatchObject({ enabled: true, alerts: 3, recipients: 3, sent: 2, skipped: 1, failed: 0 });
    const to = box.sent.map((m) => m.to).sort();
    expect(to).toEqual([String(a.admin2User.email).toLowerCase(), 'ops@example.com'].sort());
    const admin2 = box.sent.find((m) => m.to !== 'ops@example.com')!;
    expect(admin2.text).toContain(a.tripAlert.title as string);
    expect(admin2.text).toContain(a.staffAlert.title as string);
    expect(admin2.text).not.toContain(a.docAlert.title as string); // warning < critical
    expect(admin2.text).not.toContain(a.speedAlert.title as string); // reviewed
    expect(admin2.subject).toContain('2 unresolved alert(s), 2 critical');
    const ops = box.sent.find((m) => m.to === 'ops@example.com')!; // both entries merged into one e-mail
    expect(ops.text).toContain(a.docAlert.title as string);
    expect(ops.text).toContain(a.tripAlert.title as string);
    expect(ops.text).not.toContain(a.staffAlert.title as string);
    for (const m of box.sent) expect(m.text).not.toContain(b.tripAlert.id);
    const audits = await auditRows(a.sid, 'alert.digest');
    expect(audits.at(-1)?.new_values).toMatchObject({ localDate: '2026-10-02', sent: 2, failed: 0 });
  });

  it('sends at most once per school-local day; a failed address is retried alone', async () => {
    const again = mailbox();
    const r = await alertEmailDigest({ schoolId: a.sid, localDate: '2026-10-02' }, { channels: again.channels });
    expect(r).toMatchObject({ sent: 0, skipped: 3 });
    const flaky = mailbox((m) => m.to === 'ops@example.com');
    await expect(alertEmailDigest({ schoolId: a.sid, localDate: '2026-10-03' }, { channels: flaky.channels })).rejects.toThrow(/failed and will be retried/);
    expect(flaky.sent.map((m) => m.to)).toEqual([String(a.admin2User.email).toLowerCase()]);
    const retry = mailbox();
    const r2 = await alertEmailDigest({ schoolId: a.sid, localDate: '2026-10-03' }, { channels: retry.channels });
    expect(retry.sent.map((m) => m.to)).toEqual(['ops@example.com']);
    expect(r2).toMatchObject({ sent: 1, failed: 0 });
  });

  it("school B's digest is independent and holds only B's alerts", async () => {
    await setFeature(b.sid, true);
    const box = mailbox();
    await alertEmailDigest({ schoolId: b.sid, localDate: '2026-10-02' }, { channels: box.channels });
    expect(box.sent.map((m) => m.to)).toEqual(['b-ops@example.com']);
    expect(box.sent[0]!.text).toContain(b.tripAlert.title as string);
    for (const id of [a.tripAlert.id, a.staffAlert.id, a.docAlert.id]) expect(box.sent[0]!.text).not.toContain(id);
    expect(await kv.get(`alert-digest:${b.sid}:2026-10-02`)).toBeNull(); // claims are per address, never per school only
  });
});
