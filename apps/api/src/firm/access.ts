// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Taking access away, shared by a client's People list and a person's page (P66).

import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { schema } from '@vibe-portal/db';

import { voidChallenges } from '../auth/client-auth';
import { endSessionsOf } from '../auth/sessions';
import type { Ctx } from '../context';

/** Withdraws pending invitations: a client's (all, or those to some contacts), or with
 *  `clientId` null those to the contacts on every client. */
export async function withdrawInvites(
  ctx: Ctx,
  clientId: string | null,
  to?: (string | null)[],
): Promise<{ id: string }[]> {
  const contacts = (to ?? []).filter((c): c is string => !!c);
  if (to && contacts.length === 0) return [];
  // Never every invitation on the portal.
  if (!clientId && !to) throw new Error('withdrawInvites: a client or contacts');
  return ctx.db
    .update(schema.portalInvitation)
    .set({ revokedAt: ctx.now() })
    .where(
      and(
        clientId ? eq(schema.portalInvitation.clientId, clientId) : undefined,
        isNull(schema.portalInvitation.acceptedAt),
        isNull(schema.portalInvitation.revokedAt),
        to
          ? clientId
            ? or(
                inArray(schema.portalInvitation.email, contacts),
                inArray(schema.portalInvitation.phone, contacts),
              )
            : // Across clients (P66): only invitations whose link went to these contacts (the
              // email, else the phone), not a number typed beside someone else's email.
              or(
                inArray(schema.portalInvitation.email, contacts),
                and(
                  isNull(schema.portalInvitation.email),
                  inArray(schema.portalInvitation.phone, contacts),
                ),
              )
          : undefined,
      ),
    )
    .returning({ id: schema.portalInvitation.id });
}

/** The person's email and phone (either may be null). */
export async function contactsOf(ctx: Ctx, identityId: string): Promise<(string | null)[]> {
  const [who] = await ctx.db
    .select({ email: schema.portalIdentity.email, phone: schema.portalIdentity.phone })
    .from(schema.portalIdentity)
    .where(eq(schema.portalIdentity.id, identityId));
  return [who?.email ?? null, who?.phone ?? null];
}

/**
 * Sets a person's access to one client on or off. Off ends their sessions and unused sign-in
 * secrets at once (they can sign in again to their other clients), and withdraws a waiting
 * invitation to this client that would quietly turn them back on (QA 2026-11-09).
 * False when they had no access to the client.
 */
export async function setAccess(
  ctx: Ctx,
  clientId: string,
  identityId: string,
  active: boolean,
): Promise<boolean> {
  const rows = await ctx.db
    .update(schema.clientAccess)
    .set({ active })
    .where(
      and(
        eq(schema.clientAccess.clientId, clientId),
        eq(schema.clientAccess.identityId, identityId),
      ),
    )
    .returning({ id: schema.clientAccess.identityId });
  if (!rows.length) return false;
  if (!active) {
    await endSessionsOf(ctx.db, identityId);
    await voidChallenges(ctx, identityId, { keepContactChange: true });
    await withdrawInvites(ctx, clientId, await contactsOf(ctx, identityId));
  }
  return true;
}
