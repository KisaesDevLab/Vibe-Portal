// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Files from Vibe Files to clients (BUILD_PLAN.md §3, Phase 3). The portal keeps an encrypted
// copy; the cabinet keeps the original (D9). Who sees a file is set per user (D8).
//
//   POST   /api/firm/v1/files?clientId&vfDocumentId&name&sha256[&taxYear]   body: the file
//          -> 201 { fileId }   (the same document with the same content: 200 { fileId, existing })
//   PUT    /api/firm/v1/files/:id/content?sha256[&name]                     body: the new file
//   PUT    /api/firm/v1/files/:id/visibility   { users: { <identityId>: true|false } }
//   DELETE /api/firm/v1/files/:id              (remove from the portal)
//   GET    /api/firm/v1/files?clientId=… | ?vfDocumentId=…
//
// Upload bodies are sent as application/octet-stream and streamed: never held in memory.

import express, { type Request, type Router } from 'express';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { generateKey } from '@vibe/crypto';
import { z } from 'zod';
import { schema } from '@vibe-portal/db';

import { uploadLimit, type Ctx } from '../context';
import { TooLarge } from '../files/blobs';
import { drop, enqueue } from '../files/notify-queue';
import { cleanName, contentTypeOf } from '../files/types';
import { record, type Actor } from '../lib/events';
import { body, h, HttpError, notForStaff, queryWithText } from '../lib/http';
import { inScope, mustSee } from '../staff/scope';

const Uuid = z.string().uuid();
const Sha = z
  .string()
  .regex(/^[0-9a-f]{64}$/i)
  .transform((s) => s.toLowerCase());
const AddQuery = z.object({
  clientId: Uuid,
  vfDocumentId: z.string().trim().min(1).max(200),
  name: z.string().min(1).max(400),
  sha256: Sha,
  taxYear: z.coerce.number().int().min(1990).max(2100).optional(),
});
const ReplaceQuery = z.object({ sha256: Sha, name: z.string().min(1).max(400).optional() });
const VisibilitySchema = z.object({ users: z.record(Uuid, z.boolean()) });
const ListQuery = z
  .object({
    clientId: Uuid.optional(),
    vfDocumentId: z.string().min(1).max(200).optional(),
    /** Every live file (Vibe Files' marks in Browse). */
    all: z.literal('1').optional(),
  })
  .refine((q) => q.clientId || q.vfDocumentId || q.all, 'clientId, vfDocumentId or all=1');

function actorOf(req: Request): Actor {
  return req.firmActor ?? { kind: 'firm_key', name: 'Vibe Files' };
}

export function firmFilesRouter(ctx: Ctx, staff = false): Router {
  const r = express.Router();
  if (staff) {
    // Only Vibe Files reaches the cabinet: staff cannot share new files or replace content.
    // Registered on the same routes, ahead of them, so they match exactly as those do (Express
    // ignores case and a trailing slash).
    r.post('/', notForStaff);
    r.put('/:id/content', notForStaff);
  }

  /** Streams the request body into a new encrypted blob and checks its hash. */
  async function store(req: Request, sha256: string) {
    if (!req.is('application/octet-stream')) throw new HttpError(415, 'octet_stream_required');
    const limit = await uploadLimit(ctx);
    if (Number(req.headers['content-length'] ?? 0) > limit) throw new HttpError(413, 'too_large');
    const dek = generateKey();
    let stored;
    try {
      stored = await ctx.blobs.put(req, dek, limit);
    } catch (err) {
      if (err instanceof TooLarge) throw new HttpError(413, 'too_large');
      throw err;
    }
    if (stored.sha256 !== sha256) {
      await ctx.blobs.remove(stored.blobKey);
      throw new HttpError(400, 'sha256_mismatch');
    }
    return { ...stored, dekWrapped: Buffer.from(ctx.keyring.wrap(dek)) };
  }

  const liveFile = async (id: string) => {
    const [f] = await ctx.db
      .select()
      .from(schema.files)
      .where(and(eq(schema.files.id, id), isNull(schema.files.removedAt)));
    if (!f) throw new HttpError(404, 'not_found');
    return f;
  };

  const fileId = (req: Request): string => {
    const v = Uuid.safeParse(req.params['id']);
    if (!v.success) throw new HttpError(404, 'not_found');
    return v.data;
  };

  r.post(
    '/',
    h(async (req, res) => {
      const q = AddQuery.parse(queryWithText(req));
      const [client] = await ctx.db
        .select()
        .from(schema.clients)
        .where(eq(schema.clients.id, q.clientId));
      if (!client) throw new HttpError(404, 'client_not_found');
      if (!client.active) throw new HttpError(409, 'client_inactive');
      const [existing] = await ctx.db
        .select()
        .from(schema.files)
        .where(
          and(
            eq(schema.files.clientId, q.clientId),
            eq(schema.files.vfDocumentId, q.vfDocumentId),
            isNull(schema.files.removedAt),
          ),
        );
      if (existing) {
        if (existing.sha256 === q.sha256) {
          res.status(200).json({ fileId: existing.id, existing: true });
          return;
        }
        res.status(409).json({ error: 'changed_use_replace', fileId: existing.id });
        return;
      }
      const stored = await store(req, q.sha256);
      const name = cleanName(q.name);
      const actor = actorOf(req);
      let row;
      try {
        [row] = await ctx.db
          .insert(schema.files)
          .values({
            clientId: q.clientId,
            vfDocumentId: q.vfDocumentId,
            name,
            contentType: contentTypeOf(name),
            size: stored.size,
            sha256: stored.sha256,
            blobKey: stored.blobKey,
            dekWrapped: stored.dekWrapped,
            sharedAt: ctx.now(),
            updatedAt: ctx.now(),
            sharedBy: actor.name,
            taxYear: q.taxYear ?? null,
          })
          .returning({ id: schema.files.id });
      } catch (err) {
        // Two PCs added the same document at once: keep the first.
        await ctx.blobs.remove(stored.blobKey);
        if ((err as { code?: string }).code === '23505') {
          throw new HttpError(409, 'already_added');
        }
        throw err;
      }
      if (!row) throw new Error('file insert returned nothing');
      await record(ctx.db, 'file_added', actor, {
        clientId: q.clientId,
        fileId: row.id,
        detail: { name, size: stored.size, vfDocumentId: q.vfDocumentId },
      });
      res.status(201).json({ fileId: row.id });
    }),
  );

  r.put(
    '/:id/content',
    h(async (req, res) => {
      const id = fileId(req);
      const q = ReplaceQuery.parse(queryWithText(req));
      const before = await liveFile(id);
      if (before.sha256 === q.sha256 && (!q.name || cleanName(q.name) === before.name)) {
        res.json({ ok: true, unchanged: true });
        return;
      }
      const stored = await store(req, q.sha256);
      const name = q.name ? cleanName(q.name) : before.name;
      const now = ctx.now();
      const actor = actorOf(req);
      const visibleTo = await ctx.db.transaction(async (tx) => {
        const [updated] = await tx
          .update(schema.files)
          .set({
            name,
            contentType: contentTypeOf(name),
            size: stored.size,
            sha256: stored.sha256,
            blobKey: stored.blobKey,
            dekWrapped: stored.dekWrapped,
            contentUpdatedAt: now,
            updatedAt: now,
          })
          .where(and(eq(schema.files.id, id), isNull(schema.files.removedAt)))
          .returning({ id: schema.files.id });
        if (!updated) return null;
        // P20: counts as new again for everyone who sees it.
        const seen = await tx
          .update(schema.fileVisibility)
          .set({ viewedAt: null })
          .where(and(eq(schema.fileVisibility.fileId, id), eq(schema.fileVisibility.visible, true)))
          .returning({ identityId: schema.fileVisibility.identityId });
        const users = seen.map((s) => s.identityId);
        await enqueue(tx, users, id, 'updated', now);
        return users;
      });
      if (!visibleTo) {
        await ctx.blobs.remove(stored.blobKey);
        throw new HttpError(404, 'not_found');
      }
      if (before.blobKey) await ctx.blobs.remove(before.blobKey);
      await record(ctx.db, 'replace', actor, {
        clientId: before.clientId,
        fileId: id,
        detail: { name, size: stored.size },
      });
      res.json({ ok: true });
    }),
  );

  r.put(
    '/:id/visibility',
    h(async (req, res) => {
      const id = fileId(req);
      const { users } = body(VisibilitySchema, req);
      const file = await liveFile(id);
      mustSee(req, file.clientId);
      const ids = Object.keys(users);
      // Only people with access to this file's client.
      const known = ids.length
        ? await ctx.db
            .select({ identityId: schema.clientAccess.identityId })
            .from(schema.clientAccess)
            .where(
              and(
                eq(schema.clientAccess.clientId, file.clientId),
                inArray(schema.clientAccess.identityId, ids),
              ),
            )
        : [];
      if (known.length !== ids.length) throw new HttpError(400, 'not_a_user_of_this_client');
      const now = ctx.now();
      const actor = actorOf(req);
      const current = ids.length
        ? await ctx.db
            .select()
            .from(schema.fileVisibility)
            .where(
              and(
                eq(schema.fileVisibility.fileId, id),
                inArray(schema.fileVisibility.identityId, ids),
              ),
            )
        : [];
      const was = new Map(current.map((c) => [c.identityId, c.visible]));
      const shown = ids.filter((i) => users[i] && !was.get(i));
      const hidden = ids.filter((i) => !users[i] && was.get(i));
      await ctx.db.transaction(async (tx) => {
        for (const identityId of [...shown, ...hidden]) {
          const visible = shown.includes(identityId);
          await tx
            .insert(schema.fileVisibility)
            .values({ fileId: id, identityId, visible, changedAt: now, changedBy: actor.name })
            .onConflictDoUpdate({
              target: [schema.fileVisibility.fileId, schema.fileVisibility.identityId],
              // Shown again: new to them again.
              set: { visible, changedAt: now, changedBy: actor.name, viewedAt: null },
            });
        }
        await enqueue(tx, shown, id, 'shared', now);
        await drop(tx, id, hidden, now);
      });
      for (const identityId of shown) {
        await record(ctx.db, 'share', actor, { clientId: file.clientId, fileId: id, identityId });
      }
      for (const identityId of hidden) {
        await record(ctx.db, 'unshare', actor, { clientId: file.clientId, fileId: id, identityId });
      }
      res.json({ ok: true, shown, hidden });
    }),
  );

  r.delete(
    '/:id',
    h(async (req, res) => {
      const id = fileId(req);
      const now = ctx.now();
      const actor = actorOf(req);
      const before = await liveFile(id);
      mustSee(req, before.clientId);
      const [gone] = await ctx.db
        .update(schema.files)
        .set({ removedAt: now, removedBy: actor.name, blobKey: null, dekWrapped: null })
        .where(and(eq(schema.files.id, id), isNull(schema.files.removedAt)))
        .returning({ clientId: schema.files.clientId });
      if (!gone) throw new HttpError(404, 'not_found');
      // D9: removed from the portal means gone from its disk too; the cabinet keeps the original.
      if (before.blobKey) await ctx.blobs.remove(before.blobKey);
      await drop(ctx.db, id, null, now);
      await record(ctx.db, 'remove', actor, { clientId: gone.clientId, fileId: id });
      res.json({ ok: true });
    }),
  );

  r.get(
    '/',
    h(async (req, res) => {
      const q = ListQuery.parse(req.query);
      const live = and(
        isNull(schema.files.removedAt),
        inScope(req, schema.files.clientId),
        q.clientId ? eq(schema.files.clientId, q.clientId) : undefined,
        q.vfDocumentId ? eq(schema.files.vfDocumentId, q.vfDocumentId) : undefined,
      );
      const rows = await ctx.db
        .select()
        .from(schema.files)
        .where(live)
        .orderBy(asc(schema.files.sharedAt));
      // The same files' visibility in one joined query (all=1 can be tens of thousands of files:
      // too many to pass as parameters), grouped once by file.
      const byFile = new Map<string, (typeof schema.fileVisibility.$inferSelect)[]>();
      if (rows.length) {
        const vis = await ctx.db
          .select({ v: schema.fileVisibility })
          .from(schema.fileVisibility)
          .innerJoin(schema.files, eq(schema.files.id, schema.fileVisibility.fileId))
          .where(live);
        for (const { v } of vis) {
          const list = byFile.get(v.fileId);
          if (list) list.push(v);
          else byFile.set(v.fileId, [v]);
        }
      }
      res.json({
        files: rows.map((f) => ({
          fileId: f.id,
          clientId: f.clientId,
          vfDocumentId: f.vfDocumentId,
          name: f.name,
          size: f.size,
          sha256: f.sha256,
          taxYear: f.taxYear,
          sharedAt: f.sharedAt,
          sharedBy: f.sharedBy,
          contentUpdatedAt: f.contentUpdatedAt,
          // P21: who sees it, and whether they opened the current content.
          users: (byFile.get(f.id) ?? []).map((v) => ({
            identityId: v.identityId,
            visible: v.visible,
            viewedAt: v.viewedAt,
            firstViewedAt: v.firstViewedAt,
          })),
        })),
      });
    }),
  );

  return r;
}
