// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P77: staff see a client's portal as the client's people see it, read only (owner 2026-11-12:
// "preview as a client"; staff, for the clients they see; files open view only).
//
//   GET /api/staff/v1/clients/:id/preview[?as=<identityId>]                        the page's content
//   GET /api/staff/v1/clients/:id/preview/files/:fileId/content[?as=<identityId>]  a PDF or picture, inline
//
// Each person at a client sees only the files shared with them; the preview lists the client's
// files that at least one person with access can see (not the ones shared with nobody), and says
// so. Opening a file here is not the person's view: it changes nothing they see ("New" stays)
// and is recorded as the staff member's in History. Nothing downloads: only a PDF or a picture
// is sent, inline.
//
// P92 (owner 2026-11-17: "could we also add view as person"): with `as`, the preview is one
// person's: the files shared with that person alone, each marked New as it is for them. Still
// read only, and still the staff member's own opening: nothing the person sees changes. The
// person must have access to this client, switched on, on an account that is on.

import express, { type Request, type Router } from 'express';
import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
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

  /** The client's live files that someone with access to the client can see; with `as`, the
   *  ones that person can. */
  const seenBySomeone = (clientId: string, as: string | null = null) =>
    and(
      eq(schema.files.clientId, clientId),
      isNull(schema.files.removedAt),
      isNotNull(schema.files.blobKey),
      sql`EXISTS (SELECT 1 FROM ${schema.fileVisibility} v
        JOIN ${schema.clientAccess} a ON a.identity_id = v.identity_id AND a.client_id = ${clientId} AND a.active
        JOIN ${schema.portalIdentity} p ON p.id = v.identity_id AND p.status = 'active'
        WHERE v.file_id = ${schema.files.id} AND v.visible
          AND (${as}::uuid IS NULL OR v.identity_id = ${as}::uuid))`,
    );

  /** The client's people who can sign in to it now. */
  const peopleOf = (clientId: string) =>
    ctx.db
      .select({
        identityId: schema.portalIdentity.id,
        name: schema.portalIdentity.name,
        email: schema.portalIdentity.email,
        phone: schema.portalIdentity.phone,
      })
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
      )
      .orderBy(asc(schema.portalIdentity.name), asc(schema.portalIdentity.id));

  /** `?as=`: the person the preview is for, or null. Not one of the client's people: 404. */
  const asOf = async (req: Request, clientId: string): Promise<string | null> => {
    const raw = req.query['as'];
    if (raw === undefined || raw === '') return null;
    const v = Uuid.safeParse(raw);
    if (!v.success) throw new HttpError(404, 'not_found');
    if (!(await peopleOf(clientId)).some((p) => p.identityId === v.data)) {
      throw new HttpError(404, 'not_found');
    }
    return v.data;
  };

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
      const as = await asOf(req, clientId);
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
        .where(and(seenBySomeone(clientId, as), client.active ? undefined : sql`false`))
        .orderBy(
          desc(sql`coalesce(${schema.files.contentUpdatedAt}, ${schema.files.sharedAt})`),
          desc(schema.files.sharedAt),
        );
      const persons = (await peopleOf(clientId)).map((p) => ({
        identityId: p.identityId,
        name: p.name || p.email || p.phone || '?',
      }));
      // What the person has not opened yet, as their own page marks it.
      const unseen = new Set(
        as
          ? (
              await ctx.db
                .select({ fileId: schema.fileVisibility.fileId })
                .from(schema.fileVisibility)
                .where(
                  and(
                    eq(schema.fileVisibility.identityId, as),
                    eq(schema.fileVisibility.visible, true),
                    isNull(schema.fileVisibility.viewedAt),
                  ),
                )
            ).map((v) => v.fileId)
          : [],
      );
      res.json({
        firmName: await firmName(ctx),
        client,
        people: persons.length,
        // P92: who the preview can be seen as, and who it is seen as now.
        persons,
        as: persons.find((p) => p.identityId === as) ?? null,
        link: link ?? null,
        files: files.map((f) => ({
          id: f.id,
          name: f.name,
          size: f.size,
          contentType: f.contentType,
          taxYear: f.taxYear,
          sharedAt: f.sharedAt,
          updatedAt: f.contentUpdatedAt,
          isNew: unseen.has(f.id),
          preview: previewOf(f.contentType),
        })),
      });
    }),
  );

  r.get(
    '/clients/:id/preview/files/:fileId/content',
    h(async (req, res) => {
      const { clientId, fileId } = ids(req);
      const as = await asOf(req, clientId);
      const [f] = await ctx.db
        .select({ f: schema.files })
        .from(schema.files)
        .innerJoin(schema.clients, eq(schema.clients.id, schema.files.clientId))
        .where(
          and(
            eq(schema.files.id, fileId as string),
            eq(schema.clients.active, true),
            seenBySomeone(clientId, as),
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
        () =>
          record(ctx.db, 'preview_view', actorOf(req), {
            clientId: f.clientId,
            fileId: f.id,
            // Whose view it was opened in (History names them); the opening is the staff
            // member's.
            ...(as ? { identityId: as, detail: { as } } : {}),
          }),
      );
    }),
  );

  return r;
}
