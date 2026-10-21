// 'staff' module router (BP §8.3 Staff, §5.4, §13.3 Staff; contract §5). Mounted at /api/v1 by
// src/modules/index.ts. School admins only (the /school area guard also applies). API reference:
// docs/api/staff.md.
//   GET|POST /school/staff · GET|PATCH|DELETE /school/staff/:id
//   POST /school/staff/:id/credentials · /activate · /deactivate · /sessions/revoke
//   GET /school/staff/:id/assignment-history · GET /school/staff/:id/parent-preview
//   GET|POST /school/staff/:id/documents
//   GET|PUT|PATCH|DELETE /school/staff-documents/:docId · PATCH …/:docId/visibility · PATCH …/:docId/verify
import { Router } from 'express';
import { createGuards, type GuardOptions } from '../../middleware/guards.js';
import { idempotency } from '../../middleware/idempotency.js';
import { validate } from '../../shared/validate.js';
import * as c from './controller.js';
import './fileHooks.js';
import * as s from './schemas.js';

export function createStaffRouter(guardOptions: GuardOptions = {}): Router {
  const r = Router();
  const admin = createGuards(guardOptions).schoolAdmin();
  const params = validate({ params: s.staffParams });
  const docParams = validate({ params: s.staffDocumentParams });

  r.get('/school/staff', ...admin, validate({ query: s.staffListQuery }), c.list);
  r.post('/school/staff', ...admin, idempotency(), validate({ body: s.createStaffBody }), c.create);
  r.get('/school/staff/:id', ...admin, params, c.get);
  r.patch('/school/staff/:id', ...admin, params, validate({ body: s.updateStaffBody }), c.update);
  r.delete('/school/staff/:id', ...admin, params, c.remove);
  r.post('/school/staff/:id/credentials', ...admin, params, validate({ body: s.credentialsBody }), c.credentials);
  r.post('/school/staff/:id/activate', ...admin, params, c.activate);
  r.post('/school/staff/:id/deactivate', ...admin, params, validate({ body: s.deactivateBody }), c.deactivate);
  r.post('/school/staff/:id/sessions/revoke', ...admin, params, c.revokeSessions);
  r.get('/school/staff/:id/assignment-history', ...admin, params, validate({ query: s.staffAssignmentHistoryQuery }), c.assignmentHistory);
  r.get('/school/staff/:id/parent-preview', ...admin, params, c.parentPreview);

  r.get('/school/staff/:id/documents', ...admin, params, validate({ query: s.staffDocumentsQuery }), c.listDocuments);
  r.post('/school/staff/:id/documents', ...admin, idempotency(), params, validate({ body: s.createStaffDocumentBody }), c.createDocument);
  r.get('/school/staff-documents/:docId', ...admin, docParams, c.getDocument);
  r.put('/school/staff-documents/:docId', ...admin, idempotency(), docParams, validate({ body: s.replaceStaffDocumentBody }), c.replaceDocument);
  r.patch('/school/staff-documents/:docId', ...admin, docParams, validate({ body: s.updateStaffDocumentBody }), c.updateDocument);
  r.patch('/school/staff-documents/:docId/visibility', ...admin, docParams, validate({ body: s.staffDocumentVisibilityBody }), c.setDocumentVisibility);
  r.patch('/school/staff-documents/:docId/verify', ...admin, docParams, validate({ body: s.verifyStaffDocumentBody }), c.verifyDocument);
  r.delete('/school/staff-documents/:docId', ...admin, docParams, c.removeDocument);
  return r;
}

export const router: Router = createStaffRouter();
export default router;
