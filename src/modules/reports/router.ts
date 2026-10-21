// 'reports' module router (BP §7.1, §8.3 Reports + Dashboard, §13.3). Mounted at /api/v1 by
// src/modules/index.ts. API: docs/api/reports.md.
//   GET /school/reports/{bus-distance|fuel|maintenance|cost-per-km|service-due|non-school-usage|trip-summary}
//       ?from&to&busId&format=json|csv|pdf   (one aggregate query per report; school's `reports` feature)
//   GET /school/dashboard                    (dashboardRouter.ts)
// Unknown report kinds fall through to 404 NOT_FOUND.
import { REPORT_KINDS } from '@wimb/shared';
import { Router } from 'express';
import { createGuards, type GuardOptions } from '../../middleware/guards.js';
import { validate } from '../../shared/validate.js';
import * as c from './controller.js';
import { createDashboardRouter } from './dashboardRouter.js';
import { reportQuery } from './schemas.js';

export function createReportsRouter(guardOptions: GuardOptions = {}): Router {
  const r = Router();
  const admin = createGuards(guardOptions).schoolAdmin();
  const query = validate({ query: reportQuery });
  for (const kind of REPORT_KINDS) r.get(`/school/reports/${kind}`, ...admin, query, c.report(kind));
  r.use(createDashboardRouter(guardOptions));
  return r;
}

export const router: Router = createReportsRouter();
export default router;
