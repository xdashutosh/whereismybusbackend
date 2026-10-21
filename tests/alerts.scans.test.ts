// Alert scan jobs (BP §7.3, §11.1): document-expiry-scan (thresholds from school/platform settings,
// tightest threshold only, dedupe across repeated scans, superseding, expired, missing required
// documents, driver licences, renewal resolution, admin-closed suppression) and maintenance-due-scan
// (by date / km, overdue supersedes due-soon, a newer service log resolves), each confined to its school.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JOB_DEFINITIONS } from '../src/jobs/index.js';
import { withTenant } from '../src/db/tenant.js';
import { documentExpiryScan, maintenanceDueScan } from '../src/modules/alerts/jobs.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
});
afterAll(closeDb);

const D = f.isoDay(0);
const day = (n: number) => new Date(Date.parse(`${D}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

interface A extends Record<string, unknown> {
  id: string;
  alert_type: string;
  severity: string;
  status: string;
  title: string;
  dedupe_key: string;
  entity_type: string | null;
  entity_id: string | null;
  bus_id: string | null;
  staff_id: string | null;
  closed_by: string | null;
  review_note: string | null;
  details: Record<string, unknown>;
}
async function alertsOf(schoolId: string, types?: string[]): Promise<A[]> {
  const { rows } = await ownerQuery<A>(
    `select * from alerts where school_id = $1 and ($2::text[] is null or alert_type = any ($2::text[])) order by created_at, id`,
    [schoolId, types ?? null],
  );
  return rows;
}
const live = (rows: A[]) => rows.filter((r) => r.status !== 'closed');

/** A school with one fully documented bus and a licensed driver (no alerts on its own). */
async function quietSchool(o: f.Values = {}) {
  const s = await f.school(o);
  const bus = await f.bus(s.id, { code: 'R1' });
  await f.busDocument(s.id, bus.id, { doc_type: 'insurance', expiry_date: day(300) });
  await f.busDocument(s.id, bus.id, { doc_type: 'fitness', expiry_date: day(300) });
  const driver = await f.staffProfile(s.id, { full_name: 'Ramesh Kumar', licence_expiry_date: day(400) });
  return { s, sid: s.id, bus, driver };
}

describe('job registration', () => {
  it('registers both scans as daily school-local cron jobs and the escalation queue job', () => {
    const byName = new Map(JOB_DEFINITIONS.map((d) => [d.name, d]));
    expect(byName.get('document-expiry-scan')).toMatchObject({ kind: 'school-cron', cron: '30 6 * * *' });
    expect(byName.get('maintenance-due-scan')).toMatchObject({ kind: 'school-cron', cron: '45 6 * * *' });
    expect(byName.get('alert-escalation')).toMatchObject({ kind: 'queue' });
  });
});

describe('document-expiry-scan', () => {
  it('a quiet school gets no alert', async () => {
    const w = await quietSchool();
    expect(await documentExpiryScan({ schoolId: w.sid, localDate: D })).toMatchObject({ localDate: D, desired: 0, raised: 0, resolved: 0 });
    expect(await alertsOf(w.sid)).toEqual([]);
  });

  it('raises the tightest threshold once, dedupes repeated scans, supersedes with tighter thresholds, then expired', async () => {
    const w = await quietSchool();
    const doc = await f.busDocument(w.sid, w.bus.id, { doc_type: 'pollution', expiry_date: day(20) });

    expect(await documentExpiryScan({ schoolId: w.sid, localDate: D })).toMatchObject({ raised: 1 });
    let rows = await alertsOf(w.sid);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      alert_type: 'doc_expiring', severity: 'warning', status: 'open', entity_type: 'bus_document', entity_id: doc.id, bus_id: w.bus.id,
      dedupe_key: `doc_expiring:${doc.id}:30:${day(20)}`, title: `Pollution certificate (PUC) of bus R1 expires in 20 days (${day(20)})`,
    });
    expect(rows[0]!.details).toMatchObject({ threshold: 30, daysToExpiry: 20, expiryDate: day(20), docType: 'pollution', thresholds: [1, 7, 15, 30, 60] });

    // Repeated scans (same day, next day) never duplicate.
    expect(await documentExpiryScan({ schoolId: w.sid, localDate: D })).toMatchObject({ raised: 0, resolved: 0 });
    expect(await documentExpiryScan({ schoolId: w.sid, localDate: day(1) })).toMatchObject({ raised: 0, resolved: 0 });
    expect(await alertsOf(w.sid)).toHaveLength(1);

    // 14 days left → the 15-day reminder replaces the 30-day one.
    expect(await documentExpiryScan({ schoolId: w.sid, localDate: day(6) })).toMatchObject({ raised: 1, closed: 1, resolved: 1 });
    rows = await alertsOf(w.sid);
    expect(rows[0]).toMatchObject({ status: 'closed', closed_by: null, review_note: 'Superseded by a newer reminder for the same document.' });
    expect(rows[0]!.details).toMatchObject({ resolution: 'superseded' });
    expect(rows[0]!.details.resolvedAt).toBeTruthy();
    expect(live(rows)).toEqual([expect.objectContaining({ dedupe_key: `doc_expiring:${doc.id}:15:${day(20)}`, severity: 'warning' })]);

    // 6 days left → 7-day reminder, critical.
    await documentExpiryScan({ schoolId: w.sid, localDate: day(14) });
    expect(live(await alertsOf(w.sid))).toEqual([expect.objectContaining({ dedupe_key: `doc_expiring:${doc.id}:7:${day(20)}`, severity: 'critical' })]);

    // Expiry day itself: still valid ("expires today", 1-day reminder).
    await documentExpiryScan({ schoolId: w.sid, localDate: day(20) });
    expect(live(await alertsOf(w.sid))).toEqual([expect.objectContaining({ dedupe_key: `doc_expiring:${doc.id}:1:${day(20)}`, title: expect.stringContaining('expires today') })]);

    // The day after: expired (critical); scanning again later keeps the single expired alert.
    await documentExpiryScan({ schoolId: w.sid, localDate: day(21) });
    await documentExpiryScan({ schoolId: w.sid, localDate: day(40) });
    rows = await alertsOf(w.sid);
    expect(live(rows)).toEqual([
      expect.objectContaining({ alert_type: 'doc_expired', severity: 'critical', dedupe_key: `doc_expired:${doc.id}:${day(20)}`, title: `Pollution certificate (PUC) of bus R1 expired on ${day(20)}` }),
    ]);
    expect(rows).toHaveLength(5);
    const { rows: audits } = await ownerQuery<{ new_values: Record<string, unknown>; actor_type: string }>(
      `select new_values, actor_type from audit_logs where school_id = $1 and action = 'alert.scan' order by created_at`,
      [w.sid],
    );
    expect(audits.length).toBe(5);
    expect(audits[0]!.new_values).toMatchObject({ scan: 'document-expiry-scan', raised: 1, localDate: D });
  });

  it('renewal resolves the alert; an admin-closed alert stays closed while the cause persists and returns after resolution', async () => {
    const w = await quietSchool();
    const admin = await f.user(w.sid, { role: 'school_admin' });
    const old = await f.busDocument(w.sid, w.bus.id, { doc_type: 'permit', expiry_date: day(-3) });
    await documentExpiryScan({ schoolId: w.sid, localDate: D });
    const [expired] = await alertsOf(w.sid);
    expect(expired).toMatchObject({ alert_type: 'doc_expired', status: 'open' });

    // The admin closes it: later scans do not raise it again.
    await ownerQuery(`update alerts set status = 'closed', closed_by = $2, closed_at = now() where id = $1`, [expired!.id, admin.id]);
    expect(await documentExpiryScan({ schoolId: w.sid, localDate: day(1) })).toMatchObject({ raised: 0 });
    expect(await alertsOf(w.sid)).toHaveLength(1);

    // Renewal (replace keeps history): the closed alert is marked resolved, nothing live remains.
    const renewed = await f.busDocument(w.sid, w.bus.id, { doc_type: 'permit', expiry_date: day(25), is_current: false });
    await ownerQuery(`update bus_documents set is_current = false, replaced_by = $2 where id = $1`, [old.id, renewed.id]);
    await ownerQuery(`update bus_documents set is_current = true where id = $1`, [renewed.id]);
    expect(await documentExpiryScan({ schoolId: w.sid, localDate: day(1) })).toMatchObject({ raised: 1, closed: 0, resolved: 1 });
    let rows = await alertsOf(w.sid);
    expect(rows[0]).toMatchObject({ status: 'closed', closed_by: admin.id });
    expect(rows[0]!.details).toMatchObject({ resolution: 'resolved' });
    expect(live(rows)).toEqual([expect.objectContaining({ alert_type: 'doc_expiring', dedupe_key: `doc_expiring:${renewed.id}:30:${day(25)}` })]);

    // In-place correction of the expiry date (same document id) → a new key, the old reminder resolves.
    await ownerQuery(`update bus_documents set expiry_date = $2 where id = $1`, [renewed.id, day(300)]);
    expect(await documentExpiryScan({ schoolId: w.sid, localDate: day(1) })).toMatchObject({ raised: 0, closed: 1 });
    rows = await alertsOf(w.sid);
    expect(live(rows)).toEqual([]);
    expect(rows.at(-1)!.review_note).toBe('Resolved automatically: the document was renewed, corrected or is no longer required.');
  });

  it('flags missing required documents and driver licences; buses out of service and inactive staff are skipped', async () => {
    const s = await f.school();
    const bus = await f.bus(s.id, { code: 'R1' });
    await f.bus(s.id, { code: 'R9', status: 'retired' });
    await f.bus(s.id, { code: 'R8', status: 'inactive' });
    await f.bus(s.id, { code: 'R7', deleted_at: new Date().toISOString() });
    const maint = await f.bus(s.id, { code: 'R2', status: 'maintenance' });
    await f.busDocument(s.id, maint.id, { doc_type: 'insurance', expiry_date: null });
    await f.busDocument(s.id, maint.id, { doc_type: 'fitness', expiry_date: day(300) });
    const noLicence = await f.staffProfile(s.id, { full_name: 'Mahesh Gowda', licence_expiry_date: null });
    const withDoc = await f.staffProfile(s.id, { full_name: 'Kiran Rao', licence_expiry_date: null });
    await f.staffDocument(s.id, withDoc.id, { doc_type: 'licence_front', expiry_date: null });
    await f.staffProfile(s.id, { staff_type: 'conductor', full_name: 'Suresh Babu', licence_expiry_date: null, licence_no: null });
    await f.staffProfile(s.id, { full_name: 'Inactive Driver', licence_expiry_date: null, is_active: false });

    await documentExpiryScan({ schoolId: s.id, localDate: D });
    let rows = await alertsOf(s.id);
    expect(rows.map((r) => r.dedupe_key).sort()).toEqual(
      [`doc_missing:bus:${bus.id}:fitness`, `doc_missing:bus:${bus.id}:insurance`, `doc_missing:licence:${noLicence.id}`].sort(),
    );
    expect(rows.find((r) => r.dedupe_key === `doc_missing:licence:${noLicence.id}`)).toMatchObject({
      severity: 'warning', entity_type: 'staff', staff_id: noLicence.id, title: 'Driving licence missing for driver Mahesh Gowda',
    });
    expect(rows.find((r) => r.dedupe_key.endsWith(':insurance'))).toMatchObject({ entity_type: 'bus', bus_id: bus.id, title: 'Insurance missing for bus R1' });

    // Adding the insurance resolves that alert only.
    await f.busDocument(s.id, bus.id, { doc_type: 'insurance', expiry_date: day(200) });
    expect(await documentExpiryScan({ schoolId: s.id, localDate: D })).toMatchObject({ raised: 0, closed: 1 });
    rows = await alertsOf(s.id);
    expect(live(rows).map((r) => r.dedupe_key).sort()).toEqual([`doc_missing:bus:${bus.id}:fitness`, `doc_missing:licence:${noLicence.id}`].sort());

    // Deleting it again raises a NEW missing alert (the earlier one was resolved).
    await ownerQuery(`update bus_documents set deleted_at = now() where bus_id = $1 and doc_type = 'insurance'`, [bus.id]);
    expect(await documentExpiryScan({ schoolId: s.id, localDate: D })).toMatchObject({ raised: 1 });
    expect(live(await alertsOf(s.id))).toHaveLength(3);
  });

  it('driver licence on the profile wins over licence documents; staff documents use their own expiry', async () => {
    const w = await quietSchool();
    await ownerQuery(`update staff_profiles set licence_expiry_date = $2 where id = $1`, [w.driver.id, day(5)]);
    await f.staffDocument(w.sid, w.driver.id, { doc_type: 'licence_front', expiry_date: day(3) });
    const pv = await f.staffDocument(w.sid, w.driver.id, { doc_type: 'police_verification', expiry_date: day(40) });
    const conductor = await f.staffProfile(w.sid, { staff_type: 'conductor', full_name: 'Suresh Babu', licence_expiry_date: null, licence_no: null });
    await f.staffDocument(w.sid, conductor.id, { doc_type: 'first_aid', expiry_date: day(-10) });
    await f.staffDocument(w.sid, conductor.id, { doc_type: 'training', title: 'Fire safety', expiry_date: day(10), is_current: false });

    await documentExpiryScan({ schoolId: w.sid, localDate: D });
    const rows = await alertsOf(w.sid);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.dedupe_key === `doc_expiring:licence:${w.driver.id}:7:${day(5)}`)).toMatchObject({
      severity: 'critical', entity_type: 'staff', entity_id: w.driver.id, staff_id: w.driver.id, title: `Driving licence of driver Ramesh Kumar expires in 5 days (${day(5)})`,
    });
    expect(rows.find((r) => r.entity_id === pv.id)).toMatchObject({ alert_type: 'doc_expiring', severity: 'warning', entity_type: 'staff_document', dedupe_key: `doc_expiring:${pv.id}:60:${day(40)}` });
    expect(rows.find((r) => r.alert_type === 'doc_expired')).toMatchObject({ staff_id: conductor.id, title: `First-aid certificate of conductor Suresh Babu expired on ${day(-10)}` });
  });

  it('uses the school reminder days instead of the platform default', async () => {
    const w = await quietSchool();
    await f.schoolSettings(w.sid, { document_reminder_days: [10] });
    const doc = await f.busDocument(w.sid, w.bus.id, { doc_type: 'rc', expiry_date: day(20) });
    expect(await documentExpiryScan({ schoolId: w.sid, localDate: D })).toMatchObject({ desired: 0 });
    await documentExpiryScan({ schoolId: w.sid, localDate: day(11) });
    expect(await alertsOf(w.sid)).toEqual([expect.objectContaining({ dedupe_key: `doc_expiring:${doc.id}:10:${day(20)}`, severity: 'warning' })]);
  });

  it('stays inside its school: identical codes elsewhere are untouched; the app role without context sees nothing', async () => {
    const a = await quietSchool();
    const b = await quietSchool();
    await f.busDocument(a.sid, a.bus.id, { doc_type: 'permit', expiry_date: day(2) });
    await f.busDocument(b.sid, b.bus.id, { doc_type: 'permit', expiry_date: day(2) });
    await documentExpiryScan({ schoolId: a.sid, localDate: D });
    expect(await alertsOf(a.sid)).toHaveLength(1);
    expect(await alertsOf(b.sid)).toHaveLength(0);
    await documentExpiryScan({ schoolId: b.sid, localDate: D });
    expect(await alertsOf(b.sid)).toHaveLength(1);
    // B's scan never resolved A's alert.
    expect(live(await alertsOf(a.sid))).toHaveLength(1);
    const seen = await withTenant({ schoolId: null, actorId: null, role: 'system' }, (tx) => tx.many('select id from alerts'), { readOnly: true });
    expect(seen).toEqual([]);
  });
});

describe('maintenance-due-scan', () => {
  it('raises due-soon by date and km, overdue supersedes, a newer service resolves; repeated scans dedupe', async () => {
    const w = await quietSchool();
    await ownerQuery(`update buses set last_known_odometer = 44700 where id = $1`, [w.bus.id]);
    const oil = await f.maintenanceLog(w.sid, w.bus.id, { service_type: 'Oil change', service_date: day(-60), next_due_date: null, next_due_km: 45000 });
    const brakes = await f.maintenanceLog(w.sid, w.bus.id, { service_type: 'Brake check', service_date: day(-80), next_due_date: day(5) });
    const tyres = await f.maintenanceLog(w.sid, w.bus.id, { service_type: 'Tyre rotation', service_date: day(-90), next_due_date: day(-2) });
    await f.maintenanceLog(w.sid, w.bus.id, { service_type: 'Wash', service_date: day(-1), next_due_date: day(30) }); // not due yet
    await f.maintenanceLog(w.sid, w.bus.id, { service_type: 'Paint', service_date: day(-9), next_due_date: day(-1), deleted_at: new Date().toISOString() });
    // An older AC service is superseded by a newer one without a due date.
    await f.maintenanceLog(w.sid, w.bus.id, { service_type: 'AC service', service_date: day(-200), next_due_date: day(-100) });
    await f.maintenanceLog(w.sid, w.bus.id, { service_type: 'ac service ', service_date: day(-10), next_due_date: null });
    const retired = await f.bus(w.sid, { code: 'R9', status: 'retired' });
    await f.maintenanceLog(w.sid, retired.id, { service_type: 'Oil change', next_due_date: day(-5) });

    expect(await maintenanceDueScan({ schoolId: w.sid, localDate: D })).toMatchObject({ raised: 3 });
    let rows = await alertsOf(w.sid, ['service_due']);
    const byLog = (id: string) => rows.filter((r) => r.entity_id === id && r.status !== 'closed');
    expect(byLog(oil.id)).toEqual([
      expect.objectContaining({ severity: 'warning', dedupe_key: `service_due:${oil.id}:due_soon`, entity_type: 'maintenance_log', bus_id: w.bus.id, title: 'Oil change for bus R1 is due at 45,000 km (bus at 44,700 km)' }),
    ]);
    expect(byLog(oil.id)[0]!.details).toMatchObject({ reason: 'km', stage: 'due_soon', kmToDue: 300, nextDueKm: 45000, odometer: 44700 });
    expect(byLog(brakes.id)).toEqual([expect.objectContaining({ severity: 'warning', title: `Brake check for bus R1 is due in 5 days (${day(5)})` })]);
    expect(byLog(tyres.id)).toEqual([expect.objectContaining({ severity: 'critical', dedupe_key: `service_due:${tyres.id}:overdue`, title: `Tyre rotation for bus R1 is overdue (was due on ${day(-2)})` })]);

    expect(await maintenanceDueScan({ schoolId: w.sid, localDate: D })).toMatchObject({ raised: 0, resolved: 0 });
    expect(await alertsOf(w.sid, ['service_due'])).toHaveLength(3);

    // The odometer passes the due km → overdue replaces due-soon.
    await ownerQuery(`update buses set last_known_odometer = 45100 where id = $1`, [w.bus.id]);
    expect(await maintenanceDueScan({ schoolId: w.sid, localDate: D })).toMatchObject({ raised: 1, closed: 1 });
    rows = await alertsOf(w.sid, ['service_due']);
    expect(byLog(oil.id)).toEqual([expect.objectContaining({ severity: 'critical', dedupe_key: `service_due:${oil.id}:overdue` })]);
    expect(rows.find((r) => r.dedupe_key === `service_due:${oil.id}:due_soon`)).toMatchObject({ status: 'closed', review_note: 'Superseded: the service is now overdue.' });

    // The oil change is done: a newer log of the same type resolves the overdue alert.
    await f.maintenanceLog(w.sid, w.bus.id, { service_type: 'Oil Change', service_date: D, odometer: 45100, next_due_date: null, next_due_km: 55000 });
    expect(await maintenanceDueScan({ schoolId: w.sid, localDate: D })).toMatchObject({ raised: 0, closed: 1 });
    rows = await alertsOf(w.sid, ['service_due']);
    expect(byLog(oil.id)).toEqual([]);
    expect(live(rows)).toHaveLength(2);
  });
});
