// Response shapes of the platform module (camelCase JSON, contract §5). Schools, subscriptions and
// settings are platform rows; admins are a school's admin accounts (BP §2.2: the Super Admin creates
// them and resets their access); usage is counts only (BP §4.4).
import type * as repo from './repository.js';

export function toSchoolDto(s: repo.SchoolRow) {
  return {
    id: s.id,
    code: s.code,
    name: s.name,
    institutionType: s.institution_type,
    status: s.status,
    statusReason: s.status_reason,
    address: s.address,
    city: s.city,
    state: s.state,
    pincode: s.pincode,
    contact: { name: s.contact_name, phone: s.contact_phone, email: s.contact_email },
    brandColor: s.brand_color,
    location: s.latitude !== null && s.longitude !== null ? { lat: Number(s.latitude), lng: Number(s.longitude) } : null,
    geofenceRadiusM: s.geofence_radius_m,
    timezone: s.timezone,
    tenantMode: s.tenant_mode,
    dbConnectionRef: s.db_connection_ref,
    logoFileId: s.logo_file_id,
    deleted: s.deleted_at !== null,
    deletedAt: s.deleted_at,
    createdBy: s.created_by,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  };
}
export type SchoolDto = ReturnType<typeof toSchoolDto>;

export function toSubscriptionSummary(r: { sub_plan: string | null; sub_status: string | null; sub_valid_until: string | null; sub_max_buses: number | null; sub_max_students: number | null }) {
  if (r.sub_plan === null) return null;
  return { plan: r.sub_plan, status: r.sub_status, validUntil: r.sub_valid_until, maxBuses: r.sub_max_buses, maxStudents: r.sub_max_students };
}

export function toSchoolListDto(r: repo.SchoolListRow) {
  return { ...toSchoolDto(r), subscription: toSubscriptionSummary(r) };
}
export type SchoolListDto = ReturnType<typeof toSchoolListDto>;

export function toSubscriptionDto(s: repo.SubscriptionRow) {
  return {
    id: s.id,
    plan: s.plan,
    status: s.status,
    maxBuses: s.max_buses,
    maxStudents: s.max_students,
    modules: s.modules ?? {},
    validFrom: s.valid_from,
    validUntil: s.valid_until,
    notes: s.notes,
    createdBy: s.created_by,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  };
}
export type SubscriptionDto = ReturnType<typeof toSubscriptionDto>;

export function toAdminDto(a: repo.SchoolAdminRow) {
  return {
    id: a.id,
    name: a.full_name,
    email: a.email,
    phone: a.phone,
    isActive: a.is_active,
    mustChangePassword: a.must_change_password,
    lastLoginAt: a.last_login_at,
    createdAt: a.created_at,
  };
}

export function toUsageDto(u: repo.UsageCountsRow) {
  return {
    buses: Number(u.buses),
    students: Number(u.students),
    staff: Number(u.staff),
    parents: Number(u.parents),
    routes: Number(u.routes),
    activeTrips: Number(u.active_trips),
    tripsLast30Days: Number(u.trips_last_30_days),
    lastActivityAt: u.last_activity_at,
  };
}
export type UsageDto = ReturnType<typeof toUsageDto>;

/** Usage of a plan limit: used / limit (null = unlimited) and whether the limit is reached. */
export function limitUsage(used: number, limit: number | null) {
  return { used, limit, remaining: limit === null ? null : Math.max(0, limit - used), reached: limit !== null && used >= limit };
}

export function toUsageListDto(r: repo.UsageListRow) {
  const usage = toUsageDto(r);
  return {
    school: { id: r.id, code: r.code, name: r.name, status: r.status, institutionType: r.institution_type },
    subscription: toSubscriptionSummary(r),
    usage,
    limits: { buses: limitUsage(usage.buses, r.sub_max_buses), students: limitUsage(usage.students, r.sub_max_students) },
  };
}
export type UsageListDto = ReturnType<typeof toUsageListDto>;

export function toSettingDto(s: repo.SettingRow) {
  return { key: s.key, value: s.value, description: s.description, isPublic: s.is_public, updatedBy: s.updated_by, updatedAt: s.updated_at };
}

export function toHealthCountsDto(c: repo.HealthCountsRow) {
  return {
    schools: { total: Number(c.schools_total), active: Number(c.schools_active), suspended: Number(c.schools_suspended), inactive: Number(c.schools_inactive) },
    buses: Number(c.buses_total),
    activeTrips: Number(c.active_trips),
    tripsLast24h: Number(c.trips_last_24h),
    students: Number(c.students_total),
    parents: Number(c.parents_total),
    staff: Number(c.staff_total),
  };
}
