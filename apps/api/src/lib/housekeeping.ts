// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Phase 7: rows that are done with are deleted once a day, so the tables do not grow without
// end. Nothing here is part of the history (events) or of a file.

import { and, isNull, lt, eq } from 'drizzle-orm';
import { schema, type Database } from '@vibe-portal/db';

const DAY = 24 * 3_600_000;

export async function purgeStale(db: Database, now: Date): Promise<void> {
  const dayAgo = new Date(now.getTime() - DAY);
  // Rate-limit windows are at most an hour long.
  await db.delete(schema.rateLimit).where(lt(schema.rateLimit.windowStart, dayAgo));
  // Sign-in links and codes, used or not, a day after they stopped working.
  await db.delete(schema.signInChallenge).where(lt(schema.signInChallenge.expiresAt, dayAgo));
  await db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, now));
  // Access requests never confirmed (no code returned) after a week.
  await db
    .delete(schema.accessRequest)
    .where(
      and(
        eq(schema.accessRequest.status, 'pending'),
        isNull(schema.accessRequest.confirmedAt),
        lt(schema.accessRequest.createdAt, new Date(now.getTime() - 7 * DAY)),
      ),
    );
}
