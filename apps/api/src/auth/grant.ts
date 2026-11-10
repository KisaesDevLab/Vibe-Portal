// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Gives a person access to a client: finds their portal identity by email, then phone (or
// creates one), and makes their access to the client active. Used when an invitation is
// accepted and when staff approve an access request. (Same job as Vibe-Time-Billing
// apps/api/src/portal-invites/grant.ts, over this repo's tables.)

import { and, eq, ne } from 'drizzle-orm';
import { schema, type Database } from '@vibe-portal/db';

export interface GrantArgs {
  clientId: string;
  email: string | null;
  phone: string | null;
  name: string;
  roleLabel: string;
  by: string;
}

/** The database or a transaction on it. */
export type Executor = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

export async function grantAccess(
  db: Executor,
  args: GrantArgs,
): Promise<{ identityId: string; created: boolean }> {
  const byEmail = args.email
    ? (
        await db
          .select()
          .from(schema.portalIdentity)
          .where(eq(schema.portalIdentity.email, args.email))
      )[0]
    : undefined;
  const byPhone =
    !byEmail && args.phone
      ? (
          await db
            .select()
            .from(schema.portalIdentity)
            .where(eq(schema.portalIdentity.phone, args.phone))
        )[0]
      : undefined;
  const found = byEmail ?? byPhone;

  let identityId: string;
  let created = false;
  if (found) {
    identityId = found.id;
    // Fill in what the identity lacks, unless another identity already uses it.
    const patch: Partial<typeof schema.portalIdentity.$inferInsert> = {};
    if (!found.name && args.name) patch.name = args.name;
    if (!found.email && args.email && !(await taken(db, 'email', args.email, identityId))) {
      patch.email = args.email;
    }
    if (!found.phone && args.phone && !(await taken(db, 'phone', args.phone, identityId))) {
      patch.phone = args.phone;
    }
    if (Object.keys(patch).length) {
      await db
        .update(schema.portalIdentity)
        .set(patch)
        .where(eq(schema.portalIdentity.id, identityId));
    }
  } else {
    const [row] = await db
      .insert(schema.portalIdentity)
      .values({
        email: args.email,
        phone: args.phone,
        name: args.name,
        notify: args.email ? 'email' : 'sms',
      })
      .returning({ id: schema.portalIdentity.id });
    if (!row) throw new Error('identity insert returned nothing');
    identityId = row.id;
    created = true;
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

/** The clients an identity can sign in to: active access to an active client. */
export async function activeClientsOf(
  db: Database,
  identityId: string,
): Promise<{ id: string; displayName: string }[]> {
  return db
    .select({ id: schema.clients.id, displayName: schema.clients.displayName })
    .from(schema.clientAccess)
    .innerJoin(schema.clients, eq(schema.clients.id, schema.clientAccess.clientId))
    .where(
      and(
        eq(schema.clientAccess.identityId, identityId),
        eq(schema.clientAccess.active, true),
        eq(schema.clients.active, true),
      ),
    )
    .orderBy(schema.clients.displayName);
}
