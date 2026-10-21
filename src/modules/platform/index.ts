// Public surface of the platform module for other modules.
//   Create endpoints (buses, students, CSV imports) call, inside their write transaction and BEFORE
//   inserting:   await assertSubscriptionCapacity(tx, 'buses', 1)      // or 'students', n
//   Optional features:  if (!(await subscriptionAllows(tx, 'sms'))) …
// The resolveTenant subscription hook (expired/cancelled plans → 403 SCHOOL_INACTIVE) registers
// itself when this module loads.
export {
  assertSubscriptionCapacity,
  assertSubscriptionUsable,
  getSubscriptionState,
  invalidateSubscriptionState,
  LIMITED_RESOURCES,
  registerSubscriptionEnforcement,
  subscriptionAllows,
  type LimitedResource,
  type SubscriptionState,
} from './subscription.js';
export { HEARTBEAT_JOB, PLATFORM_JOB_DEFINITIONS, recordHeartbeat } from './jobs.js';
