// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P94 (owner 2026-11-17: "update by itself"): a file staff added from Vibe Files' part of the
// B2 bucket (P91) follows the bucket. Every few minutes the portal reads the bucket's manifest
// head; for each client whose segment changed since it last looked, it compares the client's
// such files with the documents there, and replaces the portal's copy of one whose content (or
// name) changed: it counts as new again for the people who see it, who are told as for any
// update. A document deleted, or taken out of B2, in Vibe Files keeps its copy on the portal.
// Only files added from B2 follow it: one shared from Vibe Files is Vibe Files' to replace.

import { Readable } from 'node:stream';

import { and, eq, isNull } from 'drizzle-orm';
import { generateKey } from '@vibe/crypto';
import { schema } from '@vibe-portal/db';

import { uploadLimit, type Ctx } from '../context';
import type { Actor } from '../lib/events';
import { replaceContent } from './replace';
import { firmRow, vfSource } from './storage';
import { cleanName } from './types';
import { content, oneAtATime, readHead, readSegment, segmentKey, VfError } from './vf-bucket';

/** How often the server looks (server.ts). */
export const FOLLOW_EVERY_MS = 10 * 60_000;

const ACTOR: Actor = { kind: 'system', name: 'Vibe Files\u2019 B2' };

/** File id -> the client's segment it was last compared with: nothing is read again until the
 *  client's segment changes. Forgotten at a restart, which only looks once more. */
const compared = new Map<string, string>();
let running = false;

export interface Followed {
  /** Files whose copy on the portal was replaced. */
  updated: number;
  /** Files that could not be compared or replaced this time (tried again at the next look). */
  failed: number;
}

export async function followB2(ctx: Ctx): Promise<Followed> {
  const out: Followed = { updated: 0, failed: 0 };
  if (running) return out;
  running = true;
  try {
    const src = vfSource(ctx, await firmRow(ctx));
    if (!src) return out;
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
      .where(and(eq(schema.files.fromB2, true), isNull(schema.files.removedAt)));
    for (const id of compared.keys()) {
      if (!files.some((f) => f.id === id)) compared.delete(id);
    }
    if (!files.length) return out;
    const head = await readHead(src.bucket, src.access);
    if (!head) return out;
    const limit = await uploadLimit(ctx);
    for (const clientId of new Set(files.map((f) => f.clientId))) {
      try {
        const key = segmentKey(head, clientId);
        // The client is no longer in the bucket: its files stay as they are.
        if (!key) continue;
        const due = files.filter((f) => f.clientId === clientId && compared.get(f.id) !== key);
        if (!due.length) continue;
        const docs = await readSegment(src.bucket, src.access, key);
        for (const f of due) {
          const doc = docs.get(f.docId);
          const name = doc ? cleanName(doc.name) : f.name;
          // Gone from B2, the same as the portal's, or too large for it: nothing to do until
          // the client's segment changes again.
          if (!doc || (doc.sha256 === f.sha256 && name === f.name) || doc.size > limit) {
            if (doc && doc.size > limit) {
              ctx.log.warn(
                { fileId: f.id },
                'a changed document in B2 is too large for the portal',
              );
            }
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
              const ok = await replaceContent(ctx, f, stored, name, ACTOR, { from: 'b2' });
              if (!ok) await ctx.blobs.remove(put.blobKey);
              return ok;
            });
            if (replaced) out.updated += 1;
            compared.set(f.id, key);
          } catch (err) {
            out.failed += 1;
            // The code and the object's place in the bucket; never a file name.
            ctx.log.warn(
              { fileId: f.id, reason: err instanceof Error ? err.message : String(err) },
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
}
