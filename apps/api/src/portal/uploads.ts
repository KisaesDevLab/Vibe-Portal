// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Files a client sends the firm (Phase 4, D10). One file per request, as
// application/octet-stream; the page sends a batch of up to 20 one after another (P34) with the
// same batch id and note (P30). Type checked by content and name (P29); HEIC photos become JPG
// (P33). A client can remove an upload until Vibe Files has fetched it (P32).
//
//   POST   /api/portal/uploads?clientId&batchId&name[&note]   body: the file
//   GET    /api/portal/uploads                                this person's uploads, active client
//   DELETE /api/portal/uploads/:id

import express, { type Router } from 'express';
import { Readable } from 'node:stream';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { generateKey } from '@vibe/crypto';
import { z } from 'zod';
import { schema } from '@vibe-portal/db';

import { requireClient } from '../auth/client-auth';
import { activeClientsOf } from '../auth/grant';
import type { ClientSession } from '../auth/sessions';
import { uploadLimit, type Ctx } from '../context';
import { TooLarge } from '../files/blobs';
import { convertHeicOffThread } from '../files/heic';
import { peek } from '../files/send';
import { allowedKind, SNIFF_BYTES } from '../files/sniff';
import { cleanName, contentTypeOf } from '../files/types';
import { record } from '../lib/events';
import { h, HttpError } from '../lib/http';
import { hit, LIMITS } from '../lib/rate-limit';

export const BATCH_MAX = 20;

const Query = z.object({
  clientId: z.string().uuid(),
  batchId: z.string().uuid(),
  name: z.string().min(1).max(400),
  note: z.string().trim().max(1000).optional(),
});

/** Converts HEIC photos; tests pass their own. */
export type HeicConverter = (body: Buffer) => Promise<Buffer>;

export function clientUploadsRouter(
  ctx: Ctx,
  convertHeic: HeicConverter = convertHeicOffThread,
): Router {
  const r = express.Router();
  r.use(requireClient(ctx));

  r.post(
    '/',
    h(async (req, res) => {
      const s = req.clientSession as ClientSession;
      const q = Query.parse(req.query);
      const now = ctx.now();
      if (!req.is('application/octet-stream')) throw new HttpError(415, 'octet_stream_required');
      if (!(await hit(ctx.db, `upload:identity:${s.identityId}`, LIMITS.uploadPerIdentity, now))) {
        throw new HttpError(429, 'too_many_requests');
      }
      const clients = await activeClientsOf(ctx.db, s.identityId);
      if (!clients.some((c) => c.id === q.clientId)) throw new HttpError(404, 'not_found');
      const inBatch = await ctx.db
        .select({ id: schema.uploads.id })
        .from(schema.uploads)
        .where(
          and(eq(schema.uploads.identityId, s.identityId), eq(schema.uploads.batchId, q.batchId)),
        );
      if (inBatch.length >= BATCH_MAX) throw new HttpError(429, 'batch_full');
      const limit = await uploadLimit(ctx);
      if (Number(req.headers['content-length'] ?? 0) > limit) throw new HttpError(413, 'too_large');

      let name = cleanName(q.name);
      const { head, all } = await peek(req, SNIFF_BYTES);
      const kind = allowedKind(head.subarray(0, SNIFF_BYTES), name);
      if (!kind) throw new HttpError(415, 'type_not_allowed');

      let source: Readable = all;
      let originalName: string | null = null;
      if (kind === 'heic') {
        // P33: a phone photo, converted to JPG. Held in memory (within the size limit).
        const parts: Buffer[] = [];
        let size = 0;
        for await (const c of all) {
          size += (c as Buffer).length;
          if (size > limit) throw new HttpError(413, 'too_large');
          parts.push(c as Buffer);
        }
        let jpeg: Buffer;
        try {
          jpeg = await convertHeic(Buffer.concat(parts));
        } catch (err) {
          ctx.log.warn({ err }, 'heic conversion failed');
          throw new HttpError(415, 'photo_unreadable');
        }
        originalName = name;
        name = cleanName(`${name.replace(/\.[^.]*$/, '')}.jpg`);
        source = Readable.from([jpeg]);
      }

      const dek = generateKey();
      let stored;
      try {
        stored = await ctx.blobs.put(source, dek, limit);
      } catch (err) {
        if (err instanceof TooLarge) throw new HttpError(413, 'too_large');
        throw err;
      }
      const [row] = await ctx.db
        .insert(schema.uploads)
        .values({
          clientId: q.clientId,
          identityId: s.identityId,
          name,
          originalName,
          contentType: contentTypeOf(name),
          size: stored.size,
          sha256: stored.sha256,
          blobKey: stored.blobKey,
          dekWrapped: Buffer.from(ctx.keyring.wrap(dek)),
          note: q.note ?? '',
          batchId: q.batchId,
          uploadedAt: now,
        })
        .returning({ id: schema.uploads.id });
      if (!row) throw new Error('upload insert returned nothing');
      await record(
        ctx.db,
        'upload',
        { kind: 'client', name: s.identityId },
        {
          clientId: q.clientId,
          identityId: s.identityId,
          uploadId: row.id,
          detail: { name, size: stored.size, ...(originalName ? { originalName } : {}) },
        },
      );
      res.status(201).json({ uploadId: row.id, name });
    }),
  );

  r.get(
    '/',
    h(async (req, res) => {
      const s = req.clientSession as ClientSession;
      const clients = await activeClientsOf(ctx.db, s.identityId);
      const clientId = clients.find((c) => c.id === s.activeClientId)?.id ?? clients[0]?.id;
      if (!clientId) throw new HttpError(401, 'signed_out');
      const rows = await ctx.db
        .select()
        .from(schema.uploads)
        .where(
          and(
            eq(schema.uploads.identityId, s.identityId),
            eq(schema.uploads.clientId, clientId),
            isNull(schema.uploads.removedAt),
          ),
        )
        .orderBy(desc(schema.uploads.uploadedAt))
        .limit(200);
      res.json({
        uploads: rows.map((u) => ({
          id: u.id,
          name: u.name,
          size: u.size,
          note: u.note,
          uploadedAt: u.uploadedAt,
          received: u.fetchedAt !== null,
        })),
      });
    }),
  );

  r.delete(
    '/:id',
    h(async (req, res) => {
      const s = req.clientSession as ClientSession;
      const id = z.string().uuid().safeParse(req.params['id']);
      if (!id.success) throw new HttpError(404, 'not_found');
      const mine = and(eq(schema.uploads.id, id.data), eq(schema.uploads.identityId, s.identityId));
      const [before] = await ctx.db.select().from(schema.uploads).where(mine);
      if (!before || before.removedAt) throw new HttpError(404, 'not_found');
      // One conditional update: Vibe Files fetching at the same moment wins or loses cleanly.
      const [gone] = await ctx.db
        .update(schema.uploads)
        .set({ removedAt: ctx.now(), blobKey: null, dekWrapped: null })
        .where(and(mine, isNull(schema.uploads.fetchedAt), isNull(schema.uploads.removedAt)))
        .returning({ id: schema.uploads.id });
      if (!gone) throw new HttpError(409, 'already_received');
      if (before.blobKey) await ctx.blobs.remove(before.blobKey);
      await record(
        ctx.db,
        'upload_removed',
        { kind: 'client', name: s.identityId },
        { clientId: before.clientId, identityId: s.identityId, uploadId: before.id },
      );
      res.json({ ok: true });
    }),
  );

  return r;
}
