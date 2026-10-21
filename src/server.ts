// API process (contract §1/§2): HTTP (Express) + Socket.IO, plus the job runner when
// JOBS_IN_PROCESS=true (development, and single-instance production: SINGLE_INSTANCE=true without
// Redis — the Render Blueprint). Multi-instance production runs jobs in src/worker.ts. Optional Sentry
// reporting starts first (SENTRY_DSN); Socket.IO connections feed the /metrics gauges.
import http from 'node:http';
import { createApp } from './app.js';
import config from './config/index.js';
import { getJobs, runBootMaintenance } from './jobs/index.js';
import { bootChecks, failBoot, installShutdown } from './lifecycle.js';
import { logger } from './shared/logger.js';
import { instrumentSocketNamespace } from './shared/metrics.js';
import { initSentry } from './shared/sentry.js';
import { channels } from './shared/notifications/index.js';
import { storage } from './shared/storage.js';
import { createSocketServer } from './socket.js';

async function start(): Promise<void> {
  if (initSentry({ role: 'api' })) logger.info('Sentry error reporting enabled');
  await bootChecks('api');
  const app = createApp();
  const server = http.createServer(app);
  server.keepAliveTimeout = 65000; // longer than typical load-balancer idle timeouts
  server.headersTimeout = 66000;
  const sockets = await createSocketServer(server);
  instrumentSocketNamespace(sockets.namespace);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, () => {
      server.off('error', reject);
      resolve();
    });
  });
  logger.info({ port: config.port }, 'HTTP + Socket.IO listening');

  const jobs = getJobs();
  if (config.jobsInProcess) {
    await jobs.start({ schedule: true });
    await runBootMaintenance(logger);
  } else if (!config.redisUrl) {
    logger.warn('JOBS_IN_PROCESS=false without REDIS_URL: scheduled jobs do not run in this process (on-demand jobs still run here)');
  }

  installShutdown([
    { name: 'jobs', run: () => (config.jobsInProcess || !config.redisUrl ? jobs.stop() : undefined) },
    {
      name: 'http + sockets',
      run: async () => {
        server.closeIdleConnections();
        const forceClose = setTimeout(() => server.closeAllConnections(), 5000);
        forceClose.unref();
        await sockets.close(); // also closes the HTTP server
        clearTimeout(forceClose);
      },
    },
    { name: 'storage', run: () => storage.close() },
    { name: 'email', run: () => channels.email.close() },
  ]);
}

start().catch((err: unknown) => failBoot(err));
