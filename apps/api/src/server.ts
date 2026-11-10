// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Entry point: check config, apply migrations, serve.

import postgres from 'postgres';
import { createDb, migrate } from '@vibe-portal/db';
import pino from 'pino';

import { createApp } from './app';
import { loadConfig } from './config';
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

  const { ping } = createDb({ connectionString: config.DATABASE_URL });
  const app = createApp({ pingDb: ping });
  app.listen(config.PORT, () => {
    log.info({ port: config.PORT, version: VERSION }, 'vibe-portal api listening');
  });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
