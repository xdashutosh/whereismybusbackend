// Alert jobs (BP §7.3, contract §8), registered in src/jobs/index.ts JOB_DEFINITIONS:
//   document-expiry-scan   daily 06:30 school-local: documents/licences vs reminder thresholds, missing
//                          required documents (documentScan.ts)
//   maintenance-due-scan   daily 06:45 school-local: service due by date or km (maintenanceScan.ts)
//   alert-email-digest     daily 07:00 school-local: unresolved alerts e-mailed to the alert recipients when
//                          the school's emailDigest feature is on (digest.ts)
//   alert-escalation       on demand after PATCH /school/alerts/:id {action: escalate}: e-mail/push to the
//                          school's alert recipients (escalation.ts)
// Scan handlers run inside withSchoolSystem(schoolId), are idempotent (reconcile.ts) and announce new
// alerts (alert:new) and system closures (alert:updated) after commit. Exported for tests.
// Imports only the job registry (not jobs/index.ts), so the registry can import this file.
import { withSchoolSystem } from '../../db/tenant.js';
import { defineQueueJob, defineSchoolCronJob } from '../../jobs/registry.js';
import type { JobDef, SchoolCronPayload } from '../../jobs/types.js';
import { ALERT_EMAIL_DIGEST_JOB, alertEmailDigest } from './digest.js';
import { computeDocumentAlerts, DOCUMENT_ALERT_TYPES, DOCUMENT_EXPIRY_SCAN_JOB, DOCUMENT_NOTES } from './documentScan.js';
import { ALERT_ESCALATION_JOB, deliverEscalation, type EscalationPayload } from './escalation.js';
import { computeMaintenanceAlerts, MAINTENANCE_ALERT_TYPES, MAINTENANCE_DUE_SCAN_JOB, MAINTENANCE_NOTES } from './maintenanceScan.js';
import { announceAlertUpdates } from './publish.js';
import { reconcileScanAlerts, type ReconcileResult } from './reconcile.js';
import { announceAlerts } from './service.js';

export { ALERT_EMAIL_DIGEST_JOB, ALERT_ESCALATION_JOB, DOCUMENT_EXPIRY_SCAN_JOB, MAINTENANCE_DUE_SCAN_JOB };

export interface ScanPayload {
  schoolId: string;
  /** School-local day to evaluate (defaults to today in the school's timezone). */
  localDate?: string;
}

export interface ScanSummary {
  localDate: string;
  desired: number;
  raised: number;
  closed: number;
  resolved: number;
}

async function localToday(tx: Parameters<Parameters<typeof withSchoolSystem>[1]>[0], schoolId: string): Promise<string> {
  const r = await tx.one<{ d: string }>('select school_local_date($1::uuid)::text as d', [schoolId]);
  return r.d;
}

async function publish(result: ReconcileResult): Promise<void> {
  await announceAlerts(result.raised);
  await announceAlertUpdates(result.closed);
}

const summary = (localDate: string, desired: number, r: ReconcileResult): ScanSummary => ({
  localDate,
  desired,
  raised: r.raised.length,
  closed: r.closed.length,
  resolved: r.resolvedIds.length,
});

/** document-expiry-scan for one school. */
export async function documentExpiryScan({ schoolId, localDate }: ScanPayload): Promise<ScanSummary> {
  const { result, day, desired } = await withSchoolSystem(schoolId, async (tx) => {
    const day = localDate ?? (await localToday(tx, schoolId));
    const { desired, thresholds } = await computeDocumentAlerts(tx, day);
    const result = await reconcileScanAlerts(tx, {
      scan: DOCUMENT_EXPIRY_SCAN_JOB,
      types: DOCUMENT_ALERT_TYPES,
      desired,
      notes: DOCUMENT_NOTES,
      auditContext: { localDate: day, thresholds },
    });
    return { result, day, desired: desired.length };
  });
  await publish(result);
  return summary(day, desired, result);
}

/** maintenance-due-scan for one school. */
export async function maintenanceDueScan({ schoolId, localDate }: ScanPayload): Promise<ScanSummary> {
  const { result, day, desired } = await withSchoolSystem(schoolId, async (tx) => {
    const day = localDate ?? (await localToday(tx, schoolId));
    const desired = await computeMaintenanceAlerts(tx, day);
    const result = await reconcileScanAlerts(tx, {
      scan: MAINTENANCE_DUE_SCAN_JOB,
      types: MAINTENANCE_ALERT_TYPES,
      desired,
      notes: MAINTENANCE_NOTES,
      auditContext: { localDate: day },
    });
    return { result, day, desired: desired.length };
  });
  await publish(result);
  return summary(day, desired, result);
}

export const documentExpiryScanJob = defineSchoolCronJob({
  name: DOCUMENT_EXPIRY_SCAN_JOB,
  cron: '30 6 * * *',
  attempts: 3,
  handler: async (p: SchoolCronPayload) => void (await documentExpiryScan({ schoolId: p.schoolId, localDate: p.localDate })),
});

export const maintenanceDueScanJob = defineSchoolCronJob({
  name: MAINTENANCE_DUE_SCAN_JOB,
  cron: '45 6 * * *',
  attempts: 3,
  handler: async (p: SchoolCronPayload) => void (await maintenanceDueScan({ schoolId: p.schoolId, localDate: p.localDate })),
});

export const alertEmailDigestJob = defineSchoolCronJob({
  name: ALERT_EMAIL_DIGEST_JOB,
  cron: '0 7 * * *',
  attempts: 3,
  handler: async (p: SchoolCronPayload) => void (await alertEmailDigest({ schoolId: p.schoolId, localDate: p.localDate })),
});

export const alertEscalationJob = defineQueueJob<EscalationPayload>({
  name: ALERT_ESCALATION_JOB,
  concurrency: 2,
  attempts: 4,
  backoffMs: 10_000,
  handler: async (p) => void (await deliverEscalation(p)),
});

export const ALERT_JOB_DEFINITIONS: readonly JobDef[] = [documentExpiryScanJob, maintenanceDueScanJob, alertEmailDigestJob, alertEscalationJob];
