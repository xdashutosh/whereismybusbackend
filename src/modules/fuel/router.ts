// 'fuel' module router (BP §8.3 Fuel/Maintenance, §13.3 Fuel; contract §5). Mounted at /api/v1.
// School admins only (the /school area guard also applies). API: docs/api/fuel.md.
//   GET|POST /school/fuel-logs · GET|PATCH|DELETE /school/fuel-logs/:id
//   GET /school/fuel-logs/mileage-trend?busId · GET /school/fuel-logs/mileage-summary
import { Router } from 'express';
import { registerConstraintError } from '../../middleware/errorHandler.js';
import { createGuards, type GuardOptions } from '../../middleware/guards.js';
import { idempotency } from '../../middleware/idempotency.js';
import { validate } from '../../shared/validate.js';
import * as c from './controller.js';
import * as s from './schemas.js';

// Concurrent links of one uploaded file (migration 700) → 409 like the service's own check.
registerConstraintError('fuel_logs_bill_file_uq', 'CONFLICT', 'This file is already attached to another fuel log.');

export function createFuelRouter(guardOptions: GuardOptions = {}): Router {
  const r = Router();
  const admin = createGuards(guardOptions).schoolAdmin();
  const params = validate({ params: s.fuelLogParams });

  // Fixed sub-paths first: '/:id' only accepts UUIDs.
  r.get('/school/fuel-logs/mileage-trend', ...admin, validate({ query: s.mileageTrendQuery }), c.mileageTrend);
  r.get('/school/fuel-logs/mileage-summary', ...admin, validate({ query: s.mileageSummaryQuery }), c.mileageSummary);

  r.get('/school/fuel-logs', ...admin, validate({ query: s.fuelLogListQuery }), c.list);
  r.post('/school/fuel-logs', ...admin, idempotency(), validate({ body: s.createFuelLogBody }), c.create);
  r.get('/school/fuel-logs/:id', ...admin, params, c.get);
  r.patch('/school/fuel-logs/:id', ...admin, params, validate({ body: s.updateFuelLogBody }), c.update);
  r.delete('/school/fuel-logs/:id', ...admin, params, c.remove);
  return r;
}

export const router: Router = createFuelRouter();
export default router;
