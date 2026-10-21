// Request context helpers shared by the driver and admin services of the trips module.
import type { AlertSeverity, AlertType } from '@wimb/shared';
import type { Request } from 'express';
import type { BoundDevice } from '../auth/index.js';
import type { Tx } from '../../db/tenant.js';
import type { AuthContext } from '../../middleware/authenticate.js';
import { deviceNotBound, unauthenticated } from '../../shared/errors.js';
import type { RaisedAlert } from '../alerts/service.js';
import type { TripRow } from './repository.js';

export interface DriverContext {
  auth: AuthContext;
  schoolId: string;
  /** Device the session is bound to (requireBoundDevice). */
  device: BoundDevice;
}

export function schoolContext(req: Request): { auth: AuthContext; schoolId: string } {
  const auth = req.auth;
  const schoolId = req.tenant?.schoolId;
  if (!auth || !schoolId) throw unauthenticated();
  return { auth, schoolId };
}

export function driverContext(req: Request): DriverContext {
  const { auth, schoolId } = schoolContext(req);
  if (!req.boundDevice) throw deviceNotBound();
  return { auth, schoolId, device: req.boundDevice };
}

/** The caller started the trip or is its driver/conductor. */
export function isParticipant(t: Pick<TripRow, 'started_by' | 'driver_staff_id' | 'conductor_staff_id'>, userId: string, staffId: string | null): boolean {
  return t.started_by === userId || (staffId !== null && (t.driver_staff_id === staffId || t.conductor_staff_id === staffId));
}

export interface AlertBrief {
  type: AlertType;
  severity: AlertSeverity;
  title: string;
}

export const briefOf = (alerts: readonly (RaisedAlert | null)[]): AlertBrief[] =>
  alerts.filter((a): a is RaisedAlert => a !== null).map((a) => ({ type: a.type, severity: a.severity, title: a.title }));

/** Local "today" of the current school (transaction context). */
export async function localToday(tx: Tx): Promise<string> {
  return (await tx.one<{ d: string }>('select app_local_date()::text as d')).d;
}

/** Adds the server clock at the answer (BP §14.3: the driver app measures its clock offset from it). */
export function withServerTime<T extends object>(result: T): T & { serverTime: string } {
  return { serverTime: new Date().toISOString(), ...result };
}
