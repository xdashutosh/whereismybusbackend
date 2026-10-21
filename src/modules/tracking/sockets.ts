// Socket.IO room authorization of the tracking module (contract §7, BP §8.6). Registered at import
// time on the process-wide registry; every join re-runs it (the socket layer reloads the live
// session first). school:{id}:fleet and school:{id}:alerts are built in (school admins of that school).
//   trip:{tripId}  school admins of the trip's school; the trip's own driver/conductor and the user who
//                  started it (the start phone stays bound after a reassignment); parents with
//                  an active assignment of a linked child to the trip's bus AND direction on the trip
//                  date (school trips only, scheduled or running), in an active school with a valid plan.
// Parent principals carry no school, so the authorizer resolves the schools through
// parent_children_index() and checks each school's state and plan itself.
import type { AuthContext } from '../../middleware/authenticate.js';
import { loadSchoolStateFromDb, runSubscriptionChecks, type SchoolStateLoader } from '../../middleware/resolveTenant.js';
import { definerQuery } from '../../db/definer.js';
import { withTenant } from '../../db/tenant.js';
import { serviceUnavailable } from '../../shared/errors.js';
import { logger as rootLogger } from '../../shared/logger.js';
import { roomRegistry, type RoomParams, type RoomRegistry } from '../../shared/realtime.js';

const log = rootLogger.child({ module: 'tracking.sockets' });

export const TRIP_ROOM = 'trip:{tripId}';

async function adminCanWatch(p: AuthContext, tripId: string): Promise<boolean> {
  if (!p.schoolId) return false;
  const row = await withTenant({ schoolId: p.schoolId, actorId: p.actorId, role: 'school_admin' }, (tx) => tx.maybeOne('select 1 as ok from trips where id = $1', [tripId]), { readOnly: true });
  return row !== null;
}

async function crewCanWatch(p: AuthContext, tripId: string): Promise<boolean> {
  if (!p.schoolId) return false;
  const row = await withTenant(
    { schoolId: p.schoolId, actorId: p.actorId, role: p.role },
    (tx) =>
      tx.maybeOne(
        `select 1 as ok from trips t
          where t.id = $1
            and (t.started_by = $2
                 or exists (select 1 from staff_profiles sp where sp.user_id = $2 and sp.deleted_at is null and sp.id in (t.driver_staff_id, t.conductor_staff_id)))`,
        [tripId, p.actorId],
      ),
    { readOnly: true },
  );
  return row !== null;
}

async function schoolUsable(schoolId: string, loadSchool: SchoolStateLoader): Promise<boolean> {
  const state = await loadSchool(schoolId);
  if (!state || state.status !== 'active' || state.deleted) return false;
  try {
    await runSubscriptionChecks(state, null);
    return true;
  } catch {
    return false;
  }
}

async function parentCanWatch(p: AuthContext, tripId: string, loadSchool: SchoolStateLoader): Promise<boolean> {
  const links = await definerQuery<{ school_id: string }>('select distinct school_id from parent_children_index($1)', [p.actorId]);
  for (const { school_id: schoolId } of links) {
    // Parent RLS: trips of the assigned bus + direction; assignments of the parent's linked children.
    const row = await withTenant(
      { schoolId, actorId: p.actorId, role: 'parent' },
      (tx) =>
        tx.maybeOne(
          `select 1 as ok
             from trips t
            where t.id = $1 and t.trip_type = 'school' and t.status in ('scheduled', 'in_progress')
              and exists (select 1 from student_assignments sa
                           where sa.bus_id = t.bus_id and sa.trip_direction = t.direction
                             and sa.valid_from <= t.trip_date and (sa.valid_to is null or sa.valid_to > t.trip_date))`,
          [tripId],
        ),
      { readOnly: true },
    );
    if (row) return schoolUsable(schoolId, loadSchool);
  }
  return false;
}

/** The trip-room authorizer (exported for tests with another school loader). */
export function tripRoomAuthorizer(loadSchool: SchoolStateLoader = loadSchoolStateFromDb) {
  return async (p: AuthContext, params: RoomParams): Promise<boolean> => {
    const tripId = params.tripId;
    if (!tripId) return false;
    try {
      switch (p.role) {
        case 'school_admin':
          return await adminCanWatch(p, tripId);
        case 'driver':
        case 'conductor':
          return await crewCanWatch(p, tripId);
        case 'parent':
          return await parentCanWatch(p, tripId, loadSchool);
        default:
          return false;
      }
    } catch (err) {
      // Transient failure (database unreachable): the join is refused with 503, while a periodic
      // re-check keeps an existing membership until the next run (src/socket.ts).
      log.warn({ err, tripId, role: p.role }, 'Trip room authorization failed');
      throw serviceUnavailable('Live tracking is temporarily unavailable. Please retry.');
    }
  };
}

const registered = new WeakSet<RoomRegistry>();
/** Registers the tracking rooms on a registry (idempotent per registry). */
export function registerTrackingRooms(registry: RoomRegistry = roomRegistry, loadSchool?: SchoolStateLoader): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  registry.register(TRIP_ROOM, tripRoomAuthorizer(loadSchool));
}

registerTrackingRooms();
