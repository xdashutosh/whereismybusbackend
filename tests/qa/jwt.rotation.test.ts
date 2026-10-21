// BP §16 Secrets — access-token signing keys can be rotated with a graceful overlap:
// JWT_ACCESS_KEYS (kid → secret) + JWT_ACTIVE_KID sign new tokens with a header kid; verification
// looks the kid up, and kid-less tokens fall back to the legacy JWT_ACCESS_SECRET.
import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { buildConfig, ConfigError, redactedSummary } from '../../src/config/index.js';
import { parseJwtKeys } from '../../src/config/env.js';
import { activeSigningKey, JWT_AUDIENCE, JWT_ISSUER, signAccessToken, verifyAccessToken, type VerificationKeys } from '../../src/shared/tokens.js';

const ACTOR = 'ac000000-0000-4000-8000-0000000000ac';
const SID = '5e000000-0000-4000-8000-00000000005e';
const SCHOOL = '5c000000-0000-4000-8000-000000000001';
const LEGACY = 'legacy-secret-legacy-secret-legacy-secret-0001';
const OLD = 'old-key-secret-old-key-secret-old-key-secret-02';
const NEW = 'new-key-secret-new-key-secret-new-key-secret-03';

const base = { NODE_ENV: 'development', DATABASE_URL: 'postgresql://owner:ownerpw@localhost:5432/wimb', STORAGE_DRIVER: 'local', JWT_ACCESS_SECRET: LEGACY };
const input = { actorId: ACTOR, role: 'school_admin' as const, schoolId: SCHOOL, sessionId: SID };

function issuesOf(env: Record<string, string>): string {
  try {
    buildConfig(env);
    return '';
  } catch (err) {
    if (err instanceof ConfigError) return err.issues.join('\n');
    throw err;
  }
}

const headerOf = (token: string) => jwt.decode(token, { complete: true })!.header;

describe('JWT_ACCESS_KEYS / JWT_ACTIVE_KID configuration', () => {
  it('parses kid:secret pairs and JSON objects (secrets may contain ":" and "=")', () => {
    expect(parseJwtKeys(`k1:${OLD}, k2:a:b=c`)).toEqual([['k1', OLD], ['k2', 'a:b=c']]);
    expect(parseJwtKeys(JSON.stringify({ k1: OLD, k2: NEW }))).toEqual([['k1', OLD], ['k2', NEW]]);
    expect(() => parseJwtKeys('no-colon-here')).toThrow(/kid:secret/);
    expect(() => parseJwtKeys('{"k1": 5}')).toThrow(/must be a string/);
  });

  it('builds the active signing key and verification map', () => {
    const cfg = buildConfig({ ...base, JWT_ACCESS_KEYS: `2026-09:${OLD},2026-10:${NEW}`, JWT_ACTIVE_KID: '2026-10' });
    expect(cfg.jwt.activeKid).toBe('2026-10');
    expect(Object.keys(cfg.jwt.accessKeys)).toEqual(['2026-09', '2026-10']);
    expect(Object.isFrozen(cfg.jwt.accessKeys)).toBe(true);
    expect(activeSigningKey(cfg.jwt)).toEqual({ kid: '2026-10', secret: NEW });
    // Without an active kid the legacy secret keeps signing (keys are verification-only).
    expect(activeSigningKey(buildConfig({ ...base, JWT_ACCESS_KEYS: `k1:${OLD}` }).jwt)).toEqual({ kid: null, secret: LEGACY });
    expect(activeSigningKey(buildConfig(base).jwt)).toEqual({ kid: null, secret: LEGACY });
  });

  it.each([
    [{ JWT_ACTIVE_KID: 'k1' }, /JWT_ACTIVE_KID must name a kid listed/],
    [{ JWT_ACCESS_KEYS: `k1:${OLD}`, JWT_ACTIVE_KID: 'k2' }, /JWT_ACTIVE_KID must name a kid listed/],
    [{ JWT_ACCESS_KEYS: 'k1:short' }, /secret for kid "k1" must be at least 32/],
    [{ JWT_ACCESS_KEYS: `k1:${OLD},k1:${NEW}` }, /duplicate kid "k1"/],
    [{ JWT_ACCESS_KEYS: `bad kid!:${OLD}` }, /every kid must match/],
    [{ JWT_ACCESS_KEYS: '{not json' }, /valid JSON or kid:secret/],
  ])('refuses %o', (override, message) => {
    expect(issuesOf({ ...base, ...override })).toMatch(message);
  });

  it('never echoes key secrets in issues or the redacted summary', () => {
    expect(issuesOf({ ...base, JWT_ACCESS_KEYS: `${NEW}` })).not.toContain(NEW);
    const cfg = buildConfig({ ...base, JWT_ACCESS_KEYS: `k1:${OLD},k2:${NEW}`, JWT_ACTIVE_KID: 'k2' });
    const text = JSON.stringify(redactedSummary(cfg));
    for (const s of [OLD, NEW, LEGACY]) expect(text).not.toContain(s);
    expect(redactedSummary(cfg).jwt).toMatchObject({ activeKid: 'k2', keyIds: ['k1', 'k2'] });
  });
});

describe('signing and verifying with key ids', () => {
  const before: VerificationKeys = { legacySecret: LEGACY, keys: { k1: OLD } };
  const during: VerificationKeys = { legacySecret: LEGACY, keys: { k1: OLD, k2: NEW } };
  const after: VerificationKeys = { legacySecret: LEGACY, keys: { k2: NEW } };

  it('signs with the active kid in the header and verifies by kid', () => {
    const { accessToken } = signAccessToken(input, { key: { kid: 'k2', secret: NEW } });
    expect(headerOf(accessToken)).toMatchObject({ alg: 'HS256', kid: 'k2' });
    expect(verifyAccessToken(accessToken, { keys: during })).toMatchObject({ sub: ACTOR, role: 'school_admin', schoolId: SCHOOL, sid: SID });
  });

  it('keeps tokens of the previous kid valid during the overlap and drops them once the key is removed', () => {
    const oldToken = signAccessToken(input, { key: { kid: 'k1', secret: OLD } }).accessToken;
    expect(verifyAccessToken(oldToken, { keys: before }).sub).toBe(ACTOR);
    expect(verifyAccessToken(oldToken, { keys: during }).sub).toBe(ACTOR);
    expect(() => verifyAccessToken(oldToken, { keys: after })).toThrow(expect.objectContaining({ code: 'UNAUTHENTICATED' }));
  });

  it('accepts kid-less tokens with the legacy secret (pre-rotation tokens)', () => {
    const legacy = signAccessToken(input, { key: { kid: null, secret: LEGACY } }).accessToken;
    expect(headerOf(legacy).kid).toBeUndefined();
    expect(verifyAccessToken(legacy, { keys: during }).sub).toBe(ACTOR);
  });

  it('rejects unknown kids, mismatched secrets and non-string kids', () => {
    const unknown = signAccessToken(input, { key: { kid: 'k9', secret: NEW } }).accessToken;
    expect(() => verifyAccessToken(unknown, { keys: during })).toThrow(expect.objectContaining({ code: 'UNAUTHENTICATED' }));
    // kid points at k2 but the token was signed with the legacy secret.
    const mismatched = signAccessToken(input, { key: { kid: 'k2', secret: LEGACY } }).accessToken;
    expect(() => verifyAccessToken(mismatched, { keys: during })).toThrow(expect.objectContaining({ code: 'UNAUTHENTICATED' }));
    // A prototype name is not a key.
    const proto = signAccessToken(input, { key: { kid: 'constructor', secret: NEW } }).accessToken;
    expect(() => verifyAccessToken(proto, { keys: during })).toThrow(expect.objectContaining({ code: 'UNAUTHENTICATED' }));
    const numericKid = jwt.sign({ sub: ACTOR, role: 'parent', school_id: null, sid: SID, typ: 'access' }, NEW, { issuer: JWT_ISSUER, audience: JWT_AUDIENCE, header: { alg: 'HS256', kid: 2 as unknown as string } });
    expect(() => verifyAccessToken(numericKid, { keys: during })).toThrow(expect.objectContaining({ code: 'UNAUTHENTICATED' }));
  });

  it('still reports expiry as TOKEN_EXPIRED for kid tokens', () => {
    const expired = signAccessToken(input, { key: { kid: 'k2', secret: NEW }, now: Date.now() - 3600_000 }).accessToken;
    expect(() => verifyAccessToken(expired, { keys: during })).toThrow(expect.objectContaining({ code: 'TOKEN_EXPIRED' }));
  });

  it('uses the process configuration by default (round trip)', () => {
    const { accessToken } = signAccessToken(input);
    expect(verifyAccessToken(accessToken).sid).toBe(SID);
  });
});
