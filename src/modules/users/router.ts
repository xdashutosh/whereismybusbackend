// 'users' module router (BP §8.3 Admin users, §13.3 Users & Roles; contract §6). Mounted at
// /api/v1 by src/modules/index.ts. School admins manage the other school admins of their school;
// drivers/conductors are managed by the staff module. API reference: docs/api/users.md.
//   GET/POST          /school/admins
//   GET/PATCH/DELETE  /school/admins/:id
//   POST              /school/admins/:id/reset-access · /activate · /deactivate · /sessions/revoke
import { Router, type Request } from 'express';
import { createGuards, type GuardOptions } from '../../middleware/guards.js';
import { created, ok } from '../../shared/envelope.js';
import { validate, validated } from '../../shared/validate.js';
import {
  adminListQuery,
  createAdminBody,
  deactivateBody,
  idParams,
  resetAccessBody,
  updateAdminBody,
  type AdminListQuery,
  type CreateAdminBody,
  type DeactivateBody,
  type IdParams,
  type ResetAccessBody,
  type UpdateAdminBody,
} from './schemas.js';
import * as service from './service.js';

const idOf = (req: Request) => validated<IdParams>(req, 'params').id;

export function createUsersRouter(guardOptions: GuardOptions = {}): Router {
  const r = Router();
  const admin = createGuards(guardOptions).schoolAdmin();

  r.get('/school/admins', ...admin, validate({ query: adminListQuery }), (req, res) => service.list(req, res, validated<AdminListQuery>(req, 'query')));
  // No idempotency(): the response may carry a generated temporary password, which the replay store
  // would keep for 24 h (same rule as POST /platform/schools). A retry answers 409 DUPLICATE on the
  // e-mail; a lost password is replaced with POST /school/admins/:id/reset-access.
  r.post('/school/admins', ...admin, validate({ body: createAdminBody }), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    created(res, await service.create(req, validated<CreateAdminBody>(req, 'body')));
  });
  r.get('/school/admins/:id', ...admin, validate({ params: idParams }), async (req, res) => {
    ok(res, await service.get(req, idOf(req)));
  });
  r.patch('/school/admins/:id', ...admin, validate({ params: idParams, body: updateAdminBody }), async (req, res) => {
    ok(res, await service.update(req, idOf(req), validated<UpdateAdminBody>(req, 'body')));
  });
  r.delete('/school/admins/:id', ...admin, validate({ params: idParams }), async (req, res) => {
    const id = idOf(req);
    await service.remove(req, id);
    ok(res, { id, deleted: true }); // same delete envelope as every other module
  });
  r.post('/school/admins/:id/reset-access', ...admin, validate({ params: idParams, body: resetAccessBody }), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    ok(res, await service.resetAccess(req, idOf(req), validated<ResetAccessBody>(req, 'body')));
  });
  r.post('/school/admins/:id/activate', ...admin, validate({ params: idParams }), async (req, res) => {
    ok(res, await service.activate(req, idOf(req)));
  });
  r.post('/school/admins/:id/deactivate', ...admin, validate({ params: idParams, body: deactivateBody }), async (req, res) => {
    ok(res, await service.deactivate(req, idOf(req), validated<DeactivateBody>(req, 'body')));
  });
  r.post('/school/admins/:id/sessions/revoke', ...admin, validate({ params: idParams }), async (req, res) => {
    ok(res, await service.revokeSessions(req, idOf(req)));
  });
  return r;
}

export const router: Router = createUsersRouter();
export default router;
