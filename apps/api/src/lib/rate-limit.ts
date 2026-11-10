// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Fixed-window rate limits kept in Postgres (no Redis).

import { and, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@vibe-portal/db';

export interface Limit {
  max: number;
  windowSeconds: number;
}

export const LIMITS = {
  /** Sign-in requests for one email or phone from one address. Counted per address too, so
   *  a stranger asking for someone's sign-in cannot use up theirs (Phase 7). */
  loginPerContact: { max: 5, windowSeconds: 15 * 60 },
  /** Sign-in messages to one email or phone from every address: stops a flood of mail. */
  loginPerContactAll: { max: 20, windowSeconds: 15 * 60 },
  /** Sign-in requests from one address. */
  loginPerIp: { max: 30, windowSeconds: 15 * 60 },
  /** Code and link checks from one address. */
  verifyPerIp: { max: 30, windowSeconds: 15 * 60 },
  /** Code checks for one phone from one address, across all its codes (each code also allows
   *  only 5 tries). Per address, so wrong codes from elsewhere cannot lock the person out. */
  verifyPerContact: { max: 10, windowSeconds: 15 * 60 },
  /** Access requests from one address. */
  requestPerIp: { max: 5, windowSeconds: 60 * 60 },
  /** Access requests and new confirmation codes for one email or phone. */
  requestPerContact: { max: 3, windowSeconds: 60 * 60 },
  /** Files one person uploads (P34: batches of up to 20). */
  uploadPerIdentity: { max: 100, windowSeconds: 60 * 60 },
  /** Wrong firm keys from one address. */
  badKeyPerIp: { max: 20, windowSeconds: 15 * 60 },
} satisfies Record<string, Limit>;

function windowStart(limit: Limit, now: Date): Date {
  const ms = limit.windowSeconds * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

/** Counts a hit; false when the bucket is now over its limit. */
export async function hit(db: Database, bucket: string, limit: Limit, now: Date): Promise<boolean> {
  const [row] = await db
    .insert(schema.rateLimit)
    .values({ bucket, windowStart: windowStart(limit, now), hits: 1 })
    .onConflictDoUpdate({
      target: [schema.rateLimit.bucket, schema.rateLimit.windowStart],
      set: { hits: sql`${schema.rateLimit.hits} + 1` },
    })
    .returning({ hits: schema.rateLimit.hits });
  return (row?.hits ?? 0) <= limit.max;
}

/** Whether a bucket is already at its limit, without counting a hit. */
export async function isBlocked(
  db: Database,
  bucket: string,
  limit: Limit,
  now: Date,
): Promise<boolean> {
  const [row] = await db
    .select({ hits: schema.rateLimit.hits })
    .from(schema.rateLimit)
    .where(
      and(
        eq(schema.rateLimit.bucket, bucket),
        eq(schema.rateLimit.windowStart, windowStart(limit, now)),
      ),
    );
  return (row?.hits ?? 0) >= limit.max;
}
