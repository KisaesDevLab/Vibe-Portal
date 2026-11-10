// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Client uploads for Vibe Files to fetch into its Portal inbox (D10, P2, P3).
//
//   GET  /api/firm/v1/uploads                 uploads waiting to be fetched, oldest first
//   GET  /api/firm/v1/uploads/:id/content     the file (until purged)
//   POST /api/firm/v1/uploads/:id/fetched     marks it fetched; only the first caller wins (409)
//
// Fetched uploads are purged P8 days later (firm.upload_keep_days); the client still sees
// "Received by the firm".

import express, { type Request, type Router } from 'express';
import { and, asc, eq, isNotNull, isNull, lte } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@vibe-portal/db';

import type { Ctx } from '../context';
import { sendStored } from '../files/send';
import { record, type Actor } from '../lib/events';
import { h, HttpError, notForStaff } from '../lib/http';
import { inScope } from '../staff/scope';

function actorOf(req: Request): Actor {
  return req.firmActor ?? { kind: 'firm_key', name: 'Vibe Files' };
}

const idOf = (req: Request): string => {
  const v = z.string().uuid().safeParse(req.params['id']);
  if (!v.success) throw new HttpError(404, 'not_found');
  return v.data;
};

export function firmUploadsRouter(ctx: Ctx, staff = false): Router {
  const r = express.Router();
  // P10: downloading on the staff page never marks an upload fetched; it still reaches Intake.
  if (staff) r.post('/:id/fetched', notForStaff);

  r.get(
    '/',
    h(async (req, res) => {
      const q = z.object({ clientId: z.string().uuid().optional() }).safeParse(req.query);
      if (!q.success) throw new HttpError(400, 'bad_query');
      const clientId = q.data.clientId;
      const rows = await ctx.db
        .select({
          u: schema.uploads,
          clientCode: schema.clients.clientCode,
          clientName: schema.clients.displayName,
          fromName: schema.portalIdentity.name,
          fromEmail: schema.portalIdentity.email,
          fromPhone: schema.portalIdentity.phone,
        })
        .from(schema.uploads)
        .innerJoin(schema.clients, eq(schema.clients.id, schema.uploads.clientId))
        .innerJoin(schema.portalIdentity, eq(schema.portalIdentity.id, schema.uploads.identityId))
        .where(
          and(
            isNull(schema.uploads.fetchedAt),
            isNull(schema.uploads.removedAt),
            inScope(req, schema.uploads.clientId),
            // P54: one client's, for its page on the staff page.
            clientId ? eq(schema.uploads.clientId, clientId) : undefined,
          ),
        )
        .orderBy(asc(schema.uploads.uploadedAt))
        .limit(500);
      res.json({
        uploads: rows.map(({ u, ...c }) => ({
          uploadId: u.id,
          clientId: u.clientId,
          clientCode: c.clientCode,
          clientName: c.clientName,
          name: u.name,
          originalName: u.originalName,
          size: u.size,
          sha256: u.sha256,
          note: u.note,
          batchId: u.batchId,
          uploadedAt: u.uploadedAt,
          from: {
            identityId: u.identityId,
            name: c.fromName,
            email: c.fromEmail,
            phone: c.fromPhone,
          },
        })),
      });
    }),
  );

  r.get(
    '/:id/content',
    h(async (req, res) => {
      const id = idOf(req);
      const [u] = await ctx.db
        .select()
        .from(schema.uploads)
        .where(and(eq(schema.uploads.id, id), inScope(req, schema.uploads.clientId)));
      if (!u || !u.blobKey || !u.dekWrapped) throw new HttpError(404, 'not_found');
      const blobKey = u.blobKey;
      const dekWrapped = u.dekWrapped;
      await sendStored(
        ctx,
        res,
        { id: u.id, blobKey, dekWrapped, size: u.size, name: u.name, inlineType: null },
        async () => {
          res.setHeader('X-Content-SHA256', u.sha256);
          // Vibe Files' own download is recorded when it marks the upload fetched; a staff
          // download on the page is recorded here (P10).
          const actor = actorOf(req);
          if (actor.kind === 'staff') {
            await record(ctx.db, 'download', actor, {
              clientId: u.clientId,
              identityId: u.identityId,
              uploadId: u.id,
            });
          }
        },
      );
    }),
  );

  r.post(
    '/:id/fetched',
    h(async (req, res) => {
      const id = idOf(req);
      const actor = actorOf(req);
      const [u] = await ctx.db
        .update(schema.uploads)
        .set({ fetchedAt: ctx.now(), fetchedBy: actor.name })
        .where(
          and(
            eq(schema.uploads.id, id),
            isNull(schema.uploads.fetchedAt),
            isNull(schema.uploads.removedAt),
          ),
        )
        .returning();
      if (!u) {
        const [exists] = await ctx.db
          .select({
            id: schema.uploads.id,
            removedAt: schema.uploads.removedAt,
            fetchedBy: schema.uploads.fetchedBy,
          })
          .from(schema.uploads)
          .where(eq(schema.uploads.id, id));
        if (!exists) throw new HttpError(404, 'not_found');
        // Who has it: a PC whose earlier claim reached the portal but whose answer was lost
        // knows it is its own (Phase 6 QA).
        res.status(409).json({
          error: exists.removedAt ? 'removed_by_client' : 'already_fetched',
          fetchedBy: exists.removedAt ? null : exists.fetchedBy,
        });
        return;
      }
      await record(ctx.db, 'fetch', actor, {
        clientId: u.clientId,
        identityId: u.identityId,
        uploadId: u.id,
      });
      res.json({ ok: true });
    }),
  );

  return r;
}

/** P8: deletes fetched uploads' stored files after the firm's keep period. */
export async function purgeUploads(ctx: Ctx): Promise<number> {
  const [firm] = await ctx.db.select({ days: schema.firm.uploadKeepDays }).from(schema.firm);
  const before = new Date(ctx.now().getTime() - (firm?.days ?? 30) * 86_400_000);
  const due = await ctx.db
    .select({ id: schema.uploads.id, blobKey: schema.uploads.blobKey })
    .from(schema.uploads)
    .where(
      and(
        isNotNull(schema.uploads.fetchedAt),
        lte(schema.uploads.fetchedAt, before),
        isNull(schema.uploads.purgedAt),
      ),
    );
  for (const u of due) {
    const [done] = await ctx.db
      .update(schema.uploads)
      .set({ purgedAt: ctx.now(), blobKey: null, dekWrapped: null })
      .where(and(eq(schema.uploads.id, u.id), isNull(schema.uploads.purgedAt)))
      .returning({ id: schema.uploads.id });
    if (done && u.blobKey) await ctx.blobs.remove(u.blobKey);
    if (done) {
      await record(ctx.db, 'upload_purged', { kind: 'system', name: 'purge' }, { uploadId: u.id });
    }
  }
  return due.length;
}
