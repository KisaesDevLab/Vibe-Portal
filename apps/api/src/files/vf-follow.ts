// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P94 (owner 2026-11-17: "update by itself"): a file staff added from Vibe Files' part of the
// B2 bucket (P91) follows the bucket. Every few minutes the portal reads the bucket's manifest
// head; for each client whose segment changed since it last looked, it compares the client's
// such files with the documents there, and replaces the portal's copy of one whose content (or
// name) changed: it counts as new again for the people who see it.
//
// P95 (owner 2026-11-17): the update marks the file new and sends no notice; and a document
// deleted, or taken out of B2, in Vibe Files leaves the portal too: its copy is removed, as
// staff removing it would. So does one moved to another client in Vibe Files (it is no longer
// this client's to see). Removal cannot be undone, so it is slow to act: only when the client's
// segment is there and no longer has the document (a client not in the manifest at all, as
// after a bucket set up anew, loses nothing); only at a second look, ten minutes after the
// first found it gone; and never from a manifest head older than one already seen (two PCs
// pushing at once can leave an older head for a moment).
// Only files added from B2 follow it: one shared from Vibe Files is Vibe Files' to replace.

import { Readable } from 'node:stream';

import { and, eq, isNull } from 'drizzle-orm';
import { generateKey } from '@vibe/crypto';
import { schema } from '@vibe-portal/db';

import { uploadLimit, type Ctx } from '../context';
import type { Actor } from '../lib/events';
import { removeFile, replaceContent } from './replace';
import { firmRow, vfSource } from './storage';
import { cleanName, contentTypeOf } from './types';
import { content, oneAtATime, readHead, readSegment, segmentKey, VfError } from './vf-bucket';

/** How often the server looks (server.ts). */
export const FOLLOW_EVERY_MS = 10 * 60_000;
/** How long a document must have been gone from B2 before its file leaves the portal. */
export const GONE_WAIT_MS = 9 * 60_000;

/** The actor of what the portal does by itself from Vibe Files' bucket. */
export const FOLLOW_ACTOR = 'Vibe Files\u2019 B2';
const ACTOR: Actor = { kind: 'system', name: FOLLOW_ACTOR };

/** File id -> the client's segment it was last compared with: nothing is read again until the
 *  client's segment changes. Forgotten at a restart, which only looks once more. */
const compared = new Map<string, string>();
/** File id -> the segment a fetch failed at, and how often: a document that does not open is
 *  not fetched again and again (each try is a whole download). */
const failures = new Map<string, { key: string; n: number }>();
const TRIES = 3;
/** File id -> when its document was first found gone from the client's segment. */
const goneSince = new Map<string, number>();
/** The newest manifest head seen (its revision): an older one removes nothing. */
let newestHead = 0;
let running = false;
/** Why the bucket could not be read at the last look (a VfError's code, or 'unread'); null
 *  when it could. Settings > Storage says so. */
let problem: string | null = null;
export function followProblem(): string | null {
  return problem;
}

export interface Followed {
  /** Files whose copy on the portal was replaced. */
  updated: number;
  /** Files taken off the portal: their document left B2. */
  removed: number;
  /** Files that could not be compared or replaced this time (tried again at the next look). */
  failed: number;
}

export async function followB2(ctx: Ctx): Promise<Followed> {
  const out: Followed = { updated: 0, removed: 0, failed: 0 };
  if (running) return out;
  running = true;
  try {
    const src = vfSource(ctx, await firmRow(ctx));
    if (!src) {
      problem = null;
      return out;
    }
    // Not a switched-off client's: its people see nothing of it, and are told nothing.
    const files = await ctx.db
      .select({
        id: schema.files.id,
        clientId: schema.files.clientId,
        docId: schema.files.vfDocumentId,
        sha256: schema.files.sha256,
        name: schema.files.name,
        blobKey: schema.files.blobKey,
      })
      .from(schema.files)
      .innerJoin(schema.clients, eq(schema.clients.id, schema.files.clientId))
      .where(
        and(
          eq(schema.files.fromB2, true),
          isNull(schema.files.removedAt),
          eq(schema.clients.active, true),
        ),
      );
    const live = new Set(files.map((f) => f.id));
    for (const id of compared.keys()) if (!live.has(id)) compared.delete(id);
    for (const id of failures.keys()) if (!live.has(id)) failures.delete(id);
    for (const id of goneSince.keys()) if (!live.has(id)) goneSince.delete(id);
    if (!files.length) {
      problem = null;
      return out;
    }
    let head;
    try {
      head = await readHead(src.bucket, src.access);
      problem = null;
    } catch (err) {
      // The sync key changed, or the bucket cannot be reached: nothing follows until an admin
      // looks (Settings > Storage shows it).
      problem = err instanceof VfError ? err.code : 'unread';
      throw err;
    }
    if (!head) return out;
    const stale = head.rev < newestHead;
    newestHead = Math.max(newestHead, head.rev);
    const limit = await uploadLimit(ctx);
    const byClient = new Map<string, typeof files>();
    for (const f of files) {
      const list = byClient.get(f.clientId);
      if (list) list.push(f);
      else byClient.set(f.clientId, [f]);
    }
    for (const [clientId, theirs] of byClient) {
      try {
        const key = segmentKey(head, clientId);
        // The client is no longer in the bucket: its files stay as they are.
        if (!key) continue;
        // Also the files found gone at an earlier look: looked at again, to remove them.
        const due = theirs.filter((f) => compared.get(f.id) !== key || goneSince.has(f.id));
        if (!due.length) continue;
        const docs = await readSegment(src.bucket, src.access, key);
        for (const f of due) {
          const doc = docs.get(f.docId);
          // No longer in B2 (deleted in the cabinet, or taken out of B2): off the portal too.
          // Not if Vibe Files or staff changed the file meanwhile.
          if (!doc) {
            compared.set(f.id, key);
            const first = goneSince.get(f.id);
            if (first === undefined) {
              goneSince.set(f.id, ctx.now().getTime());
              continue;
            }
            // Still gone at a later look, and the head is not an older one.
            if (stale || ctx.now().getTime() - first < GONE_WAIT_MS) continue;
            if (await removeFile(ctx, f, ACTOR, { from: 'b2' }, { sha256: f.sha256 })) {
              out.removed += 1;
            }
            goneSince.delete(f.id);
            compared.delete(f.id);
            continue;
          }
          // There (again): whatever was seen before was a moment's.
          goneSince.delete(f.id);
          const name = cleanName(doc.name);
          // The same as the portal's, or too large for it: nothing to do until the client's
          // segment changes again.
          if ((doc.sha256 === f.sha256 && name === f.name) || doc.size > limit) {
            if (doc.size > limit) {
              ctx.log.warn(
                { fileId: f.id },
                'a changed document in B2 is too large for the portal',
              );
            }
            compared.set(f.id, key);
            continue;
          }
          // Renamed in the cabinet, the same content: the name alone follows. Nothing is
          // fetched, and nobody is told of a new file.
          if (doc.sha256 === f.sha256) {
            await ctx.db
              .update(schema.files)
              .set({ name, contentType: contentTypeOf(name), updatedAt: ctx.now() })
              .where(
                and(
                  eq(schema.files.id, f.id),
                  isNull(schema.files.removedAt),
                  eq(schema.files.fromB2, true),
                  eq(schema.files.sha256, f.sha256),
                ),
              );
            compared.set(f.id, key);
            continue;
          }
          try {
            const replaced = await oneAtATime(async () => {
              const plain = await content(src.bucket, src.access, doc);
              const dek = generateKey();
              const put = await ctx.blobs.put(Readable.from([plain]), dek, limit);
              if (put.sha256 !== doc.sha256) {
                await ctx.blobs.remove(put.blobKey);
                throw new VfError('vf_damaged', 'stored copy');
              }
              const stored = { ...put, dekWrapped: Buffer.from(ctx.keyring.wrap(dek)) };
              // Only while the file is still as it was read above: replaced or removed
              // meanwhile (by Vibe Files, by staff), the new copy is dropped.
              const ok = await replaceContent(
                ctx,
                f,
                stored,
                name,
                ACTOR,
                { from: 'b2' },
                // New for those who see it; nobody is sent a notice (P95).
                { onlyIf: f.sha256, quiet: true },
              );
              if (!ok) await ctx.blobs.remove(put.blobKey);
              return ok;
            });
            if (replaced) out.updated += 1;
            compared.set(f.id, key);
            failures.delete(f.id);
          } catch (err) {
            out.failed += 1;
            const was = failures.get(f.id);
            const n = was?.key === key ? was.n + 1 : 1;
            failures.set(f.id, { key, n });
            // Given up on until the client's segment changes: Vibe Files pushing again.
            if (n >= TRIES) compared.set(f.id, key);
            // The code and the object's place in the bucket; never a file name.
            ctx.log.warn(
              {
                fileId: f.id,
                tries: n,
                reason: err instanceof Error ? err.message : String(err),
              },
              'a file added from B2 could not be updated',
            );
          }
        }
      } catch (err) {
        out.failed += 1;
        ctx.log.warn(
          { clientId, reason: err instanceof Error ? err.message : String(err) },
          'a client\u2019s documents in B2 could not be read',
        );
      }
    }
    return out;
  } finally {
    running = false;
  }
}

/** For tests: as after a restart. */
export function forgetCompared(): void {
  compared.clear();
  failures.clear();
  goneSince.clear();
  newestHead = 0;
  problem = null;
}
