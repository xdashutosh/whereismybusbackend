// Temporary passwords and account e-mails for school admin accounts (BP §5.4: a reset "generates a
// temporary password … forces a change on next login"). Temporary passwords are random, satisfy
// the auth password rules (≥ 8 chars, a letter and a digit), avoid look-alike characters and are
// returned exactly once; only their argon2id hash is stored. E-mails go through the shared email
// channel (SMTP or log) after commit and never fail the request.
import crypto from 'node:crypto';
import config from '../../config/index.js';
import { logger as rootLogger } from '../../shared/logger.js';
import { channels } from '../../shared/notifications/index.js';

const log = rootLogger.child({ module: 'users.credentials' });

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
const DIGITS = '23456789';

const pick = (alphabet: string, n: number) => Array.from({ length: n }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');

/** e.g. 'Kmtp-Wqra-4827' — 8 letters + 4 digits (≈ 58 bits). */
export function generateTemporaryPassword(): string {
  return `${pick(LETTERS, 4)}-${pick(LETTERS, 4)}-${pick(DIGITS, 4)}`;
}

export type AccountMailKind = 'welcome' | 'reset';

export interface AccountMail {
  kind: AccountMailKind;
  to: string;
  fullName: string;
  schoolName: string;
  /** Included only when the server generated it (an admin-chosen password is shared by that admin). */
  temporaryPassword: string | null;
}

export function accountMailText(m: AccountMail): { subject: string; text: string } {
  const signIn = `${config.appPublicUrl}/school/login`;
  const passwordLine = m.temporaryPassword
    ? `Temporary password: ${m.temporaryPassword}`
    : 'Your administrator will give you the temporary password.';
  const intro =
    m.kind === 'welcome'
      ? `A school admin account was created for you at ${m.schoolName} on Where Is My Bus.`
      : `Your Where Is My Bus sign-in for ${m.schoolName} was reset by another school admin. You have been signed out everywhere.`;
  return {
    subject: m.kind === 'welcome' ? `Your Where Is My Bus account for ${m.schoolName}` : `Your Where Is My Bus password was reset`,
    text: [`Hello ${m.fullName},`, '', intro, '', `Sign in: ${signIn}`, `E-mail: ${m.to}`, passwordLine, '', 'You will be asked to choose a new password when you sign in.'].join('\n'),
  };
}

/** Sends the account e-mail without blocking or failing the caller. */
export function sendAccountMail(m: AccountMail): void {
  const { subject, text } = accountMailText(m);
  channels.email.send({ to: m.to, subject, text }).catch((err: unknown) => log.error({ err, kind: m.kind }, 'Account e-mail could not be sent'));
}
