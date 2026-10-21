// Driver/conductor app logins (BP §5.1 school code + phone/username + password or PIN, §5.4 "School
// Admin can reset driver/conductor access… generates a temporary password… forces a change on next
// login"). POST /school/staff/:id/credentials creates the login when the staff member has none and
// otherwise resets it. A reset replaces EVERY secret (password and PIN), clears any lockout, may
// change the login identifiers, and revokes every session of the login in the same transaction;
// sockets are disconnected after commit. Generated secrets are returned exactly once (the response
// is marked no-store); only argon2id hashes are stored and nothing secret is audited.
import crypto from 'node:crypto';
import type { StaffCredentialsResult } from '@wimb/shared';
import type { Request } from 'express';
import { registerConstraintError } from '../../middleware/errorHandler.js';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { audit } from '../../shared/audit.js';
import { hashPassword } from '../../shared/crypto.js';
import { fieldError, notFound } from '../../shared/errors.js';
import { realtime } from '../../shared/realtime.js';
import { revokeAllSessions } from '../auth/index.js';
import { toLoginDto } from './dto.js';
import * as loginRepo from './loginRepository.js';
import * as repo from './repository.js';
import type { CredentialsBody } from './schemas.js';
import { detailRows, toDetailDto } from './service.js';

registerConstraintError('users_staff_phone_uq', 'DUPLICATE', 'Another driver or conductor of this school already signs in with this phone number.');
registerConstraintError('users_staff_username_uq', 'DUPLICATE', 'Another driver or conductor of this school already uses this username.');
registerConstraintError('users_staff_login_ck', 'VALIDATION_ERROR', 'A login needs a phone number or a username.');

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
const DIGITS = '23456789';
const pick = (alphabet: string, n: number) => Array.from({ length: n }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');

/** e.g. 'Kmtp-Wqra-4827' — 8 letters + 4 digits (≈ 58 bits); satisfies the auth password rules. */
export function generateTemporaryPassword(): string {
  return `${pick(LETTERS, 4)}-${pick(LETTERS, 4)}-${pick(DIGITS, 4)}`;
}

const SEQ = '01234567890';
/** Random 6-digit PIN that is neither one repeated digit nor an ascending/descending run. */
export function generatePin(): string {
  for (;;) {
    const pin = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    if (/^(\d)\1+$/.test(pin) || SEQ.includes(pin) || SEQ.split('').reverse().join('').includes(pin)) continue;
    return pin;
  }
}

/** POST /school/staff/:id/credentials */
export async function setCredentials(req: Request, id: string, body: CredentialsBody): Promise<StaffCredentialsResult> {
  const temporaryPassword = body.password ? null : generateTemporaryPassword();
  const generatedPin = body.generatePin ? generatePin() : null;
  const pin = generatedPin ?? body.pin ?? null;
  const [passwordHash, pinHash] = await Promise.all([hashPassword(body.password ?? temporaryPassword!), pin ? hashPassword(pin) : Promise.resolve(null)]);
  const mustChangePassword = body.mustChangePassword ?? true;

  const result = await withRequestTenant(req, async (tx) => {
    const staff = await repo.lock(tx, id);
    if (!staff) throw notFound('Staff member not found.');
    const existing = staff.user_id ? await loginRepo.lockLogin(tx, staff.user_id) : null;
    const phone = body.phone !== undefined ? body.phone : existing ? existing.phone : staff.phone;
    const username = body.username !== undefined ? body.username : (existing?.username ?? null);
    if (!phone && !username) {
      throw fieldError(body.phone === null || existing ? 'phone' : 'username', 'A login needs a phone number or a username (the staff profile has no phone).');
    }
    let ids: string[] = [];
    let userId: string;
    if (existing) {
      userId = existing.id;
      await loginRepo.resetLogin(tx, userId, { phone, username, passwordHash, pinHash, mustChangePassword });
      ids = await revokeAllSessions(tx, 'user', userId, 'credentials_reset');
    } else {
      userId = await loginRepo.insertLogin(tx, {
        role: staff.staff_type,
        fullName: staff.full_name,
        phone,
        username,
        passwordHash,
        pinHash,
        mustChangePassword,
        isActive: staff.is_active,
      });
      await repo.linkUser(tx, id, userId);
    }
    await audit.log(tx, {
      action: existing ? 'staff.credentials_reset' : 'staff.credentials_create',
      entityType: 'staff',
      entityId: id,
      old: existing ? { loginPhone: existing.phone, loginUsername: existing.username, signInMethods: existing.has_pin ? ['password', 'pin'] : ['password'] } : null,
      new: {
        userId,
        loginPhone: phone,
        loginUsername: username,
        // Key names avoid secret words (audit redaction) — values are method names, never secrets.
        signInMethods: pin !== null ? ['password', 'pin'] : ['password'],
        generatedByServer: [...(temporaryPassword !== null ? ['password'] : []), ...(generatedPin !== null ? ['pin'] : [])],
        forcedChangeAtSignIn: mustChangePassword,
        revokedSessions: ids.length,
      },
    });
    return { rows: await detailRows(tx, id), ids, created: !existing };
  });
  if (result.ids.length) await realtime.disconnectSessions(result.ids);
  const staff = await toDetailDto(req, result.rows);
  return { staff, login: toLoginDto(result.rows.row)!, created: result.created, temporaryPassword, pin: generatedPin, revokedSessions: result.ids.length };
}

/**
 * POST /school/staff/:id/sessions/revoke — signs the driver/conductor out on every device (BP §5.2
 * force logout, e.g. a lost phone) and keeps the password/PIN: sessions revoked in the school
 * transaction, sockets disconnected after commit, audited. A staff member without a login has none.
 */
export async function revokeSessions(req: Request, id: string): Promise<{ id: string; revokedSessions: number }> {
  const ids = await withRequestTenant(req, async (tx) => {
    const locked = await repo.lock(tx, id);
    if (!locked) throw notFound('Staff member not found.');
    const revoked = locked.user_id ? await revokeAllSessions(tx, 'user', locked.user_id, 'admin_signout') : [];
    await audit.log(tx, { action: 'staff.sessions_revoke', entityType: 'staff', entityId: id, new: { revokedSessions: revoked.length } });
    return revoked;
  });
  if (ids.length) await realtime.disconnectSessions(ids);
  return { id, revokedSessions: ids.length };
}
