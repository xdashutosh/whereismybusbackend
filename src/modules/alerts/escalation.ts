// Alert escalation (BP §11.1 "Escalation notifies the configured alert_recipients").
//   planEscalation(tx, alert)   inside the PATCH transaction: matches the school's alert recipients
//                               (minSeverity + alertTypes), resolves school admins (active, this school)
//                               and returns the escalation snapshot stored in alerts.details.escalation
//                               with one pending delivery per recipient × channel (deduplicated).
//   deliverEscalation(p, deps)  'alert-escalation' queue job (after commit): sends the pending/failed
//                               deliveries through the e-mail and push adapters OUTSIDE any transaction,
//                               then stores the results (prunes FCM tokens reported invalid) and audits
//                               'alert.notify'. SMTP failures are retried by the job runner; deliveries
//                               that succeeded are never sent twice. Recipients are re-checked on every run:
//                               a user who is no longer an active admin of the school is skipped
//                               (RECIPIENT_INACTIVE), and push goes only to trusted devices bound to a live
//                               session (liveUserDevice — the same rule as announcements). One run per alert
//                               at a time (kv claim), so two workers never send the same delivery twice.
// Phone-only contacts are recorded as skipped (SMS_NOT_SUPPORTED): alert SMS would need their own DLT
// template; e-mail and push are the escalation channels.
import {
  ALERT_SEVERITY_RANK,
  type AlertDelivery,
  type AlertEscalation,
  type AlertRecipient,
  type AlertSeverity,
  type AlertType,
} from '@wimb/shared';
import config from '../../config/index.js';
import { withSchoolSystem, type Tx } from '../../db/tenant.js';
import { audit } from '../../shared/audit.js';
import { kv, kvKey } from '../../shared/kv.js';
import { logger as rootLogger } from '../../shared/logger.js';
import { channels as defaultChannels, type NotificationChannels } from '../../shared/notifications/index.js';
import { maskPhone } from '../../shared/phone.js';
import { adminPushTokens } from '../notifications/repository.js';
import { loadSchoolSettings } from '../school/index.js';
import { readEscalation } from './dto.js';
import * as repo from './repository.js';

const log = rootLogger.child({ module: 'alerts' });

export const ALERT_ESCALATION_JOB = 'alert-escalation';

export const ALERT_TYPE_LABELS: Readonly<Record<AlertType, string>> = Object.freeze({
  trip_not_started: 'Trip not started',
  odometer_gap: 'Odometer gap',
  odometer_decrease: 'Odometer decrease',
  odometer_gps_mismatch: 'Odometer / GPS mismatch',
  non_school_trip: 'Non-school trip',
  doc_expiring: 'Document expiring',
  doc_expired: 'Document expired',
  doc_missing: 'Document missing',
  service_due: 'Service due',
  speeding: 'Speeding',
  harsh_driving: 'Harsh driving',
  route_deviation: 'Route deviation',
  long_stop: 'Long stop',
  gps_disabled: 'GPS disabled',
  low_battery: 'Low battery',
  no_network: 'No network',
  trip_auto_closed: 'Trip auto-closed',
  location_permission: 'Location permission denied',
  clock_drift: 'Phone clock wrong',
});

/** Does a recipient want this alert (minSeverity and alertTypes filters)? */
export function recipientMatches(r: Pick<AlertRecipient, 'minSeverity' | 'alertTypes'>, type: AlertType, severity: AlertSeverity): boolean {
  if (ALERT_SEVERITY_RANK[severity] < ALERT_SEVERITY_RANK[r.minSeverity ?? 'warning']) return false;
  return !r.alertTypes || r.alertTypes.length === 0 || r.alertTypes.includes(type);
}

const pending = (d: Omit<AlertDelivery, 'status' | 'reason' | 'attemptedAt'>): AlertDelivery => ({ ...d, status: 'pending', reason: null, attemptedAt: null });
const skipped = (d: Omit<AlertDelivery, 'status' | 'reason' | 'attemptedAt'>, reason: string): AlertDelivery => ({ ...d, status: 'skipped', reason, attemptedAt: null });

/** Escalation snapshot for an alert of the current school (see the header). */
export async function planEscalation(tx: Tx, alert: { alert_type: AlertType; severity: AlertSeverity }): Promise<AlertEscalation> {
  const settings = await loadSchoolSettings(tx);
  const matching = settings.alertRecipients.filter((r) => recipientMatches(r, alert.alert_type, alert.severity));
  const userIds = [...new Set(matching.map((r) => r.userId).filter((v): v is string => Boolean(v)))];
  const admins = new Map(
    (
      await tx.many<{ id: string; full_name: string; email: string | null }>(
        `select id, full_name, email::text as email from users
          where id = any ($1::uuid[]) and role = 'school_admin' and is_active and deleted_at is null`,
        [userIds],
      )
    ).map((u) => [u.id, u]),
  );
  const deliveries: AlertDelivery[] = [];
  const emails = new Set<string>();
  const pushUsers = new Set<string>();
  const addEmail = (email: string, userId: string | null, name: string | null) => {
    const key = email.toLowerCase();
    if (emails.has(key)) return;
    emails.add(key);
    deliveries.push(pending({ channel: 'email', userId, name, target: key }));
  };
  for (const r of matching) {
    if (r.userId) {
      const admin = admins.get(r.userId);
      if (!admin) {
        deliveries.push(skipped({ channel: 'email', userId: r.userId, name: r.name ?? null, target: null }, 'RECIPIENT_INACTIVE'));
        continue;
      }
      const name = r.name ?? admin.full_name;
      if (admin.email) addEmail(admin.email, admin.id, name);
      if (!pushUsers.has(admin.id)) {
        pushUsers.add(admin.id);
        deliveries.push(pending({ channel: 'push', userId: admin.id, name, target: admin.full_name }));
      }
    }
    if (r.email) addEmail(r.email, r.userId ?? null, r.name ?? null);
    if (r.phone) deliveries.push(skipped({ channel: 'sms', userId: r.userId ?? null, name: r.name ?? null, target: maskPhone(r.phone) }, 'SMS_NOT_SUPPORTED'));
  }
  return { escalatedAt: new Date().toISOString(), escalatedBy: tx.ctx.actorId, recipientCount: matching.length, deliveries };
}

// ── delivery job ─────────────────────────────────────────────────────────────
export interface EscalationPayload {
  schoolId: string;
  alertId: string;
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();

function formatLocal(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-IN', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function emailFor(a: repo.AlertRow, school: { name: string; timezone: string }) {
  const severity = a.severity.charAt(0).toUpperCase() + a.severity.slice(1);
  const lines = [
    `An alert was escalated in Where Is My Bus for ${school.name}.`,
    '',
    `Alert: ${oneLine(a.title)}`,
    `Type: ${ALERT_TYPE_LABELS[a.alert_type]} · Severity: ${severity}`,
    a.bus_code ? `Bus: ${a.bus_code}` : null,
    a.staff_name ? `Staff: ${a.staff_name}` : null,
    a.trip_date ? `Trip: ${a.trip_date}${a.trip_direction ? ` (${a.trip_direction})` : ''}${a.route_code ? ` · route ${a.route_code}` : ''}` : null,
    `Raised: ${formatLocal(a.created_at, school.timezone)} (${school.timezone})`,
    a.escalated_by_name ? `Escalated by: ${a.escalated_by_name}` : null,
    a.review_note ? `Note: ${a.review_note}` : null,
    '',
    `Open the alert: ${config.appPublicUrl}/school/alerts?alert=${encodeURIComponent(a.id)}`,
  ].filter((l): l is string => l !== null);
  return {
    subject: oneLine(`[Where Is My Bus] Escalated ${a.severity} alert: ${a.title}`).slice(0, 200),
    text: lines.join('\n'),
  };
}

type Channels = Pick<NotificationChannels, 'email' | 'push'>;

/** Seconds a delivery run holds its per-alert claim (longer than any SMTP/FCM timeout of one run). */
export const ESCALATION_CLAIM_TTL_S = 120;

/** Runs the deliveries of one escalated alert (see the header). Returns the final deliveries. */
export async function deliverEscalation(payload: EscalationPayload, deps: { channels?: Channels } = {}): Promise<AlertDelivery[]> {
  const claim = kvKey('alert-escalation', payload.schoolId, payload.alertId);
  // Another run (second worker, stalled-job recovery) is sending this alert right now: it stores the results
  // and retries its own failures, so this run must not send anything.
  if (!(await kv.setIfAbsent(claim, '1', ESCALATION_CLAIM_TTL_S))) return [];
  try {
    return await runDeliveries(payload, deps.channels ?? defaultChannels);
  } finally {
    await kv.del(claim);
  }
}

const isOpen = (d: AlertDelivery) => d.status === 'pending' || d.status === 'failed';

async function runDeliveries({ schoolId, alertId }: EscalationPayload, ch: Channels): Promise<AlertDelivery[]> {
  const loaded = await withSchoolSystem(
    schoolId,
    async (tx) => {
      const alert = await repo.findById(tx, alertId);
      const escalation = readEscalation(alert?.details?.escalation);
      if (!alert || !escalation) return null;
      const school = await tx.one<{ name: string; timezone: string }>(`select name, timezone from schools where id = $1`, [schoolId]);
      const userIds = [...new Set(escalation.deliveries.filter((d) => d.userId && isOpen(d)).map((d) => d.userId!))];
      const active = new Set(
        (
          await tx.many<{ id: string }>(
            `select id from users where id = any ($1::uuid[]) and role = 'school_admin' and is_active and deleted_at is null`,
            [userIds],
          )
        ).map((u) => u.id),
      );
      const tokens = await adminPushTokens(tx, [...active]);
      return { alert, escalation, school, active, tokens };
    },
    { readOnly: true },
  );
  if (!loaded) return [];
  const { alert, escalation, school, active, tokens } = loaded;
  const mail = emailFor(alert, school);
  const invalidTokens: string[] = [];
  let retry = false;
  const results: AlertDelivery[] = [];
  for (const d of escalation.deliveries) {
    if (!isOpen(d)) {
      results.push(d);
      continue;
    }
    const attemptedAt = new Date().toISOString();
    if (d.userId && !active.has(d.userId)) {
      // Deactivated, deleted or demoted after the escalation: neither the e-mail nor the push goes out.
      results.push({ ...d, status: 'skipped', reason: 'RECIPIENT_INACTIVE', attemptedAt });
      continue;
    }
    try {
      if (d.channel === 'email' && d.target) {
        const r = await ch.email.send({ to: d.target, subject: mail.subject, text: mail.text });
        const status = r.delivered ? 'sent' : r.transport === 'log' ? 'logged' : 'failed';
        if (status === 'failed') retry = true;
        results.push({ ...d, status, reason: status === 'failed' ? 'SMTP_FAILED' : status === 'logged' ? 'SMTP_NOT_CONFIGURED' : null, attemptedAt });
      } else if (d.channel === 'push' && d.userId) {
        const list = tokens.get(d.userId) ?? [];
        if (!list.length) {
          results.push({ ...d, status: 'skipped', reason: 'NO_DEVICES', attemptedAt });
          continue;
        }
        const r = await ch.push.send({
          tokens: list,
          title: oneLine(`Escalated alert · ${ALERT_TYPE_LABELS[alert.alert_type]}`),
          body: oneLine(alert.title).slice(0, 180),
          data: { type: 'alert', schoolId, alertId },
        });
        invalidTokens.push(...r.invalidTokens);
        const status = r.skipped ? 'skipped' : r.successCount > 0 ? 'sent' : 'failed';
        results.push({ ...d, status, reason: r.skipped ? 'PUSH_DISABLED' : status === 'failed' ? 'PUSH_FAILED' : null, attemptedAt });
      } else {
        results.push({ ...d, status: 'skipped', reason: d.reason ?? 'NO_TARGET', attemptedAt });
      }
    } catch (err) {
      retry = true;
      log.warn({ err, schoolId, alertId, channel: d.channel }, 'Alert escalation delivery failed');
      results.push({ ...d, status: 'failed', reason: 'DELIVERY_ERROR', attemptedAt });
    }
  }
  await withSchoolSystem(schoolId, async (tx) => {
    await repo.saveEscalation(tx, alertId, { ...escalation, deliveries: results });
    if (invalidTokens.length) {
      await tx.query(`update devices set fcm_token = null, updated_at = now() where owner_type = 'user' and fcm_token = any ($1::text[])`, [invalidTokens]);
    }
    const count = (s: AlertDelivery['status']) => results.filter((d) => d.status === s).length;
    await audit.log(tx, {
      action: 'alert.notify',
      entityType: 'alert',
      entityId: alertId,
      actorName: ALERT_ESCALATION_JOB,
      new: { sent: count('sent'), logged: count('logged'), failed: count('failed'), skipped: count('skipped') },
    });
  });
  if (retry) throw new Error(`Alert escalation ${alertId}: some deliveries failed and will be retried`);
  return results;
}
