// School admin credentials issued by the Super Admin (BP §2.2, §13.2, App. A): a temporary
// password (forced change at first sign-in) that is either shown once to the Super Admin
// ('show') or e-mailed to the admin as the invitation ('email'). Passwords are never logged or
// audited; e-mails go through the shared email channel (SMTP, or the log in development).
import crypto from 'node:crypto';
import config from '../../config/index.js';
import { hashPassword } from '../../shared/crypto.js';
import { logger as rootLogger } from '../../shared/logger.js';
import { channels } from '../../shared/notifications/index.js';
import { parseOrThrow } from '../../shared/validate.js';
import { newPassword } from '../auth/index.js';

const log = rootLogger.child({ module: 'platform.credentials' });
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
/** Largest multiple of the alphabet size ≤ 256: bytes at or above it are skipped (no modulo bias). */
const UNBIASED_LIMIT = Math.floor(256 / ALPHABET.length) * ALPHABET.length;

/** 14 random characters from an unambiguous alphabet, always with a letter and a digit. */
export function generateTemporaryPassword(length = 14): string {
  for (;;) {
    const bytes = crypto.randomBytes(length * 2);
    let out = '';
    for (const b of bytes) {
      if (b >= UNBIASED_LIMIT) continue;
      out += ALPHABET[b % ALPHABET.length];
      if (out.length === length) break;
    }
    if (out.length === length && /[A-Za-z]/.test(out) && /\d/.test(out)) return out;
  }
}

export interface IssuedCredential {
  password: string;
  generated: boolean;
  hash: string;
}

/** Validates a chosen password (auth rules) or generates one, and hashes it (argon2id). */
export async function issuePassword(chosen: string | undefined, path: (string | number)[]): Promise<IssuedCredential> {
  const password = chosen === undefined ? generateTemporaryPassword() : parseOrThrow(newPassword, chosen, path);
  return { password, generated: chosen === undefined, hash: await hashPassword(password) };
}

export const schoolLoginUrl = (): string => `${config.appPublicUrl}/school/login`;

interface CredentialMail {
  to: string;
  adminName: string;
  schoolName: string;
  schoolCode: string;
  /** Included only for the 'email' delivery. */
  password: string | null;
}

function credentialLines(m: CredentialMail): string[] {
  return m.password
    ? [`Temporary password: ${m.password}`, 'You will be asked to choose a new password when you first sign in.']
    : ['Your temporary password will be shared with you separately by the Where Is My Bus team.', 'You will be asked to choose a new password when you first sign in.'];
}

/** Welcome / invitation e-mail of a new school admin → delivered (false when only logged). */
export async function sendWelcomeEmail(m: CredentialMail): Promise<boolean> {
  const text = [
    `Hello ${m.adminName},`,
    '',
    `${m.schoolName} (${m.schoolCode}) is now set up on Where Is My Bus, and you are its school administrator.`,
    '',
    `Sign in: ${schoolLoginUrl()}`,
    `E-mail: ${m.to}`,
    ...credentialLines(m),
    '',
    'Next steps: complete the school profile, add buses, routes and stops, then staff, students and parents.',
    '',
    '— Where Is My Bus',
  ].join('\n');
  return deliver({ to: m.to, subject: `Welcome to Where Is My Bus — ${m.schoolName}`, text }, 'welcome');
}

/** Password reset notice of a school admin → delivered. */
export async function sendPasswordResetEmail(m: CredentialMail): Promise<boolean> {
  const text = [
    `Hello ${m.adminName},`,
    '',
    `The Where Is My Bus platform team has reset your administrator password for ${m.schoolName} (${m.schoolCode}). All your sessions were signed out.`,
    '',
    `Sign in: ${schoolLoginUrl()}`,
    ...credentialLines(m),
    '',
    'If you did not ask for this, contact the Where Is My Bus team.',
    '',
    '— Where Is My Bus',
  ].join('\n');
  return deliver({ to: m.to, subject: `Your Where Is My Bus password was reset — ${m.schoolName}`, text }, 'password_reset');
}

async function deliver(message: { to: string; subject: string; text: string }, kind: string): Promise<boolean> {
  try {
    const result = await channels.email.send(message);
    return result.delivered;
  } catch (err) {
    log.error({ kind, err: { message: (err as Error).message } }, 'Platform e-mail could not be sent');
    return false;
  }
}
