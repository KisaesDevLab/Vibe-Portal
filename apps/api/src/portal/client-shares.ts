// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// A client sending files the firm shared with them to someone outside (P55): a lender, another
// adviser. The same secure link staff send (firm/shares.ts): the recipient proves the mailbox
// with a code, the link expires, and staff see it on the client's page and can revoke it. For a
// client it is always watermarked, lasts at most 30 days, and only exists while an admin has
// turned it on (Settings > Firm, "Clients may send secure links").
//
//   GET    /api/portal/outside-shares          { enabled, shares }  this person's, active client
//   POST   /api/portal/outside-shares          { clientId, fileIds, email, name?, organization?,
//                                                message?, canDownload?, days? }
//   DELETE /api/portal/outside-shares/:id      their own link only

import express, { type Router } from 'express';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@vibe-portal/db';

import { requireClient } from '../auth/client-auth';
import { activeClientsOf } from '../auth/grant';
import type { ClientSession } from '../auth/sessions';
import type { Ctx } from '../context';
import { dropMarksOfShare } from '../files/marks';
import { createOutsideShare, SHARE_MAX_FILES, shareStatus } from '../firm/shares';
import { record, type Actor } from '../lib/events';
import { body, h, HttpError } from '../lib/http';
import { LIMITS } from '../lib/rate-limit';

/** A client's link lasts at most this long (owner 2026-11-10). */
export const CLIENT_SHARE_MAX_DAYS = 30;

const Uuid = z.string().uuid();
const CreateSchema = z.object({
  clientId: Uuid,
  fileIds: z.array(Uuid).min(1).max(SHARE_MAX_FILES),
  email: z.string().trim().max(254),
  name: z.string().trim().max(120).default(''),
  organization: z.string().trim().max(120).default(''),
  message: z.string().trim().max(1000).default(''),
  canDownload: z.boolean().default(false),
  days: z.number().int().min(1).max(CLIENT_SHARE_MAX_DAYS).default(CLIENT_SHARE_MAX_DAYS),
});

async function enabled(ctx: Ctx): Promise<boolean> {
  const [f] = await ctx.db.select({ on: schema.firm.clientLinks }).from(schema.firm);
  return Boolean(f?.on);
}

async function whoIs(ctx: Ctx, s: ClientSession): Promise<{ actor: Actor; name: string }> {
  const [p] = await ctx.db
    .select()
    .from(schema.portalIdentity)
    .where(eq(schema.portalIdentity.id, s.identityId));
  const name = p?.name || p?.email || p?.phone || 'A client';
  return { actor: { kind: 'client', name: s.identityId }, name };
}

export function clientSharesRouter(ctx: Ctx): Router {
  const r = express.Router();
  r.use(requireClient(ctx));

  r.get(
    '/',
    h(async (req, res) => {
      const s = req.clientSession as ClientSession;
      const on = await enabled(ctx);
      const clients = await activeClientsOf(ctx.db, s.identityId);
      const clientId = clients.find((c) => c.id === s.activeClientId)?.id ?? clients[0]?.id;
      if (!on || !clientId) {
        res.json({ enabled: on, maxDays: CLIENT_SHARE_MAX_DAYS, shares: [] });
        return;
      }
      const now = ctx.now();
      const shares = await ctx.db
        .select()
        .from(schema.fileShare)
        .where(
          and(
            eq(schema.fileShare.clientId, clientId),
            eq(schema.fileShare.sentByIdentityId, s.identityId),
          ),
        )
        .orderBy(desc(schema.fileShare.createdAt))
        .limit(100);
      const items = shares.length
        ? await ctx.db
            .select({
              shareId: schema.fileShareItem.shareId,
              name: schema.files.name,
              removedAt: schema.files.removedAt,
            })
            .from(schema.fileShareItem)
            .innerJoin(schema.files, eq(schema.files.id, schema.fileShareItem.fileId))
            .where(
              inArray(
                schema.fileShareItem.shareId,
                shares.map((x) => x.id),
              ),
            )
            .orderBy(asc(schema.files.name))
        : [];
      res.json({
        enabled: true,
        maxDays: CLIENT_SHARE_MAX_DAYS,
        shares: shares.map((x) => ({
          id: x.id,
          email: x.recipientEmail,
          name: x.recipientName,
          organization: x.organization,
          canDownload: x.canDownload,
          createdAt: x.createdAt,
          expiresAt: x.expiresAt,
          opens: x.opens,
          downloads: x.downloads,
          downloadLimit: x.downloadLimit,
          status: shareStatus(x, now),
          files: items.filter((i) => i.shareId === x.id).map((i) => i.name),
        })),
      });
    }),
  );

  r.post(
    '/',
    h(async (req, res) => {
      const s = req.clientSession as ClientSession;
      if (!(await enabled(ctx))) throw new HttpError(403, 'client_links_off');
      const input = body(CreateSchema, req);
      const clients = await activeClientsOf(ctx.db, s.identityId);
      if (!clients.some((c) => c.id === input.clientId)) throw new HttpError(404, 'not_found');
      const [client] = await ctx.db
        .select()
        .from(schema.clients)
        .where(eq(schema.clients.id, input.clientId));
      if (!client) throw new HttpError(404, 'not_found');
      // Only files the firm shared with this person.
      const ids = [...new Set(input.fileIds.map((x) => x.toLowerCase()))];
      const mine = await ctx.db
        .select({ id: schema.fileVisibility.fileId })
        .from(schema.fileVisibility)
        .innerJoin(schema.files, eq(schema.files.id, schema.fileVisibility.fileId))
        .where(
          and(
            inArray(schema.fileVisibility.fileId, ids),
            eq(schema.fileVisibility.identityId, s.identityId),
            eq(schema.fileVisibility.visible, true),
            eq(schema.files.clientId, client.id),
            isNull(schema.files.removedAt),
          ),
        );
      if (mine.length !== ids.length) throw new HttpError(400, 'file_not_found');
      const who = await whoIs(ctx, s);
      const made = await createOutsideShare(ctx, {
        client,
        // Always watermarked for a client (owner 2026-11-10).
        input: { ...input, fileIds: ids, watermark: true },
        actor: who.actor,
        quota: `outside-share:client:${s.identityId}`,
        limit: LIMITS.outsideSharePerClientPerson,
        from: { identityId: s.identityId, name: who.name },
      });
      res.status(201).json(made);
    }),
  );

  r.delete(
    '/:id',
    h(async (req, res) => {
      const s = req.clientSession as ClientSession;
      const id = Uuid.safeParse(req.params['id']);
      if (!id.success) throw new HttpError(404, 'not_found');
      const [share] = await ctx.db
        .select()
        .from(schema.fileShare)
        .where(
          and(
            eq(schema.fileShare.id, id.data),
            eq(schema.fileShare.sentByIdentityId, s.identityId),
          ),
        );
      if (!share) throw new HttpError(404, 'not_found');
      const who = await whoIs(ctx, s);
      const ended = await ctx.db
        .update(schema.fileShare)
        .set({ revokedAt: ctx.now(), revokedBy: who.name })
        .where(and(eq(schema.fileShare.id, share.id), isNull(schema.fileShare.revokedAt)))
        .returning({ id: schema.fileShare.id });
      await ctx.db.delete(schema.fileShareGrant).where(eq(schema.fileShareGrant.shareId, share.id));
      await dropMarksOfShare(ctx, share.id);
      if (ended.length > 0) {
        await record(ctx.db, 'outside_share_revoked', who.actor, {
          clientId: share.clientId,
          identityId: s.identityId,
          detail: { shareId: share.id, to: share.recipientEmail, byClient: true },
        });
      }
      res.json({ ok: true });
    }),
  );

  return r;
}
