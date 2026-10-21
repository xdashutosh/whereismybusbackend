// Process lifecycle shared by server.ts and worker.ts: boot checks and graceful shutdown on
// SIGINT/SIGTERM (steps run in order, bounded by a timeout), fatal-error handling. Unhandled
// rejections, uncaught exceptions and boot failures are also reported to Sentry when it is enabled
// (shared/sentry.ts; a no-op otherwise), and pending reports are flushed before the process exits.
import config, { redactedSummary } from './config/index.js';
import { serveModeIssue } from './config/serveGuard.js';
import { assertMigrationsApplied } from './db/migrate.js';
import { closePools, getAppPool } from './db/pool.js';
import { logger, type Logger } from './shared/logger.js';
import { closeRedis } from './shared/redis.js';
import { captureError, closeSentry, flushSentry } from './shared/sentry.js';

export const SHUTDOWN_TIMEOUT_MS = 20000;

/** Config summary, serve-mode guard, warnings, schema check (as the app role). */
export async function bootChecks(role: 'api' | 'worker', log: Logger = logger): Promise<void> {
  log.info({ role, config: redactedSummary() }, 'Starting Where Is My Bus');
  for (const warning of config.warnings) log.warn(warning);
  const issue = serveModeIssue(config);
  if (issue) throw Object.assign(new Error(issue), { name: 'UnsafeServeMode' });
  if (config.allowRemoteDevDb && !config.isProduction) log.warn('ALLOW_REMOTE_DEV_DB=true: running in non-production mode against a remote database');
  if (config.jwt.accessSecretEphemeral) log.warn('JWT_ACCESS_SECRET is not set: using an ephemeral secret (sessions end on restart)');
  if (config.db.appIsOwnerFallback) log.warn('No app role configured: runtime uses the OWNER connection (RLS is not exercised). Set DB_APP_USER/DB_APP_PASSWORD and run npm run db:setup-roles.');
  await assertMigrationsApplied({ pool: getAppPool() });
}

export type ShutdownStep = { name: string; run: () => unknown };

/** Installs signal handlers; steps run in order, then pools and Redis close. */
export function installShutdown(steps: ShutdownStep[], log: Logger = logger): (signal: string, exitCode?: number) => Promise<void> {
  let shuttingDown = false;
  const shutdown = async (signal: string, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'Shutting down');
    const force = setTimeout(() => {
      log.error('Graceful shutdown timed out; exiting');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();
    for (const step of [...steps, { name: 'db pools', run: closePools }, { name: 'redis', run: closeRedis }, { name: 'sentry', run: () => closeSentry() }]) {
      try {
        await step.run();
      } catch (err) {
        exitCode = 1;
        log.error({ err, step: step.name }, 'Shutdown step failed');
      }
    }
    clearTimeout(force);
    log.info('Shutdown complete');
    log.flush?.();
    process.exit(exitCode);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    log.error({ err: reason }, 'Unhandled promise rejection');
    captureError(reason, { source: 'process' });
  });
  process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'Uncaught exception');
    captureError(err, { source: 'process' });
    void shutdown('uncaughtException', 1);
  });
  return shutdown;
}

/** Logs a boot failure (no secrets) and exits non-zero. */
export async function failBoot(err: unknown, log: Logger = logger): Promise<never> {
  const e = err as { message?: string; name?: string; code?: string };
  log.fatal({ err: { message: e.message, name: e.name, code: e.code } }, 'Failed to start');
  captureError(err, { source: 'process' });
  await flushSentry();
  await closePools().catch(() => undefined);
  await closeRedis().catch(() => undefined);
  log.flush?.();
  process.exit(1);
}
