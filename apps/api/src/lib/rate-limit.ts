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
  /** Files one person uploads in a day: new batches cannot get past it (P47). */
  uploadPerIdentityDay: { max: 300, windowSeconds: 24 * 60 * 60 },
  /** Files sent for one client by all its people in an hour. */
  uploadPerClient: { max: 200, windowSeconds: 60 * 60 },
  /** Secure links to people outside, made by one staff member in a day (P49). */
  outsideSharePerStaff: { max: 50, windowSeconds: 24 * 60 * 60 },
  /** Secure links one client person may send a day (P55). */
  outsideSharePerClientPerson: { max: 10, windowSeconds: 24 * 60 * 60 },
  /** Sign-in links and contact confirmations staff send one person (P66). */
  staffSendPerPerson: { max: 5, windowSeconds: 60 * 60 },
  /** Every call about secure links from one address. */
  outsidePerIp: { max: 60, windowSeconds: 60 },
  /** Access codes asked for from one address. */
  outsideCodePerIp: { max: 10, windowSeconds: 60 },
  /** Access codes tried from one address. */
  outsideVerifyPerIp: { max: 20, windowSeconds: 60 },
  /** One access code a minute for a link (also checked against the last code's time, so
   *  two windows cannot give two codes seconds apart), and ten a day. */
  outsideCodeMinute: { max: 1, windowSeconds: 60 },
  outsideCodeDay: { max: 10, windowSeconds: 24 * 60 * 60 },
  /** Codes to confirm a new mobile number, asked for by one signed-in person (P50). */
  phoneConfirmPerIdentity: { max: 5, windowSeconds: 60 * 60 },
  /** Codes to confirm a mobile number, texted to one number by everyone: a signed-in person
   *  cannot use the portal to flood someone's phone. */
  phoneConfirmPerPhone: { max: 5, windowSeconds: 60 * 60 },
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

/** Takes back a hit counted for something that then did not happen (an email that failed). */
export async function refund(db: Database, bucket: string, limit: Limit, now: Date): Promise<void> {
  await db
    .update(schema.rateLimit)
    .set({ hits: sql`greatest(${schema.rateLimit.hits} - 1, 0)` })
    .where(
      and(
        eq(schema.rateLimit.bucket, bucket),
        eq(schema.rateLimit.windowStart, windowStart(limit, now)),
      ),
    );
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
