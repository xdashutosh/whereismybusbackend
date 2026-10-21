// Worker process (contract §8): job consumers + repeatable schedules (BullMQ with Redis). Without
// Redis the in-process backend runs schedules here, but on-demand jobs enqueued by the API process
// cannot reach this process — use JOBS_IN_PROCESS=true on the API in local development instead.
// Metrics: this process has no HTTP server, so it publishes its registry (job runs/failures/durations)
// to the KV store every 15 s and the API merges it into GET /metrics (process="worker"). Optional
// Sentry reporting (SENTRY_DSN) covers job failures and crashes.
import config from './config/index.js';
import { getJobs, runBootMaintenance } from './jobs/index.js';
import { bootChecks, failBoot, installShutdown } from './lifecycle.js';
import { kv } from './shared/kv.js';
import { logger } from './shared/logger.js';
import { setMetricsProcess, startSnapshotPublisher } from './shared/metrics.js';
import { initSentry } from './shared/sentry.js';
import { channels } from './shared/notifications/index.js';
import { storage } from './shared/storage.js';

async function start(): Promise<void> {
  setMetricsProcess('worker');
  if (initSentry({ role: 'worker' })) logger.info('Sentry error reporting enabled');
  // SINGLE_INSTANCE=true: the API process runs every job (JOBS_IN_PROCESS=true); a worker would run
  // the schedules twice and cannot receive the API's on-demand jobs without Redis.
  if (config.singleInstance) throw Object.assign(new Error('SINGLE_INSTANCE=true: jobs run inside the API process — do not start the worker'), { name: 'UnsafeServeMode' });
  await bootChecks('worker');
  if (!config.redisUrl) logger.warn('REDIS_URL is not set: the worker uses the in-process job backend (schedules only; API-enqueued jobs run in the API process)');
  const jobs = getJobs();
  await jobs.start({ schedule: true });
  await runBootMaintenance(logger);
  logger.info({ backend: jobs.backend, jobs: jobs.stats().jobs.map((j) => j.name) }, 'Worker started');
  const stopMetrics = startSnapshotPublisher(kv, { onError: (err) => logger.warn({ err: { message: (err as Error).message } }, 'Metrics snapshot could not be published') });
  installShutdown([
    { name: 'jobs', run: () => jobs.stop() },
    { name: 'metrics', run: stopMetrics },
    { name: 'storage', run: () => storage.close() },
    { name: 'email', run: () => channels.email.close() },
  ]);
}

start().catch((err: unknown) => failBoot(err));
