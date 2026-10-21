// Erasure / anonymisation of one student or parent within the school (BP §16 "deletion … on
// request", DPDP right to erasure; docs/api/privacy.md, docs/PRIVACY.md §6). Irreversible: the body
// must carry { "confirm": "ERASE" }. One transaction in the school admin's context (RLS), audited as
// `privacy.erase` with counts only (no personal data in the audit row); afterwards the stored photos
// are deleted from object storage and affected sockets are disconnected.
// What stays (aggregate and audit integrity): the row ids (pseudonymous), trips, stop events, alerts,
// reports and the school's audit trail; assignment history is kept (bus / route / stop / dates only)
// and ends today. Erasing again is refused (409); a parent record re-registered later (same phone) is a
// new registration and can be erased again.
// Parents: parent_accounts is a GLOBAL identity. The school's own record (name, e-mail, relation,
// alternate phone), links, preferences, inbox and consent network details are always erased; the
// global identity (phone, display name, password, sessions, push tokens) is anonymised only when no
// other school holds a live link to it (school_erase_parent_account, migration 901). The response is
// the same either way, so it never reveals whether another school knows the number.
import type { PrivacyEraseBody, PrivacyEraseResult } from '@wimb/shared';
import type { Request } from 'express';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { audit } from '../../shared/audit.js';
import { invalidState, notFound } from '../../shared/errors.js';
import { logger as rootLogger } from '../../shared/logger.js';
import { realtime } from '../../shared/realtime.js';
import { storage } from '../../shared/storage.js';
import { disconnectParentSockets } from '../students/parentSessions.js';
import * as repo from './repository.js';

const log = rootLogger.child({ module: 'privacy.erase' });

/** Deletes stored objects (and thumbnails) after commit → objects removed. Failures are logged, never thrown. */
async function deleteObjects(files: readonly repo.FileRow[]): Promise<number> {
  let removed = 0;
  for (const f of files) {
    const ok = await storage.deleteObjectQuietly(f.key);
    if (f.thumb_key) await storage.deleteObjectQuietly(f.thumb_key);
    if (ok) removed += 1;
    else log.error({ fileId: f.id }, 'Erased file could not be removed from storage; remove it manually');
  }
  return removed;
}

/** POST /school/privacy/students/:id/erase */
export async function eraseStudent(req: Request, id: string, body: PrivacyEraseBody): Promise<PrivacyEraseResult> {
  const result = await withRequestTenant(req, async (tx) => {
    const s = await repo.findStudent(tx, id, { lock: true });
    if (!s) throw notFound('Student not found.');
    if (s.erased_at) throw invalidState('This student has already been erased.', { erasedAt: s.erased_at });
    const files = (await repo.studentFiles(tx, id, s.photo_file_id, { lock: true })).filter((f) => f.status !== 'deleted');
    const parents = (await repo.linksOfStudent(tx, id)).map((l) => l.parent_account_id);
    const r = await repo.eraseStudentRows(tx, id);
    await repo.markFilesDeleted(tx, files.map((f) => f.id));
    await audit.log(tx, {
      action: 'privacy.erase',
      entityType: 'student',
      entityId: id,
      new: {
        erasedAt: r.erased_at,
        filesDeleted: files.length,
        parentLinksRemoved: r.links_removed,
        preferencesRemoved: r.preferences_removed,
        assignmentsEnded: r.assignments_ended,
        notificationsDeleted: r.notifications_deleted,
        notificationEventsScrubbed: r.events_scrubbed,
        ...(body.reason ? { reason: body.reason } : {}),
      },
    });
    return { erasedAt: r.erased_at, files, parents };
  });
  const filesDeleted = await deleteObjects(result.files);
  if (result.parents.length) await disconnectParentSockets(result.parents);
  return { subjectType: 'student', id, erasedAt: result.erasedAt, filesDeleted };
}

/** POST /school/privacy/parents/:id/erase (`id` = the school's parent id). */
export async function eraseParent(req: Request, id: string, body: PrivacyEraseBody): Promise<PrivacyEraseResult> {
  const result = await withRequestTenant(req, async (tx) => {
    const p = await repo.findParent(tx, id, { lock: true });
    if (!p) throw notFound('Parent not found.');
    if (p.erased_at && p.deleted_at) throw invalidState('This parent has already been erased.', { erasedAt: p.erased_at });
    const r = await repo.eraseParentRows(tx, id, p.parent_account_id);
    const account = await repo.eraseParentAccount(tx, p.parent_account_id);
    await audit.log(tx, {
      action: 'privacy.erase',
      entityType: 'parent',
      entityId: id,
      new: {
        erasedAt: r.erased_at,
        parentLinksRemoved: r.links_removed,
        preferencesRemoved: r.preferences_removed,
        notificationsDeleted: r.notifications_deleted,
        consentsRedacted: r.consents_redacted,
        ...(body.reason ? { reason: body.reason } : {}),
      },
    });
    return { erasedAt: r.erased_at, accountId: p.parent_account_id, revoked: account.revoked_session_ids };
  });
  // Global identity anonymised → its sessions were revoked (disconnect them); otherwise only drop the
  // parent's socket room joins so they are re-authorised without this school.
  if (result.revoked.length) await realtime.disconnectSessions(result.revoked);
  else await disconnectParentSockets([result.accountId]);
  return { subjectType: 'parent', id, erasedAt: result.erasedAt, filesDeleted: 0 };
}
