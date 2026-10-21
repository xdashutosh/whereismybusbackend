// Socket.IO room child:{studentId}:live (contract §7, BP §8.6, §9.3, Appendix B step 6). Registered at
// import time on the process-wide registry; every join — and every later membership re-check
// (realtime.revalidateActors after an assignment change, the periodic sweep) — re-runs it:
//   * the principal is a parent account,
//   * the student is one of its ACTIVE links (parent_children_index: active parent account, active
//     school profile, active student, school not deleted),
//   * the student's school is active and within its plan (parent principals carry no school, so the
//     authorizer checks the school state itself, as resolveTenant does for X-School-Id),
//   * the child has a CURRENT assignment (school-local today) — checked in the parent's own tenant
//     context, under RLS.
// A child without any current assignment loses the room (room:revoked); a child moved to another bus
// keeps it and the feed follows the new bus (the relay reads the fan-out targets per message).
// A transient failure throws 503: the join is refused, an existing membership is kept until the next
// check (src/socket.ts). The first authorized join starts the live relay in this process.
import type { AuthContext } from '../../middleware/authenticate.js';
import { loadSchoolStateFromDb, type SchoolStateLoader } from '../../middleware/resolveTenant.js';
import { serviceUnavailable } from '../../shared/errors.js';
import { logger as rootLogger } from '../../shared/logger.js';
import { roomRegistry, type RoomParams, type RoomRegistry } from '../../shared/realtime.js';
import { childRelay } from './liveRelay.js';
import { parentLinks, usableSchool, withParentSchool } from './schools.js';

const log = rootLogger.child({ module: 'parent.sockets' });

export const CHILD_ROOM = 'child:{studentId}:live';

async function childHasCurrentAssignment(parentId: string, studentId: string, loadSchool: SchoolStateLoader): Promise<boolean> {
  const link = (await parentLinks(parentId)).find((l) => l.studentId === studentId);
  if (!link) return false;
  const school = await usableSchool(link.schoolId, loadSchool);
  if (!school) return false;
  const row = await withParentSchool(parentId, school, (tx) =>
    tx.maybeOne(
      `select 1 as ok
         from students s
         join student_parents l on l.student_id = s.id and l.parent_account_id = nullif(current_setting('app.actor_id', true), '')::uuid
         join student_assignments sa on sa.student_id = s.id and sa.valid_from <= app_local_date()
                                    and (sa.valid_to is null or sa.valid_to > app_local_date())
        where s.id = $1 and s.deleted_at is null and s.is_active
        limit 1`,
      [studentId],
    ),
  );
  return row !== null;
}

/** The child-room authorizer (exported for tests with another school loader). */
export function childRoomAuthorizer(loadSchool: SchoolStateLoader = loadSchoolStateFromDb) {
  return async (p: AuthContext, params: RoomParams): Promise<boolean> => {
    const studentId = params.studentId;
    if (p.role !== 'parent' || !studentId) return false;
    let allowed: boolean;
    try {
      allowed = await childHasCurrentAssignment(p.actorId, studentId, loadSchool);
    } catch (err) {
      log.warn({ err, studentId }, 'Child room authorization failed');
      throw serviceUnavailable('Live tracking is temporarily unavailable. Please retry.');
    }
    if (allowed && !childRelay.started) {
      childRelay.start().catch((err: unknown) => log.error({ err }, 'Could not start the child room relay'));
    }
    return allowed;
  };
}

const registered = new WeakSet<RoomRegistry>();
/** Registers the parent rooms on a registry (idempotent per registry). */
export function registerParentRooms(registry: RoomRegistry = roomRegistry, loadSchool?: SchoolStateLoader): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  registry.register(CHILD_ROOM, childRoomAuthorizer(loadSchool));
}

registerParentRooms();
