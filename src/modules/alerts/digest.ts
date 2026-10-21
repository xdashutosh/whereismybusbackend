// Daily alert e-mail digest (BP §11.2 "Admin web: in-app alert bell via Socket.IO + optional email digest";
// school feature `emailDigest`, narrowed by the plan's `email` module like every feature).
//   alert-email-digest   daily 07:00 school-local (after the 06:30 / 06:45 scans): one e-mail per alert
//                        recipient address (school settings `alertRecipients`: an active school admin's own
//                        e-mail and/or an explicit e-mail) listing the school's unresolved alerts (open,
//                        escalated) that match the recipient's minSeverity / alertTypes, most urgent first,
//                        with the ones raised in the last 24 h marked new. Nothing is sent when nothing matches.
// At most once per school, local day and address: a kv claim (key with school_id, day and a hash of the
// address) is taken before sending and released when the send fails, so a retry resends only failures.
// The e-mail goes out OUTSIDE any transaction; the run is audited as 'alert.digest' (counts only).
import { type AlertRecipient, type AlertSeverity, type AlertStatus, type AlertType } from '@wimb/shared';
import config from '../../config/index.js';
import { withSchoolSystem } from '../../db/tenant.js';
import { audit } from '../../shared/audit.js';
import { sha256Hex } from '../../shared/crypto.js';
import { kv, kvKey } from '../../shared/kv.js';
import { logger as rootLogger } from '../../shared/logger.js';
import { channels as defaultChannels, type NotificationChannels } from '../../shared/notifications/index.js';
import { loadSchoolSettings } from '../school/index.js';
import { ALERT_TYPE_LABELS, recipientMatches } from './escalation.js';

const log = rootLogger.child({ module: 'alerts' });

export const ALERT_EMAIL_DIGEST_JOB = 'alert-email-digest';
/** Alerts listed per e-mail (the counts always cover every match). */
export const DIGEST_MAX_LINES = 40;
const CLAIM_TTL_S = 48 * 3600;

export interface DigestAlertRow extends Record<string, unknown> {
  id: string;
  alert_type: AlertType;
  severity: AlertSeverity;
  status: AlertStatus;
  title: string;
  bus_code: string | null;
  created_at: string;
  is_new: boolean;
}

export interface DigestSummary {
  schoolId: string;
  localDate: string;
  /** false when the school's effective emailDigest feature is off (nothing is read or sent). */
  enabled: boolean;
  alerts: number;
  recipients: number;
  sent: number;
  logged: number;
  failed: number;
  /** Addresses already served today (claim held) or with no matching alert. */
  skipped: number;
}

type Filter = Pick<AlertRecipient, 'minSeverity' | 'alertTypes'>;

const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function formatLocal(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-IN', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** Recipient addresses (lower-cased, deduplicated) with every filter that applies to each. */
export function digestAddresses(recipients: readonly AlertRecipient[], activeAdmins: ReadonlyMap<string, { email: string | null; name: string }>): Map<string, { name: string | null; filters: Filter[] }> {
  const out = new Map<string, { name: string | null; filters: Filter[] }>();
  const add = (email: string | null | undefined, name: string | null, f: Filter) => {
    if (!email) return;
    const key = email.trim().toLowerCase();
    const cur = out.get(key);
    if (cur) cur.filters.push(f);
    else out.set(key, { name, filters: [f] });
  };
  for (const r of recipients) {
    const f = { minSeverity: r.minSeverity, alertTypes: r.alertTypes };
    if (r.userId) {
      const admin = activeAdmins.get(r.userId);
      if (!admin) continue; // deactivated / deleted / demoted admin: neither address gets the digest
      add(admin.email, r.name ?? admin.name, f);
    }
    add(r.email, r.name ?? null, f);
  }
  return out;
}

/** Subject + text of one digest e-mail. */
export function digestEmail(alerts: readonly DigestAlertRow[], school: { name: string; timezone: string }, localDate: string) {
  const by = (s: AlertSeverity) => alerts.filter((a) => a.severity === s).length;
  const fresh = alerts.filter((a) => a.is_new).length;
  const lines = [
    `Daily alert summary for ${school.name} — ${localDate}`,
    '',
    `Unresolved alerts: ${alerts.length} (critical ${by('critical')}, warning ${by('warning')}, info ${by('info')}); new in the last 24 hours: ${fresh}.`,
    '',
    ...alerts.slice(0, DIGEST_MAX_LINES).map(
      (a) => `• ${a.is_new ? '[new] ' : ''}${cap(a.severity)} · ${ALERT_TYPE_LABELS[a.alert_type]}${a.bus_code ? ` · bus ${a.bus_code}` : ''}${a.status === 'escalated' ? ' · escalated' : ''} — ${oneLine(a.title)} (${formatLocal(a.created_at, school.timezone)})`,
    ),
    alerts.length > DIGEST_MAX_LINES ? `… and ${alerts.length - DIGEST_MAX_LINES} more.` : null,
    '',
    `Open the alert inbox: ${config.appPublicUrl}/school/alerts?status=open,escalated`,
    'You receive this e-mail because you are an alert recipient of the school (Settings → Alerts).',
  ].filter((l): l is string => l !== null);
  return {
    subject: oneLine(`[Where Is My Bus] ${school.name}: ${alerts.length} unresolved alert(s), ${by('critical')} critical — ${localDate}`).slice(0, 200),
    text: lines.join('\n'),
  };
}

type Channels = Pick<NotificationChannels, 'email'>;

/** Runs the digest of one school (exported for tests; the cron passes the school-local day). */
export async function alertEmailDigest({ schoolId, localDate }: { schoolId: string; localDate?: string }, deps: { channels?: Channels } = {}): Promise<DigestSummary> {
  const ch = deps.channels ?? defaultChannels;
  const loaded = await withSchoolSystem(
    schoolId,
    async (tx) => {
      const settings = await loadSchoolSettings(tx);
      const school = await tx.one<{ name: string; timezone: string; today: string }>(
        `select name, timezone, to_char((now() at time zone timezone)::date, 'YYYY-MM-DD') as today from schools where id = $1`,
        [schoolId],
      );
      if (!settings.effective.features.emailDigest) return { enabled: false as const, school };
      const userIds = [...new Set(settings.alertRecipients.map((r) => r.userId).filter((v): v is string => Boolean(v)))];
      const admins = await tx.many<{ id: string; full_name: string; email: string | null }>(
        `select id, full_name, email::text as email from users where id = any ($1::uuid[]) and role = 'school_admin' and is_active and deleted_at is null`,
        [userIds],
      );
      const alerts = await tx.many<DigestAlertRow>(
        `select a.id, a.alert_type, a.severity, a.status, a.title, coalesce(b.code, t.bus_code_snapshot) as bus_code, a.created_at,
                (a.created_at >= now() - interval '24 hours') as is_new
           from alerts a left join buses b on b.id = a.bus_id left join trips t on t.id = a.trip_id
          where a.status in ('open', 'escalated')
          order by case a.severity when 'critical' then 3 when 'warning' then 2 else 1 end desc, a.created_at desc, a.id desc`,
      );
      return { enabled: true as const, school, recipients: settings.alertRecipients, admins, alerts };
    },
    { readOnly: true },
  );
  const day = localDate ?? loaded.school.today;
  const summary: DigestSummary = { schoolId, localDate: day, enabled: loaded.enabled, alerts: 0, recipients: 0, sent: 0, logged: 0, failed: 0, skipped: 0 };
  if (!loaded.enabled) return summary;
  summary.alerts = loaded.alerts.length;
  const addresses = digestAddresses(loaded.recipients, new Map(loaded.admins.map((u) => [u.id, { email: u.email, name: u.full_name }])));
  summary.recipients = addresses.size;
  for (const [email, { filters }] of addresses) {
    const matched = loaded.alerts.filter((a) => filters.some((f) => recipientMatches(f, a.alert_type, a.severity)));
    if (!matched.length) {
      summary.skipped += 1;
      continue;
    }
    const claim = kvKey('alert-digest', schoolId, day, sha256Hex(email).slice(0, 24));
    if (!(await kv.setIfAbsent(claim, '1', CLAIM_TTL_S))) {
      summary.skipped += 1;
      continue;
    }
    const mail = digestEmail(matched, loaded.school, day);
    try {
      const r = await ch.email.send({ to: email, subject: mail.subject, text: mail.text });
      if (r.delivered) summary.sent += 1;
      else if (r.transport === 'log') summary.logged += 1;
      else throw new Error('SMTP did not accept the message');
    } catch (err) {
      summary.failed += 1;
      await kv.del(claim);
      log.warn({ err, schoolId }, 'Alert digest e-mail failed');
    }
  }
  if (summary.sent + summary.logged + summary.failed > 0) {
    await withSchoolSystem(schoolId, (tx) =>
      audit.log(tx, {
        action: 'alert.digest',
        entityType: 'school',
        entityId: schoolId,
        actorName: ALERT_EMAIL_DIGEST_JOB,
        new: { localDate: day, alerts: summary.alerts, recipients: summary.recipients, sent: summary.sent, logged: summary.logged, failed: summary.failed },
      }),
    );
  }
  if (summary.failed) throw new Error(`Alert digest for school ${schoolId}: ${summary.failed} e-mail(s) failed and will be retried`);
  return summary;
}
