// HTTP layer of the students module: read req.valid, call the service, send the envelope.
import type { Request, Response } from 'express';
import { created, ok } from '../../shared/envelope.js';
import { validated } from '../../shared/validate.js';
import * as assignments from './assignmentsService.js';
import { sendTemplate } from './import/templates.js';
import * as imports from './importService.js';
import * as parents from './parentsService.js';
import type * as s from './schemas.js';
import * as students from './service.js';

const idOf = (req: Request) => validated<s.StudentParams>(req, 'params').id;

// ── students ─────────────────────────────────────────────────────────────────
export const list = (req: Request, res: Response) => students.list(req, res, validated<s.StudentListQuery>(req, 'query'));
export async function get(req: Request, res: Response) {
  ok(res, await students.get(req, idOf(req)));
}
export async function create(req: Request, res: Response) {
  created(res, await students.create(req, validated<s.CreateStudentBody>(req, 'body')));
}
export async function update(req: Request, res: Response) {
  ok(res, await students.update(req, idOf(req), validated<s.UpdateStudentBody>(req, 'body')));
}
export async function remove(req: Request, res: Response) {
  ok(res, await students.remove(req, idOf(req)));
}

// ── parent links ─────────────────────────────────────────────────────────────
export async function changeLink(req: Request, res: Response) {
  ok(res, await parents.changeLink(req, idOf(req), validated<s.StudentParentLinkBody>(req, 'body')));
}
export async function unlink(req: Request, res: Response) {
  const p = validated<s.StudentParentParams>(req, 'params');
  ok(res, await parents.unlink(req, p.id, p.parentId));
}

// ── assignments ──────────────────────────────────────────────────────────────
export async function assign(req: Request, res: Response) {
  ok(res, await assignments.assign(req, idOf(req), validated<s.StudentAssignmentBody>(req, 'body')));
}
export const assignmentHistory = (req: Request, res: Response) =>
  assignments.history(req, res, idOf(req), validated<s.StudentAssignmentHistoryQuery>(req, 'query'));
export async function bulkAssign(req: Request, res: Response) {
  ok(res, await assignments.bulkAssign(req, validated<s.BulkAssignmentBody>(req, 'body')));
}

// ── imports ──────────────────────────────────────────────────────────────────
export async function importStudents(req: Request, res: Response) {
  ok(res, await imports.importStudents(req, validated<s.ImportBody>(req, 'body')));
}
export async function importParents(req: Request, res: Response) {
  ok(res, await imports.importParents(req, validated<s.ImportBody>(req, 'body')));
}
export const studentTemplate = (req: Request, res: Response) => sendTemplate(res, 'students', validated<s.ImportTemplateQuery>(req, 'query').format);
export const parentTemplate = (req: Request, res: Response) => sendTemplate(res, 'parents', validated<s.ImportTemplateQuery>(req, 'query').format);

// ── parents ──────────────────────────────────────────────────────────────────
const parentIdOf = (req: Request) => validated<s.ParentParams>(req, 'params').id;
export const listParents = (req: Request, res: Response) => parents.list(req, res, validated<s.ParentListQuery>(req, 'query'));
export async function getParent(req: Request, res: Response) {
  ok(res, await parents.get(req, parentIdOf(req)));
}
export async function createParent(req: Request, res: Response) {
  created(res, await parents.create(req, validated<s.CreateParentBody>(req, 'body')));
}
export async function updateParent(req: Request, res: Response) {
  ok(res, await parents.update(req, parentIdOf(req), validated<s.UpdateParentBody>(req, 'body')));
}
export async function removeParent(req: Request, res: Response) {
  ok(res, await parents.remove(req, parentIdOf(req)));
}
export async function revokeParentSessions(req: Request, res: Response) {
  ok(res, await parents.revokeSessions(req, parentIdOf(req)));
}
export async function resetParentAccess(req: Request, res: Response) {
  ok(res, await parents.resetAccess(req, parentIdOf(req), validated<s.ResetParentAccessBody>(req, 'body')));
}
