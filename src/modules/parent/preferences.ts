// Notification preferences per child and direction (BP §11.2, §15.2 Notification Settings).
// notification_preferences has one row per (student, parent, direction); a missing row means every
// event is on (column defaults). Rows are the parent's own (parent_scope: writable, own account and
// linked children only); the FK to student_parents guarantees the link. Any linked child may hold
// preferences for both directions (a bus may be assigned later), so no assignment is required.
// The notifications module reads the same table when it fans out parent notifications
// (effectivePreferences() below is exported for it through ./index.ts).
import {
  DIRECTIONS,
  PARENT_TRIP_EVENTS,
  NOTIFICATION_TOGGLE_OF,
  type Direction,
  type ParentTripEvent,
  type NotificationPreferencesBody,
  type NotificationPreferencesDto,
  type NotificationToggles,
} from '@wimb/shared';
import type { Request } from 'express';
import type { Tx } from '../../db/tenant.js';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { audit } from '../../shared/audit.js';
import { loadChild } from './access.js';

type PreferenceRow = { direction: Direction; updated_at: string } & Record<ParentTripEvent, boolean>;

const COLUMNS = PARENT_TRIP_EVENTS.join(', ');

export const ALL_ON: Readonly<NotificationToggles> = Object.freeze({
  tripStarted: true,
  busLeftSchool: true,
  approachingStop: true,
  arrivedAtStop: true,
  tripDelayed: true,
  tripNotStarted: true,
  tripInterrupted: true,
  tripCancelled: true,
});

function togglesOf(row: PreferenceRow | undefined): NotificationToggles {
  const out = { ...ALL_ON };
  if (row) for (const e of PARENT_TRIP_EVENTS) out[NOTIFICATION_TOGGLE_OF[e]] = row[e];
  return out;
}

async function readRows(tx: Tx, studentId: string): Promise<PreferenceRow[]> {
  return tx.many<PreferenceRow>(
    `select direction, updated_at, ${COLUMNS} from notification_preferences
      where student_id = $1 and parent_account_id = nullif(current_setting('app.actor_id', true), '')::uuid`,
    [studentId],
  );
}

function toDto(studentId: string, rows: PreferenceRow[]): NotificationPreferencesDto {
  const by = new Map(rows.map((r) => [r.direction, r]));
  const stamps = rows.map((r) => r.updated_at).sort();
  return { studentId, morning: togglesOf(by.get('morning')), afternoon: togglesOf(by.get('afternoon')), updatedAt: stamps.at(-1) ?? null };
}

export async function getPreferences(req: Request, studentId: string): Promise<NotificationPreferencesDto> {
  return withRequestTenant(req, async (tx) => {
    const child = await loadChild(tx, studentId);
    return toDto(child.studentId, await readRows(tx, child.studentId));
  });
}

export async function putPreferences(req: Request, studentId: string, body: NotificationPreferencesBody): Promise<NotificationPreferencesDto> {
  return withRequestTenant(req, async (tx) => {
    const child = await loadChild(tx, studentId);
    const before = toDto(child.studentId, await readRows(tx, child.studentId));
    const next = { morning: { ...before.morning }, afternoon: { ...before.afternoon } };
    const changed: Direction[] = [];
    for (const d of DIRECTIONS) {
      const patch = body[d];
      if (!patch) continue;
      let dirty = false;
      for (const [k, v] of Object.entries(patch) as [keyof NotificationToggles, boolean | undefined][]) {
        if (v !== undefined && next[d][k] !== v) {
          next[d][k] = v;
          dirty = true;
        }
      }
      if (dirty) changed.push(d);
    }
    if (!changed.length) return before;
    // One statement for both directions (multi-row upsert).
    const values: unknown[] = [child.studentId];
    const tuples = changed.map((d) => {
      values.push(d, ...PARENT_TRIP_EVENTS.map((e) => next[d][NOTIFICATION_TOGGLE_OF[e]]));
      const base = values.length - PARENT_TRIP_EVENTS.length - 1;
      const flags = PARENT_TRIP_EVENTS.map((_, i) => `$${base + 2 + i}::boolean`).join(', ');
      return `(nullif(current_setting('app.school_id', true), '')::uuid, nullif(current_setting('app.actor_id', true), '')::uuid, $1::uuid, $${base + 1}::text, ${flags})`;
    });
    await tx.query(
      `insert into notification_preferences (school_id, parent_account_id, student_id, direction, ${COLUMNS})
       values ${tuples.join(', ')}
       on conflict (student_id, parent_account_id, direction) do update
          set ${PARENT_TRIP_EVENTS.map((e) => `${e} = excluded.${e}`).join(', ')}, updated_at = now()`,
      values,
    );
    const after = toDto(child.studentId, await readRows(tx, child.studentId));
    await audit.log(tx, {
      action: 'notification_preferences.update',
      entityType: 'student',
      entityId: child.studentId,
      old: Object.fromEntries(changed.map((d) => [d, before[d]])),
      new: Object.fromEntries(changed.map((d) => [d, after[d]])),
    });
    return after;
  });
}

/**
 * Effective toggles of the given parents for one child and direction (missing rows = all on). For
 * the notifications module; runs in the caller's school context (system/job or the parent's own).
 */
export async function effectivePreferences(tx: Tx, studentId: string, direction: Direction, parentIds: readonly string[]): Promise<Map<string, NotificationToggles>> {
  const rows = await tx.many<PreferenceRow & { parent_account_id: string }>(
    `select parent_account_id, direction, updated_at, ${COLUMNS} from notification_preferences
      where student_id = $1 and direction = $2 and parent_account_id = any ($3::uuid[])`,
    [studentId, direction, [...parentIds]],
  );
  const by = new Map(rows.map((r) => [r.parent_account_id, r]));
  return new Map(parentIds.map((id) => [id, togglesOf(by.get(id))]));
}
