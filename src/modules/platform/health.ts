// Super Admin dashboard data (BP §4.4, §13.2, §20 #3): counts only — never school rows.
//   GET /platform/health  platform_health_counts() + API, database, Redis and job-queue health +
//                         operational signals (shared/systemStatus: SMS credits, job worker)
//   GET /platform/usage   per-school counts (school_usage_counts) next to the plan limits
// Job health: the 'platform-heartbeat' cron job (jobs.ts) stores its last run in kv; the 'jobs'
// system status check reports it (stale or missing → warn).
import type { Request, Response } from 'express';
import config from '../../config/index.js';
import { getAppPool, ping } from '../../db/pool.js';
import { getJobs } from '../../jobs/index.js';
import { createCsvWriter, type CsvColumn } from '../../shared/csv.js';
import { list as sendList } from '../../shared/envelope.js';
import { listMeta, parsePagination, parseSort } from '../../shared/pagination.js';
import { pingRedis } from '../../shared/redis.js';
import { getSystemStatus, registerStatusCheck, type StatusLevel } from '../../shared/systemStatus.js';
import { toHealthCountsDto, toUsageListDto, type UsageListDto } from './dto.js';
import { jobsStatus } from './jobs.js';
import * as repo from './repository.js';
import type { UsageListQuery } from './schemas.js';
import { platformTx } from './schools.js';

registerStatusCheck('jobs', () => jobsStatus());

const worst = (levels: StatusLevel[]): StatusLevel => (levels.includes('error') ? 'error' : levels.includes('warn') ? 'warn' : 'ok');

/** GET /platform/health */
export async function getHealth(req: Request) {
  const [counts, database, redis, system] = await Promise.all([
    platformTx(req, (tx) => repo.healthCounts(tx)),
    ping(getAppPool()),
    config.redisUrl ? pingRedis() : Promise.resolve({ ok: true, skipped: true as const }),
    getSystemStatus(),
  ]);
  const stats = getJobs().stats();
  const jobs = stats.jobs.map((j) => ({ name: j.name, kind: j.kind, runs: j.runs, failures: j.failures, running: j.running, queued: j.queued }));
  const memory = process.memoryUsage();
  const status = worst([database.ok ? 'ok' : 'error', redis.ok ? 'ok' : 'error', system.level]);
  return {
    status,
    generatedAt: new Date().toISOString(),
    counts: toHealthCountsDto(counts),
    api: {
      status: 'ok' as const,
      environment: config.env,
      uptimeSeconds: Math.round(process.uptime()),
      node: process.version,
      memoryMb: { rss: Math.round(memory.rss / 1048576), heapUsed: Math.round(memory.heapUsed / 1048576) },
    },
    database,
    redis,
    queue: {
      backend: stats.backend,
      /** Consumers/schedules started in THIS process (false on an API instance with a separate worker). */
      startedInThisProcess: stats.started,
      worker: system.checks.jobs ?? null,
      jobs,
    },
    checks: system.checks,
  };
}

const USAGE_SORT = { allowed: { name: 's.name', code: 's.code', status: 's.status', createdAt: 's.created_at' }, defaultSort: 'name', tiebreaker: 's.id' };

const USAGE_CSV: CsvColumn<UsageListDto>[] = [
  { header: 'Code', value: (r) => r.school.code },
  { header: 'Name', value: (r) => r.school.name },
  { header: 'Status', value: (r) => r.school.status },
  { header: 'Plan', value: (r) => r.subscription?.plan ?? '' },
  { header: 'Valid until', value: (r) => r.subscription?.validUntil ?? '' },
  { header: 'Buses', value: (r) => r.usage.buses },
  { header: 'Max buses', value: (r) => r.limits.buses.limit ?? '' },
  { header: 'Students', value: (r) => r.usage.students },
  { header: 'Max students', value: (r) => r.limits.students.limit ?? '' },
  { header: 'Staff', value: (r) => r.usage.staff },
  { header: 'Parents', value: (r) => r.usage.parents },
  { header: 'Routes', value: (r) => r.usage.routes },
  { header: 'Active trips', value: (r) => r.usage.activeTrips },
  { header: 'Trips (30 days)', value: (r) => r.usage.tripsLast30Days },
  { header: 'Last activity', value: (r) => r.usage.lastActivityAt ?? '' },
];

/** GET /platform/usage — counts per school (no school rows), paginated or CSV. */
export async function listUsage(req: Request, res: Response, q: UsageListQuery): Promise<void> {
  const { orderBy } = parseSort(q.sort, USAGE_SORT);
  const filter: repo.SchoolFilter = { q: q.q, statuses: q.status, includeDeleted: false };
  if (q.format === 'csv') {
    const rows = await platformTx(req, (tx) => repo.usageExport(tx, filter, orderBy));
    const csv = createCsvWriter<UsageListDto>(res, { fileName: 'school-usage.csv', columns: USAGE_CSV });
    await csv.writeAll(rows.map(toUsageListDto));
    await csv.end();
    return;
  }
  const { page, limit, offset } = parsePagination(q);
  const { rows, total } = await platformTx(req, (tx) => repo.usagePage(tx, filter, { orderBy, limit, offset }));
  sendList(res, rows.map(toUsageListDto), listMeta({ page, limit, total }));
}
