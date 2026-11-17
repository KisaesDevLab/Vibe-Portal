// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// A file's content replaced by a new version: by Vibe Files (PUT /files/:id/content), or by the
// portal itself for a file added from Vibe Files' part of the B2 bucket (files/vf-follow.ts).

import { and, eq, isNull } from 'drizzle-orm';
import { schema } from '@vibe-portal/db';

import type { Ctx } from '../context';
import { record, type Actor } from '../lib/events';
import type { Stored } from './blobs';
import { dropMarksOfFile } from './marks';
import { enqueue } from './notify-queue';
import { contentTypeOf } from './types';

/**
 * Points the file at the new stored content. It counts as new again for everyone who sees it
 * (P20), and they are told as for any update. False when the file was removed meanwhile: the
 * new stored content is then the caller's to remove.
 *
 * `opts.onlyIf`: replaced only while the file's content is still the one with this SHA-256
 * (the portal following B2 took a while to fetch the new one; Vibe Files may have replaced
 * the file meanwhile, and its version is not written over). `opts.fromB2`: whether the file
 * follows the bucket from now on (false when Vibe Files replaced it: it is then Vibe Files'
 * to replace).
 */
export async function replaceContent(
  ctx: Ctx,
  before: { id: string; clientId: string; blobKey: string | null },
  stored: Stored & { dekWrapped: Buffer },
  name: string,
  actor: Actor,
  detail: Record<string, unknown> = {},
  opts: { onlyIf?: string; fromB2?: boolean } = {},
): Promise<boolean> {
  const now = ctx.now();
  const id = before.id;
  const done = await ctx.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(schema.files)
      .set({
        name,
        contentType: contentTypeOf(name),
        size: stored.size,
        sha256: stored.sha256,
        blobKey: stored.blobKey,
        dekWrapped: stored.dekWrapped,
        contentUpdatedAt: now,
        updatedAt: now,
        ...(opts.fromB2 === undefined ? {} : { fromB2: opts.fromB2 }),
      })
      .where(
        and(
          eq(schema.files.id, id),
          isNull(schema.files.removedAt),
          opts.onlyIf === undefined ? undefined : eq(schema.files.sha256, opts.onlyIf),
        ),
      )
      // The stored content it had at that moment: that one is removed below, whatever the
      // caller read earlier.
      .returning({ id: schema.files.id });
    if (!updated) return false;
    const seen = await tx
      .update(schema.fileVisibility)
      .set({ viewedAt: null })
      .where(and(eq(schema.fileVisibility.fileId, id), eq(schema.fileVisibility.visible, true)))
      .returning({ identityId: schema.fileVisibility.identityId });
    await enqueue(
      tx,
      seen.map((s) => s.identityId),
      id,
      'updated',
      now,
    );
    return true;
  });
  if (!done) return false;
  if (before.blobKey) await ctx.blobs.remove(before.blobKey);
  // Watermarked copies in secure links were made from the old content (P49).
  await dropMarksOfFile(ctx, id);
  await record(ctx.db, 'replace', actor, {
    clientId: before.clientId,
    fileId: id,
    detail: { name, size: stored.size, ...detail },
  });
  return true;
}
