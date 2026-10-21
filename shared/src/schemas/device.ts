// Device descriptor sent at staff login and device registration (contract §6).
import { z } from 'zod';
import { DEVICE_PLATFORMS } from '../enums.js';
import { semver } from './common.js';

export const deviceInfo = z.object({
  deviceId: z.string().trim().min(8).max(128),
  platform: z.enum(DEVICE_PLATFORMS),
  model: z.string().trim().max(120).optional(),
  appVersion: semver().optional(),
  fcmToken: z.string().trim().max(4096).optional(),
});
export type DeviceInfo = z.infer<typeof deviceInfo>;
