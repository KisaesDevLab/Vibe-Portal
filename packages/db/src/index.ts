// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import * as schema from './schema';

export * as schema from './schema';
export { listMigrations, migrate, type Migration, type MigrationTarget } from './migrations';

export type Database = PostgresJsDatabase<typeof schema>;

export interface CreateDbOptions {
  connectionString: string;
  max?: number;
}

export function createDb(opts: CreateDbOptions): {
  db: Database;
  ping: () => Promise<boolean>;
  close: () => Promise<void>;
} {
  const client = postgres(opts.connectionString, { max: opts.max ?? 10 });
  const db = drizzle(client, { schema });
  return {
    db,
    ping: async () => {
      try {
        await client`SELECT 1`;
        return true;
      } catch {
        return false;
      }
    },
    close: () => client.end({ timeout: 5 }),
  };
}
