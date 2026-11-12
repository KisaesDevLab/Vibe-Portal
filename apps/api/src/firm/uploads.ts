// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Client uploads for Vibe Files to fetch into its Portal inbox (D10, P2, P3).
//
//   GET  /api/firm/v1/uploads                 uploads waiting to be fetched, oldest first
//   GET  /api/firm/v1/uploads/:id/content     the file (until purged)
//   POST /api/firm/v1/uploads/:id/fetched     marks it fetched; only the first caller wins (409)
//   GET  /api/firm/v1/uploads/unfiled         fetched, not yet filed or dismissed (P74)
//   POST /api/firm/v1/uploads/:id/filed       Vibe Files filed it from its Portal inbox (P74)
//   POST /api/firm/v1/uploads/:id/dismissed   a person in Vibe Files said not to file it (P74)
//
// Uploads are purged firm.upload_keep_days after they were filed or dismissed (P8, P74); the
// client still sees "Received by the firm". A fetcher that says it reports filing
// (`{ "tracksFiling": true }` on /fetched) keeps the upload until it does, at most
// UNFILED_CAP_DAYS after the fetch; any other fetcher's upload counts as filed when fetched.

import express, { type Request, type Router } from 'express';
import { and, asc, eq, isNotNull, isNull, lte, or } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@vibe-portal/db';

import type { Ctx } from '../context';
import { sendStored } from '../files/send';
import { record, type Actor } from '../lib/events';
import { h, HttpError, notForStaff } from '../lib/http';
import { inScope, limitedTo } from '../staff/scope';

function actorOf(req: Request): Actor {
  return req.firmActor ?? { kind: 'firm_key', name: 'Vibe Files' };
}

const idOf = (req: Request): string => {
  const v = z.string().uuid().safeParse(req.params['id']);
  if (!v.success) throw new HttpError(404, 'not_found');
  return v.data;
};

/** P74: an upload fetched by a fetcher that reports filing is purged at the latest this many
 *  days after the fetch, filed or not (the portal is not an archive). */
export const UNFILED_CAP_DAYS = 180;

const DAY = 86_400_000;

async function keepDays(ctx: Ctx): Promise<number> {
  const [firm] = await ctx.db.select({ days: schema.firm.uploadKeepDays }).from(schema.firm);
  return firm?.days ?? 30;
}

export function firmUploadsRouter(ctx: Ctx, staff = false): Router {
  const r = express.Router();
  // P10: downloading on the staff page never marks an upload fetched; it still reaches Intake.
  // P74: filing is Vibe Files' to say.
  if (staff) {
    r.post('/:id/fetched', notForStaff);
    r.post('/:id/filed', notForStaff);
    r.post('/:id/dismissed', notForStaff);
  }

  // P74: fetched by Vibe Files, not yet filed or dismissed, oldest first. Only those whose file
  // the portal still has: one it no longer has cannot be fetched again. A distinct path, so an
  // older portal answers 404 rather than its list of waiting uploads.
  r.get(
    '/unfiled',
    h(async (req, res) => {
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
            isNotNull(schema.uploads.fetchedAt),
            isNull(schema.uploads.filedAt),
            isNull(schema.uploads.dismissedAt),
            isNull(schema.uploads.removedAt),
            isNull(schema.uploads.purgedAt),
            isNotNull(schema.uploads.blobKey),
            inScope(req, schema.uploads.clientId),
            // P67: the record of an access request is for staff who see every client.
            limitedTo(req) ? isNull(schema.uploads.accessRequestId) : undefined,
          ),
        )
        .orderBy(asc(schema.uploads.fetchedAt))
        .limit(500);
      res.json({
        state: 'unfiled',
        keepDays: await keepDays(ctx),
        capDays: UNFILED_CAP_DAYS,
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
          fetchedAt: u.fetchedAt,
          fetchedBy: u.fetchedBy,
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
            // P67: the record of an access request (with its photo ID) is for staff who see
            // every client, as the request was.
            limitedTo(req) ? isNull(schema.uploads.accessRequestId) : undefined,
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
        .where(
          and(
            eq(schema.uploads.id, id),
            inScope(req, schema.uploads.clientId),
            limitedTo(req) ? isNull(schema.uploads.accessRequestId) : undefined,
          ),
        );
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
              // P67: an access-request record stays out of the client's History.
              clientId: u.accessRequestId ? null : u.clientId,
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
      // P74: a fetcher that does not report filing has filed it as far as the portal knows.
      const b: unknown = req.body;
      const tracksFiling =
        typeof b === 'object' &&
        b !== null &&
        (b as { tracksFiling?: unknown }).tracksFiling === true;
      const now = ctx.now();
      const [u] = await ctx.db
        .update(schema.uploads)
        .set({
          fetchedAt: now,
          fetchedBy: actor.name,
          ...(tracksFiling ? {} : { filedAt: now, filedBy: actor.name }),
        })
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
        // P67: an access-request record stays out of the client's History.
        clientId: u.accessRequestId ? null : u.clientId,
        identityId: u.identityId,
        uploadId: u.id,
      });
      res.json({ ok: true });
    }),
  );

  // P74: filed or dismissed. Saying it again is fine (another PC saw the same filing); an upload
  // not fetched yet cannot be either.
  const settle = (kind: 'filed' | 'dismissed') =>
    h(async (req, res) => {
      const id = idOf(req);
      const actor = actorOf(req);
      const [u] = await ctx.db
        .select()
        .from(schema.uploads)
        .where(and(eq(schema.uploads.id, id), inScope(req, schema.uploads.clientId)));
      if (!u) throw new HttpError(404, 'not_found');
      if (!u.fetchedAt) throw new HttpError(409, 'not_fetched');
      if (u.filedAt || u.dismissedAt) {
        res.json({ ok: true, already: u.filedAt ? 'filed' : 'dismissed' });
        return;
      }
      const now = ctx.now();
      const [done] = await ctx.db
        .update(schema.uploads)
        .set(
          kind === 'filed'
            ? { filedAt: now, filedBy: actor.name }
            : { dismissedAt: now, dismissedBy: actor.name },
        )
        .where(
          and(
            eq(schema.uploads.id, id),
            isNull(schema.uploads.filedAt),
            isNull(schema.uploads.dismissedAt),
          ),
        )
        .returning({ id: schema.uploads.id });
      if (done) {
        await record(ctx.db, kind === 'filed' ? 'upload_filed' : 'upload_dismissed', actor, {
          // P67: an access-request record stays out of the client's History.
          clientId: u.accessRequestId ? null : u.clientId,
          identityId: u.identityId,
          uploadId: u.id,
        });
      }
      res.json({ ok: true });
    });
  r.post('/:id/filed', settle('filed'));
  r.post('/:id/dismissed', settle('dismissed'));

  return r;
}

/** P8, P74: deletes uploads' stored files the firm's keep period after they were filed or
 *  dismissed, and any fetched upload UNFILED_CAP_DAYS after the fetch. Access-request records
 *  also have their own, shorter rule (access-id.ts). */
export async function purgeUploads(ctx: Ctx): Promise<number> {
  const now = ctx.now().getTime();
  const before = new Date(now - (await keepDays(ctx)) * DAY);
  const cap = new Date(now - UNFILED_CAP_DAYS * DAY);
  const due = await ctx.db
    .select({
      id: schema.uploads.id,
      blobKey: schema.uploads.blobKey,
      filedAt: schema.uploads.filedAt,
      dismissedAt: schema.uploads.dismissedAt,
      accessRequestId: schema.uploads.accessRequestId,
    })
    .from(schema.uploads)
    .where(
      and(
        isNotNull(schema.uploads.fetchedAt),
        isNull(schema.uploads.purgedAt),
        or(
          lte(schema.uploads.filedAt, before),
          lte(schema.uploads.dismissedAt, before),
          // Only one never filed or dismissed: a filed one keeps the firm's keep period, however
          // long.
          and(
            isNull(schema.uploads.filedAt),
            isNull(schema.uploads.dismissedAt),
            lte(schema.uploads.fetchedAt, cap),
          ),
        ),
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
      const never = !u.filedAt && !u.dismissedAt && !u.accessRequestId;
      await record(
        ctx.db,
        'upload_purged',
        { kind: 'system', name: 'purge' },
        {
          uploadId: u.id,
          ...(never
            ? { detail: { reason: `not filed ${UNFILED_CAP_DAYS} days after fetch` } }
            : {}),
        },
      );
    }
  }
  return due.length;
}
