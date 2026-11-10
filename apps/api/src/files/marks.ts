// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Watermarked copies of the PDFs in secure links (P49 review). A PDF is marked once per link and
// day, in a worker (files/watermark.ts), and the marked copy is stored encrypted like any file;
// later views that day stream it. A copy counts only while the file's content is the one it was
// made from, so a file Vibe Files updates is marked again. Copies are removed with the file, when
// the link ends, and once their day is over: a marked copy never outlives what it was made from.

import { Readable } from 'node:stream';

import { and, eq, lt, or, sql } from 'drizzle-orm';
import { generateKey } from '@vibe/crypto';
import { schema } from '@vibe-portal/db';

import type { Ctx } from '../context';
import { HttpError } from '../lib/http';
import { readPlain } from './send';
import { WATERMARK_MAX_BYTES, watermarkPdf, watermarkText } from './watermark';

type Share = typeof schema.fileShare.$inferSelect;

export interface Marked {
  blobKey: string;
  dekWrapped: Buffer;
  size: number;
}

/** Copies being made now, so views at once wait for the one job instead of each starting one. */
const making = new Map<string, Promise<Marked>>();

const dayOf = (now: Date): string => now.toISOString().slice(0, 10);

async function make(
  ctx: Ctx,
  s: Share,
  f: { id: string; blobKey: string; dekWrapped: Buffer; size: number },
  day: string,
): Promise<Marked> {
  // Marked or not sent: an unmarked copy never goes out in place of a marked one.
  if (f.size > WATERMARK_MAX_BYTES) throw new HttpError(422, 'watermark_failed');
  const plain = await readPlain(ctx, f);
  let marked: Uint8Array;
  try {
    marked = await watermarkPdf(
      plain,
      watermarkText(
        { name: s.recipientName, email: s.recipientEmail, organization: s.organization },
        new Date(`${day}T12:00:00Z`),
      ),
    );
  } catch (err) {
    ctx.log.warn({ err, id: f.id }, 'file could not be watermarked');
    throw new HttpError(422, 'watermark_failed');
  }
  const dek = generateKey();
  const stored = await ctx.blobs.put(
    Readable.from([Buffer.from(marked.buffer, marked.byteOffset, marked.byteLength)]),
    dek,
    Number.MAX_SAFE_INTEGER,
  );
  const row = {
    shareId: s.id,
    fileId: f.id,
    day,
    sourceBlobKey: f.blobKey,
    blobKey: stored.blobKey,
    dekWrapped: Buffer.from(ctx.keyring.wrap(dek)),
    size: stored.size,
  };
  const [before] = await ctx.db
    .select({ blobKey: schema.fileShareMark.blobKey })
    .from(schema.fileShareMark)
    .where(
      and(
        eq(schema.fileShareMark.shareId, s.id),
        eq(schema.fileShareMark.fileId, f.id),
        eq(schema.fileShareMark.day, day),
      ),
    );
  await ctx.db
    .insert(schema.fileShareMark)
    .values(row)
    .onConflictDoUpdate({
      target: [schema.fileShareMark.shareId, schema.fileShareMark.fileId, schema.fileShareMark.day],
      set: {
        sourceBlobKey: row.sourceBlobKey,
        blobKey: row.blobKey,
        dekWrapped: row.dekWrapped,
        size: row.size,
        createdAt: sql`now()`,
      },
    });
  if (before && before.blobKey !== row.blobKey) await ctx.blobs.remove(before.blobKey);
  return row;
}

/**
 * Today's marked copy of `f` for the link, made now if there is none for the file as it is.
 * `fresh` makes a new one even if one is kept (the kept one could not be read).
 */
export async function markedCopy(
  ctx: Ctx,
  s: Share,
  f: { id: string; blobKey: string; dekWrapped: Buffer; size: number },
  fresh = false,
): Promise<Marked> {
  const day = dayOf(ctx.now());
  if (!fresh) {
    const [kept] = await ctx.db
      .select()
      .from(schema.fileShareMark)
      .where(
        and(
          eq(schema.fileShareMark.shareId, s.id),
          eq(schema.fileShareMark.fileId, f.id),
          eq(schema.fileShareMark.day, day),
        ),
      );
    if (kept && kept.sourceBlobKey === f.blobKey && (await ctx.blobs.exists(kept.blobKey))) {
      return kept;
    }
  }
  const key = `${s.id}:${f.id}:${day}:${f.blobKey}`;
  const already = making.get(key);
  if (already) return already;
  const job = make(ctx, s, f, day).finally(() => making.delete(key));
  making.set(key, job);
  return job;
}

/** Removes marked copies (rows and their stored files). */
async function drop(
  ctx: Ctx,
  rows: Array<{ shareId: string; fileId: string; day: string; blobKey: string }>,
) {
  for (const m of rows) {
    await ctx.db
      .delete(schema.fileShareMark)
      .where(
        and(
          eq(schema.fileShareMark.shareId, m.shareId),
          eq(schema.fileShareMark.fileId, m.fileId),
          eq(schema.fileShareMark.day, m.day),
          eq(schema.fileShareMark.blobKey, m.blobKey),
        ),
      );
    await ctx.blobs.remove(m.blobKey);
  }
}

const markCols = {
  shareId: schema.fileShareMark.shareId,
  fileId: schema.fileShareMark.fileId,
  day: schema.fileShareMark.day,
  blobKey: schema.fileShareMark.blobKey,
};

/** The marked copies of a file (removed from the portal, or its content replaced). */
export async function dropMarksOfFile(ctx: Ctx, fileId: string): Promise<void> {
  await drop(
    ctx,
    await ctx.db
      .select(markCols)
      .from(schema.fileShareMark)
      .where(eq(schema.fileShareMark.fileId, fileId)),
  );
}

/** The marked copies of a link that has ended. */
export async function dropMarksOfShare(ctx: Ctx, shareId: string): Promise<void> {
  await drop(
    ctx,
    await ctx.db
      .select(markCols)
      .from(schema.fileShareMark)
      .where(eq(schema.fileShareMark.shareId, shareId)),
  );
}

/** Housekeeping: copies of a day gone by, of a link that ended, or of content since changed. */
export async function purgeMarks(ctx: Ctx): Promise<void> {
  const now = ctx.now();
  const stale = await ctx.db
    .select(markCols)
    .from(schema.fileShareMark)
    .innerJoin(schema.fileShare, eq(schema.fileShare.id, schema.fileShareMark.shareId))
    .innerJoin(schema.files, eq(schema.files.id, schema.fileShareMark.fileId))
    .where(
      or(
        lt(schema.fileShareMark.day, dayOf(now)),
        sql`${schema.fileShare.revokedAt} IS NOT NULL`,
        lt(schema.fileShare.expiresAt, now),
        sql`${schema.files.removedAt} IS NOT NULL`,
        sql`${schema.files.blobKey} IS DISTINCT FROM ${schema.fileShareMark.sourceBlobKey}`,
      ),
    );
  await drop(ctx, stale);
}
