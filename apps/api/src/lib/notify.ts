// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Email and SMS to clients. The appliance's Email & SMS settings pick the real providers
// (Phase 5); development and tests use the console and recording notifiers.

import type { Logger } from 'pino';

export interface Message {
  channel: 'email' | 'sms';
  to: string;
  subject?: string;
  body: string;
}

export interface Notifier {
  send(msg: Message): Promise<void>;
}

/** Logs messages instead of sending them (development). */
export function consoleNotifier(log: Logger): Notifier {
  return {
    async send(msg) {
      log.info({ ...msg }, `notify (${msg.channel}, console)`);
    },
  };
}

/** Keeps every message, for tests. */
export function recordingNotifier(): Notifier & { sent: Message[]; last(to: string): Message } {
  const sent: Message[] = [];
  return {
    sent,
    async send(msg) {
      sent.push(msg);
    },
    last(to) {
      const m = [...sent].reverse().find((x) => x.to === to);
      if (!m) throw new Error(`nothing sent to ${to}`);
      return m;
    },
  };
}

/** Sends to an email address or an E.164 phone, whichever `to` is. */
export function messageTo(to: string, subject: string, body: string): Message {
  return to.includes('@')
    ? { channel: 'email', to, subject, body }
    : { channel: 'sms', to, body: body.length > 300 ? `${body.slice(0, 297)}...` : body };
}
