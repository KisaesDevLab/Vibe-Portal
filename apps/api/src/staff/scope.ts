// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Who may see which clients (P48). Vibe Files (the firm key) and most staff see every client; an
// admin can limit a staff member to some. A client outside a limited member's list answers as
// if it were not there. Admins alone use Settings.
//
// A limited member's list is read by the database where it is used (a subquery, or one row
// looked up), never loaded whole: it can hold every client the firm has.

import type { Request, RequestHandler } from 'express';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { schema, type Database } from '@vibe-portal/db';

import { HttpError } from '../lib/http';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The staff member whose list limits the caller; null when they see every client. */
function limitedTo(req: Request): string | null {
  return req.staff?.limited ? req.staff.staffId : null;
}

/** Refuses a client outside the caller's list, as not found. */
export async function mustSee(
  db: Database,
  req: Request,
  clientId: string,
  error = 'not_found',
): Promise<void> {
  const staffId = limitedTo(req);
  if (!staffId) return;
  if (!UUID.test(clientId)) throw new HttpError(404, error);
  const [row] = await db
    .select({ id: schema.staffClient.clientId })
    .from(schema.staffClient)
    .where(
      and(
        eq(schema.staffClient.staffId, staffId),
        eq(schema.staffClient.clientId, clientId.toLowerCase()),
      ),
    );
  if (!row) throw new HttpError(404, error);
}

/** A condition keeping a query to the caller's clients; nothing to add when they see all. */
export function inScope(req: Request, clientId: PgColumn): SQL | undefined {
  const staffId = limitedTo(req);
  if (!staffId) return undefined;
  return sql`${clientId} IN (SELECT ${schema.staffClient.clientId} FROM ${schema.staffClient} WHERE ${schema.staffClient.staffId} = ${staffId})`;
}

/** Settings are for admins. */
export const requireAdmin: RequestHandler = (req, _res, next) => {
  next(req.staff?.admin ? undefined : new HttpError(403, 'admins_only'));
};

/** Work that is not about one client (access requests) is for staff who see every client. */
export const requireAllClients: RequestHandler = (req, _res, next) => {
  next(limitedTo(req) ? new HttpError(403, 'all_clients_only') : undefined);
};
