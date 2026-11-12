// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P18: files shared with (or updated for) the same person are gathered into one message. A
// person's waiting notices are sent 5 minutes after the first of them, in their chosen way
// (email, text, both or none, P4). File names are not put in the message: the person signs in
// to see them.

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema } from '@vibe-portal/db';

import type { Executor } from '../auth/grant';
import { firmName, type Ctx } from '../context';
import { messageTo } from '../lib/notify';

export const GATHER_MINUTES = 5;

export async function enqueue(
  db: Executor,
  identityIds: string[],
  fileId: string,
  kind: 'shared' | 'updated',
  now: Date,
): Promise<void> {
  if (identityIds.length === 0) return;
  await db
    .insert(schema.notifyQueue)
    .values(identityIds.map((identityId) => ({ identityId, fileId, kind, createdAt: now })));
}

/** Drops waiting notices about a file, for some people or for everyone. */
export async function drop(
  db: Executor,
  fileId: string,
  identityIds: string[] | null,
  now: Date,
): Promise<void> {
  if (identityIds && identityIds.length === 0) return;
  await db
    .update(schema.notifyQueue)
    .set({ droppedAt: now })
    .where(
      and(
        eq(schema.notifyQueue.fileId, fileId),
        isNull(schema.notifyQueue.sentAt),
        isNull(schema.notifyQueue.droppedAt),
        identityIds ? inArray(schema.notifyQueue.identityId, identityIds) : undefined,
      ),
    );
}

/** Sends every person's gathered notices whose first notice is 5 minutes old. */
export async function flush(ctx: Ctx): Promise<number> {
  const now = ctx.now();
  const due = new Date(now.getTime() - GATHER_MINUTES * 60_000);
  const ready = await ctx.db
    .select({ identityId: schema.notifyQueue.identityId })
    .from(schema.notifyQueue)
    .where(and(isNull(schema.notifyQueue.sentAt), isNull(schema.notifyQueue.droppedAt)))
    .groupBy(schema.notifyQueue.identityId)
    // The time as text, cast: compared with a bare SQL expression, drizzle cannot tell it is a
    // timestamp and hands the Date to the driver as it is, which postgres-js refuses ("The
    // "string" argument must be of type string... Received an instance of Date"); PGlite, in
    // the tests, takes it.
    .having(sql`min(${schema.notifyQueue.createdAt}) <= ${due.toISOString()}::timestamptz`)
    .orderBy(asc(schema.notifyQueue.identityId));
  let sent = 0;
  for (const { identityId } of ready) {
    // Claim this person's waiting notices (another API instance cannot send them twice).
    const claimed = await ctx.db
      .update(schema.notifyQueue)
      .set({ sentAt: now })
      .where(
        and(
          eq(schema.notifyQueue.identityId, identityId),
          isNull(schema.notifyQueue.sentAt),
          isNull(schema.notifyQueue.droppedAt),
        ),
      )
      .returning();
    if (claimed.length === 0) continue;
    // Count only files the person can still see.
    const fileIds = [...new Set(claimed.map((c) => c.fileId))];
    const live = await ctx.db
      .select({ id: schema.files.id })
      .from(schema.files)
      .innerJoin(schema.fileVisibility, eq(schema.fileVisibility.fileId, schema.files.id))
      .where(
        and(
          inArray(schema.files.id, fileIds),
          isNull(schema.files.removedAt),
          eq(schema.fileVisibility.identityId, identityId),
          eq(schema.fileVisibility.visible, true),
        ),
      );
    const [who] = await ctx.db
      .select()
      .from(schema.portalIdentity)
      .where(eq(schema.portalIdentity.id, identityId));
    if (!who || who.status !== 'active' || live.length === 0 || who.notify === 'none') continue;
    const n = live.length;
    const firm = await firmName(ctx);
    const what = n === 1 ? 'a file' : `${n} files`;
    const subject = `${firm} has ${n === 1 ? 'a new file' : `${n} new files`} for you`;
    const text =
      `${firm} has shared ${what} with you on its client portal (new or updated). ` +
      `Sign in to see ${n === 1 ? 'it' : 'them'}: ${ctx.portalUrl}`;
    const to = [
      ...(who.notify !== 'sms' && who.email ? [who.email] : []),
      ...(who.notify !== 'email' && who.phone ? [who.phone] : []),
    ];
    // A person whose only contact does not match their choice still hears by that contact.
    if (to.length === 0) to.push(...[who.email, who.phone].filter((c): c is string => !!c));
    // Sent here, not in the background: a failure puts the notices back for the next run
    // (QA 2026-11-09), so a short SMTP or Twilio outage does not lose them.
    try {
      for (const t of to) await ctx.notifier.send(messageTo(t, subject, text));
      sent += 1;
    } catch (err) {
      ctx.log.error({ err, identityId }, 'new-files notice failed; will retry');
      await ctx.db
        .update(schema.notifyQueue)
        .set({ sentAt: null })
        .where(
          inArray(
            schema.notifyQueue.id,
            claimed.map((c) => c.id),
          ),
        );
    }
  }
  return sent;
}
