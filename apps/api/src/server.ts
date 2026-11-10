// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Entry point: check config, apply migrations, serve.

import postgres from 'postgres';
import { createDb, migrate } from '@vibe-portal/db';
import pino from 'pino';

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { createApp } from './app';
import { loadConfig } from './config';
import type { Ctx } from './context';
import { BlobStore } from './files/blobs';
import { openKeyring } from './files/keyring';
import { flush } from './files/notify-queue';
import { purgeUploads } from './firm/uploads';
import { consoleNotifier } from './lib/notify';
import { VERSION } from './version';

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
    // Real email and SMS come from the appliance's Email & SMS settings (Phase 5). Until then
    // the console notifier; in production it leaves out the message text, which holds
    // sign-in links and codes.
    notifier: consoleNotifier(log, { redact: config.NODE_ENV === 'production' }),
    now: () => new Date(),
    portalUrl,
    cookie: { secure: portalUrl.startsWith('https://') },
    trustCfIp: config.TRUST_CF_CONNECTING_IP,
    keyring,
    blobs,
  };
  const app = createApp({ pingDb: ping, ctx });
  // P18: send gathered "new files" notices every minute.
  setInterval(() => {
    flush(ctx).catch((err: unknown) => log.error({ err }, 'notification flush failed'));
  }, 60_000).unref();
  // P8: fetched client uploads leave the portal after the keep period.
  setInterval(() => {
    purgeUploads(ctx).catch((err: unknown) => log.error({ err }, 'upload purge failed'));
  }, 3_600_000).unref();
  app.listen(config.PORT, () => {
    log.info({ port: config.PORT, version: VERSION }, 'vibe-portal api listening');
  });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
