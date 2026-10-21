// WebPay Services SMS provider (contract §2 Parent OTP). fetch is always a fake: no test ever
// reaches the network or sends a real SMS. Covers request construction, +91 handling, response
// parsing, retry rules, the non-production allow-list, CreditCheck caching and log hygiene.
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/shared/logger.js';
import { createSmsChannel, createWebpaySms, renderOtpMessage, toIndianNational, type HttpFetch, type HttpResponseLike, type WebpaySettings } from '../src/shared/notifications/sms.js';
import { smsStatus } from '../src/shared/notifications/index.js';
import { getSystemStatus, statusCheckNames } from '../src/shared/systemStatus.js';

const SETTINGS: WebpaySettings = {
  url: 'https://sms.example.com/api/pushsms.php',
  username: 'wimb-user',
  apiKey: 'K3Y-super-secret-0001',
  senderId: 'WIMBUS',
  route: 'OTP',
  templateId: '1707170000000000001',
};
const TEMPLATE = 'Dear Parent, {otp} is your Where Is My Bus login code. Valid for 10 minutes & do not share. -WIMB';
const TO = '+919845012345';
const OTP = '482913';

interface Call {
  url: string;
  init: { method: string; headers: Record<string, string>; signal: AbortSignal };
}

// 'network': generic fetch failure (the request may have been sent); 'refused': connection refused
// (undici cause.code ECONNREFUSED, the request never left this host).
type Step = { status?: number; body: unknown } | { throws: 'network' | 'refused' } | { hang: true };

function fakeFetch(steps: Step[]): HttpFetch & { calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (url: string, init: Call['init']): Promise<HttpResponseLike> => {
    calls.push({ url, init });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)]!;
    if ('throws' in step) {
      if (step.throws === 'refused') throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
      throw new TypeError('fetch failed');
    }
    if ('hang' in step) {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    const status = step.status ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => (typeof step.body === 'string' ? step.body : JSON.stringify(step.body)) };
  }) as HttpFetch & { calls: Call[] };
  fn.calls = calls;
  return fn;
}

function captureLogs() {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { logger: createLogger({ level: 'debug', destination: sink }), lines, text: () => lines.join('\n') };
}

function channel(steps: Step[], opts: Parameters<typeof createWebpaySms>[1] = {}) {
  const fetchImpl = fakeFetch(steps);
  const logs = captureLogs();
  const sms = createWebpaySms(SETTINGS, { otpMessage: TEMPLATE, sendToAll: true, fetchImpl, logger: logs.logger, ...opts });
  return { sms, fetchImpl, logs };
}

/** Logs of the real-send path must never contain the key, the OTP, the message text or the full number. */
function expectCleanLogs(text: string) {
  expect(text).not.toContain(SETTINGS.apiKey);
  expect(text).not.toContain(OTP);
  expect(text).not.toContain('login code');
  expect(text).not.toContain('9845012345');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('helpers', () => {
  it('renders the DLT template with digits only', () => {
    expect(renderOtpMessage('A {otp} B {otp}', '123456')).toBe('A 123456 B 123456');
    expect(() => renderOtpMessage('{otp}', '12a456')).toThrow(TypeError);
    expect(() => renderOtpMessage('{otp}', '$&')).toThrow(TypeError);
  });

  it('maps +91 E.164 to the 10-digit national number', () => {
    expect(toIndianNational('+919845012345')).toBe('9845012345');
    expect(toIndianNational('+14155550100')).toBeNull();
    expect(toIndianNational('+9198450123')).toBeNull();
    expect(toIndianNational('919845012345')).toBeNull();
  });
});

describe('request construction', () => {
  it('sends a GET with every parameter, the 10-digit number, the URL-encoded message and TemplateID', async () => {
    const { sms, fetchImpl, logs } = channel([{ body: { status: 'success', msgid: 'MSG-42' } }]);
    expect(await sms.sendOtp(TO, OTP)).toEqual({ delivered: true, provider: 'webpayservices', providerMessageId: 'MSG-42' });
    expect(fetchImpl.calls).toHaveLength(1);
    const { url, init } = fetchImpl.calls[0]!;
    expect(init.method).toBe('GET');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(url.startsWith('https://sms.example.com/api/pushsms.php?')).toBe(true);
    const query = url.slice(url.indexOf('?') + 1);
    expect(query.split('&').map((p) => p.split('=')[0])).toEqual(['username', 'apikey', 'apirequest', 'sender', 'mobile', 'message', 'route', 'TemplateID', 'format']);
    const params = new URL(url).searchParams;
    expect(Object.fromEntries(params)).toEqual({
      username: 'wimb-user',
      apikey: SETTINGS.apiKey,
      apirequest: 'Text',
      sender: 'WIMBUS',
      mobile: '9845012345',
      message: `Dear Parent, ${OTP} is your Where Is My Bus login code. Valid for 10 minutes & do not share. -WIMB`,
      route: 'OTP',
      TemplateID: '1707170000000000001',
      format: 'JSON',
    });
    // Percent-encoding (spaces as %20, & and , escaped) so the text reaches the provider verbatim.
    expect(query).toContain('message=Dear%20Parent%2C%20482913%20is%20your');
    expect(query).toContain('%26%20do%20not%20share');
    expect(query).not.toContain('+');
    expectCleanLogs(logs.text());
  });

  it('appends to an API URL that already has a query string', async () => {
    const { sms, fetchImpl } = createAndSend('https://sms.example.com/api.php?v=2');
    await sms;
    expect(fetchImpl.calls[0]!.url).toMatch(/^https:\/\/sms\.example\.com\/api\.php\?v=2&username=/);
  });

  it('refuses non-Indian numbers without calling the API', async () => {
    const { sms, fetchImpl, logs } = channel([{ body: { status: 'success' } }]);
    expect(await sms.sendOtp('+14155550100', OTP)).toEqual({ delivered: false, provider: 'webpayservices', error: 'UNSUPPORTED_NUMBER' });
    expect(await sms.sendOtp('+447911123456', OTP)).toMatchObject({ error: 'UNSUPPORTED_NUMBER' });
    expect(sms.sendsRealSms('+14155550100')).toBe(false);
    expect(fetchImpl.calls).toHaveLength(0);
    expect(logs.text()).not.toContain(OTP);
  });

  it('rejects non-numeric codes and free text without a DLT template id', async () => {
    const { sms, fetchImpl } = channel([{ body: { status: 'success' } }]);
    expect(await sms.sendOtp(TO, '12ab56')).toMatchObject({ delivered: false, error: 'INVALID_CODE' });
    expect(await sms.sendText(TO, 'Bus is late')).toMatchObject({ delivered: false, error: 'TEMPLATE_REQUIRED' });
    expect(fetchImpl.calls).toHaveLength(0);
    expect(await sms.sendText(TO, 'Bus R1 is late', { templateId: '1707170000000000002' })).toMatchObject({ delivered: true });
    expect(new URL(fetchImpl.calls[0]!.url).searchParams.get('TemplateID')).toBe('1707170000000000002');
  });
});

function createAndSend(url: string) {
  const fetchImpl = fakeFetch([{ body: { status: 'success' } }]);
  const sms = createWebpaySms({ ...SETTINGS, url }, { otpMessage: TEMPLATE, sendToAll: true, fetchImpl, logger: captureLogs().logger }).sendOtp(TO, OTP);
  return { sms, fetchImpl };
}

describe('responses', () => {
  it('accepts status "success" in any case, with or without a message id, also wrapped in an array', async () => {
    expect(await channel([{ body: { status: 'Success' } }]).sms.sendOtp(TO, OTP)).toEqual({ delivered: true, provider: 'webpayservices' });
    expect(await channel([{ body: [{ status: 'success', id: 991 }] }]).sms.sendOtp(TO, OTP)).toMatchObject({ delivered: true, providerMessageId: '991' });
  });

  it('maps provider errors to a code and logs the (scrubbed) provider message, never the request', async () => {
    const { sms, logs } = channel([{ body: { status: 'error', message: 'Invalid Mobile Number (Must be 10 Digit Mobile Number)' } }]);
    expect(await sms.sendOtp(TO, OTP)).toEqual({ delivered: false, provider: 'webpayservices', error: 'PROVIDER_REJECTED' });
    expect(logs.text()).toContain('Invalid Mobile Number');
    expect(logs.text()).toContain('"level":50');
    expectCleanLogs(logs.text());
    const t = channel([{ body: { status: 'error', message: 'Template ID Missing or Invalid' } }]);
    expect(await t.sms.sendOtp(TO, OTP)).toMatchObject({ error: 'PROVIDER_REJECTED' });
  });

  it('scrubs an echoed key, code or number out of the provider message before logging', async () => {
    const { sms, logs } = channel([{ body: { status: 'error', message: `bad key ${SETTINGS.apiKey} for 9845012345 text ${OTP}` } }]);
    await sms.sendOtp(TO, OTP);
    expectCleanLogs(logs.text());
    expect(logs.text()).toContain('[REDACTED]');
  });

  it('maps "Low SMS Balance" to LOW_BALANCE with an error-level log', async () => {
    const { sms, logs } = channel([{ body: { status: 'error', message: 'Low SMS Balance' } }]);
    expect(await sms.sendOtp(TO, OTP)).toEqual({ delivered: false, provider: 'webpayservices', error: 'LOW_BALANCE' });
    const entry = logs.lines.map((l) => JSON.parse(l) as { level: number; msg: string }).find((l) => /Low SMS Balance/.test(l.msg));
    expect(entry?.level).toBe(50);
    expectCleanLogs(logs.text());
  });

  it('treats anything that is not clearly success as a failure', async () => {
    for (const body of [{ status: 'queued' }, { message: 'ok' }, {}, 'OK', '<html>502</html>', [], null]) {
      const { sms, fetchImpl } = channel([{ body }]);
      const r = await sms.sendOtp(TO, OTP);
      expect(r.delivered).toBe(false);
      expect(['PROVIDER_REJECTED', 'INVALID_RESPONSE']).toContain(r.error);
      expect(fetchImpl.calls).toHaveLength(1); // a provider response is never retried
    }
  });

  it('maps HTTP errors without retrying', async () => {
    const { sms, fetchImpl } = channel([{ status: 503, body: { status: 'success' } }]);
    expect(await sms.sendOtp(TO, OTP)).toMatchObject({ delivered: false, error: 'HTTP_ERROR' });
    expect(fetchImpl.calls).toHaveLength(1);
  });
});

describe('retry and timeout', () => {
  // Sending is not idempotent: only a failure that proves the request never left this host is retried.
  it('retries once when the connection was refused (nothing reached the provider)', async () => {
    const { sms, fetchImpl, logs } = channel([{ throws: 'refused' }, { body: { status: 'success' } }]);
    expect(await sms.sendOtp(TO, OTP)).toMatchObject({ delivered: true });
    expect(fetchImpl.calls).toHaveLength(2);
    expectCleanLogs(logs.text());
  });

  it('gives up after the single retry', async () => {
    const { sms, fetchImpl, logs } = channel([{ throws: 'refused' }, { throws: 'refused' }, { body: { status: 'success' } }]);
    expect(await sms.sendOtp(TO, OTP)).toEqual({ delivered: false, provider: 'webpayservices', error: 'NETWORK_ERROR' });
    expect(fetchImpl.calls).toHaveLength(2);
    expectCleanLogs(logs.text());
  });

  it('does not retry a network error that may have happened after the request was sent', async () => {
    const { sms, fetchImpl, logs } = channel([{ throws: 'network' }, { body: { status: 'success' } }]);
    expect(await sms.sendOtp(TO, OTP)).toEqual({ delivered: false, provider: 'webpayservices', error: 'NETWORK_ERROR' });
    expect(fetchImpl.calls).toHaveLength(1);
    expectCleanLogs(logs.text());
  });

  it('aborts after the timeout (10 s by default) and does not retry (WebPay may already have sent it)', async () => {
    vi.useFakeTimers();
    const { sms, fetchImpl } = channel([{ hang: true }, { body: { status: 'success' } }]);
    const pending = sms.sendOtp(TO, OTP);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchImpl.calls).toHaveLength(1);
    expect(fetchImpl.calls[0]!.init.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl.calls[0]!.init.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toEqual({ delivered: false, provider: 'webpayservices', error: 'TIMEOUT' });
    expect(fetchImpl.calls).toHaveLength(1);
  });
});

describe('non-production allow-list', () => {
  it('outside production only allow-listed numbers reach the provider; others are printed', async () => {
    const { sms, fetchImpl, logs } = channel([{ body: { status: 'success' } }], { sendToAll: false, devAllowedNumbers: ['+919900000001'] });
    expect(sms.sendsRealSms(TO)).toBe(false);
    expect(sms.sendsRealSms('+919900000001')).toBe(true);
    expect(await sms.sendOtp(TO, OTP)).toEqual({ delivered: true, provider: 'webpayservices', simulated: true });
    expect(fetchImpl.calls).toHaveLength(0);
    expect(logs.text()).toContain(OTP); // console path: the code is printed, as the console provider does
    expect(logs.text()).toContain('not in SMS_DEV_ALLOWED_NUMBERS');
    expect(logs.text()).not.toContain(SETTINGS.apiKey);
    expect(await sms.sendOtp('+919900000001', OTP)).toMatchObject({ delivered: true });
    expect(fetchImpl.calls).toHaveLength(1);
    expect(new URL(fetchImpl.calls[0]!.url).searchParams.get('mobile')).toBe('9900000001');
  });

  it('in production every Indian number is sent', async () => {
    const { sms, fetchImpl } = channel([{ body: { status: 'success' } }], { sendToAll: true, devAllowedNumbers: [] });
    expect(sms.sendsRealSms(TO)).toBe(true);
    expect(await sms.sendOtp(TO, OTP)).toMatchObject({ delivered: true });
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it('createSmsChannel wires production vs development from config', async () => {
    const cfg = {
      provider: 'webpayservices' as const,
      webpay: SETTINGS,
      otp: { message: TEMPLATE, expirySeconds: 600, maxAttempts: 5, resendSeconds: 60, dailyCapPerPhone: 10, globalDailyCap: 2000 },
      devAllowedNumbers: ['+919900000001'],
      allowlistOnly: false,
      lowBalanceThreshold: 500,
    };
    expect(createSmsChannel(cfg, { isProduction: false }).sendsRealSms(TO)).toBe(false);
    expect(createSmsChannel(cfg, { isProduction: true }).sendsRealSms(TO)).toBe(true);
    expect(createSmsChannel({ ...cfg, provider: 'console' }, { isProduction: false }).provider).toBe('console');
  });
});

describe('SMS_ALLOWLIST_ONLY in production (demo deployments)', () => {
  const ALLOWED = '+919900000001';
  const smsConfig = (allowlistOnly: boolean) => ({
    provider: 'webpayservices' as const,
    webpay: SETTINGS,
    otp: { message: TEMPLATE, expirySeconds: 600, maxAttempts: 5, resendSeconds: 60, dailyCapPerPhone: 10, globalDailyCap: 2000 },
    devAllowedNumbers: [ALLOWED],
    allowlistOnly,
    lowBalanceThreshold: 500,
  });

  it('production + allowlist-only: an allowed number reaches the provider', async () => {
    const cfg = smsConfig(true);
    // Through the production wiring (createSmsChannel), with global fetch stubbed (no network).
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ status: 'success', msgid: 'm-0' }), { status: 200 }));
    try {
      const wired = createSmsChannel(cfg, { isProduction: true });
      expect(wired.sendsRealSms(ALLOWED)).toBe(true);
      expect(await wired.sendOtp(ALLOWED, OTP)).toMatchObject({ delivered: true });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(new URL(spy.mock.calls[0]![0] as string).searchParams.get('mobile')).toBe('9900000001');
    } finally {
      spy.mockRestore();
    }
    // Same wiring createSmsChannel uses, with a fake fetch (no network).
    const { sms, fetchImpl, logs } = channel([{ body: { status: 'success', msgid: 'm-1' } }], { sendToAll: false, devAllowedNumbers: cfg.devAllowedNumbers });
    expect(await sms.sendOtp(ALLOWED, OTP)).toMatchObject({ delivered: true });
    expect(fetchImpl.calls).toHaveLength(1);
    expect(new URL(fetchImpl.calls[0]!.url).searchParams.get('mobile')).toBe('9900000001');
    expect(logs.text()).not.toContain(OTP);
  });

  it('production + allowlist-only: any other number is not sent; the OTP is written to the log', async () => {
    const cfg = smsConfig(true);
    expect(createSmsChannel(cfg, { isProduction: true }).sendsRealSms(TO)).toBe(false);
    const { sms, fetchImpl, logs } = channel([{ body: { status: 'success' } }], { sendToAll: false, devAllowedNumbers: cfg.devAllowedNumbers });
    expect(await sms.sendOtp(TO, OTP)).toEqual({ delivered: true, provider: 'webpayservices', simulated: true });
    expect(fetchImpl.calls).toHaveLength(0);
    expect(logs.text()).toContain(OTP);
    expect(logs.text()).toContain('not in SMS_DEV_ALLOWED_NUMBERS');
    expect(logs.text()).not.toContain(SETTINGS.apiKey);
  });

  it('default production (allowlist-only off) sends to every number', async () => {
    const cfg = smsConfig(false);
    expect(createSmsChannel(cfg, { isProduction: true }).sendsRealSms(TO)).toBe(true);
    expect(createSmsChannel(cfg, { isProduction: true }).sendsRealSms(ALLOWED)).toBe(true);
    const { sms, fetchImpl } = channel([{ body: { status: 'success' } }], { sendToAll: true, devAllowedNumbers: cfg.devAllowedNumbers });
    expect(await sms.sendOtp(TO, OTP)).toMatchObject({ delivered: true });
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it('createSmsChannel with allowlist-only never calls the network for other numbers (global fetch untouched)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network must not be used'));
    try {
      const sms = createSmsChannel(smsConfig(true), { isProduction: true });
      expect(await sms.sendOtp(TO, OTP)).toEqual({ delivered: true, provider: 'webpayservices', simulated: true });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('checkBalance (CreditCheck)', () => {
  it('builds the CreditCheck request, parses string balances and caches for 5 minutes', async () => {
    let now = 1_000_000;
    const { sms, fetchImpl, logs } = channel([{ body: { route: 'OTP', balance: '9803' } }, { body: { route: 'OTP', balance: 9700 } }], { now: () => now, lowBalanceThreshold: 500 });
    expect(await sms.checkBalance()).toMatchObject({ provider: 'webpayservices', balance: 9803, low: false, threshold: 500, cached: false });
    expect(Object.fromEntries(new URL(fetchImpl.calls[0]!.url).searchParams)).toEqual({ username: 'wimb-user', apikey: SETTINGS.apiKey, apirequest: 'CreditCheck', route: 'OTP', format: 'JSON' });
    now += 4 * 60_000;
    expect(await sms.checkBalance()).toMatchObject({ balance: 9803, cached: true });
    expect(fetchImpl.calls).toHaveLength(1);
    now += 60_001;
    expect(await sms.checkBalance()).toMatchObject({ balance: 9700, cached: false });
    expect(fetchImpl.calls).toHaveLength(2);
    expect(await sms.checkBalance({ force: true })).toMatchObject({ cached: false });
    expect(fetchImpl.calls).toHaveLength(3);
    expect(logs.text()).not.toContain(SETTINGS.apiKey);
  });

  it('flags a low balance with a warning', async () => {
    const { sms, logs } = channel([{ body: { route: 'OTP', balance: 120 } }], { lowBalanceThreshold: 500 });
    expect(await sms.checkBalance()).toMatchObject({ balance: 120, low: true });
    const warn = logs.lines.map((l) => JSON.parse(l) as { level: number; msg: string }).find((l) => l.level === 40);
    expect(warn?.msg).toMatch(/SMS balance is low/);
    expect(logs.text()).not.toContain(SETTINGS.apiKey);
    expect(await channel([{ body: { balance: '500' } }], { lowBalanceThreshold: 500 }).sms.checkBalance()).toMatchObject({ low: false });
  });

  it('reports failures without throwing (and caches them briefly)', async () => {
    let now = 0;
    const { sms, fetchImpl } = channel([{ body: { status: 'error', message: 'Invalid API Key' } }, { body: { balance: '10' } }], { now: () => now });
    expect(await sms.checkBalance()).toMatchObject({ balance: null, low: false, error: 'INVALID_RESPONSE' });
    now += 30_000;
    expect(await sms.checkBalance()).toMatchObject({ cached: true, error: 'INVALID_RESPONSE' });
    now += 31_000;
    expect(await sms.checkBalance()).toMatchObject({ balance: 10, cached: false });
    expect(fetchImpl.calls).toHaveLength(2);
    expect(await channel([{ throws: 'network' }]).sms.checkBalance()).toMatchObject({ balance: null, error: 'NETWORK_ERROR' });
  });

  it('is exposed to the platform through the system status registry', async () => {
    expect(statusCheckNames()).toContain('sms');
    const status = await getSystemStatus();
    expect(status.checks.sms).toMatchObject({ level: 'ok', details: { provider: 'console' } }); // tests always run the console provider
    const low = await smsStatus(channel([{ body: { balance: '12' } }], { lowBalanceThreshold: 500 }).sms);
    expect(low).toMatchObject({ level: 'warn', details: { balance: 12, low: true, threshold: 500 } });
    const fine = await smsStatus(channel([{ body: { balance: '9803' } }]).sms);
    expect(fine.level).toBe('ok');
    expect(JSON.stringify([low, fine])).not.toContain(SETTINGS.apiKey);
  });
});
