// GET/PUT /platform/schools/:id/subscription (BP §20 #1, contract §9) — the platform side of the
// subscription: plan, max buses / students, validity and module switches. Enforcement lives in
// subscription.ts (resolveTenant hook + create-endpoint capacity checks).
// PUT semantics: the current subscription row is updated in place while it is active (or when it
// is set to a non-active status again); re-activating after a cancellation/expiry starts a new row,
// so the history of plans is kept.
import type { Request } from 'express';
import { audit, changedFields } from '../../shared/audit.js';
import { notFound } from '../../shared/errors.js';
import { events } from '../../shared/events.js';
import { limitUsage, toSubscriptionDto, toUsageDto } from './dto.js';
import * as repo from './repository.js';
import type { SubscriptionBody } from './schemas.js';
import { lockLiveSchool, platformTx } from './schools.js';
import { invalidateSubscriptionState } from './subscription.js';
import type { Tx } from '../../db/tenant.js';

async function view(tx: Tx, schoolId: string) {
  const current = await repo.currentSubscription(tx, schoolId);
  const history = await repo.subscriptionHistory(tx, schoolId);
  const usage = toUsageDto(await repo.usageCounts(tx, schoolId));
  return {
    current: current ? toSubscriptionDto(current) : null,
    usage: {
      buses: limitUsage(usage.buses, current?.status === 'active' ? current.max_buses : null),
      students: limitUsage(usage.students, current?.status === 'active' ? current.max_students : null),
    },
    history: history.map(toSubscriptionDto),
  };
}

/** GET /platform/schools/:id/subscription — current plan, limits vs usage (counts) and history. */
export async function getSubscription(req: Request, schoolId: string) {
  return platformTx(req, async (tx) => {
    if (!(await repo.findSchool(tx, schoolId))) throw notFound('School not found.');
    return view(tx, schoolId);
  });
}

/** PUT /platform/schools/:id/subscription */
export async function putSubscription(req: Request, schoolId: string, body: SubscriptionBody) {
  const result = await platformTx(req, async (tx) => {
    await lockLiveSchool(tx, schoolId);
    const current = await repo.currentSubscription(tx, schoolId, { lock: true });
    const values: repo.SubscriptionValues = {
      plan: body.plan,
      status: body.status,
      maxBuses: body.maxBuses,
      maxStudents: body.maxStudents,
      modules: Object.fromEntries(Object.entries(body.modules).filter((e): e is [string, boolean] => e[1] !== undefined)),
      validFrom: body.validFrom ?? null,
      validUntil: body.validUntil,
      notes: body.notes ?? null,
    };
    const inPlace = current !== null && (current.status === 'active' || body.status !== 'active');
    const saved = inPlace ? await repo.updateSubscription(tx, current.id, values) : await repo.insertSubscription(tx, schoolId, values);
    const before = current ? toSubscriptionDto(current) : null;
    const after = toSubscriptionDto(saved);
    const strip = (s: ReturnType<typeof toSubscriptionDto> | null) => (s ? { id: s.id, plan: s.plan, status: s.status, maxBuses: s.maxBuses, maxStudents: s.maxStudents, modules: s.modules, validFrom: s.validFrom, validUntil: s.validUntil, notes: s.notes } : {});
    const diff = changedFields(strip(before), strip(after));
    await audit.log(tx, { action: inPlace ? 'school.subscription_update' : 'school.subscription_create', entityType: 'school', entityId: schoolId, old: diff.old, new: diff.new });
    return view(tx, schoolId);
  });
  invalidateSubscriptionState(schoolId);
  events.emit('school.subscription_changed', { schoolId });
  return result;
}
