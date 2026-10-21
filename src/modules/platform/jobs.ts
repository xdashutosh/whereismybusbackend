// Platform job definitions (contract §8), registered in src/jobs/index.ts JOB_DEFINITIONS.
// 'platform-heartbeat' runs every minute wherever schedules run (the worker, or the API with
// JOBS_IN_PROCESS=true) and stores its last run in kv; GET /platform/health and the 'jobs' system
// status check read it to tell whether scheduled jobs are running. Imports only the job registry
// (not jobs/index.ts) so the registry can import this file without a cycle.
import config from '../../config/index.js';
import { defineCronJob } from '../../jobs/registry.js';
import { getJson, kv, kvKey, setJson, type KvStore } from '../../shared/kv.js';
import type { StatusCheckResult } from '../../shared/systemStatus.js';

export const HEARTBEAT_JOB = 'platform-heartbeat';
export const HEARTBEAT_KEY = kvKey('platform', 'jobs', 'heartbeat');
/** A heartbeat older than this means scheduled jobs are not running. */
export const HEARTBEAT_STALE_S = 180;

export interface Heartbeat {
  at: string;
  pid: number;
  backend: 'bullmq' | 'in-process';
}

/** Heartbeat job handler (exported for tests). */
export async function recordHeartbeat(store: KvStore = kv, now = new Date()): Promise<void> {
  const hb: Heartbeat = { at: now.toISOString(), pid: process.pid, backend: config.redisUrl ? 'bullmq' : 'in-process' };
  await setJson(store, HEARTBEAT_KEY, hb, 24 * 3600);
}

export const heartbeatJob = defineCronJob({ name: HEARTBEAT_JOB, cron: '* * * * *', handler: () => recordHeartbeat() });

/** Job worker status from the last heartbeat (registered as the 'jobs' system status check). */
export async function jobsStatus(store: KvStore = kv, now = Date.now()): Promise<StatusCheckResult> {
  const hb = await getJson<Heartbeat>(store, HEARTBEAT_KEY);
  if (!hb) return { level: 'warn', message: 'No job worker heartbeat yet: scheduled jobs may not be running', details: { lastHeartbeatAt: null } };
  const ageSeconds = Math.max(0, Math.round((now - Date.parse(hb.at)) / 1000));
  const details = { lastHeartbeatAt: hb.at, ageSeconds, backend: hb.backend };
  if (ageSeconds > HEARTBEAT_STALE_S) return { level: 'warn', message: 'The job worker heartbeat is stale: scheduled jobs are not running', details };
  return { level: 'ok', details };
}

export const PLATFORM_JOB_DEFINITIONS = [heartbeatJob] as const;
