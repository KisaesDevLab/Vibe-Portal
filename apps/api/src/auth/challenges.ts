// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// One-time secrets sent to a person: sign-in links, sign-in codes, request confirmation codes.
//
// QA 2026-11-09: a new secret replaces the person's earlier unused ones of the same kind; tries are
// counted and a secret is used up with single conditional updates, so parallel guesses cannot
// get past MAX_ATTEMPTS and a right code cannot be used twice.

import { and, desc, eq, gt, isNull, lt, sql, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@vibe-portal/db';

import { sameHash, sha256 } from '../lib/secrets';

export const MAX_ATTEMPTS = 5;

type Challenge = typeof schema.signInChallenge.$inferSelect;
type NewChallenge = typeof schema.signInChallenge.$inferInsert;

/** Stores a new secret's hash, retiring earlier unused secrets of the same kind for the same
 *  person or request. */
export async function issue(db: Database, values: NewChallenge, now: Date): Promise<void> {
  const owner = values.identityId
    ? eq(schema.signInChallenge.identityId, values.identityId)
    : values.accessRequestId
      ? eq(schema.signInChallenge.accessRequestId, values.accessRequestId)
      : undefined;
  if (owner) {
    await db
      .update(schema.signInChallenge)
      .set({ usedAt: now })
      .where(
        and(
          owner,
          eq(schema.signInChallenge.kind, values.kind),
          isNull(schema.signInChallenge.usedAt),
        ),
      );
  }
  await db.insert(schema.signInChallenge).values(values);
}

/** Uses up the live secret whose hash matches `secret` (a link token). */
export async function redeemToken(
  db: Database,
  kind: Challenge['kind'],
  secret: string,
  now: Date,
): Promise<Challenge | null> {
  const [row] = await db
    .update(schema.signInChallenge)
    .set({ usedAt: now })
    .where(
      and(
        eq(schema.signInChallenge.kind, kind),
        eq(schema.signInChallenge.secretHash, sha256(secret)),
        isNull(schema.signInChallenge.usedAt),
        gt(schema.signInChallenge.expiresAt, now),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Checks a typed code against the newest live secret matching `which`. Every check counts as a
 * try; the secret is used up when right. Null when wrong, expired or out of tries.
 */
export async function checkCode(
  db: Database,
  which: SQL | undefined,
  code: string,
  now: Date,
): Promise<Challenge | null> {
  const live = and(
    which,
    isNull(schema.signInChallenge.usedAt),
    gt(schema.signInChallenge.expiresAt, now),
    lt(schema.signInChallenge.attempts, MAX_ATTEMPTS),
  );
  const [newest] = await db
    .select({ id: schema.signInChallenge.id })
    .from(schema.signInChallenge)
    .where(live)
    .orderBy(desc(schema.signInChallenge.createdAt))
    .limit(1);
  if (!newest) return null;
  const [tried] = await db
    .update(schema.signInChallenge)
    .set({ attempts: sql`${schema.signInChallenge.attempts} + 1` })
    .where(and(eq(schema.signInChallenge.id, newest.id), live))
    .returning();
  if (!tried || !sameHash(tried.secretHash, sha256(code))) return null;
  const [used] = await db
    .update(schema.signInChallenge)
    .set({ usedAt: now })
    .where(and(eq(schema.signInChallenge.id, tried.id), isNull(schema.signInChallenge.usedAt)))
    .returning();
  return used ?? null;
}
