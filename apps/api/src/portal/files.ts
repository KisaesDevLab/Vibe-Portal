// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// The client's files (Phase 3). A person sees a file only while it is shown to them (D8), they
// have active access to its client, and it is still on the portal. Checked on every request.
//
//   GET /api/portal/files?year=&q=            files for the active client, newest first (P19)
//   GET /api/portal/files/:id/content?mode=view|download
//
// "view" opens PDFs and JPG/PNG in the browser (P22); anything else, and "download", is sent as
// a download. Opening or downloading marks the file as no longer new for that person (P21).

import express, { type Router } from 'express';
import { and, desc, eq, ilike, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@vibe-portal/db';

import { requireClient } from '../auth/client-auth';
import { activeClientsOf } from '../auth/grant';
import type { ClientSession } from '../auth/sessions';
import type { Ctx } from '../context';
import { disposition, previewOf } from '../files/types';
import { record } from '../lib/events';
import { h, HttpError } from '../lib/http';

const ListQuery = z.object({
  year: z.coerce.number().int().min(1990).max(2100).optional(),
  q: z.string().trim().max(100).optional(),
});
const ContentQuery = z.object({ mode: z.enum(['view', 'download']).default('download') });

/** Escapes LIKE wildcards in a search. */
function likeText(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function clientFilesRouter(ctx: Ctx): Router {
  const r = express.Router();
  r.use(requireClient(ctx));

  /** The files this person may see now, for one client (all of their clients when null). */
  const visibleTo = (identityId: string) =>
    and(
      eq(schema.fileVisibility.identityId, identityId),
      eq(schema.fileVisibility.visible, true),
      isNull(schema.files.removedAt),
    );

  r.get(
    '/',
    h(async (req, res) => {
      const s = req.clientSession as ClientSession;
      const q = ListQuery.parse(req.query);
      const clients = await activeClientsOf(ctx.db, s.identityId);
      const clientId = clients.find((c) => c.id === s.activeClientId)?.id ?? clients[0]?.id;
      if (!clientId) throw new HttpError(401, 'signed_out');
      const base = and(visibleTo(s.identityId), eq(schema.files.clientId, clientId));
      const rows = await ctx.db
        .select({ f: schema.files, viewedAt: schema.fileVisibility.viewedAt })
        .from(schema.files)
        .innerJoin(schema.fileVisibility, eq(schema.fileVisibility.fileId, schema.files.id))
        .where(
          and(
            base,
            q.year ? eq(schema.files.taxYear, q.year) : undefined,
            q.q ? ilike(schema.files.name, likeText(q.q)) : undefined,
          ),
        )
        .orderBy(
          desc(sql`coalesce(${schema.files.contentUpdatedAt}, ${schema.files.sharedAt})`),
          desc(schema.files.sharedAt),
        );
      const years = await ctx.db
        .selectDistinct({ year: schema.files.taxYear })
        .from(schema.files)
        .innerJoin(schema.fileVisibility, eq(schema.fileVisibility.fileId, schema.files.id))
        .where(base);
      res.json({
        clientId,
        files: rows.map(({ f, viewedAt }) => ({
          id: f.id,
          name: f.name,
          size: f.size,
          contentType: f.contentType,
          taxYear: f.taxYear,
          sharedAt: f.sharedAt,
          updatedAt: f.contentUpdatedAt,
          isNew: viewedAt === null,
          preview: previewOf(f.contentType),
        })),
        years: years
          .map((y) => y.year)
          .filter((y): y is number => y !== null)
          .sort((a, b) => b - a),
      });
    }),
  );

  r.get(
    '/:id/content',
    h(async (req, res) => {
      const s = req.clientSession as ClientSession;
      const id = z.string().uuid().safeParse(req.params['id']);
      if (!id.success) throw new HttpError(404, 'not_found');
      const { mode } = ContentQuery.parse(req.query);
      const clients = await activeClientsOf(ctx.db, s.identityId);
      const [row] = await ctx.db
        .select({ f: schema.files })
        .from(schema.files)
        .innerJoin(schema.fileVisibility, eq(schema.fileVisibility.fileId, schema.files.id))
        .where(and(eq(schema.files.id, id.data), visibleTo(s.identityId)));
      const f = row?.f;
      if (!f || !f.blobKey || !f.dekWrapped || !clients.some((c) => c.id === f.clientId)) {
        throw new HttpError(404, 'not_found');
      }

      const dek = ctx.keyring.unwrap(new Uint8Array(f.dekWrapped));
      const stream = ctx.blobs.get(f.blobKey, dek);
      const it = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
      // Read the first chunk before answering: a damaged file is an error, not half a file.
      let first: IteratorResult<Buffer>;
      try {
        first = await it.next();
      } catch (err) {
        ctx.log.error({ err, fileId: f.id }, 'stored file failed to decrypt');
        throw new HttpError(500, 'file_unreadable');
      }

      const inline = mode === 'view' && previewOf(f.contentType) !== null;
      res.setHeader('Content-Type', inline ? f.contentType : 'application/octet-stream');
      res.setHeader('Content-Disposition', disposition(inline ? 'inline' : 'attachment', f.name));
      res.setHeader('Content-Length', String(f.size));
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");

      const now = ctx.now();
      await ctx.db
        .update(schema.fileVisibility)
        .set({
          viewedAt: now,
          firstViewedAt: sql`coalesce(${schema.fileVisibility.firstViewedAt}, ${now.toISOString()}::timestamptz)`,
        })
        .where(
          and(
            eq(schema.fileVisibility.fileId, f.id),
            eq(schema.fileVisibility.identityId, s.identityId),
          ),
        );
      await record(
        ctx.db,
        mode === 'view' ? 'view' : 'download',
        { kind: 'client', name: s.identityId },
        { clientId: f.clientId, fileId: f.id, identityId: s.identityId },
      );

      if (!first.done) res.write(first.value);
      try {
        for (let next = await it.next(); !next.done; next = await it.next()) {
          if (!res.write(next.value)) await new Promise((ok) => res.once('drain', ok));
        }
        res.end();
      } catch (err) {
        // Damaged later in the file: the client gets a broken download, never wrong bytes.
        ctx.log.error({ err, fileId: f.id }, 'stored file failed to decrypt part-way');
        res.destroy(err as Error);
      }
    }),
  );

  return r;
}
