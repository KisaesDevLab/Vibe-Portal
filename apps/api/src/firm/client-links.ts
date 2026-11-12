// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P76: each client's link from another service (its own URL), with a short message and a
// button, shown at the top of the client's portal. Any staff member, for the clients they see
// (owner 2026-11-11); set one client at a time, or many from a CSV, and change or remove any.
//
//   GET    /api/staff/v1/client-links                    the links of the caller's clients
//   POST   /api/staff/v1/client-links/import             { csv, apply } -> what each row does
//   GET    /api/staff/v1/clients/:id/link
//   PUT    /api/staff/v1/clients/:id/link                { url, message, button? }
//   DELETE /api/staff/v1/clients/:id/link
//
// The CSV has a header row. Each row names its client by client code (as Vibe Files sends it)
// or, when the code matches none, by name; a row matching no client or several is reported,
// never guessed. A row overwrites the client's link; a row with no URL removes it. The import
// answers what each row would do; only `apply: true` changes anything. Only http and https
// links are taken: a link is put in a page, and another kind (javascript:) would run there.

import express, { type Request, type Router } from 'express';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@vibe-portal/db';

import type { Ctx } from '../context';
import { record, type Actor } from '../lib/events';
import { body, h, HttpError } from '../lib/http';
import { inScope } from '../staff/scope';

export const LINK_LIMITS = { url: 2000, message: 300, button: 40, rows: 5000 } as const;
export const DEFAULT_BUTTON = 'Open';

const Uuid = z.string().uuid();
const LinkSchema = z.object({
  url: z.string().max(LINK_LIMITS.url + 100),
  message: z.string().max(LINK_LIMITS.message + 100),
  button: z
    .string()
    .max(LINK_LIMITS.button + 100)
    .optional(),
});
const ImportSchema = z.object({
  csv: z.string().max(2_100_000),
  apply: z.boolean().default(false),
});

export interface Link {
  url: string;
  message: string;
  button: string;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_OR_SPACE = /[\u0000-\u001f\u007f]/g;

/** A cell from a spreadsheet: a leading ' that keeps =, +, - or @ from being a formula is
 *  dropped (the staff page's download writes it so). */
export const unguard = (v: string): string => (/^'[=+\-@]/.test(v) ? v.slice(1) : v);

/** A link as stored, or what is wrong with it. */
export function checkLink(input: {
  url: string;
  message: string;
  button?: string | undefined;
}): Link | { error: 'invalid_url' | 'invalid_message' | 'invalid_button' } {
  const url = input.url.trim();
  let parsed: URL | null = null;
  try {
    // Written out in full (https://...): URL() also takes forms like https:x.test, which a page
    // reads as a path on the portal itself. No control characters (Postgres refuses NUL).
    parsed = /^https?:\/\/[^\s]/i.test(url) && !CONTROL.test(url) ? new URL(url) : null;
  } catch {
    parsed = null;
  }
  if (
    !parsed ||
    parsed.href.length > LINK_LIMITS.url ||
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username ||
    parsed.password
  ) {
    return { error: 'invalid_url' };
  }
  const message = input.message.replace(CONTROL_OR_SPACE, ' ').replace(/\s+/g, ' ').trim();
  if (!message || message.length > LINK_LIMITS.message) return { error: 'invalid_message' };
  const button =
    (input.button ?? '').replace(CONTROL_OR_SPACE, ' ').replace(/\s+/g, ' ').trim() ||
    DEFAULT_BUTTON;
  if (button.length > LINK_LIMITS.button) return { error: 'invalid_button' };
  return { url: parsed.href, message, button };
}

/** RFC 4180 CSV: quoted fields with "" for a quote, commas and line breaks inside quotes. A
 *  quote inside an unquoted field (5" binder) is just a quote. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const COLUMN: Record<string, 'code' | 'name' | 'url' | 'message' | 'button'> = {
  clientcode: 'code',
  code: 'code',
  clientname: 'name',
  name: 'name',
  client: 'name',
  url: 'url',
  link: 'url',
  message: 'message',
  button: 'button',
  buttontext: 'button',
};

export type RowStatus =
  | 'new'
  | 'changed'
  | 'unchanged'
  | 'removed'
  | 'no_link'
  | 'not_found'
  | 'ambiguous'
  | 'duplicate'
  | 'invalid';

export interface RowResult {
  /** The row's number in the file (the header is row 1), as a spreadsheet numbers it. */
  line: number;
  status: RowStatus;
  clientId?: string;
  client?: string;
  clientCode?: string;
  /** What the row names its client by, when it matches none or several. */
  asked?: string;
  reason?: string;
}

function actorOf(req: Request): Actor {
  return req.firmActor ?? { kind: 'firm_key', name: 'Vibe Files' };
}

export function staffClientLinksRouter(ctx: Ctx): Router {
  const r = express.Router();

  const linkOf = async (clientId: string): Promise<Link | null> => {
    const [row] = await ctx.db
      .select({
        url: schema.clientLink.url,
        message: schema.clientLink.message,
        button: schema.clientLink.button,
      })
      .from(schema.clientLink)
      .where(eq(schema.clientLink.clientId, clientId));
    return row ?? null;
  };

  const clientId = (req: Request): string => {
    const v = Uuid.safeParse(req.params['id']);
    if (!v.success) throw new HttpError(404, 'client_not_found');
    return v.data;
  };

  r.get(
    '/client-links',
    h(async (req, res) => {
      const links = await ctx.db
        .select({
          clientId: schema.clients.id,
          clientCode: schema.clients.clientCode,
          client: schema.clients.displayName,
          url: schema.clientLink.url,
          message: schema.clientLink.message,
          button: schema.clientLink.button,
          updatedAt: schema.clientLink.updatedAt,
          updatedBy: schema.clientLink.updatedBy,
        })
        .from(schema.clientLink)
        .innerJoin(schema.clients, eq(schema.clients.id, schema.clientLink.clientId))
        .where(inScope(req, schema.clients.id))
        .orderBy(asc(schema.clients.displayName));
      res.json({ links });
    }),
  );

  r.post(
    '/client-links/import',
    h(async (req, res) => {
      const input = body(ImportSchema, req);
      // Each row with its number in the file (the header is row 1), blank rows left out.
      const table = parseCsv(input.csv)
        .map((row, i) => ({ row, line: i + 1 }))
        .filter(({ row }) => row.some((v) => v.trim() !== ''));
      const header = (table[0]?.row ?? []).map(
        (h) => COLUMN[h.toLowerCase().replace(/[^a-z]/g, '')],
      );
      if (!header.includes('url') || !(header.includes('code') || header.includes('name'))) {
        throw new HttpError(400, 'csv_columns');
      }
      if (table.length - 1 > LINK_LIMITS.rows) throw new HttpError(400, 'csv_too_long');
      const col = (row: string[], name: string): string => {
        const i = header.indexOf(name as never);
        return i < 0 ? '' : unguard((row[i] ?? '').trim());
      };

      const clients = await ctx.db
        .select({
          id: schema.clients.id,
          code: schema.clients.clientCode,
          name: schema.clients.displayName,
        })
        .from(schema.clients)
        .where(inScope(req, schema.clients.id));
      const byCode = new Map<string, typeof clients>();
      const byName = new Map<string, typeof clients>();
      const key = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();
      for (const c of clients) {
        if (c.code.trim()) byCode.set(key(c.code), [...(byCode.get(key(c.code)) ?? []), c]);
        byName.set(key(c.name), [...(byName.get(key(c.name)) ?? []), c]);
      }
      const existing = new Map(
        (
          await ctx.db
            .select({
              clientId: schema.clientLink.clientId,
              url: schema.clientLink.url,
              message: schema.clientLink.message,
              button: schema.clientLink.button,
            })
            .from(schema.clientLink)
            .where(inScope(req, schema.clientLink.clientId))
        ).map((l) => [l.clientId, l]),
      );

      const results: RowResult[] = [];
      const changes: { clientId: string; link: Link | null }[] = [];
      const seen = new Set<string>();
      for (const { row, line } of table.slice(1)) {
        const code = col(row, 'code');
        const name = col(row, 'name');
        let found = code ? (byCode.get(key(code)) ?? []) : [];
        // A code shared by several clients is settled by the name, when the row has one.
        if (found.length > 1 && name) found = found.filter((c) => key(c.name) === key(name));
        else if (found.length === 0 && name) found = byName.get(key(name)) ?? [];
        const asked = code || name;
        if (found.length === 0) {
          results.push({ line, status: 'not_found', asked });
          continue;
        }
        if (found.length > 1) {
          results.push({ line, status: 'ambiguous', asked });
          continue;
        }
        const c = found[0] as (typeof clients)[number];
        const about = { line, clientId: c.id, client: c.name, clientCode: c.code };
        if (seen.has(c.id)) {
          results.push({ ...about, status: 'duplicate' });
          continue;
        }
        seen.add(c.id);
        const had = existing.get(c.id);
        const url = col(row, 'url');
        if (!url) {
          results.push({ ...about, status: had ? 'removed' : 'no_link' });
          if (had) changes.push({ clientId: c.id, link: null });
          continue;
        }
        const link = checkLink({ url, message: col(row, 'message'), button: col(row, 'button') });
        if ('error' in link) {
          results.push({ ...about, status: 'invalid', reason: link.error });
          continue;
        }
        const same =
          had && had.url === link.url && had.message === link.message && had.button === link.button;
        results.push({ ...about, status: same ? 'unchanged' : had ? 'changed' : 'new' });
        if (!same) changes.push({ clientId: c.id, link });
      }

      if (input.apply && changes.length > 0) {
        const actor = actorOf(req);
        const now = ctx.now();
        await ctx.db.transaction(async (tx) => {
          for (const ch of changes) {
            if (ch.link) {
              await tx
                .insert(schema.clientLink)
                .values({
                  clientId: ch.clientId,
                  ...ch.link,
                  updatedAt: now,
                  updatedBy: actor.name,
                })
                .onConflictDoUpdate({
                  target: schema.clientLink.clientId,
                  set: { ...ch.link, updatedAt: now, updatedBy: actor.name },
                });
              await record(tx, 'client_link_set', actor, {
                clientId: ch.clientId,
                detail: { url: ch.link.url, via: 'csv' },
              });
            } else {
              await tx.delete(schema.clientLink).where(eq(schema.clientLink.clientId, ch.clientId));
              await record(tx, 'client_link_removed', actor, {
                clientId: ch.clientId,
                detail: { via: 'csv' },
              });
            }
          }
        });
      }
      res.json({ applied: input.apply, changes: changes.length, rows: results });
    }),
  );

  r.get(
    '/clients/:id/link',
    h(async (req, res) => {
      res.json({ link: await linkOf(clientId(req)) });
    }),
  );

  r.put(
    '/clients/:id/link',
    h(async (req, res) => {
      const id = clientId(req);
      const link = checkLink(body(LinkSchema, req));
      if ('error' in link) throw new HttpError(400, link.error);
      const [c] = await ctx.db
        .select({ id: schema.clients.id })
        .from(schema.clients)
        .where(eq(schema.clients.id, id));
      if (!c) throw new HttpError(404, 'client_not_found');
      const actor = actorOf(req);
      const now = ctx.now();
      await ctx.db
        .insert(schema.clientLink)
        .values({ clientId: id, ...link, updatedAt: now, updatedBy: actor.name })
        .onConflictDoUpdate({
          target: schema.clientLink.clientId,
          set: { ...link, updatedAt: now, updatedBy: actor.name },
        });
      await record(ctx.db, 'client_link_set', actor, { clientId: id, detail: { url: link.url } });
      res.json({ link });
    }),
  );

  r.delete(
    '/clients/:id/link',
    h(async (req, res) => {
      const id = clientId(req);
      const gone = await ctx.db
        .delete(schema.clientLink)
        .where(eq(schema.clientLink.clientId, id))
        .returning({ id: schema.clientLink.clientId });
      if (gone.length > 0) {
        await record(ctx.db, 'client_link_removed', actorOf(req), { clientId: id });
      }
      res.json({ ok: true });
    }),
  );

  return r;
}
