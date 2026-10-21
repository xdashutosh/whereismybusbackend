// SMS channel (contract §2 Parent OTP): env-selected adapter.
//   webpayservices — WebPay Services HTTP API (GET SMS_API_URL with username, apikey, apirequest=Text,
//                    sender, mobile = 10-digit Indian number, message, route, TemplateID, format=JSON).
//                    Indian (+91) numbers only. Outside production — and in production with
//                    SMS_ALLOWLIST_ONLY=true (demo deployments) — only SMS_DEV_ALLOWED_NUMBERS get a
//                    real SMS; any other number takes the console path (code printed to the log).
//   console        — development: the message (including OTPs) is written to the server log; refused
//                    in production by config.
// Recipients are E.164 numbers (shared/phone.ts). Delivery never throws: failures resolve
// { delivered: false, error: <CODE> }. The real-send path never logs the API key or username, the
// message text or the OTP, and phone numbers are always masked. A send is retried once only when the
// connection was never established (never after a timeout or any response: sending is not idempotent). checkBalance() reads the remaining credits
// (apirequest=CreditCheck), cached for 5 minutes.
import config, { type Config } from '../../config/index.js';
import { logger as rootLogger, type Logger } from '../logger.js';
import { maskPhone } from '../phone.js';

export type SmsProvider = Config['sms']['provider'];

/** Delivery error codes (never the provider's own text, which stays in the server log). */
export type SmsErrorCode =
  | 'UNSUPPORTED_NUMBER'
  | 'INVALID_CODE'
  | 'TEMPLATE_REQUIRED'
  | 'LOW_BALANCE'
  | 'PROVIDER_REJECTED'
  | 'INVALID_RESPONSE'
  | 'HTTP_ERROR'
  | 'TIMEOUT'
  | 'NETWORK_ERROR';

export interface SmsResult {
  delivered: boolean;
  provider: SmsProvider;
  providerMessageId?: string;
  error?: SmsErrorCode;
  /** true when the message was printed to the log instead of sent (console / non-allow-listed). */
  simulated?: boolean;
}

export interface SmsBalance {
  provider: SmsProvider;
  /** Remaining credits on the configured route; null when unknown (console, or the check failed). */
  balance: number | null;
  /** balance < SMS_LOW_BALANCE_THRESHOLD. */
  low: boolean;
  threshold: number;
  checkedAt: string;
  cached: boolean;
  error?: SmsErrorCode;
}

export interface SmsChannel {
  readonly provider: SmsProvider;
  /** Sends the OTP using the configured message template (SMS_OTP_MESSAGE with {otp} replaced). */
  sendOtp(toE164: string, otp: string): Promise<SmsResult>;
  /** Free text; WebPay needs the DLT template id registered for exactly this text. */
  sendText(toE164: string, text: string, opts?: { templateId?: string }): Promise<SmsResult>;
  /** true when sending to this number calls the paid provider (counts toward the global daily cap). */
  sendsRealSms(toE164: string): boolean;
  checkBalance(opts?: { force?: boolean }): Promise<SmsBalance>;
}

export interface HttpResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}
export type HttpFetch = (url: string, init: { method: string; headers: Record<string, string>; signal: AbortSignal }) => Promise<HttpResponseLike>;

export const SMS_TIMEOUT_MS = 10_000;
export const BALANCE_CACHE_MS = 5 * 60_000;
const BALANCE_ERROR_CACHE_MS = 60_000;

/** SMS_OTP_MESSAGE with every {otp} replaced; the code must be digits only. */
export function renderOtpMessage(template: string, otp: string): string {
  if (!/^\d{4,10}$/.test(otp)) throw new TypeError('OTP must be 4-10 digits');
  return template.split('{otp}').join(otp);
}

/** +91XXXXXXXXXX → 'XXXXXXXXXX'; anything else → null (WebPay delivers to Indian numbers only). */
export function toIndianNational(toE164: string): string | null {
  const m = /^\+91(\d{10})$/.exec(toE164);
  return m ? m[1]! : null;
}

// ── console ───────────────────────────────────────────────────────────────────
export function createConsoleSms({
  otpMessage = config.sms.otp.message,
  lowBalanceThreshold = config.sms.lowBalanceThreshold,
  logger = rootLogger.child({ module: 'sms' }),
}: { otpMessage?: string; lowBalanceThreshold?: number; logger?: Logger } = {}): SmsChannel {
  return {
    provider: 'console',
    async sendOtp(to, otp) {
      if (!/^\d{4,10}$/.test(otp)) return { delivered: false, provider: 'console', error: 'INVALID_CODE' };
      // Development only (config refuses SMS_PROVIDER=console in production).
      logger.info({ sms: { to } }, `SMS (console provider) to ${to}: ${renderOtpMessage(otpMessage, otp)}`);
      return { delivered: true, provider: 'console', simulated: true };
    },
    async sendText(to, text) {
      logger.info({ sms: { to } }, `SMS (console provider) to ${to}: ${text}`);
      return { delivered: true, provider: 'console', simulated: true };
    },
    sendsRealSms: () => false,
    async checkBalance() {
      return { provider: 'console', balance: null, low: false, threshold: lowBalanceThreshold, checkedAt: new Date().toISOString(), cached: false };
    },
  };
}

// ── webpayservices ────────────────────────────────────────────────────────────
export interface WebpaySettings {
  url: string;
  username: string;
  apiKey: string;
  senderId: string;
  route: string;
  templateId: string;
}

export interface WebpayOptions {
  otpMessage?: string;
  /** true → every number gets a real SMS (production). false → only devAllowedNumbers. */
  sendToAll?: boolean;
  devAllowedNumbers?: readonly string[];
  lowBalanceThreshold?: number;
  fetchImpl?: HttpFetch;
  logger?: Logger;
  timeoutMs?: number;
  now?: () => number;
}

class NoResponseError extends Error {
  constructor(
    readonly kind: 'TIMEOUT' | 'NETWORK_ERROR',
    /** true only when the connection was never established, so the provider cannot have the request. */
    readonly notSent = false,
  ) {
    super(kind);
  }
}

/** Connection-establishment failures (undici / Node error codes): the request never left this host. */
const PRE_SEND_ERROR_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

/** true when a fetch rejection proves the request was never sent (safe to retry a non-idempotent send). */
export function failedBeforeSend(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 4; e = (e as { cause?: unknown }).cause, depth += 1) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && PRE_SEND_ERROR_CODES.has(code)) return true;
  }
  return false;
}

function queryString(params: [string, string][]): string {
  return params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

/** Tolerant JSON parse: object, first element of an array, or null. */
function parseBody(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown;
    const o: unknown = Array.isArray(v) ? (v as unknown[])[0] : v;
    return o && typeof o === 'object' ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** First value whose key matches the names in PRIORITY order (case-insensitive), not object order. */
const field = (o: Record<string, unknown>, ...names: string[]): unknown => {
  const entries = Object.entries(o);
  for (const name of names) for (const [k, v] of entries) if (k.toLowerCase() === name) return v;
  return undefined;
};

const isWord = (v: unknown, re: RegExp) => typeof v === 'string' && re.test(v.trim());
const SUCCESS_RE = /^success$/i;
const FAILURE_RE = /^(error|fail|failed|failure|rejected|invalid)$/i;

/** Delivered only when 'status' (or, when absent, 'type') is exactly "success" and nothing contradicts it. */
function isSuccessBody(body: Record<string, unknown> | null): boolean {
  if (!body) return false;
  const status = field(body, 'status');
  const type = field(body, 'type');
  if (status !== undefined) return isWord(status, SUCCESS_RE) && !isWord(type, FAILURE_RE);
  return isWord(type, SUCCESS_RE);
}

/** The URL without any #fragment (a query appended after '#' would never reach the provider). */
const withoutFragment = (url: string) => url.split('#', 1)[0]!;

export function createWebpaySms(settings: WebpaySettings, opts: WebpayOptions = {}): SmsChannel {
  const {
    otpMessage = config.sms.otp.message,
    sendToAll = config.isProduction && !config.sms.allowlistOnly,
    devAllowedNumbers = config.sms.devAllowedNumbers,
    lowBalanceThreshold = config.sms.lowBalanceThreshold,
    fetchImpl = globalThis.fetch,
    logger = rootLogger.child({ module: 'sms' }),
    timeoutMs = SMS_TIMEOUT_MS,
    now = Date.now,
  } = opts;
  const allowed = new Set(devAllowedNumbers);
  const provider = 'webpayservices' as const;

  // Fixed text of the OTP template (the parts around {otp}); long pieces only, so short words are kept.
  const templatePieces = otpMessage.split('{otp}').map((p) => p.trim()).filter((p) => p.length >= 8);

  /**
   * Removes anything sensitive from a provider text before it is logged: the API key and username,
   * the message text, the OTP and the template text (raw, percent-encoded and form-encoded), longest
   * first so a shorter secret (the OTP) never breaks the match of a longer one (the text holding it).
   */
  const scrub = (text: unknown, extra: string[] = []): string => {
    let s = typeof text === 'string' ? text : JSON.stringify(text ?? null);
    const secrets = new Set<string>();
    for (const v of [settings.apiKey, settings.username, ...extra, ...templatePieces]) {
      if (!v) continue;
      secrets.add(v);
      secrets.add(encodeURIComponent(v));
      secrets.add(new URLSearchParams({ v }).toString().slice(2));
      secrets.add(JSON.stringify(v).slice(1, -1));
    }
    for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) s = s.split(secret).join('[REDACTED]');
    return s.replace(/\d{6,}/g, (d) => `${'*'.repeat(d.length - 4)}${d.slice(-4)}`).slice(0, 200);
  };

  /** One GET with a hard timeout. Throws NoResponseError only when no HTTP response arrived. */
  const getOnce = async (url: string): Promise<{ status: number; ok: boolean; text: string }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let res: HttpResponseLike;
      try {
        res = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' }, signal: controller.signal });
      } catch (err) {
        if (controller.signal.aborted) throw new NoResponseError('TIMEOUT');
        throw new NoResponseError('NETWORK_ERROR', failedBeforeSend(err));
      }
      // A response arrived: from here on nothing is retried (the provider may have sent the SMS).
      const text = await res.text().catch(() => '');
      return { status: res.status, ok: res.ok, text };
    } finally {
      clearTimeout(timer);
    }
  };

  const endpoint = withoutFragment(settings.url);
  const baseUrl = (params: [string, string][]) => `${endpoint}${endpoint.includes('?') ? '&' : '?'}${queryString(params)}`;

  const send = async (to: string, text: string, templateId: string, kind: 'otp' | 'text', secretsInText: string[]): Promise<SmsResult> => {
    const masked = maskPhone(to);
    const mobile = toIndianNational(to);
    if (!mobile) {
      logger.warn({ to: masked, kind }, 'SMS not sent: WebPay Services delivers to Indian (+91) mobile numbers only');
      return { delivered: false, provider, error: 'UNSUPPORTED_NUMBER' };
    }
    const url = baseUrl([
      ['username', settings.username],
      ['apikey', settings.apiKey],
      ['apirequest', 'Text'],
      ['sender', settings.senderId],
      ['mobile', mobile],
      ['message', text],
      ['route', settings.route],
      ['TemplateID', templateId],
      ['format', 'JSON'],
    ]);
    // Sending is not idempotent: retry once only when the connection was never established (the
    // provider cannot have the request). A timeout or a connection lost mid-request is never retried,
    // since WebPay may already have sent (and charged for) the SMS.
    let res: { status: number; ok: boolean; text: string } | null = null;
    for (let attempt = 1; attempt <= 2 && !res; attempt += 1) {
      try {
        res = await getOnce(url);
      } catch (err) {
        const code = err instanceof NoResponseError ? err.kind : 'NETWORK_ERROR';
        const retryable = err instanceof NoResponseError && err.notSent;
        if (attempt === 2 || !retryable) {
          logger.error({ to: masked, kind, error: code, attempts: attempt }, 'SMS delivery failed: no response from WebPay Services');
          return { delivered: false, provider, error: code };
        }
        logger.warn({ to: masked, kind, error: code }, 'SMS request could not connect to WebPay Services; retrying once');
      }
    }
    const { status, ok, text: raw } = res!;
    const body = parseBody(raw);
    const statusValue = body ? field(body, 'status', 'type') : undefined; // for the log only
    const providerText = body ? field(body, 'message', 'msg', 'error', 'description') : raw;
    if (!ok) {
      logger.error({ to: masked, kind, httpStatus: status, providerMessage: scrub(providerText, secretsInText) }, 'SMS delivery failed: WebPay Services HTTP error');
      return { delivered: false, provider, error: 'HTTP_ERROR' };
    }
    if (isSuccessBody(body)) {
      const idValue = body ? field(body, 'msgid', 'messageid', 'message_id', 'id', 'requestid', 'request_id', 'campaignid', 'campaign_id') : undefined;
      const providerMessageId = typeof idValue === 'string' || typeof idValue === 'number' ? String(idValue) : undefined;
      logger.info({ to: masked, kind, providerMessageId }, 'SMS accepted by WebPay Services');
      return { delivered: true, provider, ...(providerMessageId ? { providerMessageId } : {}) };
    }
    if (typeof providerText === 'string' && /low\s+sms\s+balance/i.test(providerText)) {
      logger.error({ to: masked, kind }, 'SMS delivery failed: WebPay Services reports Low SMS Balance — recharge the OTP route');
      return { delivered: false, provider, error: 'LOW_BALANCE' };
    }
    if (!body) {
      logger.error({ to: masked, kind, httpStatus: status, providerMessage: scrub(raw, secretsInText) }, 'SMS delivery failed: unreadable WebPay Services response');
      return { delivered: false, provider, error: 'INVALID_RESPONSE' };
    }
    logger.error(
      { to: masked, kind, providerStatus: scrub(statusValue, secretsInText), providerMessage: scrub(providerText, secretsInText), responseKeys: Object.keys(body).slice(0, 10) },
      'SMS delivery failed: WebPay Services rejected the request',
    );
    return { delivered: false, provider, error: 'PROVIDER_REJECTED' };
  };

  const isAllowListed = (to: string) => sendToAll || allowed.has(to);

  let balanceCache: { at: number; ttl: number; value: Omit<SmsBalance, 'cached'> } | null = null;

  return {
    provider,
    sendsRealSms: (to) => isAllowListed(to) && toIndianNational(to) !== null,
    async sendOtp(to, otp) {
      if (!/^\d{4,10}$/.test(otp)) return { delivered: false, provider, error: 'INVALID_CODE' };
      const text = renderOtpMessage(otpMessage, otp);
      if (!isAllowListed(to)) {
        // Non-production / SMS_ALLOWLIST_ONLY safety: no real SMS to numbers outside SMS_DEV_ALLOWED_NUMBERS.
        logger.info({ sms: { to } }, `SMS (webpayservices, ${to} is not in SMS_DEV_ALLOWED_NUMBERS: printed, not sent) to ${to}: ${text}`);
        return { delivered: true, provider, simulated: true };
      }
      return send(to, text, settings.templateId, 'otp', [otp, text]);
    },
    async sendText(to, text, { templateId } = {}) {
      if (!templateId) {
        logger.error({ to: maskPhone(to) }, 'SMS not sent: WebPay Services needs the DLT template id registered for this text');
        return { delivered: false, provider, error: 'TEMPLATE_REQUIRED' };
      }
      if (!isAllowListed(to)) {
        logger.info({ sms: { to } }, `SMS (webpayservices, ${to} is not in SMS_DEV_ALLOWED_NUMBERS: printed, not sent) to ${to}: ${text}`);
        return { delivered: true, provider, simulated: true };
      }
      return send(to, text, templateId, 'text', [text]);
    },
    async checkBalance({ force = false } = {}) {
      const t = now();
      if (!force && balanceCache && t - balanceCache.at < balanceCache.ttl) return { ...balanceCache.value, cached: true };
      const base = { provider, threshold: lowBalanceThreshold, checkedAt: new Date(t).toISOString() };
      let value: Omit<SmsBalance, 'cached'>;
      try {
        const res = await getOnce(baseUrl([
          ['username', settings.username],
          ['apikey', settings.apiKey],
          ['apirequest', 'CreditCheck'],
          ['route', settings.route],
          ['format', 'JSON'],
        ]));
        const body = parseBody(res.text);
        const rawBalance = body ? field(body, 'balance', 'credits', 'credit') : undefined;
        const balance = typeof rawBalance === 'number' ? rawBalance : typeof rawBalance === 'string' && rawBalance.trim() !== '' ? Number(rawBalance.trim()) : Number.NaN;
        if (!res.ok || !Number.isFinite(balance)) {
          logger.error({ httpStatus: res.status, providerMessage: scrub(body ? field(body, 'message', 'error') : res.text) }, 'SMS balance check failed');
          value = { ...base, balance: null, low: false, error: res.ok ? 'INVALID_RESPONSE' : 'HTTP_ERROR' };
        } else {
          value = { ...base, balance, low: balance < lowBalanceThreshold };
          if (value.low) logger.warn({ balance, threshold: lowBalanceThreshold, route: settings.route }, 'SMS balance is low: recharge the WebPay Services OTP route');
        }
      } catch (err) {
        const code = err instanceof NoResponseError ? err.kind : 'NETWORK_ERROR';
        logger.error({ error: code }, 'SMS balance check failed: no response from WebPay Services');
        value = { ...base, balance: null, low: false, error: code };
      }
      balanceCache = { at: t, ttl: value.error ? BALANCE_ERROR_CACHE_MS : BALANCE_CACHE_MS, value };
      return { ...value, cached: false };
    },
  };
}

/** Production sends to every number unless SMS_ALLOWLIST_ONLY=true; elsewhere only to the allow-list. */
export function createSmsChannel(cfg: Config['sms'] = config.sms, { isProduction = config.isProduction }: { isProduction?: boolean } = {}): SmsChannel {
  if (cfg.provider === 'webpayservices') {
    const w = cfg.webpay;
    return createWebpaySms(
      { url: w.url ?? '', username: w.username ?? '', apiKey: w.apiKey ?? '', senderId: w.senderId ?? '', route: w.route ?? '', templateId: w.templateId ?? '' },
      { otpMessage: cfg.otp.message, sendToAll: isProduction && !cfg.allowlistOnly, devAllowedNumbers: cfg.devAllowedNumbers, lowBalanceThreshold: cfg.lowBalanceThreshold },
    );
  }
  return createConsoleSms({ otpMessage: cfg.otp.message, lowBalanceThreshold: cfg.lowBalanceThreshold });
}
