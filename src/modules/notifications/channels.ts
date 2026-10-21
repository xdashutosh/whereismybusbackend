// Channel adapters and channel selection (BP §11.2 NotificationChannel; contract §2):
//   in_app    always: parent_notifications inbox rows (+ socket notification:new to actor:{id})
//   push      FCM via the shared adapter when FIREBASE_SERVICE_ACCOUNT_B64 is set AND the platform
//             'modules.push' flag is on; otherwise skipped (PUSH_DISABLED / MODULE_DISABLED)
//   sms       only when the school's 'sms' feature is in force (school flag narrowed by the platform
//             'modules.sms'); WebPay Services needs the DLT template id registered for each text
//   whatsapp  only when the school's 'whatsapp' feature is in force AND an adapter is installed;
//             delivery is out of MVP scope (contract §9), so the default adapter reports NOT_AVAILABLE
// The adapters are process-wide; tests swap them with configureNotificationDeps().
import type { NotificationKind, NotificationLanguage } from '@wimb/shared';
import { channels as sharedChannels } from '../../shared/notifications/index.js';
import type { PushChannel } from '../../shared/notifications/push.js';
import type { SmsChannel } from '../../shared/notifications/sms.js';
import { realtime as sharedRealtime, type Realtime } from '../../shared/realtime.js';

export interface WhatsAppResult {
  delivered: boolean;
  error?: string;
}

/** WhatsApp adapter interface (BP §11.2); no provider ships in the MVP. */
export interface WhatsAppChannel {
  readonly enabled: boolean;
  sendText(toE164: string, text: string): Promise<WhatsAppResult>;
}

export function createUnavailableWhatsApp(): WhatsAppChannel {
  return {
    enabled: false,
    async sendText() {
      return { delivered: false, error: 'NOT_AVAILABLE' };
    },
  };
}

/** Resolves the DLT template id registered for a notification text (WebPay requires one per text). */
export type SmsTemplateResolver = (kind: NotificationKind, lang: NotificationLanguage) => string | undefined;

export interface NotificationDeps {
  push: PushChannel;
  sms: SmsChannel;
  whatsapp: WhatsAppChannel;
  smsTemplateId: SmsTemplateResolver;
  realtime: Pick<Realtime, 'emit'>;
}

const defaults = (): NotificationDeps => ({
  push: sharedChannels.push,
  sms: sharedChannels.sms,
  whatsapp: createUnavailableWhatsApp(),
  smsTemplateId: () => undefined,
  realtime: sharedRealtime,
});

let current: NotificationDeps = defaults();

/** The adapters in use. */
export function notificationDeps(): NotificationDeps {
  return current;
}

/**
 * Replaces some adapters (tests; a deployment registering a WhatsApp provider or DLT template ids).
 * Returns a function restoring the previous set.
 */
export function configureNotificationDeps(patch: Partial<NotificationDeps>): () => void {
  const previous = current;
  current = { ...current, ...patch };
  return () => {
    current = previous;
  };
}

export interface ChannelInputs {
  /** The push adapter can deliver (FCM configured). */
  pushAdapterEnabled: boolean;
  /** platform_settings 'modules'.push (default true). */
  platformPush: boolean;
  /** Effective school features (already narrowed by the platform modules). */
  smsFeature: boolean;
  whatsappFeature: boolean;
  whatsappAdapterEnabled: boolean;
}

export interface ChannelPlan {
  push: boolean;
  sms: boolean;
  whatsapp: boolean;
  /** Why a channel is not used (recorded per event). */
  skipped: { push?: string; sms?: string; whatsapp?: string };
}

/** Pure channel selection; the in-app inbox is always used. */
export function selectChannels(i: ChannelInputs): ChannelPlan {
  const skipped: ChannelPlan['skipped'] = {};
  if (!i.platformPush) skipped.push = 'MODULE_DISABLED';
  else if (!i.pushAdapterEnabled) skipped.push = 'PUSH_DISABLED';
  if (!i.smsFeature) skipped.sms = 'FEATURE_DISABLED';
  if (!i.whatsappFeature) skipped.whatsapp = 'FEATURE_DISABLED';
  else if (!i.whatsappAdapterEnabled) skipped.whatsapp = 'NOT_AVAILABLE';
  return { push: !skipped.push, sms: !skipped.sms, whatsapp: !skipped.whatsapp, skipped };
}
