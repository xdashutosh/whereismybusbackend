// 'buses' module router (BP §8.3 Buses + Bus documents, §13.3; contract §5). Mounted at /api/v1.
// School admins only (the /school area guard also applies). API: docs/api/buses.md.
//   GET|POST /school/buses · GET|PATCH|DELETE /school/buses/:id · PATCH /school/buses/:id/status
//   GET|POST /school/buses/:id/images · PUT /school/buses/:id/images/order
//   PATCH|DELETE /school/buses/:id/images/:imageId
//   POST /school/buses/:id/assign-staff · GET /school/buses/:id/assignment-history
//   GET|POST /school/buses/:id/documents
//   GET|PUT|PATCH|DELETE /school/bus-documents/:docId · PATCH …/:docId/visibility · PATCH …/:docId/verify
import { Router } from 'express';
import { registerConstraintError } from '../../middleware/errorHandler.js';
import { createGuards, type GuardOptions } from '../../middleware/guards.js';
import { idempotency } from '../../middleware/idempotency.js';
import { validate } from '../../shared/validate.js';
import * as c from './controller.js';
import './fileHooks.js';
import * as s from './schemas.js';

registerConstraintError('buses_code_uq', 'DUPLICATE', 'A bus with this code already exists.');
registerConstraintError('buses_registration_uq', 'DUPLICATE', 'A bus with this registration number already exists.');
registerConstraintError('one_primary_driver', 'CONFLICT', 'The bus already has a primary driver.');
registerConstraintError('bus_staff_assignments_no_overlap', 'CONFLICT', 'This staff member is already assigned to the bus for that period.');
registerConstraintError('bus_documents_one_current', 'CONFLICT', 'The bus already has a current document of this type. Replace it instead.');

export function createBusesRouter(guardOptions: GuardOptions = {}): Router {
  const r = Router();
  const admin = createGuards(guardOptions).schoolAdmin();
  const params = validate({ params: s.busParams });
  const imageParams = validate({ params: s.busImageParams });
  const docParams = validate({ params: s.busDocumentParams });

  r.get('/school/buses', ...admin, validate({ query: s.busListQuery }), c.list);
  r.post('/school/buses', ...admin, idempotency(), validate({ body: s.createBusBody }), c.create);
  r.get('/school/buses/:id', ...admin, params, c.get);
  r.patch('/school/buses/:id', ...admin, params, validate({ body: s.updateBusBody }), c.update);
  r.delete('/school/buses/:id', ...admin, params, c.remove);
  r.patch('/school/buses/:id/status', ...admin, params, validate({ body: s.busStatusBody }), c.changeStatus);

  r.get('/school/buses/:id/images', ...admin, params, c.listImages);
  r.post('/school/buses/:id/images', ...admin, idempotency(), params, validate({ body: s.addBusImageBody }), c.addImage);
  r.put('/school/buses/:id/images/order', ...admin, params, validate({ body: s.reorderBusImagesBody }), c.reorderImages);
  r.patch('/school/buses/:id/images/:imageId', ...admin, imageParams, validate({ body: s.updateBusImageBody }), c.updateImage);
  r.delete('/school/buses/:id/images/:imageId', ...admin, imageParams, c.removeImage);

  r.post('/school/buses/:id/assign-staff', ...admin, params, validate({ body: s.assignStaffBody }), c.assignStaff);
  r.get('/school/buses/:id/assignment-history', ...admin, params, validate({ query: s.assignmentHistoryQuery }), c.assignmentHistory);

  r.get('/school/buses/:id/documents', ...admin, params, validate({ query: s.busDocumentsQuery }), c.listDocuments);
  r.post('/school/buses/:id/documents', ...admin, idempotency(), params, validate({ body: s.createBusDocumentBody }), c.createDocument);
  r.get('/school/bus-documents/:docId', ...admin, docParams, c.getDocument);
  r.put('/school/bus-documents/:docId', ...admin, idempotency(), docParams, validate({ body: s.replaceBusDocumentBody }), c.replaceDocument);
  r.patch('/school/bus-documents/:docId', ...admin, docParams, validate({ body: s.updateBusDocumentBody }), c.updateDocument);
  r.patch('/school/bus-documents/:docId/visibility', ...admin, docParams, validate({ body: s.busDocumentVisibilityBody }), c.setDocumentVisibility);
  r.patch('/school/bus-documents/:docId/verify', ...admin, docParams, validate({ body: s.verifyBusDocumentBody }), c.verifyDocument);
  r.delete('/school/bus-documents/:docId', ...admin, docParams, c.removeDocument);
  return r;
}

export const router: Router = createBusesRouter();
export default router;
