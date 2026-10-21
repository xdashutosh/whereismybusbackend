// Cryptographic helpers (contract §2, BP §5): argon2id passwords, opaque tokens stored as SHA-256,
// numeric OTPs, TOTP (Super Admin 2FA), HMAC signing and authenticated encryption of small
// secrets at rest (e.g. platform_users.totp_secret_enc).
import crypto from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { generateSecret, generateURI, verify as otpVerify } from 'otplib';
import QRCode from 'qrcode';
import config from '../config/index.js';

// ── passwords (argon2id) ─────────────────────────────────────────────────────
/** OWASP-recommended argon2id parameters (19 MiB, t=2, p=1); tests lower the cost. */
export const ARGON2_OPTIONS = Object.freeze(
  config.isTest ? { memoryCost: 1024, timeCost: 1, parallelism: 1 } : { memoryCost: 19456, timeCost: 2, parallelism: 1 },
);
// @node-rs/argon2 Algorithm.Argon2id === 2 (const enum; not importable under isolatedModules).
const ARGON2ID = 2;

export async function hashPassword(plain: string): Promise<string> {
  if (typeof plain !== 'string' || plain.length === 0) throw new TypeError('hashPassword requires a non-empty string');
  return argonHash(plain, { ...ARGON2_OPTIONS, algorithm: ARGON2ID });
}

/** Constant-time verification; false for malformed hashes. */
export async function verifyPassword(hash: string | null | undefined, plain: string): Promise<boolean> {
  if (!hash || typeof plain !== 'string') return false;
  try {
    return await argonVerify(hash, plain);
  } catch {
    return false;
  }
}

/** A precomputed hash for timing equalisation when the account does not exist. */
let dummyHash: Promise<string> | null = null;
export async function verifyAgainstDummy(plain: string): Promise<false> {
  dummyHash ??= hashPassword('wimb-dummy-password-for-timing');
  await verifyPassword(await dummyHash, plain);
  return false;
}

// ── opaque tokens ────────────────────────────────────────────────────────────
/** Cryptographically random opaque token (base64url). Default 32 bytes = 256 bits. */
export function generateOpaqueToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** SHA-256 hex — the only form in which refresh/reset tokens and OTPs are stored. */
export function sha256Hex(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
export const hashToken = (token: string): string => sha256Hex(String(token));

/** New refresh token: { token (client), tokenHash (DB), expiresAt }. */
export function generateRefreshToken({ ttlSeconds = config.jwt.refreshTtlSeconds, now = Date.now() } = {}) {
  const token = generateOpaqueToken(32);
  return { token, tokenHash: hashToken(token), expiresAt: new Date(now + ttlSeconds * 1000) };
}

// ── OTP (parent login) ───────────────────────────────────────────────────────
/** Uniformly random numeric code with `digits` digits (leading zeros kept). */
export function generateNumericOtp(digits = 6): string {
  if (!Number.isInteger(digits) || digits < 4 || digits > 10) throw new RangeError('digits must be 4–10');
  return String(crypto.randomInt(0, 10 ** digits)).padStart(digits, '0');
}

/** OTP hash bound to its subject (e.g. the E.164 phone) so a hash cannot be replayed elsewhere. */
export function hashOtp(otp: string, subject: string): string {
  return hmacSign(`${subject}:${otp}`, 'otp');
}

// ── comparison / HMAC ────────────────────────────────────────────────────────
/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) {
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function derivedKey(purpose: string, secret: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', secret, 'whereismybus', `wimb:${purpose}`, 32));
}

/** HMAC-SHA256 (base64url) with a key derived from JWT_ACCESS_SECRET for one purpose. */
export function hmacSign(value: string, purpose: string, { secret = config.jwt.accessSecret } = {}): string {
  return crypto.createHmac('sha256', derivedKey(`hmac:${purpose}`, secret)).update(String(value)).digest('base64url');
}

// ── secrets at rest (AES-256-GCM) ────────────────────────────────────────────
/** Encrypts a small secret → 'v1.<iv>.<tag>.<ciphertext>' (base64url parts). */
export function encryptSecret(plain: string, { purpose = 'secret', secret = config.jwt.accessSecret } = {}): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey(`enc:${purpose}`, secret), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

/** Decrypts encryptSecret() output; throws on tampering or a wrong key. */
export function decryptSecret(payload: string, { purpose = 'secret', secret = config.jwt.accessSecret } = {}): string {
  const [v, iv, tag, ct] = String(payload).split('.');
  if (v !== 'v1' || !iv || !tag || ct === undefined) throw new Error('Unsupported encrypted secret format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', derivedKey(`enc:${purpose}`, secret), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

// ── TOTP (Super Admin 2FA, contract §6) ──────────────────────────────────────
export function generateTotpSecret(): string {
  return generateSecret({ length: 20 });
}

/** otpauth:// URI for authenticator apps. */
export function totpUri(secret: string, accountLabel: string, issuer = config.totpIssuer): string {
  return generateURI({ issuer, label: accountLabel, secret });
}

/** PNG data URL of the otpauth URI (for the enrolment screen). */
export async function totpQrDataUrl(uri: string): Promise<string> {
  return QRCode.toDataURL(uri, { errorCorrectionLevel: 'M', margin: 1, width: 240 });
}

/**
 * Verifies a 6-digit TOTP with ±1 step tolerance (30 s) and replay protection: codes whose time
 * step is <= afterTimeStep (the last accepted step) are rejected. → the accepted time step or null.
 */
export async function verifyTotpStep(secret: string, token: string, { afterTimeStep, epoch }: { afterTimeStep?: number | null; epoch?: number } = {}): Promise<number | null> {
  if (!/^\d{6}$/.test(String(token))) return null;
  try {
    const result = await otpVerify({
      secret,
      token: String(token),
      epochTolerance: 30,
      ...(afterTimeStep !== undefined && afterTimeStep !== null ? { afterTimeStep } : {}),
      ...(epoch !== undefined ? { epoch } : {}),
    });
    return result.valid && 'timeStep' in result ? Number(result.timeStep) : null;
  } catch {
    return null;
  }
}

/** Verifies a 6-digit TOTP with ±1 step tolerance (30 s). */
export async function verifyTotp(secret: string, token: string): Promise<boolean> {
  if (!/^\d{6}$/.test(String(token))) return false;
  try {
    const result = await otpVerify({ secret, token: String(token), epochTolerance: 30 });
    return result.valid;
  } catch {
    return false;
  }
}
