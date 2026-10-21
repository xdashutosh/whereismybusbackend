// Role gate (BP §5.3 layer 1). Runs after authenticate(): 401 without auth, 403 for other roles.
// Ownership checks live in services; RLS is the final backstop.
import type { Role } from '@wimb/shared';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { forbidden, unauthenticated } from '../shared/errors.js';

export function authorize(...roles: (Role | readonly Role[])[]): RequestHandler {
  const allowed: ReadonlySet<Role> = new Set(roles.flat());
  if (allowed.size === 0) throw new TypeError('authorize needs at least one role');
  return function authorizeMiddleware(req: Request, _res: Response, next: NextFunction) {
    if (!req.auth) return next(unauthenticated());
    if (!allowed.has(req.auth.role)) return next(forbidden());
    return next();
  };
}

export const SCHOOL_STAFF_APP_ROLES: readonly Role[] = ['driver', 'conductor'];
