// maintenance-due-refresh (queue job): re-runs the alerts module's maintenance-due-scan for one school
// right after a maintenance log is created, edited or deleted, so a logged service resolves its
// service_due alert (and a new next-due date raises one) without waiting for the 06:45 daily scan.
// Idempotent: the scan reconciles against dedupe keys. Payload carries school_id (contract §4).
import { defineQueueJob } from '../../jobs/registry.js';
import type { JobDef } from '../../jobs/types.js';
import { childLogger } from '../../shared/logger.js';
import { maintenanceDueScan } from '../alerts/jobs.js';

export const MAINTENANCE_DUE_REFRESH_JOB = 'maintenance-due-refresh';

export interface MaintenanceDueRefreshPayload {
  schoolId: string;
}

export async function maintenanceDueRefresh({ schoolId }: MaintenanceDueRefreshPayload) {
  return maintenanceDueScan({ schoolId });
}

export const maintenanceDueRefreshJob = defineQueueJob<MaintenanceDueRefreshPayload>({
  name: MAINTENANCE_DUE_REFRESH_JOB,
  attempts: 3,
  backoffMs: 5000,
  concurrency: 1,
  handler: async (p) => void (await maintenanceDueRefresh(p)),
});

export const MAINTENANCE_JOB_DEFINITIONS: readonly JobDef[] = [maintenanceDueRefreshJob];

const log = childLogger({ module: 'maintenance' });

/** Queues the refresh after commit; a queue failure is logged (the daily scan still runs). */
export async function queueDueRefresh(schoolId: string): Promise<void> {
  try {
    const { jobs } = await import('../../jobs/index.js');
    await jobs.enqueue(MAINTENANCE_DUE_REFRESH_JOB, { schoolId });
  } catch (err) {
    log.error({ err, schoolId }, 'Could not queue the maintenance due refresh');
  }
}
