// 'maintenance' module router (BP §8.3 Fuel/Maintenance, §13.3 Maintenance; contract §5). Mounted at
// /api/v1. School admins only (the /school area guard also applies). API: docs/api/maintenance.md.
//   GET|POST /school/maintenance-logs · GET|PATCH|DELETE /school/maintenance-logs/:id
//   GET /school/maintenance-logs/due (service due list, same rules as maintenance-due-scan)
import { Router } from 'express';
import { registerConstraintError } from '../../middleware/errorHandler.js';
import { createGuards, type GuardOptions } from '../../middleware/guards.js';
import { idempotency } from '../../middleware/idempotency.js';
import { validate } from '../../shared/validate.js';
import * as c from './controller.js';
import * as s from './schemas.js';

// Concurrent links of one uploaded file (migration 700) → 409 like the service's own check.
registerConstraintError('maintenance_logs_invoice_file_uq', 'CONFLICT', 'This file is already attached to another maintenance log.');

export function createMaintenanceRouter(guardOptions: GuardOptions = {}): Router {
  const r = Router();
  const admin = createGuards(guardOptions).schoolAdmin();
  const params = validate({ params: s.maintenanceLogParams });

  // Fixed sub-path first: '/:id' only accepts UUIDs.
  r.get('/school/maintenance-logs/due', ...admin, validate({ query: s.maintenanceDueQuery }), c.due);

  r.get('/school/maintenance-logs', ...admin, validate({ query: s.maintenanceLogListQuery }), c.list);
  r.post('/school/maintenance-logs', ...admin, idempotency(), validate({ body: s.createMaintenanceLogBody }), c.create);
  r.get('/school/maintenance-logs/:id', ...admin, params, c.get);
  r.patch('/school/maintenance-logs/:id', ...admin, params, validate({ body: s.updateMaintenanceLogBody }), c.update);
  r.delete('/school/maintenance-logs/:id', ...admin, params, c.remove);
  return r;
}

export const router: Router = createMaintenanceRouter();
export default router;
