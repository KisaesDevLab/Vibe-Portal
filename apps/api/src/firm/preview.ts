// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P77: staff see a client's portal as the client's people see it, read only (owner 2026-11-12:
// "preview as a client"; staff, for the clients they see; files open view only).
//
//   GET /api/staff/v1/clients/:id/preview                         the page's content
//   GET /api/staff/v1/clients/:id/preview/files/:fileId/content   a PDF or picture, inline
//
// Each person at a client sees only the files shared with them; the preview lists the client's
// files that at least one person with access can see (not the ones shared with nobody), and says
// so. Opening a file here is not the person's view: it changes nothing they see ("New" stays)
// and is recorded as the staff member's in History. Nothing downloads: only a PDF or a picture
// is sent, inline.

import express, { type Request, type Router } from 'express';
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@vibe-portal/db';

import { firmName, type Ctx } from '../context';
import { sendStored } from '../files/send';
import { previewOf } from '../files/types';
import { record, type Actor } from '../lib/events';
import { h, HttpError } from '../lib/http';

const Uuid = z.string().uuid();

function actorOf(req: Request): Actor {
  return req.firmActor ?? { kind: 'firm_key', name: 'Vibe Files' };
}

export function staffPreviewRouter(ctx: Ctx): Router {
  const r = express.Router();

  const ids = (req: Request): { clientId: string; fileId: string | null } => {
    const c = Uuid.safeParse(req.params['id']);
    if (!c.success) throw new HttpError(404, 'client_not_found');
    const f = req.params['fileId'] === undefined ? null : Uuid.safeParse(req.params['fileId']);
    if (f && !f.success) throw new HttpError(404, 'not_found');
    return { clientId: c.data, fileId: f ? (f.data as string) : null };
  };

  /** The client's live files that someone with access to the client can see. */
  const seenBySomeone = (clientId: string) =>
    and(
      eq(schema.files.clientId, clientId),
      isNull(schema.files.removedAt),
      isNotNull(schema.files.blobKey),
      sql`EXISTS (SELECT 1 FROM ${schema.fileVisibility} v
        JOIN ${schema.clientAccess} a ON a.identity_id = v.identity_id AND a.client_id = ${clientId} AND a.active
        JOIN ${schema.portalIdentity} p ON p.id = v.identity_id AND p.status = 'active'
        WHERE v.file_id = ${schema.files.id} AND v.visible)`,
    );

  r.get(
    '/clients/:id/preview',
    h(async (req, res) => {
      const { clientId } = ids(req);
      const [client] = await ctx.db
        .select({
          id: schema.clients.id,
          name: schema.clients.displayName,
          active: schema.clients.active,
        })
        .from(schema.clients)
        .where(eq(schema.clients.id, clientId));
      if (!client) throw new HttpError(404, 'client_not_found');
      const [link] = await ctx.db
        .select({
          url: schema.clientLink.url,
          message: schema.clientLink.message,
          button: schema.clientLink.button,
        })
        .from(schema.clientLink)
        .where(eq(schema.clientLink.clientId, clientId));
      // A switched-off client's people see nothing of it on the portal: nor does the preview.
      const files = await ctx.db
        .select()
        .from(schema.files)
        .where(and(seenBySomeone(clientId), client.active ? undefined : sql`false`))
        .orderBy(
          desc(sql`coalesce(${schema.files.contentUpdatedAt}, ${schema.files.sharedAt})`),
          desc(schema.files.sharedAt),
        );
      const [people] = await ctx.db
        .select({ n: sql<number>`count(*)` })
        .from(schema.clientAccess)
        .innerJoin(
          schema.portalIdentity,
          eq(schema.portalIdentity.id, schema.clientAccess.identityId),
        )
        .where(
          and(
            eq(schema.clientAccess.clientId, clientId),
            eq(schema.clientAccess.active, true),
            eq(schema.portalIdentity.status, 'active'),
          ),
        );
      res.json({
        firmName: await firmName(ctx),
        client,
        people: Number(people?.n ?? 0),
        link: link ?? null,
        files: files.map((f) => ({
          id: f.id,
          name: f.name,
          size: f.size,
          contentType: f.contentType,
          taxYear: f.taxYear,
          sharedAt: f.sharedAt,
          updatedAt: f.contentUpdatedAt,
          isNew: false,
          preview: previewOf(f.contentType),
        })),
      });
    }),
  );

  r.get(
    '/clients/:id/preview/files/:fileId/content',
    h(async (req, res) => {
      const { clientId, fileId } = ids(req);
      const [f] = await ctx.db
        .select({ f: schema.files })
        .from(schema.files)
        .innerJoin(schema.clients, eq(schema.clients.id, schema.files.clientId))
        .where(
          and(
            eq(schema.files.id, fileId as string),
            eq(schema.clients.active, true),
            seenBySomeone(clientId),
          ),
        )
        .then((rows) => rows.map((r) => r.f));
      if (!f || !f.blobKey || !f.dekWrapped || !previewOf(f.contentType)) {
        throw new HttpError(404, 'not_found');
      }
      res.setHeader('X-Content-Type-Options', 'nosniff');
      await sendStored(
        ctx,
        res,
        {
          id: f.id,
          blobKey: f.blobKey,
          dekWrapped: f.dekWrapped,
          size: f.size,
          name: f.name,
          inlineType: f.contentType,
        },
        () => record(ctx.db, 'preview_view', actorOf(req), { clientId: f.clientId, fileId: f.id }),
      );
    }),
  );

  return r;
}
