// Same-bus schedule overlap (BP §8.3 Schedules): a bus cannot run two active schedules whose time
// windows [plannedStart, plannedStart + estimated duration) intersect on a shared weekday while their
// validity periods intersect. Windows are mapped onto the week (minutes since Monday 00:00), so a window
// that passes midnight also collides with the next day's early schedules (Sunday wraps to Monday).
import type { TripScheduleConflict } from '@wimb/shared';

export const WEEK_MIN = 7 * 1440;

export interface ScheduleWindow {
  /** 'HH:mm' or 'HH:mm:ss'. */
  plannedStartTime: string;
  durationMin: number;
  /** ISO weekdays 1 = Monday … 7 = Sunday. */
  daysOfWeek: readonly number[];
}

export const minutesOf = (t: string): number => {
  const [h, m] = t.split(':').map(Number) as [number, number];
  return h * 60 + m;
};

/** Half-open week intervals of a schedule, tagged with the weekday they start on. */
export function weekIntervals(w: ScheduleWindow): { day: number; start: number; end: number }[] {
  const start = minutesOf(w.plannedStartTime);
  const out: { day: number; start: number; end: number }[] = [];
  for (const day of w.daysOfWeek) {
    const s = (day - 1) * 1440 + start;
    const e = s + Math.max(1, w.durationMin);
    if (e <= WEEK_MIN) out.push({ day, start: s, end: e });
    else {
      out.push({ day, start: s, end: WEEK_MIN });
      out.push({ day, start: 0, end: e - WEEK_MIN });
    }
  }
  return out;
}

/** Weekdays of `a` whose window intersects a window of `b` (empty → no overlap). */
export function overlappingDays(a: ScheduleWindow, b: ScheduleWindow): number[] {
  const bi = weekIntervals(b);
  const days = new Set<number>();
  for (const x of weekIntervals(a)) {
    if (bi.some((y) => x.start < y.end && y.start < x.end)) days.add(x.day);
  }
  return [...days].sort((p, q) => p - q);
}

export interface OverlapCandidate extends ScheduleWindow {
  id: string;
  name: string | null;
  routeCode: string;
  direction: TripScheduleConflict['direction'];
  estimatedEndTime: string;
}

/** Conflicts of `window` with other schedules of the same bus (validity already intersecting). */
export function findConflicts(window: ScheduleWindow, others: readonly OverlapCandidate[]): TripScheduleConflict[] {
  const conflicts: TripScheduleConflict[] = [];
  for (const o of others) {
    const sharedDays = overlappingDays(window, o);
    if (sharedDays.length) {
      conflicts.push({
        scheduleId: o.id,
        name: o.name,
        routeCode: o.routeCode,
        direction: o.direction,
        plannedStartTime: o.plannedStartTime.slice(0, 5),
        estimatedEndTime: o.estimatedEndTime,
        sharedDays,
      });
    }
  }
  return conflicts;
}
