// SQL of the privacy module (BP §16; migration 901). Pre-authentication lookups (public branding,
// platform legal links) call SECURITY DEFINER functions through definerQuery (one statement, no
// tenant). Everything else runs inside the caller's transaction, so RLS scopes it: school admins see
// and change only their own school's rows; parents only their own consent records.
import { definerQuery } from '../../db/definer.js';
import type { Tx } from '../../db/tenant.js';

const definer = <R extends Record<string, unknown>>(sql: string, params: unknown[]) => definerQuery<R>(sql, params, { unavailableMessage: 'This service is not available yet.' });

// ── legal links / branding ───────────────────────────────────────────────────
export interface LegalRow extends Record<string, unknown> {
  privacy_url: string | null;
  terms_url: string | null;
  consent_version: string;
}

/** Effective legal links of a school (null → platform values), pre-authentication. */
export async function legalTerms(schoolId: string | null): Promise<LegalRow> {
  const rows = await definer<LegalRow>('select privacy_url, terms_url, consent_version from school_legal_terms($1::uuid)', [schoolId]);
  return rows[0] ?? { privacy_url: null, terms_url: null, consent_version: '1' };
}

/** Same, inside a transaction (the function is SECURITY DEFINER: same answer in every context). */
export async function legalTermsTx(tx: Tx, schoolId: string): Promise<LegalRow> {
  return (await tx.maybeOne<LegalRow>('select privacy_url, terms_url, consent_version from school_legal_terms($1::uuid)', [schoolId])) ?? { privacy_url: null, terms_url: null, consent_version: '1' };
}

export interface BrandingRow extends Record<string, unknown> {
  code: string;
  name: string;
  institution_type: 'school' | 'college' | 'university';
  brand_color: string | null;
  logo_key: string | null;
  privacy_url: string | null;
  terms_url: string | null;
}

/** Branding of an ACTIVE, not deleted school by code (null otherwise). */
export async function brandingByCode(code: string): Promise<BrandingRow | null> {
  return (await definer<BrandingRow>('select code, name, institution_type, brand_color, logo_key, privacy_url, terms_url from public_school_branding($1)', [code]))[0] ?? null;
}

// ── consent ──────────────────────────────────────────────────────────────────
export interface ConsentRow extends Record<string, unknown> {
  id: string;
  version: string;
  accepted_at: string;
  privacy_url: string | null;
  terms_url: string | null;
}

/**
 * The parent's consent record for `requiredVersion` in the current school when there is one, else its
 * latest record (parent or admin context; null = never consented here).
 */
export function currentConsent(tx: Tx, parentAccountId: string, requiredVersion: string): Promise<{ version: string; accepted_at: string } | null> {
  return tx.maybeOne(
    'select version, accepted_at from parent_consents where parent_account_id = $1 order by (version = $2) desc, accepted_at desc, id desc limit 1',
    [parentAccountId, requiredVersion],
  );
}

/** The calling parent accepts `version` in its X-School-Id school (parent_accept_consent, idempotent). */
export function acceptConsent(tx: Tx, p: { version: string; appName: string | null; appVersion: string | null; ip: string | null; userAgent: string | null }): Promise<ConsentRow> {
  return tx.one<ConsentRow>('select id, version, accepted_at, privacy_url, terms_url from parent_accept_consent($1, $2, $3, $4::inet, $5)', [p.version, p.appName, p.appVersion, p.ip, p.userAgent]);
}

/** Name and status of the current school (own-school read). */
export function schoolOfContext(tx: Tx, schoolId: string): Promise<{ id: string; code: string; name: string; status: string; deleted_at: string | null } | null> {
  return tx.maybeOne('select id, code, name, status, deleted_at from schools where id = $1', [schoolId]);
}

// ── export: students ─────────────────────────────────────────────────────────
export interface StudentRow extends Record<string, unknown> {
  id: string;
  admission_no: string | null;
  full_name: string;
  class_name: string | null;
  section: string | null;
  roll_no: string | null;
  notes: string | null;
  photo_file_id: string | null;
  is_active: boolean;
  deleted_at: string | null;
  erased_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Any student of the school (also soft-deleted / erased ones). */
export function findStudent(tx: Tx, id: string, { lock = false } = {}): Promise<StudentRow | null> {
  return tx.maybeOne<StudentRow>(
    `select id, admission_no, full_name, class_name, section, roll_no, notes, photo_file_id, is_active, deleted_at, erased_at, created_at, updated_at
       from students where id = $1${lock ? ' for update' : ''}`,
    [id],
  );
}

export interface FileRow extends Record<string, unknown> {
  id: string;
  key: string;
  thumb_key: string | null;
  category: string;
  mime: string;
  size_bytes: number | null;
  original_name: string | null;
  status: string;
  created_at: string;
}

/** Files stored for a student (photo + anything filed under the student). */
export function studentFiles(tx: Tx, studentId: string, photoFileId: string | null, { lock = false } = {}): Promise<FileRow[]> {
  return tx.many<FileRow>(
    `select id, key, thumb_key, category, mime, size_bytes, original_name, status, created_at
       from files
      where ((entity_type = 'student' and entity_id = $1) or id = $2::uuid)
      order by created_at${lock ? ' for update' : ''}`,
    [studentId, photoFileId],
  );
}

export interface LinkRow extends Record<string, unknown> {
  parent_id: string;
  parent_account_id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  relation: string | null;
  is_primary: boolean;
  linked_at: string;
}

/** Parent links of a student with the school's parent record (per-school id) and phone. */
export function linksOfStudent(tx: Tx, studentId: string): Promise<LinkRow[]> {
  return tx.many<LinkRow>(
    `select sp.id as parent_id, l.parent_account_id, sp.full_name, pa.phone, sp.email, coalesce(l.relation, sp.relation) as relation, l.is_primary, l.created_at as linked_at
       from student_parents l
       join school_parents sp on sp.school_id = l.school_id and sp.parent_account_id = l.parent_account_id
       left join parent_accounts pa on pa.id = l.parent_account_id
      where l.student_id = $1
      order by l.is_primary desc, sp.full_name, sp.id`,
    [studentId],
  );
}

export interface AssignmentRow extends Record<string, unknown> {
  id: string;
  student_id: string;
  trip_direction: 'morning' | 'afternoon';
  bus_id: string;
  stop_id: string;
  valid_from: string;
  valid_to: string | null;
  bus_code: string | null;
  bus_registration: string | null;
  route_code: string | null;
  route_name: string | null;
  stop_name: string | null;
  created_at: string;
}

/** Every assignment row of the given students (history included), oldest first. */
export function assignmentsOf(tx: Tx, studentIds: readonly string[]): Promise<AssignmentRow[]> {
  if (!studentIds.length) return Promise.resolve([]);
  return tx.many<AssignmentRow>(
    `select sa.id, sa.student_id, sa.trip_direction, sa.bus_id, sa.stop_id, sa.valid_from, sa.valid_to,
            b.code as bus_code, b.registration_no as bus_registration, r.code as route_code, r.name as route_name, st.name as stop_name, sa.created_at
       from student_assignments sa
       left join buses b on b.id = sa.bus_id
       left join routes r on r.id = sa.route_id
       left join stops st on st.id = sa.stop_id
      where sa.student_id = any ($1::uuid[])
      order by sa.student_id, sa.valid_from, sa.trip_direction, sa.id`,
    [studentIds],
  );
}

export interface TripRow extends Record<string, unknown> {
  student_id: string;
  trip_id: string;
  trip_date: string;
  direction: string;
  status: string;
  bus_code: string | null;
  route_code: string | null;
  route_name: string | null;
  planned_start_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  stop_name: string | null;
  arrived_at: string | null;
  departed_at: string | null;
  dwell_s: number | null;
  total: number;
}

/**
 * School trips of the bus a student was assigned to, in the assignment's direction and validity window
 * (valid_to exclusive), with the stop event at the student's stop — newest first, at most `limit`
 * rows per call (`total` = all matching rows).
 */
export function tripsOf(tx: Tx, studentIds: readonly string[], limit: number): Promise<TripRow[]> {
  if (!studentIds.length) return Promise.resolve([]);
  return tx.many<TripRow>(
    `select sa.student_id, t.id as trip_id, t.trip_date, t.direction, t.status,
            coalesce(t.bus_code_snapshot, b.code) as bus_code, t.route_code_snapshot as route_code, t.route_name_snapshot as route_name,
            t.planned_start_at, t.started_at, t.ended_at, st.name as stop_name, e.arrived_at, e.departed_at, e.dwell_s,
            count(*) over ()::int as total
       from student_assignments sa
       join trips t on t.bus_id = sa.bus_id and t.direction = sa.trip_direction and t.trip_type = 'school'
                   and t.trip_date >= sa.valid_from and (sa.valid_to is null or t.trip_date < sa.valid_to)
       left join buses b on b.id = t.bus_id
       left join stops st on st.id = sa.stop_id
       left join trip_stop_events e on e.trip_id = t.id and e.stop_id = sa.stop_id
      where sa.student_id = any ($1::uuid[])
      order by t.trip_date desc, t.direction, sa.student_id, t.id
      limit $2`,
    [studentIds, limit],
  );
}

export interface PreferenceRow extends Record<string, unknown> {
  parent_id: string | null;
  student_id: string;
  direction: string;
  trip_started: boolean;
  bus_left_school: boolean;
  approaching_stop: boolean;
  arrived_at_stop: boolean;
  trip_delayed: boolean;
  trip_not_started: boolean;
  updated_at: string;
}

const PREF_COLUMNS = `sp.id as parent_id, np.student_id, np.direction, np.trip_started, np.bus_left_school, np.approaching_stop,
  np.arrived_at_stop, np.trip_delayed, np.trip_not_started, np.updated_at`;

export function preferencesOfStudent(tx: Tx, studentId: string): Promise<PreferenceRow[]> {
  return tx.many<PreferenceRow>(
    `select ${PREF_COLUMNS} from notification_preferences np
       left join school_parents sp on sp.school_id = np.school_id and sp.parent_account_id = np.parent_account_id
      where np.student_id = $1 order by sp.id, np.direction`,
    [studentId],
  );
}

export function preferencesOfParent(tx: Tx, parentAccountId: string): Promise<PreferenceRow[]> {
  return tx.many<PreferenceRow>(
    `select ${PREF_COLUMNS} from notification_preferences np
       left join school_parents sp on sp.school_id = np.school_id and sp.parent_account_id = np.parent_account_id
      where np.parent_account_id = $1 order by np.student_id, np.direction`,
    [parentAccountId],
  );
}

export interface InboxRow extends Record<string, unknown> {
  id: string;
  parent_id: string | null;
  student_id: string | null;
  trip_id: string | null;
  kind: string;
  title: string;
  body: string;
  created_at: string;
  read_at: string | null;
}

const INBOX_SELECT = `select pn.id, sp.id as parent_id, pn.student_id, pn.trip_id, pn.kind, pn.title, pn.body, pn.created_at, pn.read_at
  from parent_notifications pn
  left join school_parents sp on sp.school_id = pn.school_id and sp.parent_account_id = pn.parent_account_id`;

/** In-app inbox rows about a student (every linked parent's copy) in this school. */
export function inboxOfStudent(tx: Tx, studentId: string): Promise<InboxRow[]> {
  return tx.many<InboxRow>(`${INBOX_SELECT} where pn.student_id = $1 order by pn.created_at desc, pn.id`, [studentId]);
}

/** The parent's in-app inbox in this school. */
export function inboxOfParent(tx: Tx, parentAccountId: string): Promise<InboxRow[]> {
  return tx.many<InboxRow>(`${INBOX_SELECT} where pn.parent_account_id = $1 order by pn.created_at desc, pn.id`, [parentAccountId]);
}

export interface NotificationEventRow extends Record<string, unknown> {
  id: string;
  trip_id: string;
  event_type: string;
  channel: string;
  status: string;
  created_at: string;
  sent_at: string | null;
}

export function notificationEventsOfStudent(tx: Tx, studentId: string): Promise<NotificationEventRow[]> {
  return tx.many<NotificationEventRow>(
    'select id, trip_id, event_type, channel, status, created_at, sent_at from notification_events where student_id = $1 order by created_at desc, id',
    [studentId],
  );
}

export interface ConsentRecordRow extends Record<string, unknown> {
  parent_id: string | null;
  version: string;
  accepted_at: string;
  privacy_url: string | null;
  terms_url: string | null;
  app_name: string | null;
  app_version: string | null;
  ip: string | null;
  user_agent: string | null;
  redacted_at: string | null;
}

/** Consent records of the given parent accounts in this school. */
export function consentsOf(tx: Tx, parentAccountIds: readonly string[]): Promise<ConsentRecordRow[]> {
  if (!parentAccountIds.length) return Promise.resolve([]);
  return tx.many<ConsentRecordRow>(
    `select sp.id as parent_id, c.version, c.accepted_at, c.privacy_url, c.terms_url, c.app_name, c.app_version, host(c.ip) as ip, c.user_agent, c.redacted_at
       from parent_consents c
       left join school_parents sp on sp.school_id = c.school_id and sp.parent_account_id = c.parent_account_id
      where c.parent_account_id = any ($1::uuid[])
      order by c.accepted_at, c.id`,
    [parentAccountIds],
  );
}

// ── export: parents ──────────────────────────────────────────────────────────
export interface SchoolParentRow extends Record<string, unknown> {
  id: string;
  parent_account_id: string;
  full_name: string;
  email: string | null;
  relation: string | null;
  alternate_phone: string | null;
  is_active: boolean;
  first_signed_in_at: string | null;
  deleted_at: string | null;
  erased_at: string | null;
  created_at: string;
  updated_at: string;
  phone: string | null;
  display_name: string | null;
  preferred_language: string | null;
}

/** Any parent record of the school (also removed / erased ones) with the account fields a school may read. */
export function findParent(tx: Tx, id: string, { lock = false } = {}): Promise<SchoolParentRow | null> {
  return tx.maybeOne<SchoolParentRow>(
    `select sp.id, sp.parent_account_id, sp.full_name, sp.email, sp.relation, sp.alternate_phone, sp.is_active, sp.first_signed_in_at,
            sp.deleted_at, sp.erased_at, sp.created_at, sp.updated_at, pa.phone, pa.display_name, pa.preferred_language
       from school_parents sp
       left join parent_accounts pa on pa.id = sp.parent_account_id
      where sp.id = $1${lock ? ' for update of sp' : ''}`,
    [id],
  );
}

export interface ChildRow extends Record<string, unknown> {
  id: string;
  admission_no: string | null;
  full_name: string;
  class_name: string | null;
  section: string | null;
  relation: string | null;
  is_primary: boolean;
  linked_at: string;
}

export function childrenOfParent(tx: Tx, parentAccountId: string): Promise<ChildRow[]> {
  return tx.many<ChildRow>(
    `select s.id, s.admission_no, s.full_name, s.class_name, s.section, l.relation, l.is_primary, l.created_at as linked_at
       from student_parents l join students s on s.id = l.student_id
      where l.parent_account_id = $1
      order by s.full_name, s.id`,
    [parentAccountId],
  );
}

// ── erasure ──────────────────────────────────────────────────────────────────
export const ERASED_STUDENT_NAME = 'Erased student';
export const ERASED_PARENT_NAME = 'Erased parent';

/** Student-side erasure in one statement → counts. Assignments end today (history kept, pseudonymous). */
export function eraseStudentRows(tx: Tx, studentId: string): Promise<{ erased_at: string; links_removed: number; preferences_removed: number; assignments_ended: number; notifications_deleted: number; events_scrubbed: number }> {
  return tx.one(
    `with today as (select app_local_date() as d),
     prefs as (select 1 from notification_preferences where student_id = $1), -- removed with the links (on delete cascade)
     links as (delete from student_parents where student_id = $1 returning 1),
     ended as (
       update student_assignments sa set valid_to = greatest(sa.valid_from, (select d from today))
        where sa.student_id = $1 and (sa.valid_to is null or sa.valid_to > (select d from today)) returning 1),
     inbox as (delete from parent_notifications where student_id = $1 returning 1),
     ev as (update notification_events set payload = '{}'::jsonb, error = null where student_id = $1 returning 1),
     st as (
       update students
          set full_name = $2, admission_no = null, class_name = null, section = null, roll_no = null, notes = null,
              photo_file_id = null, is_active = false, deleted_at = coalesce(deleted_at, now()), erased_at = now(), updated_at = now()
        where id = $1 returning erased_at)
     select (select erased_at from st) as erased_at,
            (select count(*)::int from links) as links_removed, (select count(*)::int from prefs) as preferences_removed,
            (select count(*)::int from ended) as assignments_ended, (select count(*)::int from inbox) as notifications_deleted,
            (select count(*)::int from ev) as events_scrubbed`,
    [studentId, ERASED_STUDENT_NAME],
  );
}

/** Marks files deleted in the registry (objects are removed from storage after commit). */
export async function markFilesDeleted(tx: Tx, fileIds: readonly string[]): Promise<void> {
  if (!fileIds.length) return;
  await tx.query(`update files set status = 'deleted', original_name = null, metadata = '{}'::jsonb, updated_at = now() where id = any ($1::uuid[])`, [fileIds]);
}

/** School-side erasure of a parent record in one statement → counts. */
export function eraseParentRows(tx: Tx, id: string, parentAccountId: string): Promise<{ erased_at: string; links_removed: number; preferences_removed: number; notifications_deleted: number; consents_redacted: number }> {
  return tx.one(
    `with prefs as (select 1 from notification_preferences where parent_account_id = $2), -- removed with the links (cascade)
     links as (delete from student_parents where parent_account_id = $2 returning 1),
     inbox as (delete from parent_notifications where parent_account_id = $2 returning 1),
     sp as (
       update school_parents
          set full_name = $3, email = null, relation = null, alternate_phone = null, is_active = false, first_signed_in_at = null,
              deleted_at = coalesce(deleted_at, now()), erased_at = now(), updated_at = now()
        where id = $1 returning erased_at)
     select (select erased_at from sp) as erased_at, (select count(*)::int from links) as links_removed,
            (select count(*)::int from prefs) as preferences_removed, (select count(*)::int from inbox) as notifications_deleted,
            school_redact_parent_consents($2) as consents_redacted`,
    [id, parentAccountId, ERASED_PARENT_NAME],
  );
}

/** Global identity step (school_erase_parent_account, migration 901) — after eraseParentRows. */
export function eraseParentAccount(tx: Tx, parentAccountId: string): Promise<{ anonymised: boolean; revoked_session_ids: string[] }> {
  return tx.one('select anonymised, revoked_session_ids from school_erase_parent_account($1)', [parentAccountId]);
}
