// 'audit' module router (BP §8.2, §8.3, §13.3; contract §5). Mounted at /api/v1.
//   GET /school/audit-logs     school admins — their school's trail (filters, pagination, ?format=csv)
//   GET /platform/audit-logs   super admins — platform-level actions only
// Writes happen in every module through shared/audit.ts (same transaction, secrets redacted).
import { Router } from 'express';
import { createGuards, type GuardOptions } from '../../middleware/guards.js';
import { validate, validated } from '../../shared/validate.js';
import { auditListQuery, type AuditListQuery } from './schemas.js';
import { listPlatform, listSchool } from './service.js';

export function createAuditRouter(guardOptions: GuardOptions = {}): Router {
  const r = Router();
  const g = createGuards(guardOptions);
  r.get('/school/audit-logs', ...g.schoolAdmin(), validate({ query: auditListQuery }), (req, res) => listSchool(req, res, validated<AuditListQuery>(req, 'query')));
  r.get('/platform/audit-logs', ...g.platform(), validate({ query: auditListQuery }), (req, res) => listPlatform(req, res, validated<AuditListQuery>(req, 'query')));
  return r;
}

export const router: Router = createAuditRouter();
export default router;
