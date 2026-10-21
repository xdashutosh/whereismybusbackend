// HTTP layer of the trips module: read req.valid, call the service, send the envelope.
import type { Request, Response } from 'express';
import { created, list as sendList, ok } from '../../shared/envelope.js';
import { validated } from '../../shared/validate.js';
import * as admin from './adminActions.js';
import * as queries from './adminQueries.js';
import * as driverHome from './driverHome.js';
import * as driver from './driverTrips.js';
import { endTrip } from './end.js';
import type * as s from './schemas.js';
import { startTrip } from './start.js';

const id = (req: Request) => validated<s.TripParams>(req, 'params').id;

// ── driver / conductor ───────────────────────────────────────────────────────
export async function me(req: Request, res: Response) {
  ok(res, await driverHome.me(req));
}
export async function home(req: Request, res: Response) {
  ok(res, await driverHome.home(req));
}
export async function start(req: Request, res: Response) {
  const result = await startTrip(req, validated<s.StartTripBody>(req, 'body'));
  if (result.replayed) ok(res, result);
  else created(res, result);
}
export async function end(req: Request, res: Response) {
  ok(res, await endTrip(req, id(req), validated<s.EndTripBody>(req, 'body')));
}
export async function active(req: Request, res: Response) {
  ok(res, await driver.activeTrip(req));
}
export async function history(req: Request, res: Response) {
  const { items, meta } = await driver.history(req, validated<s.DriverTripHistoryQuery>(req, 'query'));
  sendList(res, items, meta);
}
export async function events(req: Request, res: Response) {
  ok(res, await driver.reportEvents(req, id(req), validated<s.TripEventsBody>(req, 'body')));
}
export async function interrupt(req: Request, res: Response) {
  ok(res, await driver.interrupt(req, id(req), validated<s.InterruptTripBody>(req, 'body')));
}
export async function device(req: Request, res: Response) {
  ok(res, await driver.registerDevice(req, validated<s.DriverDeviceBody>(req, 'body')));
}

// ── school admin ─────────────────────────────────────────────────────────────
export async function list(req: Request, res: Response) {
  await queries.list(req, res, validated<s.TripListQuery>(req, 'query'));
}
export async function get(req: Request, res: Response) {
  ok(res, await queries.detail(req, id(req)));
}
export async function cancel(req: Request, res: Response) {
  ok(res, await admin.cancelTrip(req, id(req), validated<s.CancelTripBody>(req, 'body')));
}
export async function correctOdometer(req: Request, res: Response) {
  ok(res, await admin.correctOdometer(req, id(req), validated<s.CorrectOdometerBody>(req, 'body')));
}
export async function reassign(req: Request, res: Response) {
  ok(res, await admin.reassignTrip(req, id(req), validated<s.ReassignTripBody>(req, 'body')));
}
