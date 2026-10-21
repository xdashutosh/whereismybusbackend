// School logo set by the Super Admin (BP §13.2 "Create/Edit school: logo"). Files only exist in a
// tenant context (BP §12), so this platform-only upload path stores the logo in the school's OWN
// scope — key <prefix>schools/{school_id}/school_logo/{school_id}/{uuid}.{ext}, files row written
// inside withTenant({ schoolId, actorId: super admin, role: 'system' }) — and links it through
// schools.logo_file_id in the same transaction. The image is validated by magic bytes, re-encoded
// without EXIF/GPS and gets a WebP thumbnail exactly like a school admin's logo upload (files
// module, category school_logo). The platform audit records who changed the logo.
import type { Request } from 'express';
import { withTenant } from '../../db/tenant.js';
import { audit } from '../../shared/audit.js';
import { validationError } from '../../shared/errors.js';
import { storage } from '../../shared/storage.js';
import { FILE_CATEGORY_SPECS } from '../files/hooks.js';
import { prepareStoredObject, thumbKeyOf } from '../files/processing.js';
import { optionalSignedUrl } from '../files/urls.js';
import { actorOf, lockLiveSchool, platformTx } from './schools.js';
import * as scope from './schoolScope.js';

function schoolContext(req: Request, schoolId: string) {
  return { schoolId, actorId: actorOf(req), role: 'system' as const };
}

/** Removes the stored objects of a retired logo (best effort; the row stays for the trail). */
async function deleteObjects(file: { key: string; thumb_key: string | null } | null): Promise<void> {
  if (!file) return;
  await storage.deleteObjectQuietly(file.key);
  if (file.thumb_key) await storage.deleteObjectQuietly(file.thumb_key);
}

/** POST /platform/schools/:id/logo (multipart field "file"; JPEG, PNG or WebP up to 5 MB). */
export async function uploadLogo(req: Request, id: string) {
  const inspected = req.upload;
  if (!inspected) throw validationError('A file is required.', [{ path: 'file', message: 'Upload the logo in the "file" field' }]);
  await platformTx(req, (tx) => lockLiveSchool(tx, id, { lock: false }), { readOnly: true });
  const spec = FILE_CATEGORY_SPECS.school_logo;
  const stored = await prepareStoredObject(spec, inspected);
  const key = storage.schoolObjectKey({ schoolId: id, category: 'school_logo', entityId: id, extension: stored.extension });
  const thumbKey = stored.thumbnail ? thumbKeyOf(key) : null;
  await storage.putObject({ key, body: stored.body, contentType: stored.contentType, checksum: stored.sha256 });
  let linked: { file: scope.LogoFileRow; previous: string | null; retired: scope.LogoFileRow | null };
  try {
    if (thumbKey && stored.thumbnail) await storage.putObject({ key: thumbKey, body: stored.thumbnail, contentType: 'image/webp' });
    linked = await withTenant(schoolContext(req, id), async (tx) => {
      const file = await scope.insertLogoFile(tx, {
        key,
        thumbKey,
        mime: stored.contentType,
        sizeBytes: stored.size,
        sha256: stored.sha256,
        originalName: inspected.safeName,
        metadata: { ...stored.metadata, uploadedVia: 'platform' },
      });
      const { previous } = await scope.setLogo(tx, file.id);
      const retired = previous && previous !== file.id ? await scope.retireFile(tx, previous) : null;
      return { file, previous, retired };
    });
  } catch (err) {
    await storage.deleteObjectQuietly(key);
    if (thumbKey) await storage.deleteObjectQuietly(thumbKey);
    throw err;
  }
  await platformTx(req, (tx) =>
    audit.log(tx, { action: 'school.logo_update', entityType: 'school', entityId: id, old: { logoFileId: linked.previous }, new: { logoFileId: linked.file.id, sizeBytes: stored.size, sha256: stored.sha256 } }),
  );
  await deleteObjects(linked.retired);
  return { logoFileId: linked.file.id, logoUrl: await optionalSignedUrl(req, key), logoThumbnailUrl: await optionalSignedUrl(req, thumbKey) };
}

/** DELETE /platform/schools/:id/logo — unlinks and retires the current logo. Idempotent. */
export async function removeLogo(req: Request, id: string) {
  const school = await platformTx(req, (tx) => lockLiveSchool(tx, id, { lock: false }), { readOnly: true });
  if (!school.logo_file_id) return { logoFileId: null, logoUrl: null, logoThumbnailUrl: null };
  const retired = await withTenant(schoolContext(req, id), async (tx) => {
    const { previous } = await scope.setLogo(tx, null);
    return previous ? scope.retireFile(tx, previous) : null;
  });
  await platformTx(req, (tx) => audit.log(tx, { action: 'school.logo_remove', entityType: 'school', entityId: id, old: { logoFileId: school.logo_file_id }, new: { logoFileId: null } }));
  await deleteObjects(retired);
  return { logoFileId: null, logoUrl: null, logoThumbnailUrl: null };
}

