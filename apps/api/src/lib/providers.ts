// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Real email and text senders (P38): any SMTP server for email (as Vibe Time & Billing's
// createSmtpMailProvider), Twilio for texts (its REST API, no SDK). The appliance writes the
// settings into /etc/vibe/portal/.env.

import type { Logger } from 'pino';

import type { Message, Notifier } from './notify';

export interface SmtpSettings {
  host: string;
  port: number;
  /** TLS from the first byte (port 465). Otherwise STARTTLS is required (QA 2026-11-09). */
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

export interface TwilioSettings {
  accountSid: string;
  authToken: string;
  /** A sending number in E.164, or a Messaging Service SID (MG...). */
  from?: string;
  messagingServiceSid?: string;
  /** Tests point this at a fake. */
  baseUrl?: string;
}

interface Transport {
  sendMail: (o: object) => Promise<{ messageId?: string }>;
  verify: () => Promise<unknown>;
}

async function smtpTransport(s: SmtpSettings): Promise<Transport> {
  const nodemailer = await import('nodemailer');
  return nodemailer.default.createTransport({
    host: s.host,
    port: s.port,
    secure: s.secure,
    // Sign-in links and codes, and the password, never go over the network in clear: without
    // TLS from the start, STARTTLS is required, not optional (QA 2026-11-09).
    requireTLS: !s.secure,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    ...(s.user ? { auth: { user: s.user, pass: s.pass ?? '' } } : {}),
  }) as unknown as Transport;
}

/** Checks the SMTP settings by connecting; the reason when they do not work. */
export async function checkSmtp(s: SmtpSettings): Promise<string | null> {
  try {
    await (await smtpTransport(s)).verify();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Sends email by SMTP. */
export function smtpSender(s: SmtpSettings, log: Logger): (msg: Message) => Promise<void> {
  let transport: Transport | null = null;
  return async (msg) => {
    if (!transport) transport = await smtpTransport(s);
    const info = await transport.sendMail({
      from: s.from,
      to: msg.to,
      subject: msg.subject ?? '',
      text: msg.body,
    });
    // Never the body: it holds sign-in links and codes.
    log.info({ channel: 'email', messageId: info.messageId }, 'email sent');
  };
}

/** Sends a text by Twilio. */
export function twilioSender(s: TwilioSettings, log: Logger): (msg: Message) => Promise<void> {
  const base = s.baseUrl ?? 'https://api.twilio.com';
  const auth = Buffer.from(`${s.accountSid}:${s.authToken}`).toString('base64');
  return async (msg) => {
    const form = new URLSearchParams({ To: msg.to, Body: msg.body });
    if (s.messagingServiceSid) form.set('MessagingServiceSid', s.messagingServiceSid);
    else if (s.from) form.set('From', s.from);
    const res = await fetch(
      `${base}/2010-04-01/Accounts/${encodeURIComponent(s.accountSid)}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`twilio ${res.status}: ${detail.slice(0, 300)}`);
    }
    const sid = ((await res.json().catch(() => ({}))) as { sid?: string }).sid;
    log.info({ channel: 'sms', sid }, 'text sent');
  };
}

/**
 * Routes each message to its sender. A channel with no sender is logged (without the text) and
 * dropped: e.g. no Twilio settings means no texts, and sign-in by phone cannot work.
 */
export function routedNotifier(
  senders: { email?: (m: Message) => Promise<void>; sms?: (m: Message) => Promise<void> },
  log: Logger,
): Notifier {
  return {
    async send(msg) {
      const send = senders[msg.channel];
      if (!send) {
        log.warn({ channel: msg.channel }, `no ${msg.channel} service set up; message not sent`);
        return;
      }
      await send(msg);
    },
  };
}
