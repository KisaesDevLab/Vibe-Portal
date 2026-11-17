// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Accepting an invitation sent from Vibe Files (D5). The link came to the person's email or
// phone, so following it is proof enough: accepting signs them in. Tokens travel in the request
// body, never in a URL the server logs.
//
//   POST /api/portal/invitations/preview  { token }          -> firm, client, masked contact
//   POST /api/portal/invitations/accept   { token, name?, keepSignedIn?, addPhone? }
//
// P50: a mobile number staff typed beside the email is never stored unproved (P45). The page
// offers it masked ("also sign in by text at ***-***-1234"); when ticked, accepting texts a
// code to it, and the number is stored only when the person types the code back
// (/api/portal/account/phone/verify). The full number never reaches the browser.

import express, { type Router } from 'express';
import { and, eq, gt, inArray, isNull, ne, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@vibe-portal/db';

import { grantAccess } from '../auth/grant';
import { sendPhoneCode } from './account';
import { signIn } from '../auth/client-auth';
import { firmName, type Ctx } from '../context';
import { isUsCanadaPhone, maskContact } from '../lib/contact';
import { record } from '../lib/events';
import { body, clientIp, h, HttpError } from '../lib/http';
import { hit, LIMITS } from '../lib/rate-limit';
import { sha256 } from '../lib/secrets';

const TokenSchema = z.object({ token: z.string().min(20).max(200) });
const AcceptSchema = TokenSchema.extend({
  name: z.string().trim().max(120).optional(),
  keepSignedIn: z.boolean().optional().default(false),
  addPhone: z.boolean().optional().default(false),
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
        // A number staff typed beside the email, offered for signing in by text once proved.
        alsoPhone:
          !ctx.textsOff && inv.email && inv.phone && isUsCanadaPhone(inv.phone)
            ? maskContact(inv.phone)
            : null,
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
      const accept = () =>
        ctx.db.transaction(async (tx) => {
          const [inv] = await tx
            .update(schema.portalInvitation)
            .set({ acceptedAt: now })
            .where(live(input.token))
            .returning();
          if (!inv) return null;
          // The link went to the email when there was one, else by text: that contact is proved.
          const proved = inv.email ?? inv.phone;
          if (!proved) throw new Error('invitation without a contact');
          // P101: a link staff copied did not go to that contact, so opening it shows nothing
          // about who holds it. It may make a new account, never open one that exists (made
          // since the link was copied): the link is dead, and staff add the client on the
          // person's page. Thrown here, the invitation is not used up.
          if (inv.copied) {
            const [account] = await tx
              .select({ id: schema.portalIdentity.id })
              .from(schema.portalIdentity)
              .where(
                inv.email
                  ? eq(schema.portalIdentity.email, inv.email)
                  : eq(schema.portalIdentity.phone, proved),
              );
            if (account) throw new HttpError(404, 'invite_expired');
          }
          // Gives them the invitation's client, and the files chosen for them while it waited
          // (P98: new to them; files removed since are left out).
          const take = async (i: typeof inv): Promise<{ identityId: string; files: number }> => {
            const granted = await grantAccess(tx, {
              clientId: i.clientId,
              proved,
              name: input.name || i.name,
              roleLabel: i.roleLabel,
              by: i.invitedBy,
            });
            const chosen = await tx
              .select({ fileId: schema.invitationFile.fileId, by: schema.invitationFile.chosenBy })
              .from(schema.invitationFile)
              .innerJoin(schema.files, eq(schema.files.id, schema.invitationFile.fileId))
              .where(
                and(
                  eq(schema.invitationFile.invitationId, i.id),
                  eq(schema.files.clientId, i.clientId),
                  isNull(schema.files.removedAt),
                ),
              );
            for (const c of chosen) {
              await tx
                .insert(schema.fileVisibility)
                .values({
                  fileId: c.fileId,
                  identityId: granted.identityId,
                  visible: true,
                  changedAt: now,
                  changedBy: c.by,
                })
                .onConflictDoUpdate({
                  target: [schema.fileVisibility.fileId, schema.fileVisibility.identityId],
                  set: { visible: true, changedAt: now, changedBy: c.by, viewedAt: null },
                });
            }
            await tx
              .delete(schema.invitationFile)
              .where(eq(schema.invitationFile.invitationId, i.id));
            return { identityId: granted.identityId, files: chosen.length };
          };
          const first = await take(inv);
          // A copied link takes nothing else with it: staff copied a link to one client.
          if (inv.copied) {
            return { inv, identityId: first.identityId, files: first.files, more: [] };
          }
          // P100: staff may have invited the same person to more clients (the People page's
          // Add a client for someone invited). The contact this link went to is proved, and the
          // others went to that same contact: every one of them still waiting, not expired and
          // for a client that is on is accepted with it, so one acceptance is enough.
          const others = await tx
            .update(schema.portalInvitation)
            .set({ acceptedAt: now })
            .where(
              and(
                ne(schema.portalInvitation.id, inv.id),
                // Not a client they see already (by a request approved, another invitation):
                // an older invitation to it changes nothing of that access.
                notInArray(
                  schema.portalInvitation.clientId,
                  tx
                    .select({ id: schema.clientAccess.clientId })
                    .from(schema.clientAccess)
                    .where(
                      and(
                        eq(schema.clientAccess.identityId, first.identityId),
                        eq(schema.clientAccess.active, true),
                        ne(schema.clientAccess.clientId, inv.clientId),
                      ),
                    ),
                ),
                isNull(schema.portalInvitation.acceptedAt),
                isNull(schema.portalInvitation.revokedAt),
                gt(schema.portalInvitation.expiresAt, now),
                inv.email
                  ? eq(schema.portalInvitation.email, inv.email)
                  : and(
                      isNull(schema.portalInvitation.email),
                      eq(schema.portalInvitation.phone, proved),
                    ),
                inArray(
                  schema.portalInvitation.clientId,
                  tx
                    .select({ id: schema.clients.id })
                    .from(schema.clients)
                    .where(eq(schema.clients.active, true)),
                ),
              ),
            )
            .returning();
          const more: { inv: typeof inv; files: number }[] = [];
          for (const o of others) more.push({ inv: o, files: (await take(o)).files });
          return { inv, identityId: first.identityId, files: first.files, more };
        });
      // Two of the person's links opened at the same moment each hold their own invitation and
      // want the other's: the database stops one of them (40P01), which is simply tried again
      // and then finds its invitation accepted.
      let accepted;
      try {
        accepted = await accept();
      } catch (err) {
        if ((err as { code?: string }).code !== '40P01') throw err;
        accepted = await accept();
      }
      if (!accepted) throw new HttpError(404, 'invite_expired');
      const { inv, identityId } = accepted;
      await record(
        ctx.db,
        'invite_accepted',
        { kind: 'client', name: identityId },
        {
          clientId: inv.clientId,
          identityId,
          detail: { invitationId: inv.id, ...(accepted.files ? { files: accepted.files } : {}) },
        },
      );
      for (const m of accepted.more) {
        await record(
          ctx.db,
          'invite_accepted',
          { kind: 'client', name: identityId },
          {
            clientId: m.inv.clientId,
            identityId,
            detail: {
              invitationId: m.inv.id,
              // Accepted with the invitation whose link was opened.
              with: inv.id,
              ...(m.files ? { files: m.files } : {}),
            },
          },
        );
      }
      await signIn(ctx, res, identityId, input.keepSignedIn);
      // Also sign in by text: a code to the number staff typed, unless the account has one.
      let phoneCode: string | null = null;
      if (input.addPhone && inv.email && inv.phone) {
        const [who] = await ctx.db
          .select({ phone: schema.portalIdentity.phone })
          .from(schema.portalIdentity)
          .where(eq(schema.portalIdentity.id, identityId));
        if (!who?.phone) {
          try {
            await sendPhoneCode(ctx, identityId, inv.phone);
            phoneCode = 'sent';
          } catch (err) {
            // The invitation is accepted either way; the page says why no code came.
            if (!(err instanceof HttpError)) throw err;
            phoneCode = err.code;
          }
        }
      }
      res.json({
        ok: true,
        ...(phoneCode && { phoneCode, phone: maskContact(inv.phone ?? '') }),
      });
    }),
  );

  return r;
}
