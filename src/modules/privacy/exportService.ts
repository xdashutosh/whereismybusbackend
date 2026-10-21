// Per-person data export for school admins (BP §16 "deletion/export on request", DPDP right of
// access; format documented in docs/api/privacy.md). One JSON document per student or parent with
// everything THIS school holds about them: profile, parent/child links, bus assignments (history),
// notification preferences, in-app inbox, notification events, consent records and the school trips
// (with the stop event at the child's stop) of the buses the child was assigned to. Runs in the
// school admin's tenant context (RLS: another school's ids are 404) and is audited
// (`privacy.export`, counts only — no personal data in the audit row).
//   * The global parent account id never leaves the server: parents are identified by the school's
//     own parent id (school_parents.id), like everywhere else in the API.
//   * Raw GPS points are positions of the BUS, not of the child; they are summarised by the trip rows
//     and not exported. Files are listed with their metadata (download through GET /files/:id/url).
import { PRIVACY_EXPORT_FORMAT, PRIVACY_EXPORT_FORMAT_VERSION, type PrivacySubjectType } from '@wimb/shared';
import type { Request } from 'express';
import type { Tx } from '../../db/tenant.js';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { audit } from '../../shared/audit.js';
import { notFound } from '../../shared/errors.js';
import { schoolConsentState } from './consent.js';
import * as repo from './repository.js';

/** Trip rows exported per document (newest first); `trips.truncated` says when more exist. */
export const EXPORT_TRIP_LIMIT = 5000;

const NOTES = Object.freeze([
  'Times are ISO-8601 instants in UTC; dates (tripDate, validFrom, validTo) are school-local calendar dates; validTo is exclusive.',
  'Parents are identified by this school\'s parent id; ids of other schools never appear.',
  'Raw GPS points describe the bus, not the child, and are summarised by the trip rows (stop arrival and departure at the child\'s stop).',
  'Files are listed with their metadata; their content can be downloaded by a school admin through GET /api/v1/files/:id/url.',
  'The school\'s audit log keeps a record of past changes; it is not part of this export.',
]);

const fileDto = (f: repo.FileRow) => ({ id: f.id, category: f.category, mime: f.mime, sizeBytes: f.size_bytes, originalName: f.original_name, status: f.status, createdAt: f.created_at });
const assignmentDto = (a: repo.AssignmentRow) => ({
  id: a.id,
  studentId: a.student_id,
  direction: a.trip_direction,
  validFrom: a.valid_from,
  validTo: a.valid_to,
  bus: { id: a.bus_id, code: a.bus_code, registrationNo: a.bus_registration },
  route: { code: a.route_code, name: a.route_name },
  stop: { id: a.stop_id, name: a.stop_name },
  createdAt: a.created_at,
});
const tripDto = (t: repo.TripRow) => ({
  studentId: t.student_id,
  tripId: t.trip_id,
  tripDate: t.trip_date,
  direction: t.direction,
  status: t.status,
  busCode: t.bus_code,
  route: { code: t.route_code, name: t.route_name },
  plannedStartAt: t.planned_start_at,
  startedAt: t.started_at,
  endedAt: t.ended_at,
  stopEvent: { stopName: t.stop_name, arrivedAt: t.arrived_at, departedAt: t.departed_at, dwellSeconds: t.dwell_s },
});
const preferenceDto = (p: repo.PreferenceRow) => ({
  parentId: p.parent_id,
  studentId: p.student_id,
  direction: p.direction,
  tripStarted: p.trip_started,
  busLeftSchool: p.bus_left_school,
  approachingStop: p.approaching_stop,
  arrivedAtStop: p.arrived_at_stop,
  tripDelayed: p.trip_delayed,
  tripNotStarted: p.trip_not_started,
  updatedAt: p.updated_at,
});
const inboxDto = (n: repo.InboxRow) => ({ id: n.id, parentId: n.parent_id, studentId: n.student_id, tripId: n.trip_id, kind: n.kind, title: n.title, body: n.body, createdAt: n.created_at, readAt: n.read_at });
const consentDto = (c: repo.ConsentRecordRow, { network }: { network: boolean }) => ({
  parentId: c.parent_id,
  version: c.version,
  acceptedAt: c.accepted_at,
  privacyUrl: c.privacy_url,
  termsUrl: c.terms_url,
  appName: c.app_name,
  appVersion: c.app_version,
  ...(network ? { ip: c.ip, userAgent: c.user_agent, redactedAt: c.redacted_at } : {}),
});

async function tripsSection(tx: Tx, studentIds: readonly string[]) {
  const rows = await repo.tripsOf(tx, studentIds, EXPORT_TRIP_LIMIT);
  const total = rows[0]?.total ?? 0;
  return { total, truncated: total > rows.length, items: rows.map(tripDto) };
}

async function envelope(tx: Tx, type: PrivacySubjectType, id: string, data: Record<string, unknown>) {
  const school = await repo.schoolOfContext(tx, tx.ctx.schoolId!);
  return {
    format: PRIVACY_EXPORT_FORMAT,
    formatVersion: PRIVACY_EXPORT_FORMAT_VERSION,
    generatedAt: new Date().toISOString(),
    school: school ? { id: school.id, code: school.code, name: school.name } : null,
    subject: { type, id },
    data,
    notes: NOTES,
  };
}

const counts = (data: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, Array.isArray(v) ? v.length : v && typeof v === 'object' && 'total' in v ? (v as { total: number }).total : v ? 1 : 0]),
  );

/** GET /school/privacy/students/:id/export */
export function exportStudent(req: Request, id: string) {
  return withRequestTenant(
    req,
    async (tx) => {
      const s = await repo.findStudent(tx, id);
      if (!s) throw notFound('Student not found.');
      const links = await repo.linksOfStudent(tx, id);
      // One connection per transaction: queries run one after another.
      const files = await repo.studentFiles(tx, id, s.photo_file_id);
      const assignments = await repo.assignmentsOf(tx, [id]);
      const preferences = await repo.preferencesOfStudent(tx, id);
      const inbox = await repo.inboxOfStudent(tx, id);
      const events = await repo.notificationEventsOfStudent(tx, id);
      const consents = await repo.consentsOf(tx, links.map((l) => l.parent_account_id));
      const trips = await tripsSection(tx, [id]);
      const data = {
        profile: {
          id: s.id,
          admissionNo: s.admission_no,
          fullName: s.full_name,
          className: s.class_name,
          section: s.section,
          rollNo: s.roll_no,
          notes: s.notes,
          photoFileId: s.photo_file_id,
          isActive: s.is_active,
          deletedAt: s.deleted_at,
          erasedAt: s.erased_at,
          createdAt: s.created_at,
          updatedAt: s.updated_at,
        },
        files: files.map(fileDto),
        parents: links.map((l) => ({ parentId: l.parent_id, fullName: l.full_name, phone: l.phone, email: l.email, relation: l.relation, isPrimary: l.is_primary, linkedAt: l.linked_at })),
        assignments: assignments.map(assignmentDto),
        notificationPreferences: preferences.map(preferenceDto),
        inbox: inbox.map(inboxDto),
        notificationEvents: events.map((e) => ({ id: e.id, tripId: e.trip_id, eventType: e.event_type, channel: e.channel, status: e.status, createdAt: e.created_at, sentAt: e.sent_at })),
        consentRecords: consents.map((c) => consentDto(c, { network: false })),
        trips,
      };
      await audit.log(tx, { action: 'privacy.export', entityType: 'student', entityId: id, new: { sections: counts(data) } });
      return envelope(tx, 'student', id, data);
    },
    { readOnly: false },
  );
}

/** GET /school/privacy/parents/:id/export (`id` = the school's parent id). */
export function exportParent(req: Request, id: string) {
  return withRequestTenant(
    req,
    async (tx) => {
      const p = await repo.findParent(tx, id);
      if (!p) throw notFound('Parent not found.');
      const children = await repo.childrenOfParent(tx, p.parent_account_id);
      const childIds = children.map((c) => c.id);
      const assignments = await repo.assignmentsOf(tx, childIds);
      const preferences = await repo.preferencesOfParent(tx, p.parent_account_id);
      const inbox = await repo.inboxOfParent(tx, p.parent_account_id);
      const consents = await repo.consentsOf(tx, [p.parent_account_id]);
      const trips = await tripsSection(tx, childIds);
      const consent = await schoolConsentState(tx, p.parent_account_id, tx.ctx.schoolId!);
      const data = {
        profile: {
          id: p.id,
          fullName: p.full_name,
          phone: p.phone,
          email: p.email,
          relation: p.relation,
          alternatePhone: p.alternate_phone,
          displayName: p.display_name,
          preferredLanguage: p.preferred_language,
          isActive: p.is_active,
          firstSignedInAt: p.first_signed_in_at,
          deletedAt: p.deleted_at,
          erasedAt: p.erased_at,
          createdAt: p.created_at,
          updatedAt: p.updated_at,
        },
        children: children.map((c) => ({ studentId: c.id, admissionNo: c.admission_no, fullName: c.full_name, className: c.class_name, section: c.section, relation: c.relation, isPrimary: c.is_primary, linkedAt: c.linked_at })),
        assignments: assignments.map(assignmentDto),
        notificationPreferences: preferences.map(preferenceDto),
        inbox: inbox.map(inboxDto),
        consent: { requiredVersion: consent.requiredVersion, acceptedVersion: consent.acceptedVersion, acceptedAt: consent.acceptedAt, consentRequired: consent.consentRequired },
        consentRecords: consents.map((c) => consentDto(c, { network: true })),
        trips,
      };
      await audit.log(tx, { action: 'privacy.export', entityType: 'parent', entityId: id, new: { sections: counts(data) } });
      return envelope(tx, 'parent', id, data);
    },
    { readOnly: false },
  );
}
