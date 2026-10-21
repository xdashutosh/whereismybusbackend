// document-expiry-scan (BP §7.3, §11.1): bus documents, staff documents and driver licences against the
// reminder thresholds (school_settings.document_reminder_days, else the platform default
// docs.expiry_reminder_days, e.g. 60/30/15/7/1 days), plus missing required documents.
//   doc_expiring  days to expiry ≤ a threshold: ONE alert for the tightest threshold reached
//                 (doc_expiring:{docId}:{threshold}:{expiry}); a tighter threshold supersedes the earlier
//                 reminder; warning, critical from 7 days
//   doc_expired   expiry date before the school-local day (doc_expired:{docId}:{expiry}); critical
//   doc_missing   active bus without a current insurance / fitness document
//                 (doc_missing:bus:{busId}:{docType}), active driver without a licence expiry date or a
//                 current licence document (doc_missing:licence:{staffId}); warning
// Scope: current, non-deleted documents of non-deleted buses in service (active / maintenance) and of
// active, non-deleted staff. The driver licence on the staff profile is the source of truth for licence
// validity; licence front/back documents are scanned only when the profile has no licence expiry date.
// Licence keys use 'licence:{staffId}' in place of a document id. Renewals and corrections resolve the
// old alerts automatically (reconcile.ts).
import { REQUIRED_BUS_DOCUMENT_TYPES, type AlertType, type BusDocumentType, type StaffDocumentType } from '@wimb/shared';
import type { Tx } from '../../db/tenant.js';
import { loadSchoolSettings } from '../school/index.js';
import type { DesiredAlert } from './reconcile.js';

export const DOCUMENT_EXPIRY_SCAN_JOB = 'document-expiry-scan';
export const DOCUMENT_ALERT_TYPES: readonly AlertType[] = ['doc_expiring', 'doc_expired', 'doc_missing'];
/** Reminders at or below this many days are critical. */
export const CRITICAL_REMINDER_DAYS = 7;

export const DOCUMENT_NOTES = {
  superseded: 'Superseded by a newer reminder for the same document.',
  resolved: 'Resolved automatically: the document was renewed, corrected or is no longer required.',
};

const BUS_DOC_LABELS: Readonly<Record<BusDocumentType, string>> = {
  insurance: 'Insurance',
  fitness: 'Fitness certificate',
  pollution: 'Pollution certificate (PUC)',
  permit: 'Permit',
  rc: 'Registration certificate (RC)',
  safety_inspection: 'Safety inspection',
  other: 'Document',
};
const STAFF_DOC_LABELS: Readonly<Record<StaffDocumentType, string>> = {
  identity: 'Identity proof',
  licence_front: 'Driving licence',
  licence_back: 'Driving licence',
  character_certificate: 'Character certificate',
  police_verification: 'Police verification',
  training: 'Training certificate',
  first_aid: 'First-aid certificate',
  child_safety: 'Child-safety training',
  other: 'Document',
};

type Source = 'bus_document' | 'staff_document' | 'staff_licence' | 'bus_missing' | 'licence_missing';

interface ScanRow extends Record<string, unknown> {
  source: Source;
  subject_id: string;
  doc_type: string;
  doc_title: string | null;
  expiry_date: string | null;
  days_left: number | null;
  bus_id: string | null;
  bus_code: string | null;
  staff_id: string | null;
  staff_name: string | null;
  staff_type: 'driver' | 'conductor' | null;
}

/** Normalised reminder thresholds (positive integers, ascending, unique). */
export function normaliseThresholds(days: readonly unknown[] | null | undefined): number[] {
  return [...new Set((days ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
}

/** Tightest threshold reached by `daysLeft` (≥ 0), or null when none is reached yet. */
export function thresholdFor(daysLeft: number, thresholds: readonly number[]): number | null {
  return thresholds.find((t) => daysLeft <= t) ?? null;
}

function loadRows(tx: Tx, localDate: string, horizon: number): Promise<ScanRow[]> {
  return tx.many<ScanRow>(
    `select 'bus_document' as source, d.id as subject_id, d.doc_type, d.title as doc_title, d.expiry_date, d.bus_id, b.code as bus_code,
            null::uuid as staff_id, null::text as staff_name, null::text as staff_type
       from bus_documents d join buses b on b.id = d.bus_id and b.deleted_at is null and b.status in ('active', 'maintenance')
      where d.is_current and d.deleted_at is null and d.expiry_date is not null and d.expiry_date <= $1::date + $2::int
     union all
     select 'staff_document', d.id, d.doc_type, d.title, d.expiry_date, null, null, sp.id, sp.full_name, sp.staff_type
       from staff_documents d join staff_profiles sp on sp.id = d.staff_id and sp.deleted_at is null and sp.is_active
      where d.is_current and d.deleted_at is null and d.expiry_date is not null and d.expiry_date <= $1::date + $2::int
        and not (d.doc_type in ('licence_front', 'licence_back') and sp.licence_expiry_date is not null)
     union all
     select 'staff_licence', sp.id, 'licence', null, sp.licence_expiry_date, null, null, sp.id, sp.full_name, sp.staff_type
       from staff_profiles sp
      where sp.deleted_at is null and sp.is_active and sp.staff_type = 'driver'
        and sp.licence_expiry_date is not null and sp.licence_expiry_date <= $1::date + $2::int
     union all
     select 'bus_missing', b.id, t.doc_type, null, null, b.id, b.code, null, null, null
       from buses b cross join unnest($3::text[]) as t(doc_type)
      where b.deleted_at is null and b.status in ('active', 'maintenance')
        and not exists (select 1 from bus_documents d
                         where d.bus_id = b.id and d.doc_type = t.doc_type and d.is_current and d.deleted_at is null)
     union all
     select 'licence_missing', sp.id, 'licence', null, null, null, null, sp.id, sp.full_name, sp.staff_type
       from staff_profiles sp
      where sp.deleted_at is null and sp.is_active and sp.staff_type = 'driver' and sp.licence_expiry_date is null
        and not exists (select 1 from staff_documents d
                         where d.staff_id = sp.id and d.doc_type in ('licence_front', 'licence_back') and d.is_current and d.deleted_at is null)`,
    [localDate, horizon, REQUIRED_BUS_DOCUMENT_TYPES],
  ).then((rows) =>
    rows.map((r) => ({
      ...r,
      expiry_date: r.expiry_date ? String(r.expiry_date).slice(0, 10) : null,
      days_left: r.expiry_date ? Math.round((Date.parse(`${String(r.expiry_date).slice(0, 10)}T00:00:00Z`) - Date.parse(`${localDate}T00:00:00Z`)) / 86_400_000) : null,
    })),
  );
}

function labelOf(r: ScanRow): string {
  if (r.doc_type === 'licence') return 'Driving licence';
  const base = r.source === 'bus_document' || r.source === 'bus_missing' ? BUS_DOC_LABELS[r.doc_type as BusDocumentType] : STAFF_DOC_LABELS[r.doc_type as StaffDocumentType];
  if ((r.doc_type === 'other' || r.doc_type === 'training') && r.doc_title) return r.doc_title.trim().slice(0, 80);
  return base ?? 'Document';
}

const ownerOf = (r: ScanRow) => (r.bus_id ? `bus ${r.bus_code}` : `${r.staff_type ?? 'staff'} ${r.staff_name}`);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Alerts that should exist for the current school on `localDate`. */
export function desiredDocumentAlerts(rows: readonly ScanRow[], thresholds: readonly number[], localDate: string): DesiredAlert[] {
  const out: DesiredAlert[] = [];
  for (const r of rows) {
    const label = labelOf(r);
    const common = {
      busId: r.bus_id,
      staffId: r.staff_id,
      entity:
        r.source === 'bus_document' ? { type: 'bus_document' as const, id: r.subject_id }
        : r.source === 'staff_document' ? { type: 'staff_document' as const, id: r.subject_id }
        : r.source === 'bus_missing' ? { type: 'bus' as const, id: r.subject_id }
        : { type: 'staff' as const, id: r.subject_id },
    };
    const details = { source: r.source, docType: r.doc_type, localDate, ...(r.bus_code ? { busCode: r.bus_code } : {}), ...(r.staff_name ? { staffName: r.staff_name } : {}) };
    if (r.source === 'bus_missing' || r.source === 'licence_missing') {
      const isBus = r.source === 'bus_missing';
      out.push({
        ...common,
        type: 'doc_missing',
        severity: 'warning',
        title: isBus ? `${label} missing for bus ${r.bus_code}` : `Driving licence missing for driver ${r.staff_name}`,
        dedupeKey: isBus ? `doc_missing:bus:${r.subject_id}:${r.doc_type}` : `doc_missing:licence:${r.subject_id}`,
        subject: isBus ? `missing:bus:${r.subject_id}:${r.doc_type}` : `missing:licence:${r.subject_id}`,
        details,
      });
      continue;
    }
    if (r.days_left === null || !r.expiry_date) continue;
    const ref = r.source === 'staff_licence' ? `licence:${r.subject_id}` : r.subject_id;
    const subject = r.source === 'staff_licence' ? `licence:${r.subject_id}` : `${r.source}:${r.subject_id}`;
    if (r.days_left < 0) {
      out.push({
        ...common,
        type: 'doc_expired',
        severity: 'critical',
        title: `${label} of ${ownerOf(r)} expired on ${r.expiry_date}`,
        dedupeKey: `doc_expired:${ref}:${r.expiry_date}`,
        subject,
        details: { ...details, expiryDate: r.expiry_date, daysToExpiry: r.days_left },
      });
      continue;
    }
    const threshold = thresholdFor(r.days_left, thresholds);
    if (threshold === null) continue;
    out.push({
      ...common,
      type: 'doc_expiring',
      severity: threshold <= CRITICAL_REMINDER_DAYS ? 'critical' : 'warning',
      title: `${label} of ${ownerOf(r)} ${r.days_left === 0 ? 'expires today' : `expires in ${plural(r.days_left, 'day')}`} (${r.expiry_date})`,
      dedupeKey: `doc_expiring:${ref}:${threshold}:${r.expiry_date}`,
      subject,
      details: { ...details, expiryDate: r.expiry_date, daysToExpiry: r.days_left, threshold, thresholds: [...thresholds] },
    });
  }
  return out;
}

/** Loads the settings and documents of the current school and computes the desired alerts. */
export async function computeDocumentAlerts(tx: Tx, localDate: string): Promise<{ desired: DesiredAlert[]; thresholds: number[] }> {
  const settings = await loadSchoolSettings(tx);
  const thresholds = normaliseThresholds(settings.effective.documentReminderDays);
  const rows = await loadRows(tx, localDate, thresholds.at(-1) ?? 0);
  return { desired: desiredDocumentAlerts(rows, thresholds, localDate), thresholds };
}
