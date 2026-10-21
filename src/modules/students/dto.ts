// Row → JSON mappers of the students module (DB snake_case → API camelCase, contract §5).
// Assignment and parent sub-objects are built as jsonb in SQL (one round trip per list) and
// normalised here; storage keys never leave the server (photos get signed URLs in the service).
import type {
  Direction,
  ParentChildDto,
  ParentListItem,
  StudentAssignmentDto,
  StudentAssignmentsByDirection,
  StudentListItem,
  StudentParentLinkDto,
  StudentParentRef,
} from '@wimb/shared';

/** jsonb assignment object as produced by ASSIGNMENT_JSON (repository). */
export interface AssignmentJson {
  id: string;
  direction: Direction;
  busId: string;
  busCode: string | null;
  busName: string | null;
  routeId: string;
  routeCode: string | null;
  routeName: string | null;
  stopId: string;
  stopName: string | null;
  stopSequence: number | null;
  expectedTime: string | null;
  validFrom: string;
  validTo: string | null;
  state: 'current' | 'upcoming' | 'ended';
  createdAt: string;
}

export interface StudentRow extends Record<string, unknown> {
  id: string;
  school_id: string;
  admission_no: string | null;
  full_name: string;
  class_name: string | null;
  section: string | null;
  roll_no: string | null;
  photo_file_id: string | null;
  notes: string | null;
  is_active: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

/** List/detail row: the student plus parent and assignment summaries from the same statement. */
export interface StudentListRow extends StudentRow {
  photo_key: string | null;
  photo_thumb_key: string | null;
  parent_count: number;
  primary_parent: StudentParentRef | null;
  morning: AssignmentJson | null;
  afternoon: AssignmentJson | null;
}

const iso = (v: string | null | undefined): string | null => (v ? new Date(v).toISOString() : null);

export function toAssignmentDto(a: AssignmentJson): StudentAssignmentDto {
  return {
    id: a.id,
    direction: a.direction,
    busId: a.busId,
    busCode: a.busCode ?? null,
    busName: a.busName ?? null,
    routeId: a.routeId,
    routeCode: a.routeCode ?? null,
    routeName: a.routeName ?? null,
    stopId: a.stopId,
    stopName: a.stopName ?? null,
    stopSequence: a.stopSequence ?? null,
    expectedTime: a.expectedTime ?? null,
    validFrom: a.validFrom,
    validTo: a.validTo ?? null,
    state: a.state,
    createdAt: iso(a.createdAt) ?? a.createdAt,
  };
}

/** Current-or-next assignment per direction from a list of effective rows. */
export function byDirection(rows: readonly StudentAssignmentDto[]): StudentAssignmentsByDirection {
  const pick = (d: Direction) => rows.filter((r) => r.direction === d && r.state !== 'ended').sort((x, y) => x.validFrom.localeCompare(y.validFrom))[0] ?? null;
  return { morning: pick('morning'), afternoon: pick('afternoon') };
}

export function toStudentListItem(r: StudentListRow, photoThumbnailUrl: string | null): StudentListItem {
  return {
    id: r.id,
    admissionNo: r.admission_no,
    fullName: r.full_name,
    className: r.class_name,
    section: r.section,
    rollNo: r.roll_no,
    isActive: r.is_active,
    photoFileId: r.photo_file_id,
    photoThumbnailUrl,
    parentCount: r.parent_count ?? 0,
    primaryParent: r.primary_parent ?? null,
    assignments: {
      morning: r.morning ? toAssignmentDto(r.morning) : null,
      afternoon: r.afternoon ? toAssignmentDto(r.afternoon) : null,
    },
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Audit snapshot of a student (plain columns only). */
export function studentAuditView(r: Record<string, unknown>) {
  return {
    admissionNo: r.admission_no,
    fullName: r.full_name,
    className: r.class_name,
    section: r.section,
    rollNo: r.roll_no,
    photoFileId: r.photo_file_id,
    notes: r.notes,
    isActive: r.is_active,
  };
}

export interface StudentParentLinkRow extends Record<string, unknown> {
  id: string;
  parent_account_id: string;
  full_name: string;
  phone: string;
  email: string | null;
  relation: string | null;
  is_primary: boolean;
  is_active: boolean;
  linked_at: string;
}

export function toParentLinkDto(r: StudentParentLinkRow): StudentParentLinkDto {
  return { id: r.id, fullName: r.full_name, phone: r.phone, email: r.email, relation: r.relation, isPrimary: r.is_primary, isActive: r.is_active, linkedAt: r.linked_at };
}

export interface SchoolParentRow extends Record<string, unknown> {
  id: string;
  school_id: string;
  parent_account_id: string;
  full_name: string;
  email: string | null;
  relation: string | null;
  alternate_phone: string | null;
  is_active: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ParentListRow extends SchoolParentRow {
  phone: string;
  has_signed_in: boolean;
  child_count: number;
  children: ParentChildDto[] | null;
}

export function toParentListItem(r: ParentListRow): ParentListItem {
  return {
    id: r.id,
    phone: r.phone,
    fullName: r.full_name,
    email: r.email,
    relation: r.relation,
    alternatePhone: r.alternate_phone,
    isActive: r.is_active,
    hasSignedIn: r.has_signed_in,
    childCount: r.child_count ?? 0,
    children: r.children ?? [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Audit snapshot of a school parent (school-specific columns + the phone). */
export function parentAuditView(r: Record<string, unknown>, phone?: string | null) {
  return {
    ...(phone !== undefined ? { phone } : {}),
    fullName: r.full_name,
    email: r.email,
    relation: r.relation,
    alternatePhone: r.alternate_phone,
    isActive: r.is_active,
  };
}
