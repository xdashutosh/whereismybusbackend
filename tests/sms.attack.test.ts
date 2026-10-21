// Adversarial tests for the WebPay Services SMS / parent-OTP implementation. fetch is ALWAYS a fake:
// no test reaches the network or sends a real SMS. Every test pins behaviour an attacker might try
// to break; "Fixed (was BUG)" comments mark defects this suite found, kept as regression tests.
import { Writable } from 'node:stream';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildConfig, ConfigError, redactedSummary } from '../src/config/index.js';
import { globalSendsKey, otpDay } from '../src/modules/auth/otp.js';
import type { OtpPolicy } from '../src/modules/auth/policy.js';
import { generateNumericOtp, sha256Hex } from '../src/shared/crypto.js';
import { kvKey } from '../src/shared/kv.js';
import { createLogger } from '../src/shared/logger.js';
import { createSmsChannel, createWebpaySms, renderOtpMessage, type HttpFetch, type HttpResponseLike, type WebpaySettings } from '../src/shared/notifications/sms.js';
import { normalizePhone } from '../src/shared/phone.js';
import { closeDb, ownerQuery, truncateAll } from './helpers/db.js';
import * as f from './helpers/factories.js';
import { buildApp, type TestApp } from './helpers/authApp.js';

// ── fakes ─────────────────────────────────────────────────────────────────────
const SETTINGS: WebpaySettings = {
  url: 'https://sms.example.com/api/pushsms.php',
  username: 'wimb-user-zz9',
  apiKey: 'K3Y-attack-secret-0001',
  senderId: 'WIMBUS',
  route: 'OTP',
  templateId: '1707170000000000001',
};
const TEMPLATE = 'Dear Parent, {otp} is your Where Is My Bus login code. Valid for 10 minutes. -WIMB';
const TO = '+919845012345';

type Step = { status?: number; body: unknown } | { throws: 'network' } | { hang: true } | { bodyRejects: true; status?: number };
interface Call {
  url: string;
}
function fakeFetch(steps: Step[]): HttpFetch & { calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (url: string, init: { signal: AbortSignal }): Promise<HttpResponseLike> => {
    calls.push({ url });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)]!;
    if ('throws' in step) throw new TypeError('fetch failed');
    if ('hang' in step) {
      return new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    }
    const status = step.status ?? 200;
    if ('bodyRejects' in step) return { ok: status < 300, status, text: () => Promise.reject(new TypeError('terminated: socket reset')) };
    return { ok: status >= 200 && status < 300, status, text: async () => (typeof step.body === 'string' ? step.body : JSON.stringify(step.body)) };
  }) as unknown as HttpFetch & { calls: Call[] };
  fn.calls = calls;
  return fn;
}
function captureLogs() {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _e, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { logger: createLogger({ level: 'debug', destination: sink }), text: () => lines.join('\n') };
}
function webpay(steps: Step[], opts: Parameters<typeof createWebpaySms>[1] = {}) {
  const fetchImpl = fakeFetch(steps);
  const logs = captureLogs();
  const sms = createWebpaySms(SETTINGS, { otpMessage: TEMPLATE, sendToAll: true, fetchImpl, logger: logs.logger, timeoutMs: 40, ...opts });
  return { sms, fetchImpl, logs };
}
const paramsOf = (url: string) => new URL(url).searchParams;

// ── DB / HTTP harness ─────────────────────────────────────────────────────────
let school: f.Row;
const registered: string[] = [];
async function newRegisteredParent(): Promise<string> {
  const p = await f.parentAccount();
  await f.schoolParent(school.id, p.id);
  return String(p.phone);
}
const POLICY: OtpPolicy = { expirySeconds: 600, maxAttempts: 5, resendSeconds: 60, dailyCapPerPhone: 3, globalDailyCap: 2000 };
const reqOtp = (t: TestApp, phone: string) => request(t.app).post('/api/v1/auth/parent/otp/request').send({ phone });
const cooldownKey = (phone: string) => kvKey('auth', 'otp-cooldown', sha256Hex(phone).slice(0, 40));

const unhandled: unknown[] = [];
const onUnhandled = (e: unknown) => unhandled.push(e);

beforeAll(async () => {
  await truncateAll({ keep: ['platform_settings'] });
  school = await f.school({ name: 'Attack School' });
  for (let i = 0; i < 4; i += 1) registered.push(await newRegisteredParent());
  process.on('unhandledRejection', onUnhandled);
});
beforeEach(async () => {
  await ownerQuery('delete from otp_codes');
  unhandled.length = 0;
});
afterEach(() => {
  expect(unhandled).toEqual([]);
});
afterAll(async () => {
  process.off('unhandledRejection', onUnhandled);
  await closeDb();
});

// ═════════════════════════════════════════════════════════════════════════════
describe('daily-cap bypass via phone formatting variants', () => {
  const VARIANTS = [
    '+919845012345',
    '919845012345',
    '09845012345',
    '9845012345',
    '98450 12345',
    '+91 98450-12345',
    '(+91) 98450 12345',
    '0091 98450 12345',
    '+91 098450 12345',
    '+91\t9845012345',
    '+91 9845012345 ext. 7',
    '＋９１９８４５０１２３４５', // full-width
    '+९१९८४५०१२३४५', // Devanagari
    '+٩١٩٨٤٥٠١٢٣٤٥', // Arabic-Indic
    '+91​9845012345', // zero-width space
  ];

  it('every variant either fails validation or normalises to the same E.164 number', () => {
    const out = VARIANTS.map((v) => normalizePhone(v));
    for (const n of out) if (n !== null) expect(n).toBe(TO);
  });

  it('the per-phone daily cap holds across spellings (cooldown and DB row cleared between requests)', async () => {
    const t = buildApp({ otpPolicy: { ...POLICY, dailyCapPerPhone: 3 } });
    const phone = registered[0]!;
    const national = phone.slice(3);
    const spellings = [phone, `0${national}`, `91${national}`, `${national.slice(0, 5)} ${national.slice(5)}`, `+91-${national}`, `0091${national}`];
    const statuses: number[] = [];
    for (const s of spellings) {
      const r = await reqOtp(t, s);
      statuses.push(r.status);
      await t.kv.del(cooldownKey(phone));
      await ownerQuery('delete from otp_codes');
    }
    expect(statuses.slice(0, 3)).toEqual([202, 202, 202]);
    expect(statuses.slice(3)).toEqual([429, 429, 429]);
    expect(t.sms.sent).toHaveLength(3);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('concurrency on per-phone and global counters', () => {
  it('25 concurrent requests for one number (mixed spellings) send exactly one SMS', async () => {
    const t = buildApp({ otpPolicy: POLICY });
    const phone = registered[1]!;
    const national = phone.slice(3);
    const spell = [phone, `0${national}`, `91${national}`, national, `+91 ${national}`];
    const res = await Promise.all(Array.from({ length: 25 }, (_, i) => reqOtp(t, spell[i % spell.length]!)));
    expect(res.filter((r) => r.status === 202)).toHaveLength(1);
    expect(res.filter((r) => r.status === 429)).toHaveLength(24);
    await new Promise((r) => setTimeout(r, 20));
    expect(t.sms.sent).toHaveLength(1);
  });

  it('concurrent registered numbers never exceed the global cap', async () => {
    const phones = [...registered, await newRegisteredParent(), await newRegisteredParent(), await newRegisteredParent()];
    const t = buildApp({ otpPolicy: { ...POLICY, globalDailyCap: 2 }, realSends: true });
    const res = await Promise.all(phones.map((p) => reqOtp(t, p)));
    await new Promise((r) => setTimeout(r, 20));
    expect(t.sms.sent.length).toBeLessThanOrEqual(2);
    // Requests that lose the race after the registration lookup answer 202 without sending (a 503
    // there would reveal registration); only the pre-lookup check answers 503.
    for (const r of res) expect([202, 503]).toContain(r.status);
    expect(Number(await t.kv.get(globalSendsKey(otpDay().day)))).toBe(2);
    // Once tripped, every number (registered or not) gets the same 503.
    expect((await reqOtp(t, await newRegisteredParent())).status).toBe(503);
    expect((await reqOtp(t, f.uniquePhone())).status).toBe(503);
    expect(t.sms.sent.length).toBeLessThanOrEqual(2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('enumeration: registered vs unknown numbers', () => {
  const shape = (r: request.Response) => ({ status: r.status, body: r.body, retryAfter: r.headers['retry-after'] ?? null, cache: r.headers['cache-control'] ?? null });

  it('identical status, body and headers for registered and unknown numbers', async () => {
    const t = buildApp({ otpPolicy: POLICY });
    const a = await reqOtp(t, registered[2]!);
    const b = await reqOtp(t, f.uniquePhone());
    expect(shape(b)).toEqual(shape(a));
    const ignore = new Set(['date', 'x-request-id', 'etag', 'content-length', 'connection', 'keep-alive']);
    const keys = (r: request.Response) => Object.keys(r.headers).filter((k) => !ignore.has(k)).sort();
    expect(keys(b)).toEqual(keys(a));
  });

  // Fixed (was BUG): the KV cooldown is checked for every number, but the DB cooldown (otp_request) only exists
  // for registered numbers and turns into a 429 OTP_COOLDOWN. Whenever the KV cooldown is lost
  // (memory KV after a restart, Redis eviction/failover/flush) or expires a few ms before the DB
  // one, a registered number answers 429 while an unknown number answers 202.
  it('KV state loss does not reveal which numbers are registered (DB cooldown must not surface)', async () => {
    const phone = registered[3]!;
    const unknown = f.uniquePhone();
    const t1 = buildApp({ otpPolicy: POLICY });
    expect((await reqOtp(t1, phone)).status).toBe(202);
    expect((await reqOtp(t1, unknown)).status).toBe(202);
    await new Promise((r) => setTimeout(r, 20));
    const firstCode = t1.sms.lastOtp(phone)!;
    const t2 = buildApp({ otpPolicy: { ...POLICY }, realSends: true }); // fresh KV, same database (restart / eviction)
    const reg = await reqOtp(t2, phone);
    const unk = await reqOtp(t2, unknown);
    expect(shape(reg)).toEqual(shape(unk));
    expect(reg.status).toBe(202);
    // Inside the DB cooldown nothing is sent, the global send is refunded and the first code still works.
    await new Promise((r) => setTimeout(r, 20));
    expect(t2.sms.sent).toHaveLength(0);
    expect(Number((await t2.kv.get(globalSendsKey(otpDay().day))) ?? 0)).toBe(0);
    const v = await request(t2.app).post('/api/v1/auth/parent/otp/verify').send({ phone, otp: firstCode, device: { deviceId: 'device-attack-01', platform: 'android', model: 'Pixel', appVersion: '1.0.0' } });
    expect(v.status).toBe(200);
  });

  // Fixed (was BUG): the global breaker is checked (step 1) before the DB lookup but incremented (step 4) only
  // for registered numbers; requests racing at the trip moment get 503 if registered and 202 if not.
  it('at the global-cap trip moment, registered and unknown numbers get the same answer', async () => {
    const regA = await newRegisteredParent();
    const regB = await newRegisteredParent();
    const t = buildApp({ otpPolicy: { ...POLICY, globalDailyCap: 1 }, realSends: true });
    const [a, b, u] = await Promise.all([reqOtp(t, regA), reqOtp(t, regB), reqOtp(t, f.uniquePhone())]);
    const statuses = { a: a.status, b: b.status, u: u.status };
    // Whatever the outcome, no registered number may get a status no unknown number could get.
    const regStatuses = new Set([statuses.a, statuses.b]);
    if (regStatuses.has(503)) expect(statuses.u).toBe(503);
  });

  it('timing: median latency of registered vs unknown (reported, loose bound)', async () => {
    const regs: string[] = [];
    for (let i = 0; i < 15; i += 1) regs.push(await newRegisteredParent());
    const t = buildApp({ otpPolicy: POLICY });
    const time = async (p: string) => {
      const s = process.hrtime.bigint();
      const r = await reqOtp(t, p);
      expect(r.status).toBe(202);
      return Number(process.hrtime.bigint() - s) / 1e6;
    };
    const reg: number[] = [];
    const unk: number[] = [];
    for (let i = 0; i < 15; i += 1) {
      reg.push(await time(regs[i]!));
      unk.push(await time(f.uniquePhone()));
    }
    const med = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]!;
    console.log(`[sms.attack timing] registered median ${med(reg).toFixed(2)} ms, unknown median ${med(unk).toFixed(2)} ms`);
    expect(Math.abs(med(reg) - med(unk))).toBeLessThan(25);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('dev allow-list', () => {
  const devEnv = { NODE_ENV: 'development', DATABASE_URL: 'postgresql://o:p@localhost:5432/wimb', STORAGE_DRIVER: 'local', SMS_PROVIDER: 'webpayservices', SMS_API_URL: SETTINGS.url, SMS_API_USERNAME: SETTINGS.username, SMS_API_KEY: SETTINGS.apiKey, SMS_SENDER_ID: SETTINGS.senderId, SMS_ROUTE: SETTINGS.route, SMS_DLT_TEMPLATE_ID: SETTINGS.templateId, SMS_OTP_MESSAGE: TEMPLATE };

  it('local spellings in SMS_DEV_ALLOWED_NUMBERS match only that exact E.164 number', () => {
    const cfg = buildConfig({ ...devEnv, SMS_DEV_ALLOWED_NUMBERS: '09845012345; 98450 12346' });
    expect(cfg.sms.devAllowedNumbers).toEqual(['+919845012345', '+919845012346']);
    const sms = createSmsChannel(cfg.sms, { isProduction: false });
    expect(sms.provider).toBe('webpayservices');
    expect(sms.sendsRealSms('+919845012345')).toBe(true);
    expect(sms.sendsRealSms('+919845012347')).toBe(false);
    expect(sms.sendsRealSms('919845012345')).toBe(false); // non-E.164 never matches
    expect(sms.sendsRealSms('+9198450123450')).toBe(false);
  });

  it('a non-allow-listed number never reaches fetch outside production', async () => {
    const { sms, fetchImpl } = webpay([{ body: { status: 'success' } }], { sendToAll: false, devAllowedNumbers: ['+919845012345'] });
    for (const to of ['+919845012346', '+91 9845012345', '9845012345', '+9198450123456', '+19845012345']) {
      const r = await sms.sendOtp(to, '123456');
      expect(r.simulated).toBe(true);
    }
    expect(fetchImpl.calls).toHaveLength(0);
    await sms.sendOtp('+919845012345', '123456');
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it('only exact NODE_ENV=production enables send-to-all; odd spellings are rejected', () => {
    for (const env of ['Production', 'prod', ' production', 'staging']) {
      expect(() => buildConfig({ ...devEnv, NODE_ENV: env })).toThrow(ConfigError);
    }
    expect(buildConfig(devEnv).isProduction).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('URL / parameter injection', () => {
  it('& = # ? newline and unicode in the message stay inside the message parameter', async () => {
    const evil = 'Code {otp} & apikey=EVIL&mobile=9999999999#frag\n\r%26 ?x=1 ₹ +plus';
    const { sms, fetchImpl } = webpay([{ body: { status: 'success' } }], { otpMessage: evil });
    await sms.sendOtp(TO, '654321');
    const url = fetchImpl.calls[0]!.url;
    expect(url).not.toContain('#');
    expect(url).not.toMatch(/[\n\r ]/);
    const p = paramsOf(url);
    expect([...p.keys()]).toEqual(['username', 'apikey', 'apirequest', 'sender', 'mobile', 'message', 'route', 'TemplateID', 'format']);
    expect(p.getAll('mobile')).toEqual(['9845012345']);
    expect(p.getAll('apikey')).toEqual([SETTINGS.apiKey]);
    expect(p.get('message')).toBe(evil.replace('{otp}', '654321'));
  });

  it('route / template injection through settings is encoded too', async () => {
    const fetchImpl = fakeFetch([{ body: { status: 'success' } }]);
    const sms = createWebpaySms({ ...SETTINGS, route: 'OTP&mobile=1111111111', templateId: '17&x=y' }, { otpMessage: TEMPLATE, sendToAll: true, fetchImpl, logger: captureLogs().logger });
    await sms.sendOtp(TO, '111111');
    const p = paramsOf(fetchImpl.calls[0]!.url);
    expect(p.getAll('mobile')).toEqual(['9845012345']);
    expect(p.get('route')).toBe('OTP&mobile=1111111111');
  });

  it('config rejects a sender id with URL metacharacters', () => {
    const base = { NODE_ENV: 'development', DATABASE_URL: 'postgresql://o:p@localhost:5432/wimb', STORAGE_DRIVER: 'local', SMS_PROVIDER: 'webpayservices', SMS_API_URL: SETTINGS.url, SMS_API_USERNAME: 'u', SMS_API_KEY: 'k', SMS_ROUTE: 'OTP', SMS_DLT_TEMPLATE_ID: SETTINGS.templateId, SMS_OTP_MESSAGE: TEMPLATE };
    for (const s of ['WIM&B', 'WIM=B', 'WIM#B', 'WIM\nB', 'WIMBUS&mobile=1']) expect(() => buildConfig({ ...base, SMS_SENDER_ID: s })).toThrow(/SMS_SENDER_ID/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('OTP format', () => {
  it('generated codes are always 6 ASCII digits (leading zeros kept)', () => {
    for (let i = 0; i < 5000; i += 1) expect(generateNumericOtp(6)).toMatch(/^[0-9]{6}$/);
  });

  it('sendOtp refuses non-digit, unicode-digit, short and long codes without calling fetch', async () => {
    const { sms, fetchImpl } = webpay([{ body: { status: 'success' } }]);
    for (const bad of ['12345a', '١٢٣٤٥٦', '123', '12345678901', '12 3456', '123456\n', '-12345', '1e5555']) {
      expect((await sms.sendOtp(TO, bad)).error).toBe('INVALID_CODE');
      expect(() => renderOtpMessage(TEMPLATE, bad)).toThrow();
    }
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('codes issued over HTTP are 6 digits', async () => {
    const t = buildApp({ otpPolicy: POLICY });
    const phone = await newRegisteredParent();
    expect((await reqOtp(t, phone)).status).toBe(202);
    expect(t.sms.lastOtp(phone)).toMatch(/^[0-9]{6}$/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('secrets / OTP / message text in logs', () => {
  const OTP = '482913';
  const echoBody = (extra = '') => ({ status: 'error', message: `Invalid request apikey=${SETTINGS.apiKey} username=${SETTINGS.username} mobile=9845012345 message=${TEMPLATE.replace('{otp}', OTP)} ${extra}` });

  // Fixed (was BUG, minor): scrub() replaced the secrets in order [apiKey, otp, text]; once the OTP inside the
  // echoed text is replaced, the full-text match no longer occurs, so the DLT message text is logged.
  it('provider rejections echoing the key, OTP, message and number are scrubbed from logs', async () => {
    const { sms, logs } = webpay([{ body: echoBody() }]);
    const r = await sms.sendOtp(TO, OTP);
    expect(r).toMatchObject({ delivered: false, error: 'PROVIDER_REJECTED' });
    const text = logs.text();
    expect(text).not.toContain(SETTINGS.apiKey);
    expect(text).not.toContain(OTP);
    expect(text).not.toContain('9845012345');
    expect(text).not.toContain('login code');
  });

  it('HTTP 500 HTML page echoing the request URL is scrubbed', async () => {
    const html = `<html><body>Error at https://sms.example.com/api?username=${SETTINGS.username}&apikey=${SETTINGS.apiKey}&mobile=9845012345&message=${encodeURIComponent(TEMPLATE.replace('{otp}', OTP))}</body></html>`;
    const { sms, logs } = webpay([{ status: 500, body: html }]);
    expect((await sms.sendOtp(TO, OTP)).error).toBe('HTTP_ERROR');
    const text = logs.text();
    expect(text).not.toContain(SETTINGS.apiKey);
    expect(text).not.toContain(OTP);
    expect(text).not.toContain('9845012345');
    expect(text).not.toContain(SETTINGS.username);
    expect(text).not.toContain('login%20code');
    expect(text).not.toContain('login code');
  });

  it('a form-encoded echo of the message (+ for spaces) is scrubbed as well', async () => {
    const form = new URLSearchParams({ message: TEMPLATE.replace('{otp}', OTP) }).toString();
    const { sms, logs } = webpay([{ body: { status: 'error', message: `bad request ${form}` } }]);
    await sms.sendOtp(TO, OTP);
    const text = logs.text();
    expect(text).not.toContain(OTP);
    expect(text).not.toContain('login+code');
  });

  // Fixed (was BUG, minor): scrub() redacted the API key but not SMS_API_USERNAME, which redactedSummary() treats
  // as sensitive; a provider error that echoes the username lands in the error log verbatim.
  it('the API username is not written to logs either', async () => {
    const { sms, logs } = webpay([{ body: echoBody() }]);
    await sms.sendOtp(TO, OTP);
    expect(logs.text()).not.toContain(SETTINGS.username);
  });

  it('the balance check scrubs provider text too', async () => {
    const { sms, logs } = webpay([{ body: { status: 'error', message: `bad key ${SETTINGS.apiKey}` } }]);
    const b = await sms.checkBalance();
    expect(b).toMatchObject({ balance: null, error: 'INVALID_RESPONSE' });
    expect(logs.text()).not.toContain(SETTINGS.apiKey);
    expect(JSON.stringify(b)).not.toContain(SETTINGS.apiKey);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('provider failures through the HTTP endpoint', () => {
  const cases: [string, Step[]][] = [
    ['timeout', [{ hang: true }]],
    ['network error', [{ throws: 'network' }]],
    ['HTML 502', [{ status: 502, body: '<html>Bad gateway apikey=' + SETTINGS.apiKey + '</html>' }]],
    ['garbage 200', [{ body: '\u0000ÿ{{{not json' }]],
    ['empty 200', [{ body: '' }]],
    ['JSON null', [{ body: 'null' }]],
    ['JSON array of strings', [{ body: '["success"]' }]],
    ['status as object', [{ body: { status: { toLowerCase: 1 }, message: ['x'] } }]],
    ['low balance', [{ body: { status: 'error', message: 'Low SMS Balance' } }]],
    ['body read fails', [{ bodyRejects: true }]],
  ];
  for (const [name, steps] of cases) {
    it(`${name}: 202 with no provider text, no unhandled rejection`, async () => {
      const ch = webpay(steps);
      const t = buildApp({ otpPolicy: POLICY, smsOverride: ch.sms });
      const phone = await newRegisteredParent();
      const r = await reqOtp(t, phone);
      expect(r.status).toBe(202);
      expect(r.body.data.status).toBe('sent');
      const body = JSON.stringify(r.body);
      expect(body).not.toMatch(/apikey|webpay|balance|html|PROVIDER|TIMEOUT/i);
      await new Promise((res) => setTimeout(res, 150)); // let the async send (and retry) finish
    });
  }

  it('an exception inside the OTP flow yields a generic 500 envelope (no internal message)', async () => {
    const t = buildApp({
      otpPolicy: POLICY,
      smsOverride: {
        sendsRealSms: () => {
          throw new Error(`boom apikey=${SETTINGS.apiKey}`);
        },
      },
    });
    const r = await reqOtp(t, await newRegisteredParent());
    expect(r.status).toBe(500);
    expect(r.body.error).toMatchObject({ code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' });
    // Outside production errorHandler adds details.debug = err.message (pre-existing, by design);
    // production omits it. The WebPay channel never throws on the request path, so provider text
    // cannot reach this envelope.
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('retry rules (duplicate SMS)', () => {
  const once: [string, Step[]][] = [
    ['HTTP 500', [{ status: 500, body: 'oops' }, { body: { status: 'success' } }]],
    ['HTTP 429', [{ status: 429, body: 'slow down' }, { body: { status: 'success' } }]],
    ['garbage 200', [{ body: '<html>' }, { body: { status: 'success' } }]],
    ['rejected', [{ body: { status: 'error', message: 'x' } }, { body: { status: 'success' } }]],
    ['body stream reset after headers', [{ bodyRejects: true }, { body: { status: 'success' } }]],
  ];
  for (const [name, steps] of once) {
    it(`${name}: exactly one provider call`, async () => {
      const { sms, fetchImpl } = webpay(steps);
      const r = await sms.sendOtp(TO, '123456');
      expect(r.delivered).toBe(false);
      expect(fetchImpl.calls).toHaveLength(1);
    });
  }

  // Fixed: a timeout used to be retried, so a request that had already reached WebPay could send
  // (and bill) a second SMS. Only a failure that proves nothing was sent is retried now.
  it('timeout: never retried (the first request may already have reached WebPay)', async () => {
    const { sms, fetchImpl } = webpay([{ hang: true }, { body: { status: 'success' } }]);
    const r = await sms.sendOtp(TO, '123456');
    expect(fetchImpl.calls).toHaveLength(1);
    expect(r).toMatchObject({ delivered: false, error: 'TIMEOUT' });
  });

  it('a network error without proof that nothing was sent is not retried', async () => {
    const { sms, fetchImpl } = webpay([{ throws: 'network' }, { body: { status: 'success' } }]);
    expect(await sms.sendOtp(TO, '123456')).toMatchObject({ delivered: false, error: 'NETWORK_ERROR' });
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it.each(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'])('%s (never connected): exactly one retry', async (code) => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      if (calls.length === 1) throw new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'success' }) };
    }) as unknown as HttpFetch;
    const sms = createWebpaySms(SETTINGS, { otpMessage: TEMPLATE, sendToAll: true, fetchImpl, logger: captureLogs().logger, timeoutMs: 40 });
    expect(await sms.sendOtp(TO, '123456')).toMatchObject({ delivered: true });
    expect(calls).toHaveLength(2);
  });

  it('success shapes: only an unambiguous status=success counts as delivered', async () => {
    const shapes: [unknown, boolean][] = [
      [{ status: 'success', msgid: 'abc' }, true],
      [{ status: 'SUCCESS' }, true],
      [{ status: 'successful' }, false],
      [{ status: 'error', message: 'success' }, false],
      [{ message: 'success' }, false],
      [{ status: true }, false],
    ];
    for (const [body, delivered] of shapes) {
      const { sms } = webpay([{ body }]);
      expect((await sms.sendOtp(TO, '123456')).delivered).toBe(delivered);
    }
  });

  // Fixed (was BUG, minor): field() returned the FIRST matching key in object order, so a body carrying both
  // 'type' and 'status' is judged by whichever comes first; {"type":"success","status":"error"}
  // counts as delivered.
  it('a body whose status says error is never treated as delivered', async () => {
    const { sms } = webpay([{ body: { type: 'success', status: 'error', message: 'Template ID Missing or Invalid' } }]);
    expect((await sms.sendOtp(TO, '123456')).delivered).toBe(false);
  });

  it('status and type are judged by priority, not key order; a contradiction is a failure', async () => {
    const shapes: [unknown, boolean][] = [
      [{ type: 'error', status: 'success' }, false],
      [{ status: 'success', type: 'error' }, false],
      [{ status: 'success', type: 'otp' }, true],
      [{ type: 'success' }, true],
      [{ Type: 'success', Status: 'failed' }, false],
    ];
    for (const [body, delivered] of shapes) {
      const { sms } = webpay([{ body }]);
      expect((await sms.sendOtp(TO, '123456')).delivered, JSON.stringify(body)).toBe(delivered);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('config validation gaps', () => {
  const base = { NODE_ENV: 'development', DATABASE_URL: 'postgresql://o:p@localhost:5432/wimb', STORAGE_DRIVER: 'local', SMS_PROVIDER: 'webpayservices', SMS_API_URL: SETTINGS.url, SMS_API_USERNAME: SETTINGS.username, SMS_API_KEY: SETTINGS.apiKey, SMS_SENDER_ID: SETTINGS.senderId, SMS_ROUTE: SETTINGS.route, SMS_DLT_TEMPLATE_ID: SETTINGS.templateId, SMS_OTP_MESSAGE: TEMPLATE };
  const issues = (env: Record<string, string>) => {
    try {
      buildConfig(env);
      return '';
    } catch (e) {
      return e instanceof ConfigError ? e.issues.join('\n') : String(e);
    }
  };

  it.each([
    [{ SMS_OTP_MESSAGE: 'Your code is ready' }, /\{otp\}/],
    [{ SMS_OTP_MESSAGE: 'Your code is {OTP}' }, /\{otp\}/],
    [{ SMS_OTP_MESSAGE: 'Your code is { otp }' }, /\{otp\}/],
    [{ SMS_OTP_MESSAGE: '   ' }, /SMS_OTP_MESSAGE/],
    [{ SMS_API_URL: 'http://sms.example.com/api' }, /https/],
    [{ SMS_API_URL: 'HTTP://sms.example.com/api' }, /https/],
    [{ SMS_API_URL: 'ftp://sms.example.com/api' }, /https/],
    [{ SMS_API_URL: 'javascript:alert(1)' }, /https/],
    [{ SMS_API_KEY: '' }, /SMS_API_KEY/],
    [{ SMS_API_KEY: '   ' }, /SMS_API_KEY/],
    [{ SMS_API_USERNAME: '' }, /SMS_API_USERNAME/],
    [{ SMS_ROUTE: '' }, /SMS_ROUTE/],
    [{ SMS_DLT_TEMPLATE_ID: '1707 1700 0000 0000 001' }, /SMS_DLT_TEMPLATE_ID/],
  ])('rejects %j', (over, re) => {
    expect(issues({ ...base, ...over })).toMatch(re);
  });

  it('console provider in production is refused', () => {
    expect(issues({ ...base, SMS_PROVIDER: 'console', NODE_ENV: 'production' })).toMatch(/SMS_PROVIDER=console/);
  });

  // Fixed (was BUG, minor): SMS_API_URL with a fragment passes validation; the channel then appends the query
  // AFTER the '#', so fetch drops every parameter and each OTP send fails at the provider.
  it('rejects an SMS_API_URL with a #fragment (the query would be dropped)', () => {
    expect(issues({ ...base, SMS_API_URL: 'https://sms.example.com/api.php#v2' })).toMatch(/SMS_API_URL/);
    expect(issues({ ...base, SMS_API_URL: 'https://sms.example.com/api.php#' })).toMatch(/SMS_API_URL/);
  });

  it('rejects credentials embedded in SMS_API_URL without echoing them', () => {
    const text = issues({ ...base, SMS_API_URL: `https://${SETTINGS.username}:${SETTINGS.apiKey}@sms.example.com/api.php` });
    expect(text).toMatch(/SMS_API_URL must not embed credentials/);
    expect(text).not.toContain(SETTINGS.apiKey);
    expect(text).not.toContain(SETTINGS.username);
  });

  it('a valid https URL with an existing query string still passes and keeps its query', async () => {
    expect(issues({ ...base, SMS_API_URL: 'https://sms.example.com/api.php?v=2' })).toBe('');
    const fetchImpl = fakeFetch([{ body: { status: 'success' } }]);
    const sms = createWebpaySms({ ...SETTINGS, url: 'https://sms.example.com/api.php?v=2' }, { otpMessage: TEMPLATE, sendToAll: true, fetchImpl, logger: captureLogs().logger });
    await sms.sendOtp(TO, '123456');
    const q = new URL(fetchImpl.calls[0]!.url).searchParams;
    expect(q.get('v')).toBe('2');
    expect(q.get('apikey')).toBe(SETTINGS.apiKey);
  });

  it('the channel never builds a URL whose query sits inside a fragment', async () => {
    const fetchImpl = fakeFetch([{ body: { status: 'success' } }]);
    const sms = createWebpaySms({ ...SETTINGS, url: 'https://sms.example.com/api.php#v2' }, { otpMessage: TEMPLATE, sendToAll: true, fetchImpl, logger: captureLogs().logger });
    await sms.sendOtp(TO, '123456');
    expect(new URL(fetchImpl.calls[0]!.url).searchParams.get('apikey')).toBe(SETTINGS.apiKey);
  });

  it('issue messages never contain the offending values', () => {
    const text = issues({ ...base, SMS_API_URL: `http://${SETTINGS.username}:${SETTINGS.apiKey}@sms.example.com/api`, SMS_DLT_TEMPLATE_ID: 'tpl-secretish', SMS_SENDER_ID: 'BAD SENDER!', SMS_OTP_MESSAGE: 'no placeholder here', SMS_DEV_ALLOWED_NUMBERS: '+919845012345,12345-secret' });
    expect(text).not.toEqual('');
    for (const v of [SETTINGS.apiKey, SETTINGS.username, 'tpl-secretish', 'BAD SENDER!', 'no placeholder here', '12345-secret', '9845012345']) expect(text).not.toContain(v);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('redacted summary / warnings', () => {
  it('leaves out key, username, URL, message text and allow-listed numbers', () => {
    const cfg = buildConfig({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://o:p@localhost:5432/wimb',
      STORAGE_DRIVER: 'local',
      SMS_PROVIDER: 'webpayservices',
      SMS_API_URL: 'https://sms-secret-host.example.com/api.php?token=urltoken123',
      SMS_API_USERNAME: SETTINGS.username,
      SMS_API_KEY: SETTINGS.apiKey,
      SMS_SENDER_ID: SETTINGS.senderId,
      SMS_ROUTE: SETTINGS.route,
      SMS_DLT_TEMPLATE_ID: SETTINGS.templateId,
      SMS_OTP_MESSAGE: 'Dear Parent, {otp} is your login code. Valid for 7 minutes. -WIMB',
      SMS_DEV_ALLOWED_NUMBERS: '+919845012345',
    });
    const text = JSON.stringify(redactedSummary(cfg));
    for (const v of [SETTINGS.apiKey, SETTINGS.username, 'sms-secret-host', 'urltoken123', 'Dear Parent', '9845012345']) expect(text).not.toContain(v);
    expect(cfg.warnings.join('\n')).toMatch(/SMS_OTP_MESSAGE mentions 7/);
    expect(cfg.warnings.join('\n')).not.toContain('Dear Parent');
  });
});
