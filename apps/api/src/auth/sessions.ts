// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Client sessions in Postgres. A session lasts 7 days on a device (P11); without "Keep me signed
// in on this device" it also ends after 30 minutes idle (P12). The cookie holds a random id; the
// table keeps its sha256.

import { and, eq, gt } from 'drizzle-orm';
import { serialize, parse } from 'cookie';
import type { Request, Response } from 'express';
import { schema, type Database } from '@vibe-portal/db';

import { randomToken, sha256 } from '../lib/secrets';

export const SESSION_DAYS = 7;
export const IDLE_MINUTES = 30;
export const COOKIE_NAME = '__vibe_portal';

export interface ClientSession {
  idHash: string;
  identityId: string;
  activeClientId: string | null;
  keepSignedIn: boolean;
}

export interface CookieOptions {
  /** Mark the cookie Secure: the portal is served over https (P7's own hostname). */
  secure: boolean;
}

export async function createSession(
  db: Database,
  identityId: string,
  activeClientId: string | null,
  keepSignedIn: boolean,
  now: Date,
): Promise<string> {
  const id = randomToken();
  await db.insert(schema.sessions).values({
    idHash: sha256(id),
    kind: 'client',
    subjectId: identityId,
    activeClientId,
    keepSignedIn,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + SESSION_DAYS * 86_400_000),
  });
  return id;
}

/** The live session for a cookie value, touching its last-seen time; null if ended. */
export async function resolveSession(
  db: Database,
  id: string,
  now: Date,
): Promise<ClientSession | null> {
  const idHash = sha256(id);
  const [row] = await db
    .select()
    .from(schema.sessions)
    .where(
      and(
        eq(schema.sessions.idHash, idHash),
        eq(schema.sessions.kind, 'client'),
        gt(schema.sessions.expiresAt, now),
      ),
    );
  if (!row) return null;
  const idleFor = now.getTime() - row.lastSeenAt.getTime();
  if (!row.keepSignedIn && idleFor > IDLE_MINUTES * 60_000) {
    await db.delete(schema.sessions).where(eq(schema.sessions.idHash, idHash));
    return null;
  }
  await db
    .update(schema.sessions)
    .set({ lastSeenAt: now })
    .where(eq(schema.sessions.idHash, idHash));
  return {
    idHash,
    identityId: row.subjectId,
    activeClientId: row.activeClientId,
    keepSignedIn: row.keepSignedIn,
  };
}

export async function endSession(db: Database, idHash: string): Promise<void> {
  await db.delete(schema.sessions).where(eq(schema.sessions.idHash, idHash));
}

/** Ends every session of an identity (disabled, or access removed everywhere). */
export async function endSessionsOf(db: Database, identityId: string): Promise<void> {
  await db
    .delete(schema.sessions)
    .where(and(eq(schema.sessions.kind, 'client'), eq(schema.sessions.subjectId, identityId)));
}

export async function setActiveClient(
  db: Database,
  idHash: string,
  clientId: string,
): Promise<void> {
  await db
    .update(schema.sessions)
    .set({ activeClientId: clientId })
    .where(eq(schema.sessions.idHash, idHash));
}

export function readSessionCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  return parse(header)[COOKIE_NAME] ?? null;
}

export function writeSessionCookie(
  res: Response,
  id: string,
  keepSignedIn: boolean,
  opts: CookieOptions,
): void {
  res.append(
    'Set-Cookie',
    serialize(COOKIE_NAME, id, {
      httpOnly: true,
      sameSite: 'strict',
      secure: opts.secure,
      path: '/',
      // Without "keep me signed in" the cookie ends with the browser session too.
      ...(keepSignedIn ? { maxAge: SESSION_DAYS * 86_400 } : {}),
    }),
  );
}

export function clearSessionCookie(res: Response, opts: CookieOptions): void {
  res.append(
    'Set-Cookie',
    serialize(COOKIE_NAME, '', {
      httpOnly: true,
      sameSite: 'strict',
      secure: opts.secure,
      path: '/',
      maxAge: 0,
    }),
  );
}
