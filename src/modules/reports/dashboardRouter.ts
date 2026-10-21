// Dashboard sub-router of the reports module (BP §8.3 Dashboard, §13.3 Dashboard). API: docs/api/reports.md.
//   GET /school/dashboard   today's operations for the school (one statement)
import { Router } from 'express';
import { createGuards, type GuardOptions } from '../../middleware/guards.js';
import * as c from './controller.js';

export function createDashboardRouter(guardOptions: GuardOptions = {}): Router {
  const r = Router();
  r.get('/school/dashboard', ...createGuards(guardOptions).schoolAdmin(), c.dashboard);
  return r;
}
