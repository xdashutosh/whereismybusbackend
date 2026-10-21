// Shared write rules of fuel and maintenance logs: attaching an uploaded file (fuel bill /
// maintenance invoice) and the "not in the future" date rule (school-local day).
import type { Tx } from '../../db/tenant.js';
import { conflict, fieldError, invalidState, notFound } from '../../shared/errors.js';

const LOG_TABLES = {
  fuel_log: { table: 'fuel_logs', column: 'bill_file_id', category: 'fuel_bill' },
  maintenance_log: { table: 'maintenance_logs', column: 'invoice_file_id', category: 'maintenance_invoice' },
} as const;
export type LogEntityType = keyof typeof LOG_TABLES;

interface FileLinkRow extends Record<string, unknown> {
  category: string;
  entity_type: string | null;
  entity_id: string | null;
  status: string;
  attached_to: string | null;
}

/**
 * The file must be an uploaded file of the log's category in this school (RLS → 404 otherwise),
 * uploaded for the log's bus (entity 'bus') or for this very log, and not attached to another live
 * log. `field` names the body key in validation errors.
 */
export async function assertAttachableFile(
  tx: Tx,
  fileId: string,
  { kind, busId, logId, field }: { kind: LogEntityType; busId: string; logId: string | null; field: string },
): Promise<void> {
  const spec = LOG_TABLES[kind];
  const f = await tx.maybeOne<FileLinkRow>(
    `select f.category, f.entity_type, f.entity_id, f.status,
            (select x.id from ${spec.table} x where x.${spec.column} = f.id and x.deleted_at is null and x.id is distinct from $2::uuid limit 1) as attached_to
       from files f where f.id = $1`,
    [fileId, logId],
  );
  if (!f) throw notFound('File not found.');
  if (f.category !== spec.category) throw fieldError(field, `Upload the file with category ${spec.category}.`);
  const forBus = f.entity_type === 'bus' && f.entity_id === busId;
  const forLog = logId !== null && f.entity_type === kind && f.entity_id === logId;
  if (!forBus && !forLog) throw fieldError(field, 'The file was uploaded for another record.');
  if (f.status !== 'uploaded') throw invalidState('The file upload is not complete.');
  if (f.attached_to) throw conflict('This file is already attached to another log.', { attachedTo: f.attached_to });
}

/** Rejects a log date after today in the school's timezone. */
export async function assertNotFuture(tx: Tx, day: string, field: string): Promise<string> {
  const today = (await tx.one<{ day: string }>('select app_local_date() as day')).day;
  if (day > today) throw fieldError(field, `Must not be in the future (today is ${today}).`);
  return today;
}
