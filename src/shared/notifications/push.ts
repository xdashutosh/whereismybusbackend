// Push channel (contract §2): FCM via firebase-admin when FIREBASE_SERVICE_ACCOUNT_B64 is set,
// otherwise a logged no-op (parents still get the stored in-app inbox). Lock-screen content must
// stay minimal (child first name + bus code, BP §11.2) — enforced by the notification module.
import type { App } from 'firebase-admin/app';
import config from '../../config/index.js';
import { logger as rootLogger, type Logger } from '../logger.js';

export interface PushMessage {
  tokens: string[];
  title: string;
  body: string;
  /** String-only payload for deep links ({ type, schoolId, studentId, tripId }). */
  data?: Record<string, string>;
}

export interface PushResult {
  successCount: number;
  failureCount: number;
  /** Tokens FCM reported as unregistered/invalid — remove them from devices. */
  invalidTokens: string[];
  skipped: boolean;
}

export interface PushChannel {
  readonly enabled: boolean;
  send(message: PushMessage): Promise<PushResult>;
}

const FCM_BATCH = 500;
const INVALID_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

export function createNoopPush(logger: Logger = rootLogger.child({ module: 'push' })): PushChannel {
  return {
    enabled: false,
    async send(message) {
      logger.debug({ tokens: message.tokens.length, title: message.title }, 'Push disabled (no FIREBASE_SERVICE_ACCOUNT_B64); message not sent');
      return { successCount: 0, failureCount: 0, invalidTokens: [], skipped: true };
    },
  };
}

export function createFcmPush(serviceAccountB64: string, logger: Logger = rootLogger.child({ module: 'push' })): PushChannel {
  let appPromise: Promise<App> | null = null;
  const app = () =>
    (appPromise ??= (async () => {
      const { initializeApp, cert, getApps } = await import('firebase-admin/app');
      const existing = getApps().find((a) => a.name === 'wimb');
      if (existing) return existing;
      const sa = JSON.parse(Buffer.from(serviceAccountB64, 'base64').toString('utf8')) as { project_id: string; client_email: string; private_key: string };
      return initializeApp({ credential: cert({ projectId: sa.project_id, clientEmail: sa.client_email, privateKey: sa.private_key }) }, 'wimb');
    })());
  return {
    enabled: true,
    async send({ tokens, title, body, data }) {
      const unique = [...new Set(tokens.filter(Boolean))];
      const result: PushResult = { successCount: 0, failureCount: 0, invalidTokens: [], skipped: unique.length === 0 };
      if (!unique.length) return result;
      const { getMessaging } = await import('firebase-admin/messaging');
      const messaging = getMessaging(await app());
      for (let i = 0; i < unique.length; i += FCM_BATCH) {
        const batch = unique.slice(i, i + FCM_BATCH);
        const res = await messaging.sendEachForMulticast({
          tokens: batch,
          notification: { title, body },
          data,
          android: { priority: 'high', notification: { channelId: 'trip_updates' } },
          apns: { payload: { aps: { sound: 'default' } } },
        });
        result.successCount += res.successCount;
        result.failureCount += res.failureCount;
        res.responses.forEach((r, idx) => {
          if (!r.success && r.error && INVALID_TOKEN_CODES.has(r.error.code)) result.invalidTokens.push(batch[idx]!);
        });
      }
      if (result.failureCount) logger.warn({ failures: result.failureCount, invalid: result.invalidTokens.length }, 'Some push messages failed');
      return result;
    },
  };
}

export function createPushChannel(serviceAccountB64: string | null = config.push.firebaseServiceAccountB64): PushChannel {
  return serviceAccountB64 ? createFcmPush(serviceAccountB64) : createNoopPush();
}
