// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// A fresh, migrated in-process Postgres (pglite) for tests.

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import type { Database } from './index';
import { migrate, type MigrationTarget } from './migrations';
import * as schema from './schema';

export function pgliteTarget(db: PGlite): MigrationTarget {
  return {
    exec: async (q) => {
      await db.exec(q);
    },
    applied: async () =>
      new Set(
        (await db.query<{ filename: string }>('SELECT filename FROM schema_migrations')).rows.map(
          (r) => r.filename,
        ),
      ),
    applyOne: async (name, body) => {
      await db.transaction(async (tx) => {
        await tx.exec(body);
        await tx.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [name]);
      });
    },
  };
}

export interface TestDb {
  db: Database;
  pg: PGlite;
  close: () => Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const pg = new PGlite();
  await migrate(pgliteTarget(pg));
  const db = drizzle(pg, { schema }) as unknown as Database;
  return { db, pg, close: () => pg.close() };
}
