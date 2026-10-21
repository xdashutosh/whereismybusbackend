// 'privacy' module router (BP §16 privacy and store policies, §13.1 school sign-in branding;
// docs/api/privacy.md). Mounted at /api/v1.
//   GET  /auth/legal                                  public: platform privacy policy / terms links + consent version
//   GET  /auth/school/branding?code=                  public: branding + legal links of an ACTIVE school (404 otherwise)
//   GET  /parent/consent                              parent: consent state per linked school (no X-School-Id)
//   POST /parent/consent                              parent (X-School-Id): accept the school's current consent version
//   GET  /school/privacy/students/:id/export          school admin: everything the school holds about a student (JSON)
//   POST /school/privacy/students/:id/erase           school admin: irreversible anonymisation ({ confirm: "ERASE" })
//   GET  /school/privacy/parents/:id/export           school admin: same for a parent (the school's parent id)
//   POST /school/privacy/parents/:id/erase            school admin: same for a parent
// Public routes are rate limited per IP (publicLookup) and cacheable for 60 s.
import { parentConsentBody, privacyEraseBody, schoolBrandingQuery, type ParentConsentBody, type PrivacyEraseBody, type SchoolBrandingQuery } from '@wimb/shared';
import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { createGuards, type GuardOptions } from '../../middleware/guards.js';
import { rateLimits as defaultRateLimits, type RateLimits } from '../../middleware/rateLimits.js';
import { ok } from '../../shared/envelope.js';
import { validate, validated } from '../../shared/validate.js';
import { acceptConsent, getConsent } from './consent.js';
import { eraseParent, eraseStudent } from './eraseService.js';
import { exportParent, exportStudent } from './exportService.js';
import { platformLegal, PUBLIC_CACHE_CONTROL, schoolBranding } from './legal.js';
import { idParams, type IdParams } from './schemas.js';

export interface PrivacyRouterDeps {
  guards?: GuardOptions;
  rateLimits?: RateLimits;
}

export function createPrivacyRouter({ guards: guardOptions = {}, rateLimits = defaultRateLimits }: PrivacyRouterDeps = {}): Router {
  const r = Router();
  const g = createGuards(guardOptions);
  const admin = g.schoolAdmin();
  const parentAny = [authenticate(guardOptions.authenticate), authorize('parent')];
  const id = validate({ params: idParams });
  const noStore = (res: { setHeader(k: string, v: string): unknown }) => res.setHeader('Cache-Control', 'no-store');

  // ── public ─────────────────────────────────────────────────────────────────
  r.get('/auth/legal', rateLimits.publicLookup, async (_req, res) => {
    res.setHeader('Cache-Control', PUBLIC_CACHE_CONTROL);
    ok(res, await platformLegal());
  });
  r.get('/auth/school/branding', rateLimits.publicLookup, validate({ query: schoolBrandingQuery }), async (req, res) => {
    const { code } = validated<SchoolBrandingQuery>(req, 'query');
    const dto = await schoolBranding(req, code);
    res.setHeader('Cache-Control', PUBLIC_CACHE_CONTROL);
    ok(res, dto);
  });

  // ── parents ────────────────────────────────────────────────────────────────
  r.get('/parent/consent', ...parentAny, async (req, res) => {
    noStore(res);
    ok(res, await getConsent(req));
  });
  r.post('/parent/consent', ...g.parent(), validate({ body: parentConsentBody }), async (req, res) => {
    noStore(res);
    ok(res, await acceptConsent(req, validated<ParentConsentBody>(req, 'body')));
  });

  // ── school admins ──────────────────────────────────────────────────────────
  r.get('/school/privacy/students/:id/export', ...admin, id, async (req, res) => {
    noStore(res);
    ok(res, await exportStudent(req, validated<IdParams>(req, 'params').id));
  });
  r.post('/school/privacy/students/:id/erase', ...admin, validate({ params: idParams, body: privacyEraseBody }), async (req, res) => {
    ok(res, await eraseStudent(req, validated<IdParams>(req, 'params').id, validated<PrivacyEraseBody>(req, 'body')));
  });
  r.get('/school/privacy/parents/:id/export', ...admin, id, async (req, res) => {
    noStore(res);
    ok(res, await exportParent(req, validated<IdParams>(req, 'params').id));
  });
  r.post('/school/privacy/parents/:id/erase', ...admin, validate({ params: idParams, body: privacyEraseBody }), async (req, res) => {
    ok(res, await eraseParent(req, validated<IdParams>(req, 'params').id, validated<PrivacyEraseBody>(req, 'body')));
  });
  return r;
}

export const router: Router = createPrivacyRouter();
export default router;
