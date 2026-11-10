// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// The hand-written SQL migrations in packages/db/migrations, in the order they apply. Additive
// only: a shipped migration is never edited; a change is a new file.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Migration {
  name: string;
  sql: string;
}

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, '..', 'migrations');

export function listMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }));
}

/** What a migration runner needs from a database connection. */
export interface MigrationTarget {
  /** Run SQL that returns nothing. */
  exec(sql: string): Promise<void>;
  /** Names already applied. */
  applied(): Promise<Set<string>>;
  /** Run `body` and record `name`, atomically. */
  applyOne(name: string, body: string): Promise<void>;
}

/** Applies the migrations not yet applied; returns their names. */
export async function migrate(target: MigrationTarget, all = listMigrations()): Promise<string[]> {
  await target.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const done = await target.applied();
  const ran: string[] = [];
  for (const m of all) {
    if (done.has(m.name)) continue;
    await target.applyOne(m.name, m.sql);
    ran.push(m.name);
  }
  return ran;
}
