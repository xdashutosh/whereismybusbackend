// Bus details, driver/conductor cards and file URLs for parents (BP §8.5, §13.3 visibility matrix,
// §15.2 Bus Details / Driver-Conductor, §12 files, §16 data minimisation).
//   bus    the bus of the child's current assignment (requested direction, or the one that matters
//          now), as the buses module's parentBusView() builds it from school_settings.parent_visibility
//          and the document flags (capacity/plate/images/insurance/fitness; verified documents only)
//   staff  the cards of the staff currently assigned to the child's bus(es) (primary driver,
//          conductor, backups) from the staff module's parentStaffForBus() — phone/email/photo/
//          experience/licence/verification/documents only where the matrix allows
//   files  GET /parent/files/:fileId/url → the files module's fileUrl(): a parent reads a file only
//          through a category parentRead hook (bus image/document, staff photo/document, the child's
//          photo, the school logo), each applying the visibility matrix and the "attached to the
//          child's bus/staff" rule; the files parent_scope RLS policy is the backstop. Anything else
//          is 404 (existence never revealed).
// All of it runs in the parent's tenant context (X-School-Id validated) under RLS.
import type { Direction, ParentBusDetails, ParentStaffResponse } from '@wimb/shared';
import type { Request } from 'express';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { notFound } from '../../shared/errors.js';
import { parentBusView } from '../buses/index.js';
import type { FileUrlQuery } from '../files/schemas.js';
import { fileUrl } from '../files/service.js';
import { parentStaffForBus } from '../staff/index.js';
import { assignmentFor, loadChild, NO_ASSIGNMENT } from './access.js';
import * as repo from './repository.js';

export async function busDetails(req: Request, studentId: string, direction?: Direction): Promise<ParentBusDetails> {
  return withRequestTenant(req, async (tx) => {
    const child = await loadChild(tx, studentId);
    const row = assignmentFor(child, direction);
    const bus = await parentBusView(req, tx, row.bus_id);
    // RLS hides a bus that is no longer assigned (e.g. soft-deleted between the two reads).
    if (!bus) throw notFound('No bus is assigned to this child.', { reason: NO_ASSIGNMENT });
    const brand = await repo.schoolBrand(tx);
    return {
      school: { id: brand?.id ?? req.tenant!.schoolId, name: brand?.name ?? '' },
      studentId: child.studentId,
      direction: row.direction,
      bus,
      route: { id: row.route_id, code: row.route_code, name: row.route_name },
    };
  });
}

export async function staffCards(req: Request, studentId: string, direction?: Direction): Promise<ParentStaffResponse> {
  return withRequestTenant(req, async (tx) => {
    const child = await loadChild(tx, studentId);
    const rows = direction ? [assignmentFor(child, direction)] : child.assigned;
    if (!rows.length) throw notFound('No bus is assigned to this child.', { reason: NO_ASSIGNMENT });
    const buses: ParentStaffResponse['buses'] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.bus_id)) continue;
      seen.add(row.bus_id);
      buses.push({ busId: row.bus_id, busCode: row.bus_code, direction: row.direction, staff: await parentStaffForBus(req, tx, row.bus_id) });
    }
    const brand = await repo.schoolBrand(tx);
    return { school: { id: brand?.id ?? req.tenant!.schoolId, name: brand?.name ?? '' }, studentId: child.studentId, buses };
  });
}

/** GET /parent/files/:fileId/url — short-lived signed URL of a file the parent may see. */
export function parentFileUrl(req: Request, fileId: string, q: FileUrlQuery) {
  return fileUrl(req, fileId, q);
}
