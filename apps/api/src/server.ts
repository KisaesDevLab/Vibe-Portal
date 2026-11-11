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
import { purgeMarks } from './files/marks';
import { snapshotIfDue } from './files/snapshot';
import { applyStorage, resumeInterrupted, runMove, sweep } from './files/storage';
import { normalizeEmail } from './lib/contact';
import { purgeStale } from './lib/housekeeping';
import { purgeIdPhotos } from './portal/access-id';
import { ProblemLog } from './lib/problems';
import { staffSessions } from './staff/auth';
import { firstAdminOnStart } from './staff/first-admin';
import { createStaffSso } from './staff/sso';
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
  // P64: warnings and errors also go to the database, for the staff page's Log.
  const problems = new ProblemLog();
  const level = (pino.levels.values[config.LOG_LEVEL] ?? 30) <= 40 ? config.LOG_LEVEL : 'warn';
  const log = pino(
    { level },
    pino.multistream([
      { level: config.LOG_LEVEL as pino.Level, stream: process.stdout },
      { level: 'warn', stream: problems.stream },
    ]),
  );

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
  problems.attach(db);
  await mkdir(config.DATA_DIR, { recursive: true, mode: 0o700 });
  const keyring = await openKeyring(db, config.DATA_DIR);
  const blobs = new BlobStore(join(config.DATA_DIR, 'blobs'));
  const portalUrl = config.PORTAL_URL.replace(/\/+$/, '');
  // P52: a mistyped address is said in the log, not a portal that will not start.
  const firstAdminEmail = normalizeEmail(config.FIRST_ADMIN_EMAIL);
  if (config.FIRST_ADMIN_EMAIL && !firstAdminEmail) {
    log.warn('FIRST_ADMIN_EMAIL is not an email address: no setup link is emailed');
  }
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
    textsOff: config.SMS_PROVIDER === 'none',
    ...(firstAdminEmail ? { firstAdminEmail } : {}),
  };
  // P51: stored files on the data volume or in B2, as Settings > Storage says. A move the last
  // run did not finish starts again; one the appliance command asked for starts.
  await resumeInterrupted(ctx);
  await applyStorage(ctx);
  const moveNow = (): void => {
    runMove(ctx).catch((err: unknown) => log.error({ err }, 'storage move failed'));
  };
  moveNow();
  setInterval(moveNow, 30_000).unref();
  // P44: staff sign-in through Vibe Auth, beside the portal's own. In "local" mode (until the
  // firm turns it on) it changes nothing; "single sign-on only" without the emergency account
  // stops the portal here, as Vibe Auth requires.
  ctx.sso = createStaffSso(ctx, staffSessions(ctx));
  await ctx.sso.start();
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
    purgeStale(ctx.db, ctx.now()).catch((err: unknown) =>
      log.error({ err }, 'housekeeping failed'),
    );
    // P49: watermarked copies of a day gone by, an ended link, or a changed file.
    purgeMarks(ctx).catch((err: unknown) => log.error({ err }, 'mark purge failed'));
    // P51: once a day, stored files whose delete failed (D9).
    sweep(ctx).catch((err: unknown) => log.error({ err }, 'stored file sweep failed'));
    // P67: photo IDs of access requests past their time.
    purgeIdPhotos(ctx).catch((err: unknown) => log.error({ err }, 'photo ID purge failed'));
    // P51: with files in B2, a database snapshot to the bucket every hour.
    snapshotIfDue(ctx).catch(() => undefined);
  }, 3_600_000).unref();
  // P52: the first admin's setup link, by email, while there is no staff account.
  firstAdminOnStart(ctx)
    .then((m) => {
      if (m) log.info({ ok: m.ok }, 'first admin setup link emailed');
    })
    .catch((err: unknown) => log.error({ err }, 'first admin setup email failed'));
  if (config.EMAIL_PROVIDER === 'smtp') {
    // Said at startup, not discovered when a client cannot sign in (QA 2026-11-09).
    void checkSmtp(smtpSettings(config)).then((why) => {
      if (why)
        log.warn({ host: config.SMTP_HOST, port: config.SMTP_PORT, why }, 'SMTP check failed');
      else log.info({ host: config.SMTP_HOST }, 'SMTP check ok');
    });
  }
  const server = app.listen(config.PORT, () => {
    log.info({ port: config.PORT, version: VERSION }, 'vibe-portal api listening');
  });
  // A 95 MB upload over a slow line takes longer than Node's 5-minute default; Caddy allows
  // 15 minutes (Phase 7).
  server.requestTimeout = 15 * 60_000;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
