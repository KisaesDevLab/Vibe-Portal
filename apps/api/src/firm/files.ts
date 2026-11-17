// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Files from Vibe Files to clients (BUILD_PLAN.md §3, Phase 3). The portal keeps an encrypted
// copy; the cabinet keeps the original (D9). Who sees a file is set per user (D8).
//
//   POST   /api/firm/v1/files?clientId&vfDocumentId&name&sha256[&taxYear]   body: the file
//          -> 201 { fileId }   (the same document with the same content: 200 { fileId, existing })
//   PUT    /api/firm/v1/files/:id/content?sha256[&name]                     body: the new file
//   PUT    /api/firm/v1/files/:id/visibility   { users?: { <identityId>: true|false },
//                                                 invites?: { <invitationId>: true|false } }
//          `invites` (P98): for someone invited who has not accepted yet; shown to them when
//          they accept
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
import { removeFile, replaceContent } from '../files/replace';
import { cleanName, contentTypeOf } from '../files/types';
import { maskContact } from '../lib/contact';
import { record, type Actor } from '../lib/events';
import { body, h, HttpError, notForStaff, queryWithText } from '../lib/http';
import { inScope } from '../staff/scope';

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
const VisibilitySchema = z.object({
  users: z.record(Uuid, z.boolean()).default({}),
  /** P98: invitations to this file's client still waiting (expired ones too: they are resent). */
  invites: z.record(Uuid, z.boolean()).default({}),
});
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
    // Staff send no file of their own and replace no content: a new file comes from Vibe Files,
    // or (P91) from Vibe Files' part of the bucket by firm/cabinet.ts.
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

  /** A file still on the portal, of a client the caller may see (P48): any other is not found. */
  const liveFile = async (req: Request, id: string) => {
    const [f] = await ctx.db
      .select()
      .from(schema.files)
      .where(
        and(
          eq(schema.files.id, id),
          isNull(schema.files.removedAt),
          inScope(req, schema.files.clientId),
        ),
      );
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
      const before = await liveFile(req, id);
      if (before.sha256 === q.sha256 && (!q.name || cleanName(q.name) === before.name)) {
        res.json({ ok: true, unchanged: true });
        return;
      }
      const stored = await store(req, q.sha256);
      const name = q.name ? cleanName(q.name) : before.name;
      // A file added from B2 that Vibe Files replaces is Vibe Files' from now on (P94): the
      // portal no longer follows the bucket for it, so the two never undo each other.
      if (!(await replaceContent(ctx, before, stored, name, actorOf(req), {}, { fromB2: false }))) {
        await ctx.blobs.remove(stored.blobKey);
        throw new HttpError(404, 'not_found');
      }
      res.json({ ok: true });
    }),
  );

  r.put(
    '/:id/visibility',
    h(async (req, res) => {
      const id = fileId(req);
      const { users, invites } = body(VisibilitySchema, req);
      const file = await liveFile(req, id);
      const ids = Object.keys(users);
      const inviteIds = Object.keys(invites);
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
      // P98: the invitations a file was chosen for, or taken back from, by this call.
      const chosenFor: string[] = [];
      const takenFrom: string[] = [];
      const invitedNames = new Map<string, string>();
      let staleInvites = 0;
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
        // P98: kept with the invitation until it is accepted. Nobody is told: they have no
        // account yet, and the invitation's own message is what brings them. Only invitations
        // to this file's client that still wait, held while this runs (one accepted or
        // withdrawn at this moment is not given a file nobody would ever see). One that no
        // longer waits is passed over, not a failure of the whole: the rest still applies.
        const waiting = inviteIds.length
          ? await tx
              .select({
                id: schema.portalInvitation.id,
                name: schema.portalInvitation.name,
                email: schema.portalInvitation.email,
                phone: schema.portalInvitation.phone,
              })
              .from(schema.portalInvitation)
              .where(
                and(
                  eq(schema.portalInvitation.clientId, file.clientId),
                  inArray(schema.portalInvitation.id, inviteIds),
                  isNull(schema.portalInvitation.acceptedAt),
                  isNull(schema.portalInvitation.revokedAt),
                ),
              )
              .for('update')
          : [];
        staleInvites = inviteIds.length - waiting.length;
        for (const i of waiting) {
          // Who it is for, as History says it: their name, else the contact, masked.
          invitedNames.set(i.id, i.name || maskContact(i.email ?? i.phone ?? ''));
        }
        for (const { id: invitationId } of waiting) {
          if (invites[invitationId]) {
            const made = await tx
              .insert(schema.invitationFile)
              .values({ invitationId, fileId: id, chosenAt: now, chosenBy: actor.name })
              .onConflictDoNothing()
              .returning({ id: schema.invitationFile.invitationId });
            if (made.length) chosenFor.push(invitationId);
          } else {
            const gone = await tx
              .delete(schema.invitationFile)
              .where(
                and(
                  eq(schema.invitationFile.invitationId, invitationId),
                  eq(schema.invitationFile.fileId, id),
                ),
              )
              .returning({ id: schema.invitationFile.invitationId });
            if (gone.length) takenFrom.push(invitationId);
          }
        }
      });
      for (const identityId of shown) {
        await record(ctx.db, 'share', actor, { clientId: file.clientId, fileId: id, identityId });
      }
      for (const identityId of hidden) {
        await record(ctx.db, 'unshare', actor, { clientId: file.clientId, fileId: id, identityId });
      }
      // Only what changed, as for people; said to be for someone invited (no person yet).
      for (const invitationId of chosenFor) {
        await record(ctx.db, 'share', actor, {
          clientId: file.clientId,
          fileId: id,
          detail: { invitationId, invited: invitedNames.get(invitationId) ?? '' },
        });
      }
      for (const invitationId of takenFrom) {
        await record(ctx.db, 'unshare', actor, {
          clientId: file.clientId,
          fileId: id,
          detail: { invitationId, invited: invitedNames.get(invitationId) ?? '' },
        });
      }
      res.json({ ok: true, shown, hidden, ...(staleInvites ? { staleInvites } : {}) });
    }),
  );

  r.delete(
    '/:id',
    h(async (req, res) => {
      const id = fileId(req);
      const before = await liveFile(req, id);
      if (!(await removeFile(ctx, before, actorOf(req)))) throw new HttpError(404, 'not_found');
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
      // P98: the invitations still waiting that each file was chosen for.
      const waitingFor = new Map<string, string[]>();
      if (rows.length) {
        const chosen = await ctx.db
          .select({
            fileId: schema.invitationFile.fileId,
            invitationId: schema.invitationFile.invitationId,
          })
          .from(schema.invitationFile)
          .innerJoin(
            schema.portalInvitation,
            eq(schema.portalInvitation.id, schema.invitationFile.invitationId),
          )
          .innerJoin(schema.files, eq(schema.files.id, schema.invitationFile.fileId))
          .where(
            and(
              live,
              isNull(schema.portalInvitation.acceptedAt),
              isNull(schema.portalInvitation.revokedAt),
            ),
          );
        for (const c of chosen) {
          const list = waitingFor.get(c.fileId);
          if (list) list.push(c.invitationId);
          else waitingFor.set(c.fileId, [c.invitationId]);
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
          // P94: added from B2, so the portal replaces it by itself when B2 has a new version.
          fromB2: f.fromB2,
          // P98: invitations not accepted yet that it will be shown to.
          invites: waitingFor.get(f.id) ?? [],
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
