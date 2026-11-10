// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// The firm key Vibe Files uses (D7): one for the firm, pasted on every PC (P14). Only its hash is
// stored. Rotating = create a new key, paste it everywhere, revoke the old one. Each call also
// names the PC and Windows user (X-Vibe-PC, X-Vibe-User), which go into the event history (P15).

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '@vibe-portal/db';

import type { Ctx } from '../context';
import { record, type Actor } from '../lib/events';
import { clientIp, h, HttpError } from '../lib/http';
import { hit, isBlocked, LIMITS } from '../lib/rate-limit';
import { randomToken, sha256 } from '../lib/secrets';

export const KEY_PREFIX = 'vpk_';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      firmActor?: Actor;
    }
  }
}

export async function createFirmKey(
  db: Database,
  label: string,
): Promise<{ id: string; key: string }> {
  const key = `${KEY_PREFIX}${randomToken(32)}`;
  const [row] = await db
    .insert(schema.firmKeys)
    .values({ label, keyHash: sha256(key) })
    .returning({ id: schema.firmKeys.id });
  if (!row) throw new Error('firm key insert returned nothing');
  await record(
    db,
    'firm_key_created',
    { kind: 'system', name: 'admin' },
    {
      detail: { keyId: row.id, label },
    },
  );
  return { id: row.id, key };
}

export async function revokeFirmKey(db: Database, id: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(schema.firmKeys)
    .set({ revokedAt: now })
    .where(and(eq(schema.firmKeys.id, id), isNull(schema.firmKeys.revokedAt)))
    .returning({ id: schema.firmKeys.id });
  if (rows.length) {
    await record(
      db,
      'firm_key_revoked',
      { kind: 'system', name: 'admin' },
      {
        detail: { keyId: id },
      },
    );
  }
  return rows.length > 0;
}

/** A header value fit for the history: printable, at most 64 characters. */
function clean(v: string | undefined): string {
  return (v ?? '')
    .replace(/[^\x20-\x7e]/g, '')
    .trim()
    .slice(0, 64);
}

/** Requires a live firm key; sets req.firmActor to "PC\user". */
export function requireFirmKey(ctx: Ctx): RequestHandler {
  return h(async (req: Request, res: Response, next: NextFunction) => {
    const now = ctx.now();
    const auth = req.header('authorization') ?? '';
    const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const [row] = key.startsWith(KEY_PREFIX)
      ? await ctx.db
          .select({ id: schema.firmKeys.id })
          .from(schema.firmKeys)
          .where(and(eq(schema.firmKeys.keyHash, sha256(key)), isNull(schema.firmKeys.revokedAt)))
      : [];
    if (!row) {
      // Only failures count, and a right key is never blocked: someone else's bad tries from the
      // same address cannot lock Vibe Files out (QA 2026-11-09).
      const bucket = `badkey:ip:${clientIp(req)}`;
      if (await isBlocked(ctx.db, bucket, LIMITS.badKeyPerIp, now)) {
        throw new HttpError(429, 'too_many_requests');
      }
      await hit(ctx.db, bucket, LIMITS.badKeyPerIp, now);
      res.setHeader('WWW-Authenticate', 'Bearer');
      throw new HttpError(401, 'bad_firm_key');
    }
    await ctx.db
      .update(schema.firmKeys)
      .set({ lastUsedAt: now })
      .where(eq(schema.firmKeys.id, row.id));
    const pc = clean(req.header('x-vibe-pc'));
    const user = clean(req.header('x-vibe-user'));
    req.firmActor = {
      kind: 'firm_key',
      name: pc || user ? `${pc || '?'}\\${user || '?'}` : 'Vibe Files',
    };
    next();
  });
}
