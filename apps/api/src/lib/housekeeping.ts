// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Phase 7: rows that are done with are deleted once a day, so the tables do not grow without
// end. Nothing here is part of the history (events) or of a file.

import { and, isNull, lt, eq } from 'drizzle-orm';
import { schema, type Database } from '@vibe-portal/db';

import { purgeProblems } from './problems';

const DAY = 24 * 3_600_000;

export async function purgeStale(db: Database, now: Date): Promise<void> {
  const dayAgo = new Date(now.getTime() - DAY);
  // Rate-limit windows are at most a day long.
  await db.delete(schema.rateLimit).where(lt(schema.rateLimit.windowStart, dayAgo));
  // Sign-in links and codes, used or not, a day after they stopped working.
  await db.delete(schema.signInChallenge).where(lt(schema.signInChallenge.expiresAt, dayAgo));
  await db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, now));
  // Access codes and verified browsers of secure links (P49), once they stopped working.
  await db.delete(schema.fileShareCode).where(lt(schema.fileShareCode.expiresAt, dayAgo));
  await db.delete(schema.fileShareGrant).where(lt(schema.fileShareGrant.expiresAt, now));
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
  // The Log's warnings and errors after 30 days (P64).
  await purgeProblems(db, now);
}
