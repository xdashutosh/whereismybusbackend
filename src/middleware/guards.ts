// Route guard chains (contract §4, BP §4.2 / §5.3). Every module mounts one of these instead of
// composing the middleware by hand:
//   guards.platform()              super admin; NEVER a school context (withPlatform in services)
//   guards.school(...roles)        authenticate → role gate → resolveTenant (staff/admins from the
//                                  token; parents via X-School-Id + active child link) → req.tenant
//   guards.schoolAdmin() · guards.staff() · guards.parent() · guards.schoolMember()
// The role gate runs before tenant resolution so a wrong role is refused without any lookup.
import type { Role } from '@wimb/shared';
import type { RequestHandler } from 'express';
import { authenticate, type AuthenticateOptions } from './authenticate.js';
import { authorize } from './authorize.js';
import { resolveTenant, type ResolveTenantOptions } from './resolveTenant.js';

export interface GuardOptions {
  authenticate?: AuthenticateOptions;
  tenant?: ResolveTenantOptions;
}

export function createGuards(opts: GuardOptions = {}) {
  const school = (...roles: Role[]): RequestHandler[] => {
    if (roles.includes('super_admin')) throw new TypeError('guards.school: super_admin never has a school context');
    return [authenticate(opts.authenticate), authorize(...roles), resolveTenant(opts.tenant)];
  };
  return {
    platform: (): RequestHandler[] => [authenticate(opts.authenticate), authorize('super_admin')],
    school,
    schoolAdmin: () => school('school_admin'),
    staff: () => school('driver', 'conductor'),
    parent: () => school('parent'),
    /** Any principal that belongs to a school (admins, staff, parents with X-School-Id). */
    schoolMember: () => school('school_admin', 'driver', 'conductor', 'parent'),
  };
}

export type Guards = ReturnType<typeof createGuards>;

/**
 * Area guards mounted by buildApiRouter in front of EVERY module router (defence in depth: a route
 * under these prefixes can never be reached without authentication, the area's role and — for
 * school/driver areas — an active school context, even if its module forgot a guard). Route guards
 * still declare the exact roles; authentication and tenant resolution run once per request.
 *   /platform/*  super admin (no school context, ever)
 *   /school/*    school admin + resolveTenant
 *   /driver/*    driver/conductor + resolveTenant
 *   /parent/*    parent (X-School-Id is resolved per route: /parent/children spans schools)
 */
export function areaGuards(opts: GuardOptions = {}): readonly (readonly [string, RequestHandler[]])[] {
  const g = createGuards(opts);
  return [
    ['/platform', g.platform()],
    ['/school', g.schoolAdmin()],
    ['/driver', g.staff()],
    ['/parent', [authenticate(opts.authenticate), authorize('parent')]],
  ];
}

/** Process-wide guards with the default session/school loaders. */
export const guards: Guards = createGuards();
