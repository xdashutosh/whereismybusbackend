// POST /parent/devices (BP §8.5, contract §2 Push): registers or refreshes the parent app's device
// and its FCM token. Parent devices are school-less rows (devices.school_id NULL, owner_type
// 'parent_account'; RLS own_rows + parent_scope: the caller's own rows only), so this call needs no
// X-School-Id. A session that signed in without a device descriptor is bound to the registered device
// (sessions.device_id, own session only), so push targets can be limited to devices with a live
// session. A session already bound to another device gets 403 DEVICE_NOT_BOUND (one session = one
// phone). A blocked (revoked/untrusted) device keeps its state and never receives a token. The token
// never appears in responses or audit logs (hasFcmToken only).
import type { ParentDeviceBody, ParentDeviceDto } from '@wimb/shared';
import type { Request } from 'express';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { audit } from '../../shared/audit.js';
import { deviceNotBound, unauthenticated } from '../../shared/errors.js';

interface DeviceRow extends Record<string, unknown> {
  id: string;
  device_uid: string;
  platform: string;
  device_model: string | null;
  os_version: string | null;
  app_version: string | null;
  has_fcm_token: boolean;
  last_seen_at: string | null;
  revoked_at: string | null;
  is_trusted: boolean;
}

const RETURNING = 'id, device_uid, platform, device_model, os_version, app_version, fcm_token is not null as has_fcm_token, last_seen_at, revoked_at, is_trusted';

function toDto(d: DeviceRow): ParentDeviceDto {
  return {
    id: d.id,
    deviceId: d.device_uid,
    platform: d.platform,
    model: d.device_model,
    osVersion: d.os_version,
    appVersion: d.app_version,
    hasFcmToken: d.has_fcm_token,
    lastSeenAt: d.last_seen_at,
  };
}

export async function registerDevice(req: Request, body: ParentDeviceBody): Promise<ParentDeviceDto> {
  const auth = req.auth;
  if (!auth) throw unauthenticated();
  return withRequestTenant(req, async (tx) => {
    const before = await tx.maybeOne<DeviceRow>(
      `select ${RETURNING} from devices where owner_type = 'parent_account' and owner_id = $1 and device_uid = $2`,
      [auth.actorId, body.deviceId],
    );
    if (auth.deviceId && before?.id !== auth.deviceId) {
      throw deviceNotBound('This session belongs to another device. Please sign in on this phone again.');
    }
    const blocked = before !== null && (before.revoked_at !== null || !before.is_trusted);
    const setToken = body.fcmToken !== undefined && !blocked;
    const row = await tx.one<DeviceRow>(
      `insert into devices (school_id, owner_type, owner_id, device_uid, platform, device_model, os_version, app_name, app_version, fcm_token, last_seen_at)
       values (null, 'parent_account', $1, $2, $3, $4, $5, 'parent_app', $6, case when $7::boolean then $8::text end, now())
       on conflict (owner_type, owner_id, device_uid) do update
          set platform = excluded.platform, device_model = coalesce(excluded.device_model, devices.device_model),
              os_version = coalesce(excluded.os_version, devices.os_version), app_name = coalesce(devices.app_name, 'parent_app'),
              app_version = coalesce(excluded.app_version, devices.app_version),
              fcm_token = case when $7::boolean then $8::text else devices.fcm_token end,
              last_seen_at = now(), updated_at = now()
       returning ${RETURNING}`,
      [auth.actorId, body.deviceId, body.platform, body.model ?? null, body.osVersion ?? null, body.appVersion ?? null, setToken, body.fcmToken ?? null],
    );
    if (!auth.deviceId && !blocked) {
      await tx.query('update sessions set device_id = $1 where id = $2 and device_id is null', [row.id, auth.sessionId]);
    }
    await audit.log(tx, {
      action: before ? 'device.update' : 'device.register',
      entityType: 'device',
      entityId: row.id,
      old: before ? { platform: before.platform, model: before.device_model, osVersion: before.os_version, appVersion: before.app_version, hasFcmToken: before.has_fcm_token } : null,
      new: { platform: row.platform, model: row.device_model, osVersion: row.os_version, appVersion: row.app_version, hasFcmToken: row.has_fcm_token },
    });
    return toDto(row);
  });
}
