// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Raw SQL helpers shared by stored-file storage and database snapshots (P51).

import { sql } from 'drizzle-orm';
import type { Database } from '@vibe-portal/db';

/** postgres-js returns the rows; pglite (tests) returns { rows }. */
export function rowsOf<T>(r: unknown): T[] {
  return Array.isArray(r) ? (r as T[]) : ((r as { rows: T[] }).rows ?? []);
}

/** Merges `n` into firm.storage_note: the sweep and the snapshots each keep their own fields. */
export async function mergeStorageNote(
  db: Pick<Database, 'execute'>,
  n: Record<string, unknown>,
): Promise<void> {
  await db.execute(
    sql`UPDATE firm SET storage_note = coalesce(storage_note, '{}'::jsonb) || ${JSON.stringify(n)}::jsonb`,
  );
}
