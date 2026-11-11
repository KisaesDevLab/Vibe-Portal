// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Files a client sends the firm (Phase 4, D10). One file per request, as
// application/octet-stream; the page sends a batch of up to 20 one after another (P34) with the
// same batch id and note (P30). Type checked by content and name (P29); HEIC photos become JPG
// (P33). A client can remove an upload until Vibe Files has fetched it (P32).
//
//   POST   /api/portal/uploads?clientId&batchId   body: the file
//          headers X-Vibe-Name and X-Vibe-Note, percent-encoded (P47: not in the URL, so not in
//          the proxy's access log; ?name and ?note are still read)
//   GET    /api/portal/uploads                                this person's uploads, active client
//   DELETE /api/portal/uploads/:id
//   GET    /api/portal/uploads/notify-options?clientId    staff the client may tell (P56)
//   POST   /api/portal/uploads/notify   { clientId, batchId, staffId }  once, after a batch

import express, { type Router } from 'express';
import { Readable } from 'node:stream';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { generateKey } from '@vibe/crypto';
import { z } from 'zod';
import { schema } from '@vibe-portal/db';

import { requireClient } from '../auth/client-auth';
import { activeClientsOf } from '../auth/grant';
import type { ClientSession } from '../auth/sessions';
import { uploadLimit, type Ctx } from '../context';
import { TooLarge } from '../files/blobs';
import { convertHeicQueued, HEIC_MAX_BYTES } from '../files/heic';
import { peek } from '../files/send';
import { allowedKind, SNIFF_BYTES } from '../files/sniff';
import { cleanName, contentTypeOf } from '../files/types';
import { record } from '../lib/events';
import { listOptions, notifyBatch, NotifySchema } from './upload-notice';
import { body, h, HttpError, queryWithText } from '../lib/http';
import { hit, LIMITS } from '../lib/rate-limit';

export const BATCH_MAX = 20;
/** Uploads for one client that Vibe Files has not yet collected may hold at most this much:
 *  with every office PC closed for a long weekend, the appliance's disk cannot fill (P47). */
export const WAITING_MAX_BYTES = 5 * 1024 * 1024 * 1024;

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
  convertHeic: HeicConverter = convertHeicQueued,
): Router {
  const r = express.Router();
  r.use(requireClient(ctx));

  // P56: tell someone at the firm about a batch just sent.
  r.get(
    '/notify-options',
    h(async (req, res) => {
      const q = z.object({ clientId: z.string().uuid() }).safeParse(req.query);
      if (!q.success) throw new HttpError(400, 'bad_query');
      const s = req.clientSession as ClientSession;
      res.json({ staff: await listOptions(ctx, s, q.data.clientId) });
    }),
  );
  r.post(
    '/notify',
    h(async (req, res) => {
      await notifyBatch(ctx, req.clientSession as ClientSession, body(NotifySchema, req));
      res.json({ ok: true });
    }),
  );

  r.post(
    '/',
    h(async (req, res) => {
      const s = req.clientSession as ClientSession;
      const q = Query.parse(queryWithText(req));
      const now = ctx.now();
      if (!req.is('application/octet-stream')) throw new HttpError(415, 'octet_stream_required');
      for (const [bucket, limit] of [
        [`upload:identity:${s.identityId}`, LIMITS.uploadPerIdentity],
        [`upload:identity-day:${s.identityId}`, LIMITS.uploadPerIdentityDay],
      ] as const) {
        if (!(await hit(ctx.db, bucket, limit, now))) throw new HttpError(429, 'too_many_requests');
      }
      const clients = await activeClientsOf(ctx.db, s.identityId);
      if (!clients.some((c) => c.id === q.clientId)) throw new HttpError(404, 'not_found');
      if (!(await hit(ctx.db, `upload:client:${q.clientId}`, LIMITS.uploadPerClient, now))) {
        throw new HttpError(429, 'too_many_requests');
      }
      const [waiting] = await ctx.db
        .select({ bytes: sql<string>`coalesce(sum(${schema.uploads.size}), 0)` })
        .from(schema.uploads)
        .where(
          and(
            eq(schema.uploads.clientId, q.clientId),
            isNull(schema.uploads.fetchedAt),
            isNull(schema.uploads.removedAt),
          ),
        );
      if (Number(waiting?.bytes ?? 0) >= WAITING_MAX_BYTES) {
        throw new HttpError(429, 'too_much_waiting');
      }
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
        const heicLimit = Math.min(limit, HEIC_MAX_BYTES);
        for await (const c of all) {
          size += (c as Buffer).length;
          if (size > heicLimit) throw new HttpError(413, 'too_large');
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
            // P67: the firm's record of their access request is not one of their uploads.
            isNull(schema.uploads.accessRequestId),
          ),
        )
        .orderBy(desc(schema.uploads.uploadedAt))
        .limit(200);
      res.json({
        // So the page can say "too large" before sending (a browser shows a refused large
        // upload as a broken connection).
        limitBytes: await uploadLimit(ctx),
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
      const mine = and(
        eq(schema.uploads.id, id.data),
        eq(schema.uploads.identityId, s.identityId),
        isNull(schema.uploads.accessRequestId),
      );
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
