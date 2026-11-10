// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Accepting an invitation sent from Vibe Files (D5). The link came to the person's email or
// phone, so following it is proof enough: accepting signs them in. Tokens travel in the request
// body, never in a URL the server logs.
//
//   POST /api/portal/invitations/preview  { token }          -> firm, client, masked contact
//   POST /api/portal/invitations/accept   { token, name?, keepSignedIn? }

import express, { type Router } from 'express';
import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@vibe-portal/db';

import { grantAccess } from '../auth/grant';
import { signIn } from '../auth/client-auth';
import { firmName, type Ctx } from '../context';
import { maskContact } from '../lib/contact';
import { record } from '../lib/events';
import { body, clientIp, h, HttpError } from '../lib/http';
import { hit, LIMITS } from '../lib/rate-limit';
import { sha256 } from '../lib/secrets';

const TokenSchema = z.object({ token: z.string().min(20).max(200) });
const AcceptSchema = TokenSchema.extend({
  name: z.string().trim().max(120).optional(),
  keepSignedIn: z.boolean().optional().default(false),
});

export function invitationsRouter(ctx: Ctx): Router {
  const r = express.Router();

  // Live: not used, not withdrawn, not expired, and for a client that is still active.
  const live = (token: string) =>
    and(
      eq(schema.portalInvitation.tokenHash, sha256(token)),
      isNull(schema.portalInvitation.acceptedAt),
      isNull(schema.portalInvitation.revokedAt),
      gt(schema.portalInvitation.expiresAt, ctx.now()),
      inArray(
        schema.portalInvitation.clientId,
        ctx.db
          .select({ id: schema.clients.id })
          .from(schema.clients)
          .where(eq(schema.clients.active, true)),
      ),
    );

  r.post(
    '/preview',
    h(async (req, res) => {
      const { token } = body(TokenSchema, req);
      if (!(await hit(ctx.db, `verify:ip:${clientIp(req)}`, LIMITS.verifyPerIp, ctx.now()))) {
        throw new HttpError(429, 'too_many_requests');
      }
      const [inv] = await ctx.db
        .select({
          name: schema.portalInvitation.name,
          email: schema.portalInvitation.email,
          phone: schema.portalInvitation.phone,
          client: schema.clients.displayName,
        })
        .from(schema.portalInvitation)
        .innerJoin(schema.clients, eq(schema.clients.id, schema.portalInvitation.clientId))
        .where(live(token));
      if (!inv) throw new HttpError(404, 'invite_expired');
      res.json({
        firmName: await firmName(ctx),
        clientName: inv.client,
        name: inv.name,
        contact: maskContact(inv.email ?? inv.phone ?? ''),
      });
    }),
  );

  r.post(
    '/accept',
    h(async (req, res) => {
      const input = body(AcceptSchema, req);
      const now = ctx.now();
      if (!(await hit(ctx.db, `verify:ip:${clientIp(req)}`, LIMITS.verifyPerIp, now))) {
        throw new HttpError(429, 'too_many_requests');
      }
      // One transaction: if granting fails, the invitation is not used up.
      const accepted = await ctx.db.transaction(async (tx) => {
        const [inv] = await tx
          .update(schema.portalInvitation)
          .set({ acceptedAt: now })
          .where(live(input.token))
          .returning();
        if (!inv) return null;
        // The link went to the email when there was one, else by text: that contact is proved.
        const proved = inv.email ?? inv.phone;
        if (!proved) throw new Error('invitation without a contact');
        const granted = await grantAccess(tx, {
          clientId: inv.clientId,
          proved,
          other: inv.email ? inv.phone : null,
          name: input.name || inv.name,
          roleLabel: inv.roleLabel,
          by: inv.invitedBy,
        });
        return { inv, identityId: granted.identityId };
      });
      if (!accepted) throw new HttpError(404, 'invite_expired');
      const { inv, identityId } = accepted;
      await record(
        ctx.db,
        'invite_accepted',
        { kind: 'client', name: identityId },
        { clientId: inv.clientId, identityId, detail: { invitationId: inv.id } },
      );
      await signIn(ctx, res, identityId, input.keepSignedIn);
      res.json({ ok: true });
    }),
  );

  return r;
}
