// Notification channels (contract §2, BP §11.2 NotificationChannel): push (FCM or no-op),
// sms (webpayservices/console), email (smtp or log). The notifications module decides WHAT to send
// (preferences, dedupe via notification_events, inbox rows); these adapters only deliver.
import { instrumentSms } from '../metrics.js';
import { registerStatusCheck, type StatusCheckResult } from '../systemStatus.js';
import { createEmailChannel, type EmailChannel } from './email.js';
import { createPushChannel, type PushChannel } from './push.js';
import { createSmsChannel, type SmsChannel } from './sms.js';

export * from './email.js';
export * from './push.js';
export * from './sms.js';

export interface NotificationChannels {
  push: PushChannel;
  sms: SmsChannel;
  email: EmailChannel;
}

/** Process-wide channels built from config (SMS sends are counted in /metrics: wimb_sms_sends_total). */
export const channels: NotificationChannels = {
  push: createPushChannel(),
  sms: instrumentSms(createSmsChannel()),
  email: createEmailChannel(),
};

/**
 * SMS credit status for the platform health view (registered as 'sms' in shared/systemStatus.ts):
 * 'warn' below SMS_LOW_BALANCE_THRESHOLD or when the balance cannot be read. Uses the channel's
 * 5-minute balance cache, so polling it does not hit the provider more often.
 */
export async function smsStatus(sms: SmsChannel = channels.sms): Promise<StatusCheckResult> {
  const b = await sms.checkBalance();
  const details = { provider: b.provider, balance: b.balance, threshold: b.threshold, low: b.low, checkedAt: b.checkedAt, ...(b.error ? { error: b.error } : {}) };
  if (b.provider === 'console') return { level: 'ok', message: 'Console SMS provider (development): no credits used', details };
  if (b.error) return { level: 'warn', message: 'SMS balance could not be read', details };
  if (b.low) return { level: 'warn', message: 'SMS balance is low: recharge the OTP route', details };
  return { level: 'ok', details };
}

registerStatusCheck('sms', () => smsStatus());

export default channels;
