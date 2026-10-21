// Tenant resolution (contract §4, BP §4.2 / App. B / App. C). Runs after authenticate():
//   staff/admins → school from the verified token (headers/bodies never grant a school)
//   parents      → school from X-School-Id, accepted only with an active child link there
//                  (parent_children_index(parent_id), SECURITY DEFINER — contract §4)
//   super_admin  → 403 (platform routes never resolve a tenant)
// Then the school must exist, be active and not deleted (else 403 SCHOOL_INACTIVE), and every
// registered subscription check must pass (contract §9 limits). Sets req.tenant.
// School state is cached per process for SCHOOL_CACHE_TTL_MS and evicted on school.status_changed,
// so a suspension is enforced within seconds (BP App. C: within one token lifetime).
import { HEADERS, type SchoolStatus, type TenantMode } from '@wimb/shared';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { LRUCache } from 'lru-cache';
import { definerQuery } from '../db/definer.js';
import { withTenant, type TenantContext, type Tx, type TxOptions } from '../db/tenant.js';
import { forbidden, schoolInactive, unauthenticated, validationError } from '../shared/errors.js';
import { events } from '../shared/events.js';
import { updateRequestContext } from '../shared/requestContext.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SCHOOL_CACHE_TTL_MS = 15_000;

export interface SchoolState {
  id: string;
  status: SchoolStatus;
  deleted: boolean;
  timezone: string;
  tenantMode: TenantMode;
  dbConnectionRef: string | null;
}

export interface RequestTenant {
  schoolId: string;
  timezone: string;
  tenantMode: TenantMode;
  dbConnectionRef: string | null;
}

declare module 'express-serve-static-core' {
  interface Request {
    tenant?: RequestTenant;
  }
}

export type SchoolStateLoader = (schoolId: string) => Promise<SchoolState | null>;
export type ParentLinkCheck = (parentId: string, schoolId: string) => Promise<boolean>;
/** Throws an AppError to reject (e.g. subscription expired → SCHOOL_INACTIVE). `req` is null for socket joins. */
export type SubscriptionCheck = (school: SchoolState, req: Request | null) => Promise<void>;

/** Default: the school row read inside that school's own tenant context (RLS: id = app.school_id). */
export const loadSchoolStateFromDb: SchoolStateLoader = async (schoolId) => {
  const row = await withTenant(
    { schoolId, actorId: null, role: 'system' },
    (tx) =>
      tx.maybeOne<{ id: string; status: SchoolStatus; deleted_at: string | null; timezone: string; tenant_mode: TenantMode | null; db_connection_ref: string | null }>(
        'select id, status, deleted_at, timezone, tenant_mode, db_connection_ref from schools where id = $1',
        [schoolId],
      ),
    { readOnly: true },
  );
  if (!row) return null;
  return { id: row.id, status: row.status, deleted: row.deleted_at !== null, timezone: row.timezone, tenantMode: row.tenant_mode ?? 'shared', dbConnectionRef: row.db_connection_ref };
};

/** Default: one statement against parent_children_index() (no tenant context needed). */
export const parentLinkFromDb: ParentLinkCheck = async (parentId, schoolId) => {
  const rows = await definerQuery('select 1 as ok from parent_children_index($1::uuid) where school_id = $2::uuid limit 1', [parentId, schoolId]);
  return rows.length > 0;
};

const subscriptionChecks: SubscriptionCheck[] = [];
/** Registers a check run for every tenant request (subscription limits/validity). Returns an unregister fn. */
export function registerSubscriptionCheck(check: SubscriptionCheck): () => void {
  subscriptionChecks.push(check);
  return () => {
    const i = subscriptionChecks.indexOf(check);
    if (i >= 0) subscriptionChecks.splice(i, 1);
  };
}

/** Runs every registered subscription check (HTTP requests and socket handshakes/joins). */
export async function runSubscriptionChecks(school: SchoolState, req: Request | null = null): Promise<void> {
  for (const check of subscriptionChecks) await check(school, req);
}

const schoolCache = new LRUCache<string, SchoolState>({ max: 5000, ttl: SCHOOL_CACHE_TTL_MS });
events.on('school.status_changed', ({ schoolId }) => {
  schoolCache.delete(schoolId);
});
/** Drops cached school state (one school, or all). */
export function invalidateSchoolState(schoolId?: string): void {
  if (schoolId) schoolCache.delete(schoolId);
  else schoolCache.clear();
}

export interface ResolveTenantOptions {
  loadSchool?: SchoolStateLoader;
  parentLink?: ParentLinkCheck;
  /** Cache school state (default true). */
  cache?: boolean;
}

/** Principal for which req.tenant was resolved (prefix guards + route guards → one resolution). */
const resolvedFor = new WeakMap<Request, AuthContextLike>();
type AuthContextLike = NonNullable<Request['auth']>;

export function resolveTenant({ loadSchool = loadSchoolStateFromDb, parentLink = parentLinkFromDb, cache = true }: ResolveTenantOptions = {}): RequestHandler {
  return async function resolveTenantMiddleware(req: Request, _res: Response, next: NextFunction) {
    const auth = req.auth;
    if (!auth) throw unauthenticated();
    if (req.tenant && resolvedFor.get(req) === auth) return next();
    let schoolId: string | null;
    if (auth.role === 'super_admin') throw forbidden('Platform accounts have no access to school data.');
    if (auth.role === 'parent') {
      const header = req.get(HEADERS.SCHOOL_ID);
      if (!header) throw validationError(`The ${HEADERS.SCHOOL_ID} header is required.`, [{ path: `headers.${HEADERS.SCHOOL_ID.toLowerCase()}`, message: 'Required' }]);
      if (!UUID_RE.test(header)) throw validationError(`Invalid ${HEADERS.SCHOOL_ID} header.`, [{ path: `headers.${HEADERS.SCHOOL_ID.toLowerCase()}`, message: 'Must be a valid UUID' }]);
      schoolId = header.toLowerCase();
      if (!(await parentLink(auth.actorId, schoolId))) throw forbidden('You have no active child link in this school.');
    } else {
      schoolId = auth.schoolId;
      if (!schoolId) throw unauthenticated('Your session is no longer valid. Please sign in again.');
    }
    let school = cache ? schoolCache.get(schoolId) : undefined;
    if (!school) {
      school = (await loadSchool(schoolId)) ?? undefined;
      if (school && cache) schoolCache.set(schoolId, school);
    }
    if (!school || school.deleted || school.status !== 'active') throw schoolInactive();
    await runSubscriptionChecks(school, req);
    req.tenant = { schoolId: school.id, timezone: school.timezone, tenantMode: school.tenantMode, dbConnectionRef: school.dbConnectionRef };
    resolvedFor.set(req, auth);
    updateRequestContext({ schoolId: school.id });
    req.log?.setBindings?.({ schoolId: school.id });
    return next();
  };
}

/** Tenant context of an authenticated request (after resolveTenant for school routes). */
export function tenantContext(req: Request): TenantContext {
  if (!req.auth) throw unauthenticated();
  return { schoolId: req.tenant?.schoolId ?? null, actorId: req.auth.actorId, role: req.auth.role };
}

/** withTenant for a request: GET/HEAD default to READ ONLY; dedicated tenants route to their pool. */
export function withRequestTenant<T>(req: Request, fn: (tx: Tx) => Promise<T>, opts: TxOptions = {}): Promise<T> {
  const readOnly = opts.readOnly ?? (req.method === 'GET' || req.method === 'HEAD');
  const tenant = req.tenant ? { tenantMode: req.tenant.tenantMode, dbConnectionRef: req.tenant.dbConnectionRef } : null;
  return withTenant(tenantContext(req), fn, { tenant, ...opts, readOnly });
}
