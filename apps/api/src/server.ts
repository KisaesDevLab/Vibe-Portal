// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Entry point: check config, apply migrations, serve.

import postgres from 'postgres';
import { createDb, migrate } from '@vibe-portal/db';
import pino from 'pino';

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { createApp } from './app';
import { loadConfig, type Config } from './config';
import type { Ctx } from './context';
import { BlobStore } from './files/blobs';
import { openKeyring } from './files/keyring';
import { flush } from './files/notify-queue';
import { purgeUploads } from './firm/uploads';
import { consoleNotifier, type Notifier } from './lib/notify';
import {
  checkSmtp,
  routedNotifier,
  smtpSender,
  twilioSender,
  type SmtpSettings,
} from './lib/providers';
import { VERSION } from './version';

function smtpSettings(config: Config): SmtpSettings {
  return {
    host: config.SMTP_HOST ?? '',
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE ?? config.SMTP_PORT === 465,
    ...(config.SMTP_USER ? { user: config.SMTP_USER } : {}),
    ...(config.SMTP_PASS ? { pass: config.SMTP_PASS } : {}),
    from: config.EMAIL_FROM ?? '',
  };
}

/** Email by SMTP and texts by Twilio (P38); "console" only logs, and never in production. */
function buildNotifier(config: Config, log: pino.Logger): Notifier {
  const consoleSend = consoleNotifier(log, { redact: config.NODE_ENV === 'production' });
  const email =
    config.EMAIL_PROVIDER === 'smtp'
      ? smtpSender(smtpSettings(config), log)
      : (m: Parameters<Notifier['send']>[0]) => consoleSend.send(m);
  const sms =
    config.SMS_PROVIDER === 'twilio'
      ? twilioSender(
          {
            accountSid: config.TWILIO_ACCOUNT_SID ?? '',
            authToken: config.TWILIO_AUTH_TOKEN ?? '',
            ...(config.TWILIO_FROM_NUMBER ? { from: config.TWILIO_FROM_NUMBER } : {}),
            ...(config.TWILIO_MESSAGING_SERVICE_SID
              ? { messagingServiceSid: config.TWILIO_MESSAGING_SERVICE_SID }
              : {}),
          },
          log,
        )
      : config.SMS_PROVIDER === 'console'
        ? (m: Parameters<Notifier['send']>[0]) => consoleSend.send(m)
        : undefined;
  return routedNotifier({ email, ...(sms ? { sms } : {}) }, log);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const log = pino({ level: config.LOG_LEVEL });

  const sql = postgres(config.DATABASE_URL, { max: 1, onnotice: () => undefined });
  try {
    const ran = await migrate({
      exec: async (q) => {
        await sql.unsafe(q);
      },
      applied: async () =>
        new Set(
          (await sql<{ filename: string }[]>`SELECT filename FROM schema_migrations`).map(
            (r) => r.filename,
          ),
        ),
      applyOne: async (name, body) => {
        await sql.begin(async (tx) => {
          await tx.unsafe(body);
          await tx`INSERT INTO schema_migrations (filename) VALUES (${name})`;
        });
      },
    });
    if (ran.length) log.info({ ran }, 'migrations applied');
  } finally {
    await sql.end({ timeout: 5 });
  }

  const { db, ping } = createDb({ connectionString: config.DATABASE_URL });
  await mkdir(config.DATA_DIR, { recursive: true, mode: 0o700 });
  const keyring = await openKeyring(db, config.DATA_DIR);
  const blobs = new BlobStore(join(config.DATA_DIR, 'blobs'));
  const portalUrl = config.PORTAL_URL.replace(/\/+$/, '');
  const ctx: Ctx = {
    db,
    log,
    notifier: buildNotifier(config, log),
    now: () => new Date(),
    portalUrl,
    cookie: { secure: portalUrl.startsWith('https://') },
    trustCfIp: config.TRUST_CF_CONNECTING_IP,
    keyring,
    blobs,
  };
  const app = createApp({
    pingDb: ping,
    ctx,
    ...(config.STATIC_DIR ? { staticDir: config.STATIC_DIR } : {}),
  });
  // P18: send gathered "new files" notices every minute.
  setInterval(() => {
    flush(ctx).catch((err: unknown) => log.error({ err }, 'notification flush failed'));
  }, 60_000).unref();
  // P8: fetched client uploads leave the portal after the keep period.
  setInterval(() => {
    purgeUploads(ctx).catch((err: unknown) => log.error({ err }, 'upload purge failed'));
  }, 3_600_000).unref();
  if (config.EMAIL_PROVIDER === 'smtp') {
    // Said at startup, not discovered when a client cannot sign in (QA 2026-11-09).
    void checkSmtp(smtpSettings(config)).then((why) => {
      if (why)
        log.warn({ host: config.SMTP_HOST, port: config.SMTP_PORT, why }, 'SMTP check failed');
      else log.info({ host: config.SMTP_HOST }, 'SMTP check ok');
    });
  }
  app.listen(config.PORT, () => {
    log.info({ port: config.PORT, version: VERSION }, 'vibe-portal api listening');
  });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
