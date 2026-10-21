// GET /driver/me and GET /driver/home (BP §8.4, §14.2): profile + current bus/route assignments, and
// today's (school-local) morning/afternoon trips with the caller's start eligibility, the running trip,
// announcements for drivers and the school's trip configuration.
import type { DriverBusAssignment, DriverHome, DriverHomeTrip, DriverMe, TripConfig } from '@wimb/shared';
import type { Request } from 'express';
import type { Tx } from '../../db/tenant.js';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { assertFound } from '../../shared/errors.js';
import { optionalSignedUrl } from '../files/urls.js';
import { loadSchoolSettings, visibleAnnouncements } from '../school/index.js';
import { driverContext, localToday } from './context.js';
import { toDriverTrip } from './dto.js';
import { activeTripOf } from './driverTrips.js';
import { tripConfigOf } from './odometer.js';
import * as repo from './repository.js';
import { TRIP_COLUMNS, type AssignmentRole, type TripRow } from './repository.js';

const toAssignment = (a: repo.AssignmentRow): DriverBusAssignment => ({
  busId: a.bus_id,
  busCode: a.bus_code,
  busName: a.bus_name,
  registrationNo: a.registration_no,
  busStatus: a.bus_status,
  lastKnownOdometer: a.last_known_odometer === null ? null : Number(a.last_known_odometer),
  role: a.role,
  validFrom: a.valid_from,
  validTo: a.valid_to,
  routes: a.routes ?? [],
});

interface MeRow extends Record<string, unknown> {
  user_id: string;
  role: 'driver' | 'conductor';
  user_name: string;
  user_phone: string | null;
  username: string | null;
  school_id: string;
  school_code: string;
  school_name: string;
  timezone: string;
  logo_key: string | null;
  photo_key: string | null;
}

export async function me(req: Request): Promise<DriverMe> {
  const c = driverContext(req);
  const data = await withRequestTenant(
    req,
    async (tx) => {
      const staff = await repo.staffOfUser(tx, c.auth.actorId);
      const row = assertFound(
        await tx.maybeOne<MeRow>(
          `select u.id as user_id, u.role, u.full_name as user_name, u.phone as user_phone, u.username::text as username,
                  s.id as school_id, s.code as school_code, s.name as school_name, s.timezone,
                  (select coalesce(f.thumb_key, f.key) from files f where f.id = s.logo_file_id and f.status = 'uploaded') as logo_key,
                  (select coalesce(f.thumb_key, f.key) from files f where f.id = $2::uuid and f.status = 'uploaded') as photo_key
             from users u join schools s on s.id = u.school_id
            where u.id = $1`,
          [c.auth.actorId, staff?.photo_file_id ?? null],
        ),
      );
      return { staff, row, assignments: staff ? await repo.currentAssignments(tx, staff.id) : [] };
    },
    { readOnly: true },
  );
  const { staff, row } = data;
  return {
    user: { id: row.user_id, role: row.role, fullName: row.user_name, phone: row.user_phone, username: row.username },
    staff: staff
      ? {
          id: staff.id,
          staffType: staff.staff_type,
          fullName: staff.full_name,
          phone: staff.phone,
          photoUrl: await optionalSignedUrl(req, row.photo_key),
          licenceNo: staff.licence_no,
          licenceExpiryDate: staff.licence_expiry_date,
          experienceYears: staff.experience_years === null ? null : Number(staff.experience_years),
        }
      : null,
    school: { id: row.school_id, code: row.school_code, name: row.school_name, timezone: row.timezone, logoUrl: await optionalSignedUrl(req, row.logo_key) },
    assignments: data.assignments.map(toAssignment),
  };
}

interface HomeTripRow extends TripRow {
  bus_status: string;
  my_role: AssignmentRole | null;
  bus_busy: boolean;
}

const MY_WINDOW = 'a.staff_id = $2 and a.valid_from <= now() and (a.valid_to is null or a.valid_to > now())';

function todaysTrips(tx: Tx, userId: string, staffId: string | null): Promise<HomeTripRow[]> {
  return tx.many<HomeTripRow>(
    `select ${TRIP_COLUMNS}, b.status as bus_status,
            (select a.assignment_role from bus_staff_assignments a where a.bus_id = t.bus_id and ${MY_WINDOW}
              order by array_position(array['primary_driver', 'conductor', 'backup_driver', 'backup_conductor'], a.assignment_role) limit 1) as my_role,
            exists (select 1 from trips x where x.bus_id = t.bus_id and x.status = 'in_progress' and x.id <> t.id) as bus_busy
       from trips t join buses b on b.id = t.bus_id
      where t.trip_date = app_local_date()
        and (t.bus_id in (select a.bus_id from bus_staff_assignments a where ${MY_WINDOW})
             or t.started_by = $1 or t.driver_staff_id = $2 or t.conductor_staff_id = $2)
      order by t.planned_start_at nulls last, t.started_at nulls last, t.id`,
    [userId, staffId],
  );
}

function blockedReason(t: HomeTripRow, config: TripConfig, hasActive: boolean): string | null {
  if (!t.my_role) return 'NOT_ASSIGNED';
  if (t.status !== 'scheduled') return 'NOT_SCHEDULED';
  if (t.my_role === 'backup_driver' && !config.allowBackupDriverStart) return 'BACKUP_START_NOT_ALLOWED';
  if (t.bus_status !== 'active') return 'BUS_UNAVAILABLE';
  if (t.bus_busy) return 'BUS_BUSY';
  if (hasActive) return 'ALREADY_ON_TRIP';
  return null;
}

export async function home(req: Request): Promise<DriverHome> {
  const c = driverContext(req);
  return withRequestTenant(
    req,
    async (tx) => {
      const staff = await repo.staffOfUser(tx, c.auth.actorId);
      const staffId = staff?.id ?? null;
      const config = tripConfigOf(await loadSchoolSettings(tx));
      const date = await localToday(tx);
      const rows = await todaysTrips(tx, c.auth.actorId, staffId);
      const active = await activeTripOf(tx, c.auth.actorId, staffId);
      const assignments = staffId ? await repo.currentAssignments(tx, staffId) : [];
      const announcements = await visibleAnnouncements(tx, 'drivers');
      const card = (t: HomeTripRow): DriverHomeTrip => {
        const reason = blockedReason(t, config, active !== null);
        return { ...toDriverTrip(t, c.device.id), myRole: t.my_role, canStart: reason === null, blockedReason: reason };
      };
      const school = rows.filter((r) => r.trip_type === 'school');
      return {
        date,
        serverTime: new Date().toISOString(),
        morning: school.filter((r) => r.direction === 'morning').map(card),
        afternoon: school.filter((r) => r.direction === 'afternoon').map(card),
        other: rows
          .filter((r) => r.trip_type === 'non_school' && (r.started_by === c.auth.actorId || (staffId !== null && (r.driver_staff_id === staffId || r.conductor_staff_id === staffId))))
          .map((r) => toDriverTrip(r, c.device.id)),
        activeTrip: active ? toDriverTrip(active, c.device.id) : null,
        announcements,
        config,
        buses: assignments.map(toAssignment),
      };
    },
    { readOnly: true },
  );
}
