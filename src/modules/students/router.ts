// 'students' module router (BP §8.3 Students, Parents, Assignments; §13.3; contract §5). Mounted at
// /api/v1. School admins only (the /school area guard also applies). API: docs/api/students.md.
//   GET|POST /school/students · GET /school/students/import/template · POST /school/students/import
//   GET|PATCH|DELETE /school/students/:id
//   POST /school/students/:id/parents · DELETE /school/students/:id/parents/:parentId
//   PUT /school/students/:id/assignment · GET /school/students/:id/assignment-history
//   POST /school/assignments/bulk
//   GET|POST /school/parents · GET /school/parents/import/template · POST /school/parents/import
//   GET|PATCH|DELETE /school/parents/:id · POST /school/parents/:id/reset-access · /sessions/revoke
import { Router } from 'express';
import { registerConstraintError } from '../../middleware/errorHandler.js';
import { createGuards, type GuardOptions } from '../../middleware/guards.js';
import { idempotency } from '../../middleware/idempotency.js';
import { validate } from '../../shared/validate.js';
import * as c from './controller.js';
import './fileHooks.js';
import * as s from './schemas.js';

registerConstraintError('students_admission_uq', 'DUPLICATE', 'A student with this admission number already exists.');
registerConstraintError('one_open_assignment', 'CONFLICT', 'The student already has an assignment for this direction.');
registerConstraintError('student_assignments_no_overlap', 'CONFLICT', 'The assignment overlaps another assignment of the student.');
registerConstraintError('school_parents_school_id_parent_account_id_key', 'DUPLICATE', 'A parent with this mobile number is already registered in your school.');
registerConstraintError('parent_accounts_phone_key', 'DUPLICATE', 'Another parent already uses this mobile number.');

export function createStudentsRouter(guardOptions: GuardOptions = {}): Router {
  const r = Router();
  const admin = createGuards(guardOptions).schoolAdmin();
  const params = validate({ params: s.studentParams });
  const parentParams = validate({ params: s.parentParams });
  const template = validate({ query: s.importTemplateQuery });
  const importBody = validate({ body: s.importBody });

  r.get('/school/students', ...admin, validate({ query: s.studentListQuery }), c.list);
  r.post('/school/students', ...admin, idempotency(), validate({ body: s.createStudentBody }), c.create);
  r.get('/school/students/import/template', ...admin, template, c.studentTemplate);
  r.post('/school/students/import', ...admin, idempotency(), importBody, c.importStudents);
  r.get('/school/students/:id', ...admin, params, c.get);
  r.patch('/school/students/:id', ...admin, params, validate({ body: s.updateStudentBody }), c.update);
  r.delete('/school/students/:id', ...admin, params, c.remove);
  r.post('/school/students/:id/parents', ...admin, params, validate({ body: s.studentParentLinkBody }), c.changeLink);
  r.delete('/school/students/:id/parents/:parentId', ...admin, validate({ params: s.studentParentParams }), c.unlink);
  r.put('/school/students/:id/assignment', ...admin, params, validate({ body: s.studentAssignmentBody }), c.assign);
  r.get('/school/students/:id/assignment-history', ...admin, params, validate({ query: s.studentAssignmentHistoryQuery }), c.assignmentHistory);
  r.post('/school/assignments/bulk', ...admin, validate({ body: s.bulkAssignmentBody }), c.bulkAssign);

  r.get('/school/parents', ...admin, validate({ query: s.parentListQuery }), c.listParents);
  r.post('/school/parents', ...admin, idempotency(), validate({ body: s.createParentBody }), c.createParent);
  r.get('/school/parents/import/template', ...admin, template, c.parentTemplate);
  r.post('/school/parents/import', ...admin, idempotency(), importBody, c.importParents);
  r.get('/school/parents/:id', ...admin, parentParams, c.getParent);
  r.patch('/school/parents/:id', ...admin, parentParams, validate({ body: s.updateParentBody }), c.updateParent);
  r.delete('/school/parents/:id', ...admin, parentParams, c.removeParent);
  r.post('/school/parents/:id/reset-access', ...admin, parentParams, validate({ body: s.resetParentAccessBody }), c.resetParentAccess);
  r.post('/school/parents/:id/sessions/revoke', ...admin, parentParams, c.revokeParentSessions);
  return r;
}

export const router: Router = createStudentsRouter();
export default router;
