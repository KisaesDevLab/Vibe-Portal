// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Sends a test email with the portal's own email settings (P52), for the appliance console's
// "Send a test email" and for checking settings by hand:
//
//   test-email <address>
//
// Prints "sent" and exits 0, or prints the mail server's reason in plain words and exits 1.
// Works whether or not the portal itself is running (it needs only the settings).

import pino from 'pino';

import { loadConfig } from '../config';
import { normalizeEmail } from '../lib/contact';
import { smtpSender } from '../lib/providers';

/** What usually lies behind a mail server's answer, for someone who is not an IT person. */
function hint(why: string): string {
  if (/535|auth|credentials|username and password/i.test(why)) {
    return 'The mail server did not accept the username or password. Office 365: SMTP AUTH must be on for that mailbox.';
  }
  if (/STARTTLS|TLS|SSL|certificate/i.test(why)) {
    return 'A secure connection could not be made. Try port 587 with "TLS from the start" on Automatic, or 465 with Yes.';
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(why)) {
    return 'The SMTP host name was not found. Check its spelling.';
  }
  if (/ECONNREFUSED|ETIMEDOUT|timeout|ECONNRESET/i.test(why)) {
    return 'The mail server could not be reached on that port. Check the port, and that the appliance may send mail out.';
  }
  if (/sender|from|5\.7\.60|SendAsDenied/i.test(why)) {
    return 'The mail server would not send from that From address with this mailbox.';
  }
  return 'The mail server refused the email.';
}

async function main(): Promise<void> {
  const to = normalizeEmail(process.argv[2]);
  if (!to) {
    console.error('Usage: test-email <address>');
    process.exitCode = 2;
    return;
  }
  const config = loadConfig();
  if (config.EMAIL_PROVIDER !== 'smtp' || !config.SMTP_HOST || !config.EMAIL_FROM) {
    console.error('Email is not set up: fill in the SMTP host and From address first.');
    process.exitCode = 1;
    return;
  }
  const send = smtpSender(
    {
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE ?? config.SMTP_PORT === 465,
      ...(config.SMTP_USER ? { user: config.SMTP_USER } : {}),
      ...(config.SMTP_PASS ? { pass: config.SMTP_PASS } : {}),
      from: config.EMAIL_FROM,
    },
    pino({ level: 'silent' }),
  );
  try {
    await send({
      channel: 'email',
      to,
      subject: 'Test email from your client portal',
      body: 'This is a test from your client portal. Its email settings work.',
    });
    process.stdout.write('sent\n');
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    console.error(`${hint(why)}\n(The mail server said: ${why.slice(0, 300)})`);
    process.exitCode = 1;
  }
}

void main();
