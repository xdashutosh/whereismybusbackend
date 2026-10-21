// Email channel (contract §2): SMTP via nodemailer when SMTP_HOST is set, otherwise logged
// (development: full text so links can be used; production without SMTP: recipient/subject only).
// Tests keep the last messages in memory (sentMessages()).
import nodemailer from 'nodemailer';
import config, { type Config } from '../../config/index.js';
import { logger as rootLogger, type Logger } from '../logger.js';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailResult {
  delivered: boolean;
  transport: 'smtp' | 'log';
  messageId?: string;
}

const MAX_KEPT = 50;

export function createEmailChannel({
  smtp = config.smtp,
  logger = rootLogger.child({ module: 'email' }),
  keepMessages = config.isTest,
  logBodies = !config.isProduction,
}: { smtp?: Config['smtp']; logger?: Logger; keepMessages?: boolean; logBodies?: boolean } = {}) {
  const transport = smtp.enabled
    ? nodemailer.createTransport({
        host: smtp.host ?? undefined,
        port: smtp.port,
        secure: smtp.secure,
        auth: smtp.user ? { user: smtp.user, pass: smtp.pass ?? '' } : undefined,
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 20000,
      })
    : null;
  const kept: (EmailMessage & { at: Date })[] = [];

  return {
    enabled: Boolean(transport),
    /** Never throws for delivery failures (logged); throws for invalid input. */
    async send(message: EmailMessage): Promise<EmailResult> {
      const { to, subject, text, html } = message;
      if (!to || !subject || !text) throw new TypeError('email.send requires to, subject and text');
      if (keepMessages) {
        kept.push({ ...message, at: new Date() });
        if (kept.length > MAX_KEPT) kept.shift();
      }
      if (!transport) {
        if (logBodies) logger.info({ mail: { to, subject, text } }, 'SMTP not configured — email written to log');
        else logger.warn({ mail: { to, subject } }, 'SMTP not configured — email not delivered');
        return { delivered: false, transport: 'log' };
      }
      try {
        const info = (await transport.sendMail({ from: smtp.from, to, subject, text, html })) as { messageId?: string };
        return { delivered: true, transport: 'smtp', messageId: info.messageId };
      } catch (err) {
        logger.error({ mail: { to, subject }, err: { message: (err as Error).message } }, 'Email delivery failed');
        return { delivered: false, transport: 'smtp' };
      }
    },
    sentMessages: () => [...kept],
    clearSentMessages: () => {
      kept.length = 0;
    },
    close: () => transport?.close(),
  };
}

export type EmailChannel = ReturnType<typeof createEmailChannel>;
