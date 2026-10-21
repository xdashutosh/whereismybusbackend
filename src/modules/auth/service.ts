// Sign-in flows (BP §5.1, contract §6) for school admins, drivers/conductors and the parent
// password fallback. Super Admin (+TOTP) lives in totp.ts, parent OTP in otp.ts. Every flow:
// definer lookup → atomic attempt reservation (lockout.ts; refused while locked) → credential check
// (constant-time; dummy hash for unknown accounts) → status checks → session (+ device) written in
// the actor's own context → audit. Failures count; success clears; other outcomes refund the slot.
import { withTenant } from '../../db/tenant.js';
import { verifyAgainstDummy, verifyPassword } from '../../shared/crypto.js';
import { deviceNotBound, forbidden, schoolInactive } from '../../shared/errors.js';
import type { KvStore } from '../../shared/kv.js';
import { logger as rootLogger } from '../../shared/logger.js';
import { maskPhone } from '../../shared/phone.js';
import { beginAttempt, clearAttempts, failKnown, failUnknown, refundOnError } from './lockout.js';
import * as repo from './repository.js';
import type { ParentPasswordLoginBody, SchoolLoginBody, StaffLoginBody } from './schemas.js';
import { auditAuth, createSession, ownerContext, type ClientInfo, type IssuedSession, type SessionOwner } from './sessions.js';

const log = rootLogger.child({ module: 'auth' });

export interface LoginResult {
  session: IssuedSession;
  owner: SessionOwner;
  mustChangePassword: boolean;
}

export interface LoginDeps {
  kv: KvStore;
}

const deactivated = () => forbidden('This account has been deactivated. Please contact your school.');

function assertSchoolUsable(row: repo.SchoolUserLoginRow): void {
  if (row.school_deleted || row.school_status !== 'active') throw schoolInactive();
}

/** POST /auth/school/login — globally unique e-mail + password. */
export async function schoolAdminLogin(deps: LoginDeps, body: SchoolLoginBody, client: ClientInfo): Promise<LoginResult> {
  const row = await repo.findSchoolAdmin(body.email);
  if (!row) {
    const attempt = await beginAttempt(deps.kv, { kind: 'unknown', loginKind: 'school', identifier: body.email });
    await verifyAgainstDummy(body.password);
    return failUnknown(attempt);
  }
  const attempt = await beginAttempt(deps.kv, {
    kind: 'account',
    ownerType: 'user',
    ownerId: row.id,
    lockedUntil: row.locked_until,
    reloadLockedUntil: async () => (await repo.findSchoolAdmin(body.email))?.locked_until ?? null,
  });
  const owner: SessionOwner = { ownerType: 'user', ownerId: row.id, role: 'school_admin', schoolId: row.school_id };
  if (!(await verifyPassword(row.password_hash, body.password))) {
    return failKnown(attempt, { ownerType: 'user', ownerId: row.id, ctx: ownerContext(owner) }, 'bad_password');
  }
  const session = await refundOnError(attempt, async () => {
    if (!row.is_active) throw deactivated();
    assertSchoolUsable(row);
    return withTenant(ownerContext(owner), async (tx) => {
      const s = await createSession(tx, owner, client, { touchLogin: true });
      await auditAuth(tx, { action: 'auth.login', entityType: 'session', entityId: s.sessionId, new: { method: 'password', client: client.client }, actorName: row.full_name });
      return s;
    });
  });
  await clearAttempts(attempt);
  return { session, owner, mustChangePassword: row.must_change_password };
}

/** POST /auth/staff/login — school code + phone|username + password|PIN + device (bound to the session). */
export async function staffLogin(deps: LoginDeps, body: StaffLoginBody, client: ClientInfo): Promise<LoginResult & { deviceId: string }> {
  const identifier = body.phone ?? body.username ?? '';
  const lockKey = `${body.schoolCode}|${identifier}`;
  const credential = body.password ?? body.pin ?? '';
  const row = await repo.findStaffUser(body.schoolCode, identifier);
  if (!row) {
    const attempt = await beginAttempt(deps.kv, { kind: 'unknown', loginKind: 'staff', identifier: lockKey });
    await verifyAgainstDummy(credential);
    return failUnknown(attempt);
  }
  const attempt = await beginAttempt(deps.kv, {
    kind: 'account',
    ownerType: 'user',
    ownerId: row.id,
    lockedUntil: row.locked_until,
    reloadLockedUntil: async () => (await repo.findStaffUser(body.schoolCode, identifier))?.locked_until ?? null,
  });
  const owner: SessionOwner = { ownerType: 'user', ownerId: row.id, role: row.role, schoolId: row.school_id };
  const hash = body.pin !== undefined ? row.pin_hash : row.password_hash;
  const ok = hash ? await verifyPassword(hash, credential) : await verifyAgainstDummy(credential);
  if (!ok) return failKnown(attempt, { ownerType: 'user', ownerId: row.id, ctx: ownerContext(owner) }, body.pin !== undefined ? 'bad_pin' : 'bad_password');
  const signedIn = await refundOnError(attempt, async () => {
    if (!row.is_active) throw deactivated();
    assertSchoolUsable(row);
    return staffSession(row, owner, body, client);
  });
  await clearAttempts(attempt);
  return signedIn;
}

async function staffSession(row: repo.SchoolUserLoginRow, owner: SessionOwner, body: StaffLoginBody, client: ClientInfo): Promise<LoginResult & { deviceId: string }> {
  const result = await withTenant(ownerContext(owner), async (tx) => {
    const device = await repo.upsertDevice(tx, {
      ownerType: 'user',
      ownerId: row.id,
      schoolId: row.school_id,
      deviceUid: body.device.deviceId,
      platform: body.device.platform,
      model: body.device.model ?? null,
      appName: 'driver_app',
      appVersion: body.device.appVersion ?? client.appVersion,
      fcmToken: body.device.fcmToken ?? null,
    });
    if (device.revoked_at !== null || !device.is_trusted) return { blocked: true as const, deviceId: device.id };
    const s = await createSession(tx, owner, { ...client, appName: 'driver_app', appVersion: body.device.appVersion ?? client.appVersion }, { deviceId: device.id, touchLogin: true });
    await auditAuth(tx, {
      action: 'auth.login',
      entityType: 'session',
      entityId: s.sessionId,
      new: { method: body.pin !== undefined ? 'pin' : 'password', deviceId: device.id, platform: body.device.platform, model: body.device.model ?? null },
      actorName: row.full_name,
    });
    return { blocked: false as const, deviceId: device.id, session: s };
  });
  if (result.blocked) throw deviceNotBound('This device has been blocked by your school. Please contact the school office.');
  return { session: result.session, owner, mustChangePassword: row.must_change_password, deviceId: result.deviceId };
}

/** Creates a parent session (after OTP or password verification). */
export async function startParentSession(parentId: string, client: ClientInfo, device: ParentPasswordLoginBody['device'], method: 'otp' | 'password'): Promise<LoginResult> {
  const owner: SessionOwner = { ownerType: 'parent_account', ownerId: parentId, role: 'parent', schoolId: null };
  const session = await withTenant(ownerContext(owner), async (tx) => {
    let deviceId: string | null = null;
    if (device) {
      const d = await repo.upsertDevice(tx, {
        ownerType: 'parent_account',
        ownerId: parentId,
        schoolId: null,
        deviceUid: device.deviceId,
        platform: device.platform,
        model: device.model ?? null,
        appName: 'parent_app',
        appVersion: device.appVersion ?? client.appVersion,
        fcmToken: device.fcmToken ?? null,
      });
      if (d.revoked_at === null && d.is_trusted) deviceId = d.id;
    }
    const s = await createSession(tx, owner, { ...client, appName: client.appName ?? 'parent_app' }, { deviceId, touchLogin: true });
    await auditAuth(tx, { action: 'auth.login', entityType: 'session', entityId: s.sessionId, new: { method } });
    return s;
  });
  return { session, owner, mustChangePassword: false };
}

/** POST /auth/parent/password-login — optional fallback for parents who set a password. */
export async function parentPasswordLogin(deps: LoginDeps, body: ParentPasswordLoginBody, client: ClientInfo): Promise<LoginResult> {
  const row = await repo.findParent(body.phone);
  if (!row || !row.password_hash) {
    const attempt = await beginAttempt(deps.kv, { kind: 'unknown', loginKind: 'parent', identifier: body.phone });
    await verifyAgainstDummy(body.password);
    return failUnknown(attempt);
  }
  const attempt = await beginAttempt(deps.kv, {
    kind: 'account',
    ownerType: 'parent_account',
    ownerId: row.id,
    lockedUntil: row.locked_until,
    reloadLockedUntil: async () => (await repo.findParent(body.phone))?.locked_until ?? null,
  });
  if (!(await verifyPassword(row.password_hash, body.password))) {
    return failKnown(attempt, { ownerType: 'parent_account', ownerId: row.id, ctx: { schoolId: null, actorId: row.id, role: 'parent' } }, 'bad_password');
  }
  const result = await refundOnError(attempt, async () => {
    if (!row.is_active) throw deactivated();
    if (!row.has_active_link) throw forbidden('Your number is not linked to an active school.');
    log.info({ parent: maskPhone(body.phone) }, 'Parent signed in with password');
    return startParentSession(row.id, client, body.device, 'password');
  });
  await clearAttempts(attempt);
  return result;
}
