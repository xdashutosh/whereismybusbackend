// Subscription limits per school (BP §20 #1, contract §9) — enforcement side.
//   • resolveTenant hook (registerSubscriptionCheck): every tenant request of a school whose current
//     subscription is cancelled/expired, or whose valid_until (inclusive, school-local date) has
//     passed, is refused with 403 SCHOOL_INACTIVE (details.reason SUBSCRIPTION_EXPIRED |
//     SUBSCRIPTION_CANCELLED). Schools without any subscription row are not limited.
//   • create endpoints call assertSubscriptionCapacity(tx, 'buses' | 'students', n) inside their
//     write transaction (school context) before inserting: 403 FORBIDDEN, details.reason
//     SUBSCRIPTION_LIMIT, when the plan's max would be exceeded. A transaction-scoped advisory lock
//     per school + resource serialises concurrent creates (PgBouncer-safe).
//   • subscriptionAllows(tx, module): false when the plan switches a module off (modules[m] = false).
// The state used by the request hook is cached per process for SUBSCRIPTION_CACHE_TTL_MS (like the
// school state in resolveTenant) and evicted when the platform changes it.
import type { Request } from 'express';
import { LRUCache } from 'lru-cache';
import { withTenant, type Tx } from '../../db/tenant.js';
import { registerSubscriptionCheck, type SchoolState, type SubscriptionCheck } from '../../middleware/resolveTenant.js';
import { forbidden, schoolInactive } from '../../shared/errors.js';
import { events } from '../../shared/events.js';

declare module '../../shared/events.js' {
  interface AppEvents {
    /** The platform changed a school's subscription (plan, limits, validity, modules). */
    'school.subscription_changed': { schoolId: string };
  }
}

export const SUBSCRIPTION_CACHE_TTL_MS = 15_000;

export interface SubscriptionState {
  status: 'active' | 'expired' | 'cancelled';
  plan: string;
  validUntil: string | null;
  /** valid_until lies before the school-local date. */
  lapsed: boolean;
  maxBuses: number | null;
  maxStudents: number | null;
  modules: Record<string, boolean>;
}

const CURRENT_STATE_SQL = `select status, plan, valid_until, max_buses, max_students, modules,
    (valid_until is not null and valid_until < (now() at time zone $2)::date) as lapsed
  from school_subscriptions where school_id = $1
  order by (status = 'active') desc, created_at desc, id desc limit 1`;

interface StateRow {
  status: SubscriptionState['status'];
  plan: string;
  valid_until: string | null;
  max_buses: number | null;
  max_students: number | null;
  modules: Record<string, boolean> | null;
  lapsed: boolean;
}

const toState = (r: StateRow): SubscriptionState => ({
  status: r.status,
  plan: r.plan,
  validUntil: r.valid_until,
  lapsed: r.lapsed,
  maxBuses: r.max_buses,
  maxStudents: r.max_students,
  modules: r.modules ?? {},
});

/** Current subscription state of a school, read in that school's own context (null = none). */
export async function loadSubscriptionState(schoolId: string, timezone: string): Promise<SubscriptionState | null> {
  const row = await withTenant({ schoolId, actorId: null, role: 'system' }, (tx) => tx.maybeOne<StateRow>(CURRENT_STATE_SQL, [schoolId, timezone]), { readOnly: true });
  return row ? toState(row) : null;
}

const cache = new LRUCache<string, { state: SubscriptionState | null }>({ max: 5000, ttl: SUBSCRIPTION_CACHE_TTL_MS });
export function invalidateSubscriptionState(schoolId?: string): void {
  if (schoolId) cache.delete(schoolId);
  else cache.clear();
}
events.on('school.subscription_changed', ({ schoolId }) => invalidateSubscriptionState(schoolId));
events.on('school.status_changed', ({ schoolId }) => invalidateSubscriptionState(schoolId));

export async function getSubscriptionState(schoolId: string, timezone: string): Promise<SubscriptionState | null> {
  const hit = cache.get(schoolId);
  if (hit) return hit.state;
  const state = await loadSubscriptionState(schoolId, timezone);
  cache.set(schoolId, { state });
  return state;
}

/** Throws SCHOOL_INACTIVE when the state does not allow using the school. */
export function assertSubscriptionUsable(state: SubscriptionState | null): void {
  if (!state) return;
  if (state.status === 'cancelled') {
    throw schoolInactive('The school subscription has been cancelled. Please contact the Where Is My Bus team.', { reason: 'SUBSCRIPTION_CANCELLED' });
  }
  if (state.status === 'expired' || state.lapsed) {
    throw schoolInactive('The school subscription has expired. Please contact the Where Is My Bus team.', { reason: 'SUBSCRIPTION_EXPIRED', validUntil: state.validUntil });
  }
}

/** resolveTenant hook (registered below). */
export const subscriptionCheck: SubscriptionCheck = async (school: SchoolState, _req: Request | null) => {
  assertSubscriptionUsable(await getSubscriptionState(school.id, school.timezone));
};

let unregister: (() => void) | null = null;
/** Registers the request hook once per process (idempotent). */
export function registerSubscriptionEnforcement(): void {
  unregister ??= registerSubscriptionCheck(subscriptionCheck);
}
registerSubscriptionEnforcement();

// ── create-endpoint limits ──────────────────────────────────────────────────────────────────────
export const LIMITED_RESOURCES = {
  buses: { column: 'max_buses', label: 'buses', countSql: 'select count(*)::int as used from buses where school_id = $1 and deleted_at is null' },
  students: { column: 'max_students', label: 'active students', countSql: 'select count(*)::int as used from students where school_id = $1 and deleted_at is null and is_active' },
} as const;
export type LimitedResource = keyof typeof LIMITED_RESOURCES;

function schoolOf(tx: Tx): string {
  const schoolId = tx.ctx.schoolId;
  if (!schoolId) throw new TypeError('Subscription limits need a school context (withRequestTenant / withSchoolSystem)');
  return schoolId;
}

/**
 * Call inside the write transaction BEFORE inserting `adding` new rows of `resource` (buses,
 * students). Holds an advisory lock until commit so parallel creates cannot overshoot the limit.
 */
export async function assertSubscriptionCapacity(tx: Tx, resource: LimitedResource, adding = 1): Promise<{ used: number; limit: number | null }> {
  const schoolId = schoolOf(tx);
  const spec = LIMITED_RESOURCES[resource];
  const sub = await tx.maybeOne<{ max_allowed: number | null }>(
    `select pg_advisory_xact_lock(hashtextextended('wimb:plan-limit:' || $1::text || ':' || $2::text, 0)) as locked,
            (select x.${spec.column} from school_subscriptions x where x.school_id = $1::uuid and x.status = 'active'
              order by x.created_at desc, x.id desc limit 1) as max_allowed`,
    [schoolId, resource],
  );
  const limit = sub?.max_allowed ?? null;
  if (limit === null) return { used: -1, limit: null };
  const { used } = await tx.one<{ used: number }>(spec.countSql, [schoolId]);
  if (used + adding > limit) {
    throw forbidden(`Your plan allows at most ${limit} ${spec.label}. Please contact the Where Is My Bus team to upgrade.`, { reason: 'SUBSCRIPTION_LIMIT', resource, limit, used, adding });
  }
  return { used, limit };
}

/** False when the school's current plan switches the module off (modules[module] === false). */
export async function subscriptionAllows(tx: Tx, module: string): Promise<boolean> {
  const row = await tx.maybeOne<{ enabled: boolean | null }>(
    `select (x.modules ->> $2)::boolean as enabled from school_subscriptions x
      where x.school_id = $1 order by (x.status = 'active') desc, x.created_at desc, x.id desc limit 1`,
    [schoolOf(tx), module],
  );
  return row?.enabled !== false;
}
