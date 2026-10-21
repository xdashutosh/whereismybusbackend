// Job registry: modules define their jobs with defineCronJob / defineSchoolCronJob /
// defineQueueJob and list the definitions in src/jobs/index.ts (JOB_DEFINITIONS).
import { Cron } from 'croner';
import { JOB_NAME_RE, type CronJobDef, type JobDef, type QueueJobDef, type SchoolCronJobDef } from './types.js';

function assertPattern(name: string, cron: string, timezone?: string): void {
  if (cron.trim().split(/\s+/).length !== 5) throw new TypeError(`Job ${name}: cron must have 5 fields (minute precision)`);
  try {
    new Cron(cron, { timezone, paused: true }).stop();
  } catch (err) {
    throw new TypeError(`Job ${name}: invalid cron "${cron}" (${(err as Error).message})`, { cause: err });
  }
}

function assertName(name: string): void {
  if (!JOB_NAME_RE.test(name)) throw new TypeError(`Invalid job name "${name}" (lower-case kebab, 2–63 chars)`);
}

export function defineCronJob(def: Omit<CronJobDef, 'kind'>): CronJobDef {
  assertName(def.name);
  assertPattern(def.name, def.cron, def.timezone);
  return { kind: 'cron', ...def };
}

export function defineSchoolCronJob(def: Omit<SchoolCronJobDef, 'kind'>): SchoolCronJobDef {
  assertName(def.name);
  assertPattern(def.name, def.cron);
  return { kind: 'school-cron', ...def };
}

export function defineQueueJob<P>(def: Omit<QueueJobDef<P>, 'kind'>): QueueJobDef<P> {
  assertName(def.name);
  return { kind: 'queue', ...def };
}

/** Validates a set of definitions (unique names). */
export function buildRegistry(defs: readonly JobDef[]): ReadonlyMap<string, JobDef> {
  const map = new Map<string, JobDef>();
  for (const d of defs) {
    if (map.has(d.name)) throw new TypeError(`Duplicate job name: ${d.name}`);
    map.set(d.name, d);
  }
  return map;
}
