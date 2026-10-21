// After-commit publication of alert status changes: `alert:updated` to school:{id}:alerts (admin bell
// and inbox refresh) and the in-process 'alert.updated' event (notifications, dashboards). New alerts
// are announced by service.announceAlerts (alert:new + 'alert.raised').
import { ALERT_UPDATED_EVENT, type AlertAction, type AlertSeverity, type AlertStatus, type AlertType, type AlertUpdatedEvent } from '@wimb/shared';
import { events } from '../../shared/events.js';
import { logger as rootLogger } from '../../shared/logger.js';
import { realtime, rooms } from '../../shared/realtime.js';

const log = rootLogger.child({ module: 'alerts' });

export interface AlertUpdate {
  schoolId: string;
  id: string;
  type: AlertType;
  severity: AlertSeverity;
  status: AlertStatus;
  action: AlertAction | 'resolve';
  updatedAt: string;
}

declare module '../../shared/events.js' {
  interface AppEvents {
    /** An alert changed status (admin review / escalate / close, or system resolution) — after commit. */
    'alert.updated': AlertUpdate;
  }
}

/** Never throws (a failed publish is logged; the change is already committed). */
export async function announceAlertUpdates(updates: readonly AlertUpdate[]): Promise<void> {
  for (const u of updates) {
    events.emit('alert.updated', u);
    const payload: AlertUpdatedEvent = { id: u.id, type: u.type, severity: u.severity, status: u.status, action: u.action, updatedAt: u.updatedAt };
    try {
      await realtime.emit(rooms.schoolAlerts(u.schoolId), ALERT_UPDATED_EVENT, payload);
    } catch (err) {
      log.warn({ err, schoolId: u.schoolId, alertId: u.id }, 'Could not publish the alert update');
    }
  }
}
