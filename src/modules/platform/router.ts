// 'platform' module router (BP §8.2, §13.2, §20; contract §9). Mounted at /api/v1. Super Admin only
// (guards.platform(): never a school context — services use withPlatform):
//   GET/POST   /platform/schools                          list (search, filters, CSV) · create with initial admin
//   GET/PATCH  /platform/schools/:id                      details (admins, subscription, usage) · edit
//   DELETE     /platform/schools/:id                      soft delete (deactivated schools only)
//   POST       /platform/schools/:id/activate | /deactivate
//   POST       /platform/schools/:id/admin/reset-password
//   POST/DELETE /platform/schools/:id/logo                multipart upload into the school's scope · remove
//   GET/PUT    /platform/schools/:id/subscription         plan, limits, validity, modules
//   GET/PUT    /platform/settings                         global defaults
//   GET        /platform/health                           counts + API/DB/Redis/queue health
//   GET        /platform/usage                            per-school counts vs plan limits (CSV)
// (GET /platform/audit-logs is served by the audit module.)
import { optionalText } from '@wimb/shared';
import { Router } from 'express';
import { z } from 'zod';
import { createGuards, type GuardOptions } from '../../middleware/guards.js';
import { rateLimits as defaultRateLimits, type RateLimits } from '../../middleware/rateLimits.js';
import { uploadSingle } from '../../shared/uploads.js';
import { validate } from '../../shared/validate.js';
import * as c from './controller.js';
import {
  activateSchoolBody,
  createSchoolBody,
  deactivateSchoolBody,
  idParams,
  platformSettingsBody,
  resetAdminPasswordBody,
  schoolListQuery,
  subscriptionBody,
  updateSchoolBody,
  usageListQuery,
} from './schemas.js';
import './subscription.js';

export interface PlatformRouterDeps {
  guards?: GuardOptions;
  rateLimits?: RateLimits;
}

const deleteBody = z.object({ reason: optionalText(500) });
/** Bodies are optional on lifecycle actions (DELETE / activate / deactivate without JSON). */
const optionalBody = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => v ?? {}, schema);

export function createPlatformRouter({ guards: guardOptions = {}, rateLimits = defaultRateLimits }: PlatformRouterDeps = {}): Router {
  const r = Router();
  const platform = createGuards(guardOptions).platform();
  const id = validate({ params: idParams });

  r.get('/platform/schools', ...platform, validate({ query: schoolListQuery }), c.list);
  r.post('/platform/schools', ...platform, validate({ body: createSchoolBody }), c.create);
  r.get('/platform/schools/:id', ...platform, id, c.detail);
  r.patch('/platform/schools/:id', ...platform, validate({ params: idParams, body: updateSchoolBody }), c.update);
  r.delete('/platform/schools/:id', ...platform, validate({ params: idParams, body: optionalBody(deleteBody) }), c.remove);
  r.post('/platform/schools/:id/activate', ...platform, validate({ params: idParams, body: optionalBody(activateSchoolBody) }), c.activate);
  r.post('/platform/schools/:id/deactivate', ...platform, validate({ params: idParams, body: optionalBody(deactivateSchoolBody) }), c.deactivate);
  r.post('/platform/schools/:id/admin/reset-password', ...platform, validate({ params: idParams, body: optionalBody(resetAdminPasswordBody) }), c.resetPassword);
  r.post('/platform/schools/:id/logo', ...platform, rateLimits.upload, id, uploadSingle('PHOTO'), c.logoUpload);
  r.delete('/platform/schools/:id/logo', ...platform, id, c.logoRemove);
  r.get('/platform/schools/:id/subscription', ...platform, id, c.subscription);
  r.put('/platform/schools/:id/subscription', ...platform, validate({ params: idParams, body: subscriptionBody }), c.subscriptionPut);
  r.get('/platform/settings', ...platform, c.settings);
  r.put('/platform/settings', ...platform, validate({ body: platformSettingsBody }), c.settingsPut);
  r.get('/platform/health', ...platform, c.health);
  r.get('/platform/usage', ...platform, validate({ query: usageListQuery }), c.usage);
  return r;
}

export const router: Router = createPlatformRouter();
export default router;
