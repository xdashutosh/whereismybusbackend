// App logins of drivers/conductors (users rows with role driver|conductor, linked from
// staff_profiles.user_id). Phone/username are unique per school (users_staff_phone_uq,
// users_staff_username_uq); only argon2id hashes of passwords and PINs are stored.
import type { Tx } from '../../db/tenant.js';

const SCHOOL = "nullif(current_setting('app.school_id', true), '')::uuid";
const ACTOR = "nullif(current_setting('app.actor_id', true), '')::uuid";
const OWN = "role in ('driver', 'conductor') and deleted_at is null";

export interface LoginRow extends Record<string, unknown> {
  id: string;
  role: string;
  phone: string | null;
  username: string | null;
  is_active: boolean;
  has_pin: boolean;
}

/** Locks the live login row of a staff member. */
export function lockLogin(tx: Tx, userId: string): Promise<LoginRow | null> {
  return tx.maybeOne<LoginRow>(
    `select id, role, phone, username::text as username, is_active, (pin_hash is not null) as has_pin
       from users where id = $1 and ${OWN} for update`,
    [userId],
  );
}

export interface NewLogin {
  role: string;
  fullName: string;
  phone: string | null;
  username: string | null;
  passwordHash: string;
  pinHash: string | null;
  mustChangePassword: boolean;
  isActive: boolean;
}

export async function insertLogin(tx: Tx, l: NewLogin): Promise<string> {
  const row = await tx.one<{ id: string }>(
    `insert into users (school_id, role, full_name, phone, username, password_hash, pin_hash, must_change_password, is_active, created_by)
     values (${SCHOOL}, $1, $2, $3, $4, $5, $6, $7, $8, ${ACTOR}) returning id`,
    [l.role, l.fullName, l.phone, l.username, l.passwordHash, l.pinHash, l.mustChangePassword, l.isActive],
  );
  return row.id;
}

export interface LoginReset {
  phone: string | null;
  username: string | null;
  passwordHash: string;
  pinHash: string | null;
  mustChangePassword: boolean;
}

/** Replaces every secret of the login, clears any lockout and (optionally) the identifiers. */
export async function resetLogin(tx: Tx, userId: string, r: LoginReset): Promise<void> {
  await tx.query(
    `update users set phone = $2, username = $3, password_hash = $4, pin_hash = $5, must_change_password = $6,
            failed_login_count = 0, locked_until = null, updated_at = now()
      where id = $1 and ${OWN}`,
    [userId, r.phone, r.username, r.passwordHash, r.pinHash, r.mustChangePassword],
  );
}

export async function syncName(tx: Tx, userId: string, fullName: string): Promise<void> {
  await tx.query(`update users set full_name = $2, updated_at = now() where id = $1 and ${OWN} and full_name is distinct from $2`, [userId, fullName]);
}

export async function setLoginActive(tx: Tx, userId: string, active: boolean): Promise<void> {
  await tx.query(`update users set is_active = $2, updated_at = now() where id = $1 and ${OWN}`, [userId, active]);
}

/** Soft delete: frees the phone/username for reuse; history (trips, audit) keeps the id. */
export async function softDeleteLogin(tx: Tx, userId: string): Promise<void> {
  await tx.query(`update users set deleted_at = now(), is_active = false, updated_at = now() where id = $1 and ${OWN}`, [userId]);
}
