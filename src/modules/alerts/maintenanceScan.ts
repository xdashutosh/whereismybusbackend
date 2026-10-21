// maintenance-due-scan (BP §7.3, §11.1 service_due): for every bus in service (active / maintenance) the
// LATEST non-deleted maintenance log of each service type (case-insensitive) carries the next due date
// and/or km. A newer log of the same type (the service was done) supersedes the older one, so its alert
// is resolved automatically.
//   due soon  next_due_date within SERVICE_DUE_LEAD_DAYS (7) of the school-local day, or the bus
//             odometer (buses.last_known_odometer) within SERVICE_DUE_LEAD_KM (500) of next_due_km
//             → service_due warning, key service_due:{logId}:due_soon
//   overdue   next_due_date before today or odometer ≥ next_due_km
//             → service_due critical, key service_due:{logId}:overdue (supersedes the due-soon alert)
import { SERVICE_DUE_LEAD_DAYS, SERVICE_DUE_LEAD_KM, type AlertType } from '@wimb/shared';
import type { Tx } from '../../db/tenant.js';
import type { DesiredAlert } from './reconcile.js';

export const MAINTENANCE_DUE_SCAN_JOB = 'maintenance-due-scan';
export const MAINTENANCE_ALERT_TYPES: readonly AlertType[] = ['service_due'];

export const MAINTENANCE_NOTES = {
  superseded: 'Superseded: the service is now overdue.',
  resolved: 'Resolved automatically: the service was logged, rescheduled or the bus is out of service.',
};

interface DueRow extends Record<string, unknown> {
  id: string;
  bus_id: string;
  bus_code: string;
  service_type: string;
  next_due_date: string | null;
  next_due_km: number | null;
  odometer: number | null;
  days_left: number | null;
}

function loadRows(tx: Tx, localDate: string): Promise<DueRow[]> {
  return tx.many<DueRow>(
    `with latest as (
       select distinct on (m.bus_id, lower(btrim(m.service_type))) m.id, m.bus_id, m.service_type, m.next_due_date, m.next_due_km
         from maintenance_logs m
        where m.deleted_at is null
        order by m.bus_id, lower(btrim(m.service_type)), m.service_date desc, m.created_at desc, m.id desc
     )
     select l.id, l.bus_id, b.code as bus_code, l.service_type, l.next_due_date, l.next_due_km, b.last_known_odometer as odometer,
            (l.next_due_date - $1::date) as days_left
       from latest l
       join buses b on b.id = l.bus_id and b.deleted_at is null and b.status in ('active', 'maintenance')
      where (l.next_due_date is not null and l.next_due_date <= $1::date + $2::int)
         or (l.next_due_km is not null and b.last_known_odometer is not null and b.last_known_odometer >= l.next_due_km - $3::numeric)`,
    [localDate, SERVICE_DUE_LEAD_DAYS, SERVICE_DUE_LEAD_KM],
  );
}

const km = (n: number) => `${Math.round(n).toLocaleString('en-IN')} km`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function desiredMaintenanceAlerts(rows: readonly DueRow[], localDate: string): DesiredAlert[] {
  const out: DesiredAlert[] = [];
  for (const r of rows) {
    const days = r.days_left === null ? null : Number(r.days_left);
    const dueKm = r.next_due_km === null ? null : Number(r.next_due_km);
    const odo = r.odometer === null ? null : Number(r.odometer);
    const overdueDate = days !== null && days < 0;
    const overdueKm = dueKm !== null && odo !== null && odo >= dueKm;
    const soonDate = days !== null && days <= SERVICE_DUE_LEAD_DAYS;
    const soonKm = dueKm !== null && odo !== null && odo >= dueKm - SERVICE_DUE_LEAD_KM;
    if (!overdueDate && !overdueKm && !soonDate && !soonKm) continue;
    const stage = overdueDate || overdueKm ? 'overdue' : 'due_soon';
    const reason: 'date' | 'km' = overdueDate || (!overdueKm && soonDate) ? 'date' : 'km';
    const service = r.service_type.trim();
    const what = `${service} for bus ${r.bus_code}`;
    let title: string;
    if (stage === 'overdue') {
      title = reason === 'date' ? `${what} is overdue (was due on ${r.next_due_date})` : `${what} is overdue (due at ${km(dueKm!)}, bus at ${km(odo!)})`;
    } else if (reason === 'date') {
      title = `${what} is due ${days === 0 ? 'today' : `in ${plural(days!, 'day')}`} (${r.next_due_date})`;
    } else {
      title = `${what} is due at ${km(dueKm!)} (bus at ${km(odo!)})`;
    }
    out.push({
      type: 'service_due',
      severity: stage === 'overdue' ? 'critical' : 'warning',
      entity: { type: 'maintenance_log', id: r.id },
      busId: r.bus_id,
      title,
      dedupeKey: `service_due:${r.id}:${stage}`,
      subject: `maintenance_log:${r.id}`,
      details: {
        stage,
        reason,
        serviceType: service,
        busCode: r.bus_code,
        nextDueDate: r.next_due_date,
        nextDueKm: dueKm,
        odometer: odo,
        daysToDue: days,
        kmToDue: dueKm !== null && odo !== null ? Math.round((dueKm - odo) * 10) / 10 : null,
        localDate,
      },
    });
  }
  return out;
}

export async function computeMaintenanceAlerts(tx: Tx, localDate: string): Promise<DesiredAlert[]> {
  return desiredMaintenanceAlerts(await loadRows(tx, localDate), localDate);
}
