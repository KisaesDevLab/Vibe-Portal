// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Applies packages/db/migrations to DATABASE_URL.

import postgres from 'postgres';

import { migrate } from '../migrations';

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is required');
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
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
    console.warn(ran.length ? `applied ${ran.join(', ')}` : 'up to date');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
