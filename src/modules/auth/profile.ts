// GET /auth/me profiles (contract §6): role-specific, built in the caller's own context.
//   super_admin            → platform account (+ TOTP state)
//   school_admin / staff   → account + school branding (name, code, logo URL, colour, timezone,
//                            privacy policy / terms links); staff also get their staff profile id
//                            and the bound device
//   parent                 → account + children index grouped by school (BP §4.6, §15.2) with each
//                            school's legal links and consent state; consentRequired when any
//                            school needs (re-)consent (BP §16, privacy module)
import type { Request } from 'express';
import { withPlatform, withTenant } from '../../db/tenant.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { notFound, unauthenticated } from '../../shared/errors.js';
import { optionalSignedUrl } from '../files/urls.js';
import { schoolConsentState, type SchoolConsentState } from '../privacy/index.js';
import * as repo from './repository.js';

interface SchoolBrandRow {
  school_id: string;
  code: string;
  name: string;
  institution_type: string;
  brand_color: string | null;
  timezone: string;
  city: string | null;
  state: string | null;
  latitude: number | null;
  longitude: number | null;
  status: string;
  logo_key: string | null;
  privacy_url: string | null;
  terms_url: string | null;
}

async function schoolDto(req: Request, r: SchoolBrandRow) {
  return {
    id: r.school_id,
    code: r.code,
    name: r.name,
    institutionType: r.institution_type,
    brandColor: r.brand_color,
    timezone: r.timezone,
    city: r.city,
    state: r.state,
    location: r.latitude !== null && r.longitude !== null ? { lat: r.latitude, lng: r.longitude } : null,
    status: r.status,
    logoUrl: await optionalSignedUrl(req, r.logo_key),
    privacyUrl: r.privacy_url,
    termsUrl: r.terms_url,
  };
}

const SCHOOL_COLUMNS = `s.id as school_id, s.code, s.name, s.institution_type, s.brand_color, s.timezone, s.city, s.state,
  s.latitude, s.longitude, s.status, lf.key as logo_key, lt.privacy_url, lt.terms_url`;
// Logo file + effective legal links (school override or platform value, migration 901).
const LOGO_JOIN = "left join files lf on lf.school_id = s.id and lf.id = s.logo_file_id and lf.status = 'uploaded' cross join lateral school_legal_terms(s.id) lt";

async function superAdminProfile(auth: AuthContext) {
  const row = await withPlatform(
    { actorId: auth.actorId },
    (tx) =>
      tx.maybeOne<{ id: string; email: string; name: string; totp_enabled: boolean; last_login_at: string | null; must_change_password: boolean }>(
        'select id, email, name, totp_enabled, last_login_at, must_change_password from platform_users where id = $1',
        [auth.actorId],
      ),
    { readOnly: true },
  );
  if (!row) throw unauthenticated();
  return { id: row.id, role: 'super_admin' as const, name: row.name, email: row.email, totpEnabled: row.totp_enabled, mustChangePassword: row.must_change_password, lastLoginAt: row.last_login_at };
}

interface SchoolUserRow extends SchoolBrandRow {
  id: string;
  role: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  username: string | null;
  must_change_password: boolean;
  last_login_at: string | null;
  staff_id: string | null;
  staff_type: string | null;
  photo_file_id: string | null;
  device_id: string | null;
  device_platform: string | null;
  device_model: string | null;
  device_app_version: string | null;
}

async function schoolUserProfile(req: Request, auth: AuthContext) {
  const row = await withTenant(
    { schoolId: auth.schoolId, actorId: auth.actorId, role: auth.role },
    (tx) =>
      tx.maybeOne<SchoolUserRow>(
        `select u.id, u.role, u.full_name, u.email, u.phone, u.username, u.must_change_password, u.last_login_at, ${SCHOOL_COLUMNS},
                sp.id as staff_id, sp.staff_type, sp.photo_file_id,
                d.id as device_id, d.platform as device_platform, d.device_model, d.app_version as device_app_version
           from users u
           join schools s on s.id = u.school_id
           ${LOGO_JOIN}
           left join staff_profiles sp on sp.school_id = u.school_id and sp.user_id = u.id and sp.deleted_at is null
           left join devices d on d.school_id = u.school_id and d.id = $2::uuid
          where u.id = $1`,
        [auth.actorId, auth.deviceId],
      ),
    { readOnly: true },
  );
  if (!row) throw notFound();
  return {
    id: row.id,
    role: row.role,
    name: row.full_name,
    email: row.email,
    phone: row.phone,
    username: row.username,
    mustChangePassword: row.must_change_password,
    lastLoginAt: row.last_login_at,
    school: await schoolDto(req, row),
    ...(row.role === 'school_admin'
      ? {}
      : {
          staffProfile: row.staff_id ? { id: row.staff_id, staffType: row.staff_type, photoFileId: row.photo_file_id } : null,
          device: row.device_id ? { id: row.device_id, platform: row.device_platform, model: row.device_model, appVersion: row.device_app_version } : null,
        }),
  };
}

interface ChildRow {
  id: string;
  full_name: string;
  class_name: string | null;
  section: string | null;
  photo_file_id: string | null;
}

async function parentProfile(req: Request, auth: AuthContext) {
  const parentCtx = { schoolId: null, actorId: auth.actorId, role: 'parent' as const };
  const account = await withTenant(
    parentCtx,
    (tx) =>
      tx.maybeOne<{ id: string; phone: string; display_name: string | null; preferred_language: string; has_password: boolean }>(
        'select id, phone, display_name, preferred_language, parent_self_password_hash() is not null as has_password from parent_accounts where id = $1',
        [auth.actorId],
      ),
    { readOnly: true },
  );
  if (!account) throw unauthenticated();
  const links = await repo.parentChildren(auth.actorId);
  const bySchool = new Map<string, string[]>();
  for (const l of links) bySchool.set(l.school_id, [...(bySchool.get(l.school_id) ?? []), l.student_id]);
  const schools = await Promise.all(
    [...bySchool.entries()].map(async ([schoolId, studentIds]) => {
      const data = await withTenant(
        { schoolId, actorId: auth.actorId, role: 'parent' },
        async (tx) => {
          const school = await tx.maybeOne<SchoolBrandRow>(`select ${SCHOOL_COLUMNS} from schools s ${LOGO_JOIN} where s.id = $1`, [schoolId]);
          const active = school?.status === 'active';
          const children = active
            ? await tx.many<ChildRow>('select id, full_name, class_name, section, photo_file_id from students where id = any ($1::uuid[]) order by full_name, id', [studentIds])
            : [];
          const consent: SchoolConsentState | null = active ? await schoolConsentState(tx, auth.actorId, schoolId) : null;
          return { school, children, consent };
        },
        { readOnly: true },
      );
      if (!data.school) return null;
      const c = data.consent;
      return {
        school: await schoolDto(req, data.school),
        children: data.children.map((ch) => ({ id: ch.id, fullName: ch.full_name, className: ch.class_name, section: ch.section, photoFileId: ch.photo_file_id })),
        consent: c ? { requiredVersion: c.requiredVersion, acceptedVersion: c.acceptedVersion, acceptedAt: c.acceptedAt, consentRequired: c.consentRequired } : null,
      };
    }),
  );
  const visible = schools.filter((s): s is NonNullable<typeof s> => s !== null).sort((a, b) => a.school.name.localeCompare(b.school.name));
  return {
    id: account.id,
    role: 'parent' as const,
    name: account.display_name,
    phone: account.phone,
    preferredLanguage: account.preferred_language,
    hasPassword: account.has_password,
    /** true when at least one school needs (re-)consent: show the consent screen (POST /parent/consent). */
    consentRequired: visible.some((v) => v.consent?.consentRequired === true),
    schools: visible,
  };
}

/** Profile of the authenticated principal. */
export async function buildProfile(req: Request, auth: AuthContext) {
  if (auth.role === 'super_admin') return superAdminProfile(auth);
  if (auth.role === 'parent') return parentProfile(req, auth);
  return schoolUserProfile(req, auth);
}

export type Profile = Awaited<ReturnType<typeof buildProfile>>;
