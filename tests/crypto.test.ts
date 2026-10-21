// Passwords (argon2id), opaque tokens, OTPs, secrets at rest, TOTP and access JWTs.
import jwt from 'jsonwebtoken';
import { generate } from 'otplib';
import { describe, expect, it } from 'vitest';
import config from '../src/config/index.js';
import {
  decryptSecret,
  encryptSecret,
  generateNumericOtp,
  generateRefreshToken,
  generateTotpSecret,
  hashOtp,
  hashPassword,
  hashToken,
  hmacSign,
  safeEqual,
  totpQrDataUrl,
  totpUri,
  verifyAgainstDummy,
  verifyPassword,
  verifyTotp,
} from '../src/shared/crypto.js';
import { bearerFrom, JWT_AUDIENCE, JWT_ISSUER, ownerTypeOfRole, signAccessToken, verifyAccessToken } from '../src/shared/tokens.js';

const ACTOR = 'ac000000-0000-4000-8000-0000000000ac';
const SID = '5e000000-0000-4000-8000-00000000005e';
const SCHOOL = '5c000000-0000-4000-8000-000000000001';

describe('passwords', () => {
  it('hashes with argon2id and verifies in constant time', async () => {
    const hash = await hashPassword('Wimb@12345');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(hash, 'Wimb@12345')).toBe(true);
    expect(await verifyPassword(hash, 'wrong')).toBe(false);
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
    expect(await verifyPassword(null, 'x')).toBe(false);
    expect(await verifyAgainstDummy('x')).toBe(false);
    await expect(hashPassword('')).rejects.toThrow(TypeError);
  });
});

describe('tokens and OTPs', () => {
  it('creates refresh tokens stored only as hashes', () => {
    const t = generateRefreshToken({ ttlSeconds: 60, now: 0 });
    expect(t.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(t.tokenHash).toBe(hashToken(t.token));
    expect(t.expiresAt.toISOString()).toBe('1970-01-01T00:01:00.000Z');
  });

  it('generates uniform numeric OTPs bound to their subject', () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateNumericOtp()));
    for (const c of codes) expect(c).toMatch(/^\d{6}$/);
    expect(codes.size).toBeGreaterThan(190);
    expect(hashOtp('123456', '+919845012345')).not.toBe(hashOtp('123456', '+919845012346'));
    expect(() => generateNumericOtp(3)).toThrow(RangeError);
  });

  it('compares and signs safely', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(hmacSign('v', 'a')).not.toBe(hmacSign('v', 'b'));
  });

  it('encrypts secrets at rest with authentication', () => {
    const enc = encryptSecret('JBSWY3DPEHPK3PXP', { purpose: 'totp' });
    expect(enc.startsWith('v1.')).toBe(true);
    expect(decryptSecret(enc, { purpose: 'totp' })).toBe('JBSWY3DPEHPK3PXP');
    expect(() => decryptSecret(enc, { purpose: 'other' })).toThrow();
    const parts = enc.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptSecret(parts.join('.'), { purpose: 'totp' })).toThrow();
  });
});

describe('TOTP', () => {
  it('enrols and verifies codes', async () => {
    const secret = generateTotpSecret();
    const uri = totpUri(secret, 'superadmin@example.com');
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain(encodeURIComponent(config.totpIssuer));
    expect(await totpQrDataUrl(uri)).toMatch(/^data:image\/png;base64,/);
    const code = await generate({ secret });
    expect(await verifyTotp(secret, code)).toBe(true);
    expect(await verifyTotp(secret, code === '000000' ? '111111' : '000000')).toBe(false);
    expect(await verifyTotp(secret, 'abc')).toBe(false);
  });
});

describe('access tokens', () => {
  it('signs and verifies the contract claims', () => {
    const { accessToken, expiresInSeconds } = signAccessToken({ actorId: ACTOR, role: 'school_admin', schoolId: SCHOOL, sessionId: SID });
    expect(expiresInSeconds).toBe(config.jwt.accessTtlSeconds);
    expect(verifyAccessToken(accessToken)).toMatchObject({ sub: ACTOR, role: 'school_admin', schoolId: SCHOOL, sid: SID });
    const parent = signAccessToken({ actorId: ACTOR, role: 'parent', schoolId: null, sessionId: SID });
    expect(verifyAccessToken(parent.accessToken).schoolId).toBeNull();
  });

  it('enforces school claims per role', () => {
    expect(() => signAccessToken({ actorId: ACTOR, role: 'driver', schoolId: null, sessionId: SID })).toThrow(/require a schoolId/);
    expect(() => signAccessToken({ actorId: ACTOR, role: 'super_admin', schoolId: SCHOOL, sessionId: SID })).toThrow(/carry no schoolId/);
  });

  it('rejects expired, foreign, unsigned and malformed tokens', () => {
    const expired = signAccessToken({ actorId: ACTOR, role: 'parent', schoolId: null, sessionId: SID }, { now: Date.now() - 3600_000 }).accessToken;
    expect(() => verifyAccessToken(expired)).toThrow(expect.objectContaining({ code: 'TOKEN_EXPIRED' }));
    const foreign = jwt.sign({ sub: ACTOR, role: 'parent', school_id: null, sid: SID, typ: 'access' }, 'another-secret-another-secret-another', { issuer: JWT_ISSUER, audience: JWT_AUDIENCE });
    expect(() => verifyAccessToken(foreign)).toThrow(expect.objectContaining({ code: 'UNAUTHENTICATED' }));
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: ACTOR, role: 'parent', sid: SID, typ: 'access' })).toString('base64url')}.`;
    expect(() => verifyAccessToken(none)).toThrow(expect.objectContaining({ code: 'UNAUTHENTICATED' }));
    const wrongType = jwt.sign({ sub: ACTOR, role: 'parent', school_id: null, sid: SID, typ: 'refresh' }, config.jwt.accessSecret, { issuer: JWT_ISSUER, audience: JWT_AUDIENCE });
    expect(() => verifyAccessToken(wrongType)).toThrow(expect.objectContaining({ code: 'UNAUTHENTICATED' }));
    expect(() => verifyAccessToken('short')).toThrow(expect.objectContaining({ code: 'UNAUTHENTICATED' }));
  });

  it('parses bearer headers and maps roles to owner types', () => {
    expect(bearerFrom('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(bearerFrom('Basic abc')).toBeNull();
    expect(ownerTypeOfRole('super_admin')).toBe('platform_user');
    expect(ownerTypeOfRole('conductor')).toBe('user');
    expect(ownerTypeOfRole('parent')).toBe('parent_account');
  });
});
