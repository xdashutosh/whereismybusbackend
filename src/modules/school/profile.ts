// School profile (BP §8.3 GET/PATCH /school/profile, §13.3 Settings → School profile). The school
// edits its branding, contacts, address, map location/geofence and timezone; code, status,
// institution type and tenant hooks stay platform-controlled (also enforced by the
// schools_guard_platform_columns trigger). The logo is a `school_logo` file uploaded through
// POST /files/upload and linked here (schools.logo_file_id → /auth/me returns its logoUrl).
import type { SchoolProfileDto } from '@wimb/shared';
import type { Request } from 'express';
import { invalidateSchoolState, withRequestTenant } from '../../middleware/resolveTenant.js';
import { audit, changedFields } from '../../shared/audit.js';
import { assertFound, fieldError } from '../../shared/errors.js';
import { events } from '../../shared/events.js';
import { optionalSignedUrl } from '../files/urls.js';
import * as repo from './repository.js';
import type { UpdateProfileBody } from './schemas.js';

export async function profileDto(req: Request, r: repo.ProfileRow): Promise<SchoolProfileDto> {
  const sub = r.subscription;
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    institutionType: r.institution_type,
    address: r.address,
    city: r.city,
    state: r.state,
    pincode: r.pincode,
    contactName: r.contact_name,
    contactPhone: r.contact_phone,
    contactEmail: r.contact_email,
    logoFileId: r.logo_file_id,
    logoUrl: await optionalSignedUrl(req, r.logo_key),
    brandColor: r.brand_color,
    location: r.latitude !== null && r.longitude !== null ? { lat: Number(r.latitude), lng: Number(r.longitude) } : null,
    geofenceRadiusM: r.geofence_radius_m,
    timezone: r.timezone,
    status: r.status,
    subscription: sub
      ? { plan: sub.plan, status: sub.status, maxBuses: sub.max_buses, maxStudents: sub.max_students, validFrom: sub.valid_from, validUntil: sub.valid_until }
      : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Comparable profile values (audit before/after). */
function auditView(r: repo.ProfileRow): Record<string, unknown> {
  return {
    name: r.name,
    address: r.address,
    city: r.city,
    state: r.state,
    pincode: r.pincode,
    contactName: r.contact_name,
    contactPhone: r.contact_phone,
    contactEmail: r.contact_email,
    logoFileId: r.logo_file_id,
    brandColor: r.brand_color,
    location: r.latitude !== null && r.longitude !== null ? { lat: Number(r.latitude), lng: Number(r.longitude) } : null,
    geofenceRadiusM: r.geofence_radius_m,
    timezone: r.timezone,
  };
}

const COLUMN_OF = {
  name: 'name',
  address: 'address',
  city: 'city',
  state: 'state',
  pincode: 'pincode',
  contactName: 'contact_name',
  contactPhone: 'contact_phone',
  contactEmail: 'contact_email',
  logoFileId: 'logo_file_id',
  brandColor: 'brand_color',
  geofenceRadiusM: 'geofence_radius_m',
  timezone: 'timezone',
} as const satisfies Partial<Record<keyof UpdateProfileBody, string>>;

/** GET /school/profile */
export async function getProfile(req: Request): Promise<SchoolProfileDto> {
  const row = await withRequestTenant(req, async (tx) => assertFound(await repo.getProfile(tx), 'The school was not found.'), { readOnly: true });
  return profileDto(req, row);
}

/** PATCH /school/profile */
export async function updateProfile(req: Request, body: UpdateProfileBody): Promise<SchoolProfileDto> {
  const schoolId = req.tenant!.schoolId;
  const result = await withRequestTenant(req, async (tx) => {
    const before = assertFound(await repo.lockProfile(tx), 'The school was not found.');
    const cols: Record<string, unknown> = {};
    for (const [field, column] of Object.entries(COLUMN_OF) as [keyof typeof COLUMN_OF, string][]) {
      if (body[field] !== undefined) cols[column] = body[field];
    }
    if (body.location !== undefined) {
      cols.latitude = body.location?.lat ?? null;
      cols.longitude = body.location?.lng ?? null;
    }
    if (body.logoFileId && body.logoFileId !== before.logo_file_id) {
      const file = await repo.findFile(tx, body.logoFileId);
      if (!file) throw fieldError('logoFileId', 'The logo file was not found. Upload it with POST /files/upload first.');
      if (file.category !== 'school_logo') throw fieldError('logoFileId', 'The file is not a school logo (category school_logo).');
      if (file.status !== 'uploaded') throw fieldError('logoFileId', 'The logo upload is not complete.');
    }
    if (!Object.keys(cols).length) return { row: before, changed: [] as string[] };
    await repo.updateProfile(tx, cols);
    const after = assertFound(await repo.getProfile(tx));
    const diff = changedFields(auditView(before), auditView(after));
    const changed = Object.keys(diff.new);
    if (changed.length) await audit.log(tx, { action: 'school.update', entityType: 'school', entityId: schoolId, ...diff });
    return { row: after, changed };
  });
  if (result.changed.includes('timezone')) invalidateSchoolState(schoolId);
  if (result.changed.length) events.emit('school.profile_changed', { schoolId, changedFields: result.changed });
  return profileDto(req, result.row);
}
