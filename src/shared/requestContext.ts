// Per-request context (AsyncLocalStorage): request id, client ip/user agent and the resolved actor,
// so deep helpers (audit.log, logging) can read them without threading `req` through services.
// Set by middleware/requestId (ids, ip, ua) and authenticate/resolveTenant (actor, school).
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ActorRole } from '@wimb/shared';

export interface RequestContext {
  requestId: string;
  ip: string | null;
  userAgent: string | null;
  actorId?: string | null;
  actorRole?: ActorRole | null;
  actorName?: string | null;
  schoolId?: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Runs fn with a fresh context. */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** Current context (undefined outside a request, e.g. jobs). */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Merges fields into the current context (no-op outside a request). */
export function updateRequestContext(patch: Partial<RequestContext>): void {
  const ctx = storage.getStore();
  if (ctx) Object.assign(ctx, patch);
}
