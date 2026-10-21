// Per-school-timezone scheduling (contract §8: e.g. generate-daily-trips at 00:05 school-local).
// One global dispatcher runs every minute (UTC). It loads (school_id, timezone) pairs through the
// SECURITY DEFINER function school_timezones() (contract §4) and, for every school-cron definition
// whose pattern matches the current minute in that school's timezone, enqueues one job with
// payload { schoolId, timezone, scheduledFor, localDate } and a deterministic job id, so a
// duplicate dispatch (two workers, a retry) never runs the same school-minute twice.
// Late or skipped ticks (queue backlog, worker restart, Redis delay, a slow previous run) never drop
// a school-local run: the last dispatched minute is kept in Postgres (job_dispatch_state, migration
// 852 — it survives restarts of a backend running without Redis) and every tick covers the window
// (last dispatched minute, current minute] — capped at MAX_CATCH_UP_MINUTES — starting no later than
// the tick's scheduled fire time. Without any cursor (first start, or the table is missing) the tick
// catches up the whole MAX_CATCH_UP_MINUTES window: every school-cron job is idempotent (generation
// ON CONFLICT, reconciling scans, per-day digest claims, per-minute checks). Within one window each
// (job, school) is enqueued once, for its latest due minute (missed runs are coalesced, like cron).
import { Cron } from 'croner';
import { DateTime } from 'luxon';
import { isPgError, PG_ERROR } from '../db/pool.js';
import { withSystem } from '../db/tenant.js';
import { getJson, kv as defaultKv, kvKey, setJson, type KvStore } from '../shared/kv.js';
import { logger as rootLogger } from '../shared/logger.js';
import { defineCronJob } from './registry.js';
import { sanitizeJobId, type CronJobDef, type EnqueueOptions, type SchoolCronJobDef, type SchoolCronPayload } from './types.js';

const log = rootLogger.child({ module: 'jobs.school-cron' });

export const SCHOOL_CRON_DISPATCHER = 'school-cron-dispatch';
/** Longest gap a dispatcher tick catches up on (6 h). */
export const MAX_CATCH_UP_MINUTES = 6 * 60;
/** KV key holding the last dispatched minute (ISO) when a KV store is given (tests, fallback). */
export const LAST_DISPATCH_KEY = kvKey('jobs', 'school-cron', 'last');
/** job_dispatch_state.cursor_key of the dispatcher cursor. */
export const DISPATCH_STATE_NAME = 'school-cron';
const MINUTE_MS = 60_000;

/** Where the dispatcher keeps the last dispatched minute. */
export interface DispatchCursorStore {
  read(): Promise<Date | null>;
  write(minute: Date): Promise<void>;
}

/** Cursor in a KV store (memory in tests; Redis is not durable enough on its own). */
export function kvCursorStore(store: KvStore): DispatchCursorStore {
  return {
    async read() {
      const iso = await getJson<string>(store, LAST_DISPATCH_KEY);
      return iso ? new Date(iso) : null;
    },
    async write(minute) {
      await setJson(store, LAST_DISPATCH_KEY, minute.toISOString(), MAX_CATCH_UP_MINUTES * 60 * 2);
    },
  };
}

let missingCursorTableLogged = false;
/**
 * Durable cursor in job_dispatch_state (system actor). Falls back to the KV store while the table does
 * not exist yet (a backend started before `npm run migrate`).
 */
export function pgCursorStore(fallback: KvStore = defaultKv, name = DISPATCH_STATE_NAME): DispatchCursorStore {
  const kvFallback = kvCursorStore(fallback);
  const missing = (err: unknown): boolean => {
    if (!isPgError(err, PG_ERROR.UNDEFINED_TABLE)) return false;
    if (!missingCursorTableLogged) {
      missingCursorTableLogged = true;
      log.warn('job_dispatch_state does not exist yet (run the migrations); the school-cron cursor is kept in the KV store');
    }
    return true;
  };
  return {
    async read() {
      try {
        const row = await withSystem((tx) => tx.maybeOne<{ last_minute: Date | string }>('select last_minute from job_dispatch_state where cursor_key = $1', [name]), { readOnly: true });
        return row ? new Date(row.last_minute) : null;
      } catch (err) {
        if (missing(err)) return kvFallback.read();
        throw err;
      }
    },
    async write(minute) {
      try {
        await withSystem((tx) =>
          tx.query(
            `insert into job_dispatch_state (cursor_key, last_minute) values ($1, $2)
             on conflict (cursor_key) do update set last_minute = excluded.last_minute, updated_at = now()`,
            [name, minute.toISOString()],
          ),
        );
      } catch (err) {
        if (missing(err)) return kvFallback.write(minute);
        throw err;
      }
    },
  };
}

export interface SchoolTimezone {
  schoolId: string;
  timezone: string;
}

export type SchoolTimezoneLoader = () => Promise<SchoolTimezone[]>;

let missingFunctionLogged = false;

/** Default loader: SELECT school_id, timezone FROM school_timezones() (active, non-deleted schools). */
export const loadSchoolTimezones: SchoolTimezoneLoader = async () => {
  try {
    return await withSystem(
      async (tx) => (await tx.many<{ school_id: string; timezone: string }>('select school_id, timezone from school_timezones()')).map((r) => ({ schoolId: r.school_id, timezone: r.timezone })),
      { readOnly: true },
    );
  } catch (err) {
    if (isPgError(err, PG_ERROR.UNDEFINED_FUNCTION) || isPgError(err, PG_ERROR.UNDEFINED_TABLE)) {
      if (!missingFunctionLogged) {
        missingFunctionLogged = true;
        log.warn('school_timezones() is not defined yet; school-local jobs are idle until the schema provides it');
      }
      return [];
    }
    throw err;
  }
};

const patternCache = new Map<string, Cron>();
function cronFor(pattern: string, timezone: string): Cron {
  const key = `${pattern}|${timezone}`;
  let c = patternCache.get(key);
  if (!c) {
    c = new Cron(pattern, { timezone, paused: true });
    patternCache.set(key, c);
  }
  return c;
}

/** Start of the minute containing `date`. */
export function minuteStart(date: Date): Date {
  return new Date(Math.floor(date.getTime() / 60000) * 60000);
}

/** True when `pattern` fires at `minute` (a minute start) in `timezone`. */
export function cronMatchesMinute(pattern: string, timezone: string, minute: Date): boolean {
  const next = cronFor(pattern, timezone).nextRun(new Date(minute.getTime() - 1000));
  return next !== null && next.getTime() === minute.getTime();
}

function isValidZone(tz: string): boolean {
  return DateTime.local().setZone(tz).isValid;
}

/** Latest minute in [from, to] (minute starts) at which `pattern` fires in `timezone`, or null. */
export function latestMatchInWindow(pattern: string, timezone: string, from: Date, to: Date): Date | null {
  const cron = cronFor(pattern, timezone);
  let latest: Date | null = null;
  let next = cron.nextRun(new Date(from.getTime() - 1000));
  while (next !== null && next.getTime() <= to.getTime()) {
    latest = next;
    next = cron.nextRun(next);
  }
  return latest;
}

/**
 * Every (definition, payload) due in the window [from, to] (both minute starts; `from` defaults to
 * `to`). Each (definition, school) appears at most once, for its latest due minute. Schools with an
 * invalid timezone are skipped.
 */
export function dueSchoolRuns(defs: readonly SchoolCronJobDef[], schools: readonly SchoolTimezone[], minute: Date, from: Date = minute) {
  const out: { def: SchoolCronJobDef; payload: SchoolCronPayload; jobId: string }[] = [];
  const to = minuteStart(minute);
  const start = minuteStart(from).getTime() > to.getTime() ? to : minuteStart(from);
  for (const school of schools) {
    if (!isValidZone(school.timezone)) {
      log.warn({ schoolId: school.schoolId }, 'School has an invalid timezone; skipping school-local jobs');
      continue;
    }
    for (const def of defs) {
      const at = latestMatchInWindow(def.cron, school.timezone, start, to);
      if (!at) continue;
      const payload: SchoolCronPayload = {
        schoolId: school.schoolId,
        timezone: school.timezone,
        scheduledFor: at.toISOString(),
        localDate: DateTime.fromJSDate(at, { zone: school.timezone }).toISODate() ?? '',
      };
      out.push({ def, payload, jobId: sanitizeJobId(`${def.name}|${school.schoolId}|${payload.scheduledFor}`) });
    }
  }
  return out;
}

/**
 * First minute a tick at `now` must cover: the minute after the last dispatched one, never later
 * than the tick's own scheduled minute, never more than MAX_CATCH_UP_MINUTES back. Without a last
 * dispatched minute (first start, lost cursor) the whole catch-up window is covered, so a restart
 * across a school-local run (e.g. 00:05 generate-daily-trips) still dispatches it.
 */
export function dispatchWindowStart({ now, last, scheduledAt }: { now: Date; last: Date | null; scheduledAt?: Date | null }): Date {
  const to = minuteStart(now);
  const floor = to.getTime() - (MAX_CATCH_UP_MINUTES - 1) * MINUTE_MS;
  if (!last || !Number.isFinite(last.getTime())) return new Date(floor);
  let start = to.getTime();
  if (scheduledAt && Number.isFinite(scheduledAt.getTime())) start = Math.min(start, minuteStart(scheduledAt).getTime());
  if (last.getTime() < to.getTime()) start = Math.min(start, minuteStart(last).getTime() + MINUTE_MS);
  return new Date(Math.max(start, floor));
}

/** The every-minute dispatcher job (registered automatically when school-cron jobs exist). */
export function createSchoolCronDispatcher({
  defs,
  loadSchools = loadSchoolTimezones,
  enqueue,
  now = () => new Date(),
  store,
  cursor = store ? kvCursorStore(store) : pgCursorStore(),
}: {
  defs: readonly SchoolCronJobDef[];
  loadSchools?: SchoolTimezoneLoader;
  enqueue: (name: string, payload: unknown, opts?: EnqueueOptions) => Promise<void>;
  now?: () => Date;
  /** Keep the last dispatched minute in this KV store instead of Postgres (tests). */
  store?: KvStore;
  /** Where the last dispatched minute is kept (default: job_dispatch_state, shared by every instance). */
  cursor?: DispatchCursorStore;
}): CronJobDef {
  return defineCronJob({
    name: SCHOOL_CRON_DISPATCHER,
    cron: '* * * * *',
    timezone: 'UTC',
    async handler(ctx) {
      if (!defs.length) return;
      const tick = now();
      const to = minuteStart(tick);
      const last = await cursor.read().catch((err: unknown) => {
        ctx.logger.warn({ err }, 'Could not read the last dispatched minute; catching up the whole window');
        return null;
      });
      const from = dispatchWindowStart({ now: tick, last, scheduledAt: ctx.scheduledAt ? new Date(ctx.scheduledAt) : null });
      const schools = await loadSchools();
      const runs = dueSchoolRuns(defs, schools, to, from);
      for (const r of runs) await enqueue(r.def.name, r.payload, { jobId: r.jobId });
      // Only after every enqueue succeeded: a failed tick is covered again by the next one.
      await cursor.write(to);
      if (runs.length) ctx.logger.debug({ enqueued: runs.length, from: from.toISOString(), to: to.toISOString() }, 'School-local jobs dispatched');
    },
  });
}
