// Schools (tenants) for the Super Admin (BP §8.2, §13.2, App. A). Every transaction runs in the
// platform context (withPlatform: actor_role = super_admin, no school) — the Super Admin sees the
// schools registry, subscriptions, a school's admin accounts and counts, never school data.
import { DEFAULT_SUBSCRIPTION } from '@wimb/shared';
import type { Request, Response } from 'express';
import { getPool, isPgError, PG_ERROR } from '../../db/pool.js';
import { withPlatform, withTenant, type Tx } from '../../db/tenant.js';
import { audit, changedFields } from '../../shared/audit.js';
import { createCsvWriter, type CsvColumn } from '../../shared/csv.js';
import { list as sendList } from '../../shared/envelope.js';
import { duplicate, invalidState, notFound, unauthenticated, validationError } from '../../shared/errors.js';
import { events } from '../../shared/events.js';
import { listMeta, parsePagination, parseSort } from '../../shared/pagination.js';
import { optionalSignedUrl } from '../files/urls.js';
import { issuePassword, sendWelcomeEmail } from './credentials.js';
import { toAdminDto, toSchoolDto, toSchoolListDto, toSubscriptionDto, toUsageDto, type SchoolDto, type SchoolListDto } from './dto.js';
import * as repo from './repository.js';
import type { CreateSchool, SchoolListQuery, UpdateSchool } from './schemas.js';
import * as scope from './schoolScope.js';

const SORT = {
  allowed: { name: 's.name', code: 's.code', city: 's.city', state: 's.state', status: 's.status', createdAt: 's.created_at', updatedAt: 's.updated_at' },
  defaultSort: 'name',
  tiebreaker: 's.id',
};

export function actorOf(req: Request): string {
  if (!req.auth) throw unauthenticated();
  return req.auth.actorId;
}

/** Runs fn in the platform context of the requesting super admin. */
export function platformTx<T>(req: Request, fn: (tx: Tx) => Promise<T>, opts: { readOnly?: boolean } = {}): Promise<T> {
  return withPlatform({ actorId: actorOf(req) }, fn, { readOnly: opts.readOnly ?? (req.method === 'GET' || req.method === 'HEAD') });
}

/** A live (not soft-deleted) school, locked for update by default → else NOT_FOUND / INVALID_STATE. */
export async function lockLiveSchool(tx: Tx, id: string, { lock = true }: { lock?: boolean } = {}): Promise<repo.SchoolRow> {
  const school = await repo.findSchool(tx, id, { lock });
  if (!school) throw notFound('School not found.');
  if (school.deleted_at) throw invalidState('The school has been deleted.', { reason: 'SCHOOL_DELETED' });
  return school;
}

/** Maps unique violations of school codes / admin e-mails to field errors. */
export function mapUniqueViolation(err: unknown): never {
  if (isPgError(err, PG_ERROR.UNIQUE_VIOLATION)) {
    if (err.constraint === 'schools_code_uq') throw duplicate('A school with this code already exists.', [{ path: 'code', message: 'Already in use' }]);
    if (err.constraint === 'users_admin_email_uq') throw duplicate('A school admin with this e-mail already exists.', [{ path: 'admin.email', message: 'Already in use' }]);
  }
  throw err;
}

/** Dedicated tenants need a registered database pool (BP §4.7); otherwise every request would 503. */
function assertTenantMode(mode: string | undefined, ref: string | null | undefined): void {
  if (mode !== 'dedicated') return;
  if (!ref) throw invalidState('A dedicated school needs a database reference.', [{ path: 'dbConnectionRef', message: 'Required for dedicated tenants' }]);
  try {
    getPool({ tenantMode: 'dedicated', dbConnectionRef: ref });
  } catch {
    throw invalidState('No dedicated database is registered under this reference.', [{ path: 'dbConnectionRef', message: 'Unknown database reference' }]);
  }
}

function filterOf(q: SchoolListQuery): repo.SchoolFilter {
  return { q: q.q, statuses: q.status, institutionTypes: q.institutionType, includeDeleted: q.includeDeleted ?? false };
}

const CSV_COLUMNS: CsvColumn<SchoolListDto>[] = [
  { header: 'Code', key: 'code' },
  { header: 'Name', key: 'name' },
  { header: 'Type', key: 'institutionType' },
  { header: 'Status', key: 'status' },
  { header: 'City', key: 'city' },
  { header: 'State', key: 'state' },
  { header: 'Contact', value: (s) => s.contact.name },
  { header: 'Contact phone', value: (s) => s.contact.phone },
  { header: 'Contact e-mail', value: (s) => s.contact.email },
  { header: 'Plan', value: (s) => s.subscription?.plan ?? '' },
  { header: 'Valid until', value: (s) => s.subscription?.validUntil ?? '' },
  { header: 'Max buses', value: (s) => s.subscription?.maxBuses ?? '' },
  { header: 'Max students', value: (s) => s.subscription?.maxStudents ?? '' },
  { header: 'Timezone', key: 'timezone' },
  { header: 'Tenant mode', key: 'tenantMode' },
  { header: 'Deleted at', key: 'deletedAt' },
  { header: 'Created at', key: 'createdAt' },
];

/** GET /platform/schools — search, status/type filters, pagination, CSV. */
export async function listSchools(req: Request, res: Response, q: SchoolListQuery): Promise<void> {
  const { orderBy } = parseSort(q.sort, SORT);
  const filter = filterOf(q);
  if (q.format === 'csv') {
    const rows = await platformTx(req, (tx) => repo.exportSchools(tx, filter, orderBy));
    const csv = createCsvWriter<SchoolListDto>(res, { fileName: 'schools.csv', columns: CSV_COLUMNS });
    await csv.writeAll(rows.map(toSchoolListDto));
    await csv.end();
    return;
  }
  const { page, limit, offset } = parsePagination(q);
  const { rows, total } = await platformTx(req, (tx) => repo.pageSchools(tx, filter, { orderBy, limit, offset }));
  sendList(res, rows.map((r) => toSchoolListDto(r as repo.SchoolListRow)), listMeta({ page, limit, total }));
}

/** Signed URLs of the school logo (read inside the school's own context, where files live). */
export async function logoUrls(req: Request, school: Pick<repo.SchoolRow, 'id' | 'logo_file_id'>): Promise<{ url: string | null; thumbnailUrl: string | null }> {
  if (!school.logo_file_id) return { url: null, thumbnailUrl: null };
  const fileId = school.logo_file_id;
  const file = await withTenant({ schoolId: school.id, actorId: actorOf(req), role: 'system' }, (tx) => scope.logoFile(tx, fileId), { readOnly: true });
  if (!file || file.status !== 'uploaded') return { url: null, thumbnailUrl: null };
  return { url: await optionalSignedUrl(req, file.key), thumbnailUrl: await optionalSignedUrl(req, file.thumb_key) };
}

/** GET /platform/schools/:id — profile, admins, current subscription and usage counts. */
export async function getSchool(req: Request, id: string) {
  const detail = await platformTx(req, async (tx) => {
    const school = await repo.findSchool(tx, id);
    if (!school) throw notFound('School not found.');
    const admins = await repo.schoolAdmins(tx, id);
    const subscription = await repo.currentSubscription(tx, id);
    const usage = await repo.usageCounts(tx, id);
    return { school, admins, subscription, usage };
  });
  const logo = await logoUrls(req, detail.school);
  return {
    ...toSchoolDto(detail.school),
    logoUrl: logo.url,
    logoThumbnailUrl: logo.thumbnailUrl,
    admins: detail.admins.map(toAdminDto),
    subscription: detail.subscription ? toSubscriptionDto(detail.subscription) : null,
    usage: toUsageDto(detail.usage),
  };
}

/** API body → school columns (location → latitude/longitude; null clears both). */
function writableOf(b: Partial<CreateSchool> | UpdateSchool): repo.SchoolWritable {
  const v: repo.SchoolWritable = {
    code: b.code,
    name: b.name,
    institutionType: b.institutionType,
    address: b.address,
    city: b.city,
    state: b.state,
    pincode: b.pincode,
    brandColor: b.brandColor,
    geofenceRadiusM: b.geofenceRadiusM,
    timezone: b.timezone,
    tenantMode: b.tenantMode,
    dbConnectionRef: b.dbConnectionRef,
  };
  if (b.contact) {
    v.contactName = b.contact.name;
    v.contactPhone = b.contact.phone;
    v.contactEmail = b.contact.email;
  }
  if (b.location !== undefined) {
    v.latitude = b.location?.lat ?? null;
    v.longitude = b.location?.lng ?? null;
  }
  return v;
}

function auditSchool(s: SchoolDto) {
  const { createdAt: _c, updatedAt: _u, createdBy: _b, ...rest } = s;
  return rest;
}

/**
 * POST /platform/schools — ONE transaction (BP App. A): school (+ school_settings defaults via the
 * schools_create_settings trigger) → initial school admin (platform_create_school_admin, forced
 * password change) → subscription (given or plan defaults) → platform audit. The welcome e-mail is
 * sent after commit; a failure there never undoes the school.
 */
export async function createSchool(req: Request, body: CreateSchool) {
  assertTenantMode(body.tenantMode, body.dbConnectionRef);
  const credential = await issuePassword(body.admin.password, ['admin', 'password']);
  const sub = body.subscription ?? { ...DEFAULT_SUBSCRIPTION, status: 'active' as const, validFrom: undefined, notes: null };
  let created: { school: repo.SchoolRow; adminId: string; subscription: repo.SubscriptionRow };
  try {
    created = await platformTx(req, async (tx) => {
      const school = await repo.insertSchool(tx, writableOf(body));
      const adminId = await repo.createSchoolAdmin(tx, { schoolId: school.id, name: body.admin.name, email: body.admin.email, passwordHash: credential.hash, phone: body.admin.phone ?? null });
      const subscription = await repo.insertSubscription(tx, school.id, {
        plan: sub.plan,
        status: sub.status,
        maxBuses: sub.maxBuses,
        maxStudents: sub.maxStudents,
        modules: sub.modules,
        validFrom: sub.validFrom ?? null,
        validUntil: sub.validUntil,
        notes: sub.notes ?? null,
      });
      await audit.log(tx, {
        action: 'school.create',
        entityType: 'school',
        entityId: school.id,
        new: {
          ...auditSchool(toSchoolDto(school)),
          admin: { id: adminId, name: body.admin.name, email: body.admin.email, passwordDelivery: body.admin.delivery, passwordGenerated: credential.generated },
          subscription: toSubscriptionDto(subscription),
        },
      });
      return { school, adminId, subscription };
    });
  } catch (err) {
    mapUniqueViolation(err);
  }
  const emailPassword = body.admin.delivery === 'email' ? credential.password : null;
  const emailDelivered = await sendWelcomeEmail({ to: body.admin.email, adminName: body.admin.name, schoolName: created.school.name, schoolCode: created.school.code, password: emailPassword });
  // The temporary password is returned once: when generated for 'show', or when the invitation
  // e-mail could not be delivered (so it is never lost). Never logged or audited.
  const reveal = (body.admin.delivery === 'show' && credential.generated) || (body.admin.delivery === 'email' && !emailDelivered);
  return {
    school: { ...toSchoolDto(created.school), logoUrl: null, logoThumbnailUrl: null },
    admin: { id: created.adminId, name: body.admin.name, email: body.admin.email, phone: body.admin.phone ?? null, mustChangePassword: true },
    subscription: toSubscriptionDto(created.subscription),
    credentials: { delivery: body.admin.delivery, passwordGenerated: credential.generated, emailDelivered, ...(reveal ? { temporaryPassword: credential.password } : {}) },
  };
}

/** PATCH /platform/schools/:id — profile, location, timezone, institution type, code, tenant mode. */
export async function updateSchool(req: Request, id: string, body: UpdateSchool) {
  let result: { before: repo.SchoolRow; after: repo.SchoolRow };
  try {
    result = await platformTx(req, async (tx) => {
      const before = await lockLiveSchool(tx, id);
      const values = writableOf(body);
      if (Object.values(values).every((v) => v === undefined)) throw validationError('Nothing to update.', [{ path: '', message: 'Nothing to update' }]);
      const mode = body.tenantMode ?? before.tenant_mode;
      const ref = body.dbConnectionRef !== undefined ? body.dbConnectionRef : before.db_connection_ref;
      if (body.tenantMode !== undefined || body.dbConnectionRef !== undefined) assertTenantMode(mode, ref);
      const after = await repo.updateSchool(tx, id, values);
      const diff = changedFields(auditSchool(toSchoolDto(before)), auditSchool(toSchoolDto(after)));
      if (Object.keys(diff.new).length) await audit.log(tx, { action: 'school.update', entityType: 'school', entityId: id, old: diff.old, new: diff.new });
      return { before, after };
    });
  } catch (err) {
    mapUniqueViolation(err);
  }
  const { before, after } = result;
  // Cached school state (timezone, tenant routing) is evicted everywhere that listens.
  if (before.timezone !== after.timezone || before.tenant_mode !== after.tenant_mode || before.db_connection_ref !== after.db_connection_ref || before.code !== after.code) {
    events.emit('school.status_changed', { schoolId: id, status: after.status });
  }
  // The campus location / geofence feeds tracking ("bus left school"): cached trip geometry is dropped.
  const moved = (['latitude', 'longitude', 'geofence_radius_m'] as const).filter((k) => String(before[k]) !== String(after[k]));
  if (moved.length) events.emit('school.profile_changed', { schoolId: id, changedFields: moved });
  const logo = await logoUrls(req, after);
  return { ...toSchoolDto(after), logoUrl: logo.url, logoThumbnailUrl: logo.thumbnailUrl };
}
