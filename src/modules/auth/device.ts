// Device binding (contract §6, BP §5.2 / §9.1): a driver/conductor session is bound at login to the
// device row of the phone that signed in. Trip and location endpoints mount requireBoundDevice()
// after authenticate() + resolveTenant(): the request must come with the X-Device-Id header of that
// same device, the device must not be blocked, otherwise 403 DEVICE_NOT_BOUND. The trips module
// additionally compares req.boundDevice.id with trips.device_id.
import { HEADERS } from '@wimb/shared';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { deviceNotBound, unauthenticated } from '../../shared/errors.js';
import { findDevice, type DeviceRow } from './repository.js';

export interface BoundDevice {
  id: string;
  deviceUid: string;
  platform: string;
  model: string | null;
  appVersion: string | null;
}

declare module 'express-serve-static-core' {
  interface Request {
    boundDevice?: BoundDevice;
  }
}

function toBound(d: DeviceRow): BoundDevice {
  return { id: d.id, deviceUid: d.device_uid, platform: d.platform, model: d.device_model, appVersion: d.app_version };
}

export function requireBoundDevice(): RequestHandler {
  return async function requireBoundDeviceMiddleware(req: Request, _res: Response, next: NextFunction) {
    const auth = req.auth;
    if (!auth) throw unauthenticated();
    if (!auth.deviceId) throw deviceNotBound('This session is not bound to a device. Please sign in on this phone again.');
    const header = req.get(HEADERS.DEVICE_ID)?.trim();
    if (!header) throw deviceNotBound(`The ${HEADERS.DEVICE_ID} header is required.`);
    const device = await withRequestTenant(req, (tx) => findDevice(tx, auth.deviceId!), { readOnly: true });
    if (!device || device.revoked_at !== null || !device.is_trusted || device.device_uid !== header) {
      throw deviceNotBound();
    }
    req.boundDevice = toBound(device);
    return next();
  };
}
