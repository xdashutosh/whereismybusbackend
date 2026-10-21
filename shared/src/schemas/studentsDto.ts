// Response DTOs of the students module (camelCase JSON, contract §5). Storage keys never leave the
// server: photos carry short-lived signed URLs and a file id resolvable through GET /files/:id/url.
import type { Direction } from '../enums.js';

/** One assignment row (bus → route → stop) for a direction; validTo is exclusive (null = open). */
export interface StudentAssignmentDto {
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
  /** current = covers today (school-local); upcoming = starts later; ended = history. */
  state: 'current' | 'upcoming' | 'ended';
  createdAt: string;
}

/** Per direction: the current assignment, else the next upcoming one. */
export interface StudentAssignmentsByDirection {
  morning: StudentAssignmentDto | null;
  afternoon: StudentAssignmentDto | null;
}

export interface StudentParentRef {
  /** school parent id (/school/parents/:id). */
  id: string;
  fullName: string;
  phone: string;
}

export interface StudentListItem {
  id: string;
  admissionNo: string | null;
  fullName: string;
  className: string | null;
  section: string | null;
  rollNo: string | null;
  isActive: boolean;
  photoFileId: string | null;
  photoThumbnailUrl: string | null;
  parentCount: number;
  primaryParent: StudentParentRef | null;
  assignments: StudentAssignmentsByDirection;
  createdAt: string;
  updatedAt: string;
}

export interface StudentParentLinkDto extends StudentParentRef {
  email: string | null;
  /** Relation to this child (falls back to the parent's relation). */
  relation: string | null;
  isPrimary: boolean;
  isActive: boolean;
  linkedAt: string;
}

export interface StudentDetail extends StudentListItem {
  notes: string | null;
  photoUrl: string | null;
  parents: StudentParentLinkDto[];
  /** Every current and upcoming assignment row (history: GET …/assignment-history). */
  effectiveAssignments: StudentAssignmentDto[];
}

export interface AssignmentWarning {
  code: 'BUS_OVER_CAPACITY';
  busId: string;
  busCode: string;
  direction: Direction;
  capacity: number;
  assigned: number;
}

/** PUT /school/students/:id/assignment */
export interface StudentAssignmentResult {
  studentId: string;
  effectiveFrom: string;
  changed: Direction[];
  assignments: StudentAssignmentsByDirection;
  effectiveAssignments: StudentAssignmentDto[];
  warnings: AssignmentWarning[];
}

/** POST /school/assignments/bulk */
export interface BulkAssignmentResult {
  effectiveFrom: string;
  students: number;
  /** Rows created / closed per direction; unchanged = already exactly that assignment. */
  directions: { direction: Direction; assigned: number; ended: number; unchanged: number }[];
  warnings: AssignmentWarning[];
}

export interface ParentChildDto {
  studentId: string;
  fullName: string;
  admissionNo: string | null;
  className: string | null;
  section: string | null;
  relation: string | null;
  isPrimary: boolean;
}

export interface ParentListItem {
  /** school parent id (per school; the global account id is never exposed). */
  id: string;
  phone: string;
  fullName: string;
  email: string | null;
  relation: string | null;
  alternatePhone: string | null;
  isActive: boolean;
  /** The parent has signed in to the parent app at least once. */
  hasSignedIn: boolean;
  childCount: number;
  children: ParentChildDto[];
  createdAt: string;
  updatedAt: string;
}

export type ParentDetail = ParentListItem;

/** POST /school/parents/:id/reset-access */
export interface ResetParentAccessResult {
  parentId: string;
  /** Signed-in sessions ended (all devices; the parent signs in again with an OTP). */
  revokedSessions: number;
  /** The parent can request a sign-in code now. */
  otpReady: boolean;
  /** Why otpReady is false: PARENT_INACTIVE, ACCOUNT_INACTIVE, NO_ACTIVE_CHILD. */
  blockers: string[];
  /** A failed-password lock was cleared. */
  unlocked: boolean;
  /**
   * True when the parent (who has used this school) also uses another school: its sign-in is shared,
   * so sessions and a sign-in lock are not reset from here (revokedSessions 0, unlocked false).
   * Deactivating the parent still blocks it in this school.
   */
  sharedAccount?: boolean;
}

export interface ImportRowError {
  /** Spreadsheet row number (the header is row 1). */
  row: number;
  field: string | null;
  message: string;
}

export interface ImportRowPreview {
  row: number;
  /** create | update | unchanged | skip | error */
  action: 'create' | 'update' | 'unchanged' | 'skip' | 'error';
  key: string | null;
  name: string | null;
  /** Parent phones (student import) or admission numbers (parent import) on the row. */
  links: string[];
}

export interface ImportSummary {
  totalRows: number;
  validRows: number;
  errorRows: number;
  create: number;
  update: number;
  unchanged: number;
  skip: number;
  parentsCreated: number;
  parentsUpdated: number;
  links: number;
}

export interface ImportResult {
  dryRun: boolean;
  committed: boolean;
  fileId: string;
  format: 'csv' | 'xlsx';
  columns: string[];
  ignoredColumns: string[];
  summary: ImportSummary;
  errors: ImportRowError[];
  /** First rows of the preview (at most 200). */
  rows: ImportRowPreview[];
}
