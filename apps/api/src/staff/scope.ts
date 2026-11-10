// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Who may see which clients (P48). Vibe Files (the firm key) and most staff see every client; an
// admin can limit a staff member to some. A client outside a limited member's list answers as
// if it were not there. Admins alone use Settings.

import type { Request, RequestHandler } from 'express';
import { inArray, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

import { HttpError } from '../lib/http';

/** The clients the caller may see; null means every client. */
export function clientScope(req: Request): string[] | null {
  return req.staff?.clientIds ?? null;
}

/** Refuses a client outside the caller's list, as not found. */
export function mustSee(req: Request, clientId: string, error = 'not_found'): void {
  const scope = clientScope(req);
  if (scope && !scope.includes(clientId.toLowerCase())) throw new HttpError(404, error);
}

/** A condition keeping a query to the caller's clients; nothing to add when they see all. */
export function inScope(req: Request, clientId: PgColumn): SQL | undefined {
  const scope = clientScope(req);
  if (!scope) return undefined;
  return scope.length ? inArray(clientId, scope) : sql`false`;
}

/** Settings are for admins. */
export const requireAdmin: RequestHandler = (req, _res, next) => {
  next(req.staff?.admin ? undefined : new HttpError(403, 'admins_only'));
};

/** Work that is not about one client (access requests) is for staff who see every client. */
export const requireAllClients: RequestHandler = (req, _res, next) => {
  next(clientScope(req) ? new HttpError(403, 'all_clients_only') : undefined);
};
