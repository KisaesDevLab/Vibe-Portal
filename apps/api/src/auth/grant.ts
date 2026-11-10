// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Gives a person access to a client: finds their portal identity by the contact they PROVED
// (the email or phone the invitation link or the confirmation code went to), or creates one, and
// makes their access to the client active. Used when an invitation is accepted and when staff
// approve an access request. (Same job as Vibe-Time-Billing
// apps/api/src/portal-invites/grant.ts, over this repo's tables.)
//
// QA 2026-11-09: an identity is never matched by a contact that was not proved, or someone who
// knows another person's phone could take over their account. A second, unproved contact (only
// from an invitation, where staff typed it) is stored only on an identity that lacks one, and
// only when no other identity has it.

import { and, eq, ne } from 'drizzle-orm';
import { schema, type Database } from '@vibe-portal/db';

/** The database or a transaction on it. */
export type Executor = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

export interface GrantArgs {
  clientId: string;
  /** The normalised email or E.164 phone the person proved they receive. */
  proved: string;
  /** A second contact staff typed (invitations only); never used to match. */
  other: string | null;
  name: string;
  roleLabel: string;
  by: string;
}

const isEmail = (c: string): boolean => c.includes('@');

export async function grantAccess(
  db: Executor,
  args: GrantArgs,
): Promise<{ identityId: string; created: boolean }> {
  const provedField = isEmail(args.proved) ? 'email' : 'phone';
  const col = schema.portalIdentity[provedField];
  const find = async () =>
    (await db.select().from(schema.portalIdentity).where(eq(col, args.proved)))[0];

  let found = await find();
  let created = false;
  if (!found) {
    // Race-safe: two acceptances for the same new contact end with one identity.
    const inserted = await db
      .insert(schema.portalIdentity)
      .values({
        [provedField]: args.proved,
        name: args.name,
        notify: provedField === 'email' ? 'email' : 'sms',
      })
      .onConflictDoNothing()
      .returning({ id: schema.portalIdentity.id });
    created = inserted.length > 0;
    found = await find();
    if (!found) throw new Error('identity vanished after insert');
  }
  const identityId = found.id;

  const patch: Partial<typeof schema.portalIdentity.$inferInsert> = {};
  if (!found.name && args.name) patch.name = args.name;
  if (args.other && args.other !== args.proved) {
    const otherField = isEmail(args.other) ? 'email' : 'phone';
    if (otherField !== provedField && !found[otherField]) {
      if (!(await taken(db, otherField, args.other, identityId))) patch[otherField] = args.other;
    }
  }
  if (Object.keys(patch).length) {
    await db
      .update(schema.portalIdentity)
      .set(patch)
      .where(eq(schema.portalIdentity.id, identityId));
  }

  await db
    .insert(schema.clientAccess)
    .values({
      identityId,
      clientId: args.clientId,
      roleLabel: args.roleLabel,
      active: true,
      invitedBy: args.by,
    })
    .onConflictDoUpdate({
      target: [schema.clientAccess.identityId, schema.clientAccess.clientId],
      set: { active: true, roleLabel: args.roleLabel, invitedBy: args.by },
    });
  return { identityId, created };
}

async function taken(
  db: Executor,
  field: 'email' | 'phone',
  value: string,
  except: string,
): Promise<boolean> {
  const col = schema.portalIdentity[field];
  const rows = await db
    .select({ id: schema.portalIdentity.id })
    .from(schema.portalIdentity)
    .where(and(eq(col, value), ne(schema.portalIdentity.id, except)));
  return rows.length > 0;
}

/** The clients an identity can sign in to: an active identity with active access to an active client. */
export async function activeClientsOf(
  db: Executor,
  identityId: string,
): Promise<{ id: string; displayName: string }[]> {
  return db
    .select({ id: schema.clients.id, displayName: schema.clients.displayName })
    .from(schema.clientAccess)
    .innerJoin(schema.clients, eq(schema.clients.id, schema.clientAccess.clientId))
    .innerJoin(schema.portalIdentity, eq(schema.portalIdentity.id, schema.clientAccess.identityId))
    .where(
      and(
        eq(schema.clientAccess.identityId, identityId),
        eq(schema.clientAccess.active, true),
        eq(schema.clients.active, true),
        eq(schema.portalIdentity.status, 'active'),
      ),
    )
    .orderBy(schema.clients.displayName);
}
