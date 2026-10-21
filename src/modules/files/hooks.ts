// File category registry (BP §12, contract §2 Files). Each category declares its upload kind,
// the entity types a file may be attached to, who may upload, and how images are treated.
// Authorization is layered:
//   upload  = category roles  AND  entity exists in the caller's school (RLS) [AND staff own it]
//             AND every module hook registered with authorizeUpload
//   read    = school_admin: any uploaded file of the school
//             driver/conductor: files they uploaded, or a module hook's authorizeRead grant
//             parent: ONLY a module hook's parentRead grant (applies parent_visibility); the
//             files parent_scope RLS policy is the backstop
// Modules extend a category with registerFileHooks('bus_document', { parentRead, … }).
import type { FileCategory, Role } from '@wimb/shared';
import type { Request } from 'express';
import type { AuthContext } from '../../middleware/authenticate.js';
import type { Tx } from '../../db/tenant.js';
import type { UploadKind } from '../../shared/uploads.js';

export const FILE_ENTITY_TYPES = ['school', 'bus', 'staff', 'student', 'trip', 'fuel_log', 'maintenance_log', 'import', 'report'] as const;
export type FileEntityType = (typeof FILE_ENTITY_TYPES)[number];

export interface FileCategorySpec {
  kind: UploadKind;
  /** Allowed entity types; the first is the default. */
  entityTypes: readonly FileEntityType[];
  /** The entity id may be omitted (a fresh id is used for the key path). */
  entityOptional: boolean;
  uploadRoles: readonly Role[];
  /** Re-encode images without EXIF/GPS (parent-visible or shareable images). */
  stripMetadata: boolean;
  /** Generate a WebP thumbnail for images. */
  thumbnail: boolean;
}

const ADMIN: readonly Role[] = ['school_admin'];

/** Built-in specs for every FILE_CATEGORIES value. Odometer originals are kept untouched (evidence). */
export const FILE_CATEGORY_SPECS: Readonly<Record<FileCategory, FileCategorySpec>> = Object.freeze({
  school_logo: { kind: 'PHOTO', entityTypes: ['school'], entityOptional: true, uploadRoles: ADMIN, stripMetadata: true, thumbnail: true },
  bus_image: { kind: 'PHOTO', entityTypes: ['bus'], entityOptional: false, uploadRoles: ADMIN, stripMetadata: true, thumbnail: true },
  bus_document: { kind: 'DOCUMENT', entityTypes: ['bus'], entityOptional: false, uploadRoles: ADMIN, stripMetadata: true, thumbnail: true },
  staff_photo: { kind: 'PHOTO', entityTypes: ['staff'], entityOptional: false, uploadRoles: ADMIN, stripMetadata: true, thumbnail: true },
  staff_document: { kind: 'DOCUMENT', entityTypes: ['staff'], entityOptional: false, uploadRoles: ADMIN, stripMetadata: true, thumbnail: true },
  student_photo: { kind: 'PHOTO', entityTypes: ['student'], entityOptional: false, uploadRoles: ADMIN, stripMetadata: true, thumbnail: true },
  odometer: { kind: 'ODOMETER', entityTypes: ['trip', 'bus'], entityOptional: false, uploadRoles: ['driver', 'conductor', 'school_admin'], stripMetadata: false, thumbnail: true },
  fuel_bill: { kind: 'DOCUMENT', entityTypes: ['bus', 'fuel_log'], entityOptional: false, uploadRoles: ADMIN, stripMetadata: true, thumbnail: true },
  maintenance_invoice: { kind: 'DOCUMENT', entityTypes: ['bus', 'maintenance_log'], entityOptional: false, uploadRoles: ADMIN, stripMetadata: true, thumbnail: true },
  import: { kind: 'IMPORT', entityTypes: ['import'], entityOptional: true, uploadRoles: ADMIN, stripMetadata: false, thumbnail: false },
  // Reports are generated server-side (reports module) — never uploaded through the API.
  report: { kind: 'IMPORT', entityTypes: ['report'], entityOptional: true, uploadRoles: [], stripMetadata: false, thumbnail: false },
});

export interface FileRecord {
  id: string;
  school_id: string;
  key: string;
  thumb_key: string | null;
  category: FileCategory;
  entity_type: FileEntityType | null;
  entity_id: string | null;
  mime: string;
  size_bytes: number | null;
  sha256: string | null;
  original_name: string | null;
  metadata: Record<string, unknown>;
  status: 'pending' | 'uploaded' | 'rejected' | 'deleted';
  uploaded_by: string | null;
  uploader_type: string | null;
  created_at: string;
  updated_at: string;
}

export interface UploadHookContext {
  tx: Tx;
  req: Request;
  auth: AuthContext;
  schoolId: string;
  category: FileCategory;
  entityType: FileEntityType;
  entityId: string;
}

export interface ReadHookContext {
  tx: Tx;
  req: Request;
  auth: AuthContext;
  schoolId: string;
  file: FileRecord;
}

export interface FileHooks {
  /** Extra upload restriction (all registered hooks must allow). */
  authorizeUpload?: (c: UploadHookContext) => Promise<boolean>;
  /** Extra read grant for school admins' staff (drivers/conductors). */
  authorizeRead?: (c: ReadHookContext) => Promise<boolean>;
  /** Parent read grant — must apply the school's parent_visibility settings. */
  parentRead?: (c: ReadHookContext) => Promise<boolean>;
}

export function createFileHookRegistry() {
  const hooks = new Map<FileCategory, FileHooks[]>();
  const of = (category: FileCategory) => hooks.get(category) ?? [];
  return {
    register(category: FileCategory, h: FileHooks): () => void {
      if (!(category in FILE_CATEGORY_SPECS)) throw new TypeError(`Unknown file category: ${category}`);
      hooks.set(category, [...of(category), h]);
      return () => hooks.set(category, of(category).filter((x) => x !== h));
    },
    async allowUpload(c: UploadHookContext): Promise<boolean> {
      for (const h of of(c.category)) if (h.authorizeUpload && !(await h.authorizeUpload(c))) return false;
      return true;
    },
    async allowStaffRead(c: ReadHookContext): Promise<boolean> {
      for (const h of of(c.file.category)) if (h.authorizeRead && (await h.authorizeRead(c))) return true;
      return false;
    },
    async allowParentRead(c: ReadHookContext): Promise<boolean> {
      for (const h of of(c.file.category)) if (h.parentRead && (await h.parentRead(c))) return true;
      return false;
    },
  };
}

export type FileHookRegistry = ReturnType<typeof createFileHookRegistry>;

/** Process-wide registry (modules register at import time). */
export const fileHooks: FileHookRegistry = createFileHookRegistry();
export const registerFileHooks = (category: FileCategory, h: FileHooks): (() => void) => fileHooks.register(category, h);

// The school logo is part of the school's branding: every member of the school, parents included,
// may see it (the files parent_scope policy also allows it).
registerFileHooks('school_logo', { parentRead: async () => true, authorizeRead: async () => true });
