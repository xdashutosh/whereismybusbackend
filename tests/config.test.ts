// Pure configuration building (no files, no process env): connection derivation for the owner and
// app roles, test-database guard, production safety checks, redaction.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildConfig, ConfigError, redactedSummary, ROOT_DIR, SINGLE_INSTANCE_WARNING } from '../src/config/index.js';
import { serveModeIssue } from '../src/config/serveGuard.js';

const base = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://owner:ownerpw@localhost:5432/wimb',
  STORAGE_DRIVER: 'local',
};

const prod = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://wimbowner:ownerpw@db.example.com:5432/wimb?sslmode=require',
  DB_APP_USER: 'wimb_app',
  DB_APP_PASSWORD: 'app-secret-pw',
  JWT_ACCESS_SECRET: 'x'.repeat(48),
  CORS_ORIGINS: 'https://admin.example.com',
  TRUST_PROXY: '2',
  REDIS_URL: 'redis://cache.example.com:6379',
  STORAGE_DRIVER: 's3',
  AWS_BUCKET_NAME: 'bucket',
  AWS_REGION: 'in-maa-1',
  AWS_ACCESS_KEY_ID: 'AKIA',
  AWS_SECRET_ACCESS_KEY: 'shh',
  SMS_PROVIDER: 'webpayservices',
  SMS_API_URL: 'https://sms.example.com/api.php',
  SMS_API_USERNAME: 'wimb-user',
  SMS_API_KEY: 'sms-api-key-123456',
  SMS_SENDER_ID: 'WIMBUS',
  SMS_ROUTE: 'OTP',
  SMS_DLT_TEMPLATE_ID: '1707170000000000001',
  SMS_OTP_MESSAGE: 'Your Where Is My Bus login code is {otp}. It is valid for 10 minutes.',
};

function issuesOf(env: Record<string, string>): string[] {
  try {
    buildConfig(env);
    return [];
  } catch (err) {
    if (err instanceof ConfigError) return err.issues;
    throw err;
  }
}

describe('database connections', () => {
  it('derives the app connection from the owner URL and DB_APP_USER/DB_APP_PASSWORD', () => {
    const cfg = buildConfig({ ...base, DB_APP_USER: 'wimb_app', DB_APP_PASSWORD: 'p@ss/word' });
    expect(cfg.db.owner?.user).toBe('owner');
    expect(cfg.db.app?.user).toBe('wimb_app');
    expect(cfg.db.app?.database).toBe('wimb');
    expect(new URL(cfg.db.app!.connectionString!).password).toBe(encodeURIComponent('p@ss/word'));
    expect(cfg.db.appIsOwnerFallback).toBe(false);
  });

  it('prefers DATABASE_APP_URL and supports discrete DB_* settings', () => {
    const fromUrl = buildConfig({ ...base, DATABASE_APP_URL: 'postgresql://runtime:pw@localhost:5432/wimb' });
    expect(fromUrl.db.app?.source).toBe('DATABASE_APP_URL');
    const parts = buildConfig({ NODE_ENV: 'development', STORAGE_DRIVER: 'local', DB_HOST: 'localhost', DB_USER: 'own', DB_PASSWORD: 'x', DB_NAME: 'wimb', DB_APP_USER: 'app', DB_APP_PASSWORD: 'y', DB_SSL: 'true' });
    expect(parts.db.owner).toMatchObject({ host: 'localhost', user: 'own', database: 'wimb', ssl: { rejectUnauthorized: true } });
    expect(parts.db.app).toMatchObject({ user: 'app', password: 'y', database: 'wimb' });
  });

  it('falls back to the owner in development only (flagged)', () => {
    const cfg = buildConfig(base);
    expect(cfg.db.appIsOwnerFallback).toBe(true);
    expect(cfg.db.app?.source).toMatch(/owner fallback/);
    expect(issuesOf({ ...prod, DB_APP_USER: '', DB_APP_PASSWORD: '' }).join('\n')).toMatch(/requires the RLS-restricted app role/);
  });

  it('derives the test database and requires "test" in its name', () => {
    const cfg = buildConfig({ ...base, NODE_ENV: 'test', TEST_DB_NAME: 'wimb_test', DB_APP_USER: 'wimb_test_app', DB_APP_PASSWORD: 'x' });
    expect(cfg.db.owner?.database).toBe('wimb_test');
    expect(cfg.db.app?.database).toBe('wimb_test');
    expect(cfg.storage.driver).toBe('local');
    expect(cfg.redisUrl).toBeNull();
    expect(issuesOf({ ...base, NODE_ENV: 'test', TEST_DATABASE_URL: 'postgresql://p@localhost/wimb_prod' }).join('\n')).toMatch(/must contain "test"/);
  });

  it('rejects an app connection pointing at another database', () => {
    expect(issuesOf({ ...base, DATABASE_APP_URL: 'postgresql://a:b@localhost/other' }).join('\n')).toMatch(/same database/);
  });
});

describe('production safety', () => {
  it('accepts a complete production configuration', () => {
    const cfg = buildConfig(prod);
    expect(cfg.isProduction).toBe(true);
    expect(cfg.corsAllowAll).toBe(false);
  });

  it.each([
    [{ JWT_ACCESS_SECRET: '' }, /JWT_ACCESS_SECRET is required/],
    [{ JWT_ACCESS_SECRET: 'short' }, /at least 32 characters/],
    [{ REDIS_URL: '' }, /REDIS_URL is required in production/],
    [{ CORS_ORIGINS: '' }, /CORS_ORIGINS is required/],
    [{ SMS_PROVIDER: 'console' }, /SMS_PROVIDER=console/],
    [{ STORAGE_DRIVER: 'local' }, /STORAGE_DRIVER=local is not allowed/],
    [{ RATE_LIMIT_ENABLED: 'false' }, /RATE_LIMIT_ENABLED=false/],
    [{ DB_APP_USER: 'wimbowner' }, /must differ from the owner/],
    [{ S3_KEY_PREFIX: '' }, /S3_KEY_PREFIX must not be empty/],
    [{ SMS_API_KEY: '' }, /SMS_PROVIDER=webpayservices requires SMS_API_KEY/],
    [{ FIREBASE_SERVICE_ACCOUNT_B64: Buffer.from('{"x":1}').toString('base64') }, /service-account JSON/],
    [{ DEFAULT_TIMEZONE: 'Mars/Base' }, /valid IANA time zone/],
  ])('refuses %o', (override, message) => {
    expect(issuesOf({ ...prod, ...override }).join('\n')).toMatch(message);
  });

  it('normalises the key prefix and CORS origins', () => {
    const cfg = buildConfig({ ...prod, S3_KEY_PREFIX: '/tenant-a', CORS_ORIGINS: 'https://a.example.com/, https://b.example.com' });
    expect(cfg.storage.keyPrefix).toBe('tenant-a/');
    expect(cfg.corsOrigins).toEqual(['https://a.example.com', 'https://b.example.com']);
  });

  it('roots the local storage driver at STORAGE_LOCAL_DIR (absolute or relative to backend/), default backend/storage', () => {
    expect(buildConfig(base).storage.localDir).toBe(path.join(ROOT_DIR, 'storage'));
    expect(buildConfig({ ...base, STORAGE_LOCAL_DIR: '/var/tmp/wimb-files' }).storage.localDir).toBe('/var/tmp/wimb-files');
    expect(buildConfig({ ...base, STORAGE_LOCAL_DIR: 'storage-alt' }).storage.localDir).toBe(path.join(ROOT_DIR, 'storage-alt'));
  });
});

describe('single-instance mode (SINGLE_INSTANCE: production without Redis)', () => {
  const noRedis = { ...prod, REDIS_URL: '' };

  it.each([
    // [SINGLE_INSTANCE, JOBS_IN_PROCESS, REDIS_URL] → expected issue (null = accepted)
    ['unset', 'unset', '', /REDIS_URL is required in production .*unless SINGLE_INSTANCE=true/],
    ['false', 'true', '', /REDIS_URL is required in production/],
    ['true', 'false', '', /SINGLE_INSTANCE=true requires JOBS_IN_PROCESS=true/],
    ['true', 'unset', '', /SINGLE_INSTANCE=true requires JOBS_IN_PROCESS=true/],
    ['true', 'true', '', null],
    ['true', 'true', 'redis://cache.example.com:6379', null],
    ['unset', 'false', 'redis://cache.example.com:6379', null],
  ])('production SINGLE_INSTANCE=%s JOBS_IN_PROCESS=%s REDIS_URL=%o', (single, jobs, redis, expected) => {
    const env: Record<string, string> = { ...prod, REDIS_URL: redis };
    if (single !== 'unset') env.SINGLE_INSTANCE = single;
    if (jobs !== 'unset') env.JOBS_IN_PROCESS = jobs;
    const issues = issuesOf(env).join('\n');
    if (expected) expect(issues).toMatch(expected);
    else expect(issues).toBe('');
  });

  it('runs on the in-process fallbacks and warns exactly once', () => {
    const cfg = buildConfig({ ...noRedis, SINGLE_INSTANCE: 'true', JOBS_IN_PROCESS: 'true' });
    expect(cfg.singleInstance).toBe(true);
    expect(cfg.redisUrl).toBeNull();
    expect(cfg.jobsInProcess).toBe(true);
    expect(cfg.warnings.filter((w) => w === SINGLE_INSTANCE_WARNING)).toHaveLength(1);
    expect(SINGLE_INSTANCE_WARNING).toBe('single-instance mode: run exactly one instance; live state and rate limits reset on restart');
    expect(redactedSummary(cfg)).toMatchObject({ redisEnabled: false, jobsInProcess: true, singleInstance: true });
  });

  it('does not warn when Redis is configured or the mode is off; defaults to off', () => {
    expect(buildConfig({ ...prod, SINGLE_INSTANCE: 'true', JOBS_IN_PROCESS: 'true' }).warnings).not.toContain(SINGLE_INSTANCE_WARNING);
    expect(buildConfig(prod).singleInstance).toBe(false);
    expect(buildConfig(prod).warnings).not.toContain(SINGLE_INSTANCE_WARNING);
  });

  it('applies the JOBS_IN_PROCESS rule in every environment', () => {
    expect(issuesOf({ ...base, SINGLE_INSTANCE: 'true', JOBS_IN_PROCESS: 'false' }).join('\n')).toMatch(/requires JOBS_IN_PROCESS=true/);
    expect(issuesOf({ ...base, SINGLE_INSTANCE: 'true', JOBS_IN_PROCESS: 'true' })).toEqual([]);
    expect(issuesOf({ ...base, SINGLE_INSTANCE: 'maybe', JOBS_IN_PROCESS: 'true' }).join('\n')).toMatch(/SINGLE_INSTANCE: must be true or false/);
  });
});

describe('SMS_ALLOWLIST_ONLY (demo deployments)', () => {
  it('defaults to off; on in production it keeps the allow-list and warns once (count only, no numbers)', () => {
    expect(buildConfig(prod).sms.allowlistOnly).toBe(false);
    const cfg = buildConfig({ ...prod, SMS_ALLOWLIST_ONLY: 'true', SMS_DEV_ALLOWED_NUMBERS: '+919845012345, 9900000001' });
    expect(cfg.sms.allowlistOnly).toBe(true);
    expect(cfg.sms.devAllowedNumbers).toEqual(['+919845012345', '+919900000001']);
    const w = cfg.warnings.filter((x) => x.startsWith('SMS_ALLOWLIST_ONLY=true'));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/only the 2 number\(s\)/);
    expect(cfg.warnings.join(' ')).not.toMatch(/9845012345|9900000001/);
    expect(redactedSummary(cfg).sms).toMatchObject({ allowlistOnly: true, devAllowedNumbers: 2 });
  });

  it('does not warn outside production', () => {
    expect(buildConfig({ ...base, SMS_ALLOWLIST_ONLY: 'true' }).warnings.some((x) => x.startsWith('SMS_ALLOWLIST_ONLY'))).toBe(false);
  });
});

describe('redaction and serve guard', () => {
  it('never exposes secrets, users or hosts in the summary', () => {
    const text = JSON.stringify(redactedSummary(buildConfig(prod)));
    for (const secret of ['ownerpw', 'app-secret-pw', 'x'.repeat(48), 'shh', 'AKIA', 'db.example.com', 'cache.example.com', 'wimbowner', 'wimb_app', 'sms-api-key-123456', 'wimb-user', 'sms.example.com', 'login code', '{otp}']) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('"redisEnabled":true');
    expect(text).toContain('"provider":"webpayservices"');
  });

  it('refuses development mode against a remote database unless opted in', () => {
    const remote = buildConfig({ ...base, DATABASE_URL: 'postgresql://o:p@db.example.com/wimb' });
    expect(serveModeIssue(remote)).toMatch(/remote database/);
    expect(serveModeIssue(buildConfig({ ...base, DATABASE_URL: 'postgresql://o:p@db.example.com/wimb', ALLOW_REMOTE_DEV_DB: 'true' }))).toBeNull();
    expect(serveModeIssue(buildConfig(base))).toBeNull();
    expect(serveModeIssue(buildConfig(prod))).toBeNull();
  });
});

describe('SMS (WebPay Services) and OTP policy', () => {
  it('exposes the provider settings and the OTP policy from env', () => {
    const cfg = buildConfig({
      ...prod,
      SMS_OTP_EXPIRY_MIN: '5',
      SMS_OTP_MAX_ATTEMPTS: '3',
      SMS_OTP_RESEND_SECONDS: '45',
      SMS_OTP_DAILY_CAP: '7',
      SMS_OTP_GLOBAL_DAILY_CAP: '900',
      SMS_LOW_BALANCE_THRESHOLD: '250',
      SMS_OTP_MESSAGE: 'Code {otp}, valid for 5 minutes.',
    });
    expect(cfg.sms.provider).toBe('webpayservices');
    expect(cfg.sms.webpay).toEqual({ url: 'https://sms.example.com/api.php', username: 'wimb-user', apiKey: 'sms-api-key-123456', senderId: 'WIMBUS', route: 'OTP', templateId: '1707170000000000001' });
    expect(cfg.sms.otp).toEqual({ message: 'Code {otp}, valid for 5 minutes.', expirySeconds: 300, maxAttempts: 3, resendSeconds: 45, dailyCapPerPhone: 7, globalDailyCap: 900 });
    expect(cfg.sms.lowBalanceThreshold).toBe(250);
    expect(cfg.warnings).toEqual([]);
  });

  it('uses documented defaults for the policy', () => {
    const cfg = buildConfig(base);
    expect(cfg.sms.provider).toBe('console');
    expect(cfg.sms.otp).toMatchObject({ expirySeconds: 600, maxAttempts: 5, resendSeconds: 60, dailyCapPerPhone: 10, globalDailyCap: 2000 });
    expect(cfg.sms.otp.message).toContain('{otp}');
    expect(cfg.sms.lowBalanceThreshold).toBe(500);
    expect(cfg.sms.devAllowedNumbers).toEqual([]);
  });

  it('normalises SMS_DEV_ALLOWED_NUMBERS to E.164 and rejects invalid entries', () => {
    const cfg = buildConfig({ ...base, SMS_DEV_ALLOWED_NUMBERS: '+919845000101, 98450 00102 ,+919845000101' });
    expect(cfg.sms.devAllowedNumbers).toEqual(['+919845000101', '+919845000102']);
    expect(issuesOf({ ...base, SMS_DEV_ALLOWED_NUMBERS: '+919845000101,12' }).join('\n')).toMatch(/SMS_DEV_ALLOWED_NUMBERS entry #2 is not a valid phone number/);
  });

  it.each([
    [{ SMS_OTP_EXPIRY_MIN: '0' }, /SMS_OTP_EXPIRY_MIN/],
    [{ SMS_OTP_EXPIRY_MIN: '31' }, /SMS_OTP_EXPIRY_MIN/],
    [{ SMS_OTP_MAX_ATTEMPTS: '11' }, /SMS_OTP_MAX_ATTEMPTS/],
    [{ SMS_OTP_MAX_ATTEMPTS: '0' }, /SMS_OTP_MAX_ATTEMPTS/],
    [{ SMS_OTP_RESEND_SECONDS: '14' }, /SMS_OTP_RESEND_SECONDS/],
    [{ SMS_OTP_RESEND_SECONDS: '601' }, /SMS_OTP_RESEND_SECONDS/],
    [{ SMS_OTP_DAILY_CAP: '101' }, /SMS_OTP_DAILY_CAP/],
    [{ SMS_OTP_GLOBAL_DAILY_CAP: '0' }, /SMS_OTP_GLOBAL_DAILY_CAP/],
    [{ SMS_OTP_GLOBAL_DAILY_CAP: '1000001' }, /SMS_OTP_GLOBAL_DAILY_CAP/],
    [{ SMS_LOW_BALANCE_THRESHOLD: '-1' }, /SMS_LOW_BALANCE_THRESHOLD/],
    [{ SMS_OTP_EXPIRY_MIN: 'ten' }, /SMS_OTP_EXPIRY_MIN/],
    [{ SMS_PROVIDER: 'some-other-gateway' }, /SMS_PROVIDER/],
    [{ SMS_API_URL: 'http://sms.example.com/api.php' }, /SMS_API_URL must be an https/],
    [{ SMS_API_URL: 'not a url' }, /SMS_API_URL must be an https/],
    [{ SMS_DLT_TEMPLATE_ID: 'tpl-1' }, /SMS_DLT_TEMPLATE_ID must be the numeric DLT template id/],
    [{ SMS_SENDER_ID: 'WIMB BUS!' }, /SMS_SENDER_ID/],
    [{ SMS_OTP_MESSAGE: 'Your code is ready' }, /must contain the \{otp\} placeholder/],
    [{ SMS_OTP_MESSAGE: '' }, /requires SMS_OTP_MESSAGE/],
    [{ SMS_API_URL: '', SMS_API_USERNAME: '', SMS_SENDER_ID: '', SMS_ROUTE: '', SMS_DLT_TEMPLATE_ID: '' }, /requires SMS_API_URL, SMS_API_USERNAME, SMS_SENDER_ID, SMS_ROUTE, SMS_DLT_TEMPLATE_ID/],
  ])('refuses %o', (override, message) => {
    expect(issuesOf({ ...prod, ...override }).join('\n')).toMatch(message);
  });

  it('never echoes the API key or the message text in validation errors', () => {
    const text = issuesOf({ ...prod, SMS_API_URL: 'http://sms.example.com', SMS_DLT_TEMPLATE_ID: 'abc', SMS_OTP_MESSAGE: 'secret words without placeholder' }).join('\n');
    expect(text).not.toContain('sms-api-key-123456');
    expect(text).not.toContain('secret words');
  });

  it('refuses console in production but allows it elsewhere', () => {
    expect(issuesOf({ ...prod, SMS_PROVIDER: 'console' }).join('\n')).toMatch(/SMS_PROVIDER=console/);
    expect(issuesOf({ ...base, SMS_PROVIDER: 'console' })).toEqual([]);
  });

  it('warns when the message mentions a different expiry than SMS_OTP_EXPIRY_MIN', () => {
    const cfg = buildConfig({ ...prod, SMS_OTP_EXPIRY_MIN: '5' });
    expect(cfg.warnings).toEqual([expect.stringMatching(/mentions 10 minute\(s\) but SMS_OTP_EXPIRY_MIN=5/)]);
    expect(cfg.warnings.join(' ')).not.toContain('login code');
    expect(buildConfig({ ...prod, SMS_OTP_EXPIRY_MIN: '10' }).warnings).toEqual([]);
    expect(buildConfig({ ...prod, SMS_OTP_MESSAGE: 'Code {otp}. Valid 15 mins.', SMS_OTP_EXPIRY_MIN: '10' }).warnings).toHaveLength(1);
  });

  it('forces the console provider under NODE_ENV=test', () => {
    const { NODE_ENV: _ignored, ...rest } = prod;
    const cfg = buildConfig({ ...rest, NODE_ENV: 'test', TEST_DATABASE_URL: 'postgresql://postgres@localhost:54329/wimb_test' });
    expect(cfg.sms.provider).toBe('console');
  });
});

describe('CORS origins and origin patterns (Vercel previews)', () => {
  it('accepts anchored https patterns, compiles them anchored, and matches only intended origins', async () => {
    const { originAllowed } = await import('../src/app.js');
    const cfg = buildConfig({ ...prod, CORS_ORIGIN_PATTERNS: '^https://whereismybus-[a-z0-9-]+-team\\.vercel\\.app$  ^https://a\\.example\\.com$|^https://b\\.example\\.com$' });
    expect(cfg.corsOriginPatterns).toHaveLength(2);
    expect(cfg.corsAllowAll).toBe(false);
    expect(originAllowed('https://admin.example.com', cfg)).toBe(true);
    expect(originAllowed('https://whereismybus-git-main-team.vercel.app', cfg)).toBe(true);
    expect(originAllowed('https://b.example.com', cfg)).toBe(true);
    expect(originAllowed('https://whereismybus-x-team.vercel.app.evil.example', cfg)).toBe(false);
    expect(originAllowed('https://a.example.com.evil.example', cfg)).toBe(false);
    expect(originAllowed('http://whereismybus-x-team.vercel.app', cfg)).toBe(false);
    expect(originAllowed('https://evil.example', cfg)).toBe(false);
  });

  it.each([
    [{ CORS_ORIGIN_PATTERNS: 'https://x\\.vercel\\.app' }, /must be anchored/],
    [{ CORS_ORIGIN_PATTERNS: '^https://x\\.vercel\\.app' }, /must be anchored/],
    [{ CORS_ORIGIN_PATTERNS: '^https://(x\\.vercel\\.app$' }, /not a valid regular expression/],
    [{ CORS_ORIGIN_PATTERNS: '^http://.*\\.vercel\\.app$' }, /must start with \^https:\/\//],
    [{ CORS_ORIGIN_PATTERNS: '^https://a\\.vercel\\.app$|^http://b\\.example$' }, /must start with \^https:\/\//],
    [{ CORS_ORIGINS: 'https://app.example.com/login' }, /bare origin/],
    [{ CORS_ORIGINS: 'app.example.com' }, /bare origin/],
  ])('refuses %o', (override, message) => {
    expect(issuesOf({ ...prod, ...override }).join('\n')).toMatch(message);
  });

  it('allows http patterns outside production (local split-origin testing)', () => {
    expect(issuesOf({ ...base, CORS_ORIGIN_PATTERNS: '^http://localhost:43\\d\\d$' })).toEqual([]);
  });
});
