// Test-process environment, applied before src/config is imported (setupFiles + globalSetup), so
// these values win over backend/.env.local and backend/.env. Values already present in the real
// environment are kept where marked (??=), e.g. TEST_DATABASE_URL or RATE_LIMIT_ENABLED.
export const TEST_APP_ROLE = 'wimb_test_app';
export const TEST_APP_PASSWORD = 'wimb-test-app-local-only';

/**
 * `storageDir`: this run's private local-storage root (created by globalSetup, removed in its
 * teardown; every test worker passes it). globalSetup itself writes no files and calls this without it.
 */
export function applyTestEnv(storageDir?: string): void {
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL ??= 'silent';
  process.env.RATE_LIMIT_ENABLED ??= 'false';
  process.env.STORAGE_DRIVER = 'local';
  if (storageDir) process.env.STORAGE_LOCAL_DIR = storageDir;
  // Test object keys keep their own prefix, never mixed with dev keys.
  process.env.S3_KEY_PREFIX = 'whereismybus-test/';
  process.env.JWT_ACCESS_SECRET = 'test-only-jwt-secret-0123456789abcdef0123456789';
  // Dedicated RLS-restricted runtime role for tests (created by globalSetup).
  process.env.DB_APP_USER = TEST_APP_ROLE;
  process.env.DB_APP_PASSWORD = TEST_APP_PASSWORD;
  // Never reach external services from tests.
  process.env.SMTP_HOST = '';
  process.env.REDIS_URL = '';
  // SMS: console provider (config also forces it under NODE_ENV=test), no WebPay credentials in the
  // test process at all, and a fixed OTP policy independent of backend/.env.
  process.env.SMS_PROVIDER = 'console';
  for (const key of ['SMS_API_URL', 'SMS_API_USERNAME', 'SMS_API_KEY', 'SMS_SENDER_ID', 'SMS_ROUTE', 'SMS_DLT_TEMPLATE_ID', 'SMS_DEV_ALLOWED_NUMBERS']) process.env[key] = '';
  process.env.SMS_OTP_MESSAGE = '{otp} is your Where Is My Bus login code. It is valid for 10 minutes. Do not share it.';
  process.env.SMS_OTP_EXPIRY_MIN = '10';
  process.env.SMS_OTP_MAX_ATTEMPTS = '5';
  process.env.SMS_OTP_RESEND_SECONDS = '60';
  process.env.SMS_OTP_DAILY_CAP = '10';
  process.env.SMS_OTP_GLOBAL_DAILY_CAP = '2000';
  process.env.SMS_LOW_BALANCE_THRESHOLD = '500';
  process.env.FIREBASE_SERVICE_ACCOUNT_B64 = '';
  process.env.GOOGLE_MAPS_SERVER_KEY = '';
  // Observability: no Sentry reporting and no metrics token from backend/.env (tests pass their own).
  process.env.SENTRY_DSN = '';
  process.env.METRICS_TOKEN = '';
  process.env.JOBS_IN_PROCESS = 'false';
  // backend/.env.local may opt local dev into the remote DB; tests (and the CLIs they spawn) must
  // always exercise the remote-database guards instead.
  process.env.ALLOW_REMOTE_DEV_DB = 'false';
}
