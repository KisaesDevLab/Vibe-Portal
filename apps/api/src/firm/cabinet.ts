// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// The documents Vibe Files sent to its B2 bucket, as a list for the staff page (P90). Vibe Files
// sends the list itself: each document's place in the client's folder, its size and tax year.
// No content. A client that has none on the portal yet is made by its first list.
//
// P91: where Vibe Files and the portal use the same bucket and an admin entered Vibe Files'
// sync passphrase (Settings > Storage), staff can put a listed document on the portal: the
// portal reads it from Vibe Files' part of the bucket (files/vf-bucket.ts) and keeps its own
// copy, as if Vibe Files had added it. Shown to nobody until staff choose who sees it.
//
//   GET    /api/firm/v1/cabinet                    what the portal holds, for Vibe Files to compare
//   PUT    /api/firm/v1/cabinet/:clientId          { clientCode, displayName, rev, headRev, hash, files }
//   DELETE /api/firm/v1/cabinet/:clientId?headRev  a client gone from the cabinet: its list goes
//   DELETE /api/firm/v1/cabinet                    Vibe Files stopped sending lists: all go
//   GET    /api/{firm,staff}/v1/clients/:id/cabinet-files
//   POST   /api/staff/v1/clients/:id/cabinet-files/:docId   puts it on the portal -> { fileId }
//
// Only Vibe Files writes. Several PCs may send, each from its own catalog, and one list is kept
// (`kept: true` tells a sender its list was not taken):
//   - a list made from an older segment of the client than the one kept is not taken;
//   - two PCs at the same segment whose lists differ (a detail one of them changed and has not
//     pushed yet) do not replace each other's back and forth: the PC whose list is kept may
//     replace it, another PC only with a list whose mark sorts after the kept one;
//   - a list cleared because its client left the cabinet is not brought back by a PC that has
//     seen less of the bucket than the one that cleared it.
// File names go to no log and no History entry.

import { Readable } from 'node:stream';

import express, { type Request, type RequestHandler, type Router } from 'express';
import { and, asc, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { generateKey } from '@vibe/crypto';
import { z } from 'zod';
import { schema } from '@vibe-portal/db';

import { uploadLimit, type Ctx } from '../context';
import { TooLarge } from '../files/blobs';
import { b2Settings, firmRow, openB2, vfAccess } from '../files/storage';
import { cleanName, contentTypeOf } from '../files/types';
import { content, find, VfError } from '../files/vf-bucket';
import { record, type Actor } from '../lib/events';
import { body, h, HttpError, notForStaff } from '../lib/http';

/** The most documents one client's list may hold; a longer one is refused whole. */
export const CABINET_FILES_MAX = 20_000;
/** The longest place of a document below its client's folder. */
export const CABINET_PATH_MAX = 500;
/** The JSON body of one client's list: room for the most documents with the longest places,
 *  in any alphabet. Read only once the firm key is known (the router below), never before. */
export const CABINET_BODY_LIMIT = '32mb';
/** The firm API's path of these routes, for app.ts (the general, small JSON reader skips it). */
export const CABINET_FIRM_PATH = '/api/firm/v1/cabinet';

const Uuid = z.string().uuid();
const Rev = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** No control characters (a NUL above all): the database would refuse the text, and its error,
 *  which the log keeps, could carry the file names with it. Refused here, by field, instead. */
const plain = (s: string): boolean => {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  return true;
};
const ListSchema = z.object({
  // Both are always sent: a list never empties a client's ID by leaving it out.
  clientCode: z.string().trim().max(64).refine(plain),
  displayName: z.string().trim().min(1).max(200).refine(plain),
  /** The client's manifest segment the list was made from. */
  rev: Rev,
  /** The newest state of the bucket the sending PC has seen. */
  headRev: Rev,
  /** Vibe Files' mark of the list's content. */
  hash: z.string().min(1).max(100).refine(plain),
  files: z
    .array(
      z.object({
        docId: z.string().min(1).max(200).refine(plain),
        path: z.string().min(1).max(CABINET_PATH_MAX).refine(plain),
        size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        taxYear: z.number().int().min(1900).max(2200).nullable().default(null),
      }),
    )
    .max(CABINET_FILES_MAX),
});
/** Digits only (never empty, never 1e30), within what the database and a list's own can hold. */
const GoneQuery = z.object({
  headRev: z
    .string()
    .regex(/^\d{1,16}$/)
    .transform(Number)
    .pipe(Rev),
});

function actorOf(req: Request): Actor {
  return req.firmActor ?? { kind: 'firm_key', name: 'Vibe Files' };
}

function clientId(req: Request): string {
  const v = Uuid.safeParse(req.params['clientId'] ?? req.params['id']);
  if (!v.success) throw new HttpError(404, 'client_not_found');
  return v.data.toLowerCase();
}

/** Rows go in this many at a time (five values each, far under the database's limit). */
const CHUNK = 1000;

const NO_LIST = {
  cabinetRev: null,
  cabinetHash: null,
  cabinetListedAt: null,
  cabinetBy: null,
  cabinetCount: 0,
} as const;

export function firmCabinetRouter(ctx: Ctx, staff: boolean): Router {
  const r = express.Router();
  // The list is Vibe Files' to send, to compare and to clear.
  if (staff) r.use(notForStaff);
  // A list's body is large: read here, after the firm key was checked (this router is mounted
  // behind it), so nobody without the key makes the portal read one.
  else r.use(express.json({ limit: CABINET_BODY_LIMIT }));

  r.get(
    '/',
    h(async (_req, res) => {
      const rows = await ctx.db
        .select({
          id: schema.clients.id,
          rev: schema.clients.cabinetRev,
          headRev: schema.clients.cabinetHeadRev,
          hash: schema.clients.cabinetHash,
          by: schema.clients.cabinetBy,
        })
        .from(schema.clients)
        // With a list, or with one cleared since (`hash` null: a PC that has seen less of the
        // bucket than its clearer does not send it again).
        .where(or(isNotNull(schema.clients.cabinetHash), isNotNull(schema.clients.cabinetHeadRev)));
      res.json({ max: CABINET_FILES_MAX, maxPath: CABINET_PATH_MAX, clients: rows });
    }),
  );

  r.put(
    '/:clientId',
    h(async (req, res) => {
      const id = clientId(req);
      const input = body(ListSchema, req);
      // One document once: the list is the client's whole list, by document.
      const seen = new Set<string>();
      for (const f of input.files) {
        if (seen.has(f.docId)) throw new HttpError(400, 'document_twice');
        seen.add(f.docId);
      }
      const now = ctx.now();
      const by = actorOf(req).name;
      const none = { kept: true, created: false, renamed: false };
      const out = await ctx.db.transaction(async (tx) => {
        // A client the portal has never had is made by its first list, switched on.
        const made = await tx
          .insert(schema.clients)
          .values({ id, clientCode: input.clientCode, displayName: input.displayName })
          .onConflictDoNothing()
          .returning({ id: schema.clients.id });
        // Held to the end: two PCs sending the same client's list wait their turn. Not the
        // stronger lock: an upload, a share or a History entry for this client is not held up.
        const [c] = await tx
          .select()
          .from(schema.clients)
          .where(eq(schema.clients.id, id))
          .for('no key update');
        if (!c) throw new Error('client row missing after insert');
        // Made from an older state of the bucket than the list kept.
        if (c.cabinetRev !== null && input.rev < c.cabinetRev) return none;
        // Its list was cleared (the client left the cabinet) by a PC that had seen more of the
        // bucket than this one, which may only not have heard yet.
        if (
          c.cabinetHash === null &&
          c.cabinetHeadRev !== null &&
          input.headRev < c.cabinetHeadRev
        ) {
          return none;
        }
        const changed = c.cabinetHash !== input.hash;
        // The same segment, another PC, another list: one of the two is kept for good (the one
        // whose mark sorts last), so they do not replace each other's at every send.
        if (
          changed &&
          c.cabinetHash !== null &&
          input.rev === c.cabinetRev &&
          c.cabinetBy !== by &&
          input.hash < c.cabinetHash
        ) {
          return none;
        }
        // The client's name and ID follow a list only when it is the client's first, or made
        // from a newer segment: a PC whose catalog has an old name does not put it back.
        const newer = made.length > 0 || c.cabinetRev === null || input.rev > c.cabinetRev;
        const renamed =
          !made.length &&
          newer &&
          (c.clientCode !== input.clientCode || c.displayName !== input.displayName);
        if (changed) {
          await tx.delete(schema.cabinetFile).where(eq(schema.cabinetFile.clientId, id));
          for (let i = 0; i < input.files.length; i += CHUNK) {
            await tx.insert(schema.cabinetFile).values(
              input.files.slice(i, i + CHUNK).map((f) => ({
                clientId: id,
                docId: f.docId,
                path: f.path,
                size: f.size,
                taxYear: f.taxYear,
              })),
            );
          }
        }
        await tx
          .update(schema.clients)
          .set({
            // `active` is never touched: a client switched off stays off.
            ...(renamed
              ? { clientCode: input.clientCode, displayName: input.displayName, updatedAt: now }
              : {}),
            cabinetRev: input.rev,
            cabinetHeadRev: Math.max(input.headRev, c.cabinetHeadRev ?? 0),
            cabinetHash: input.hash,
            cabinetBy: by,
            ...(changed ? { cabinetListedAt: now, cabinetCount: input.files.length } : {}),
          })
          .where(eq(schema.clients.id, id));
        return { kept: false, created: made.length > 0, renamed };
      });
      // History has a client's making and renaming, as from PUT /clients/:id; not each list.
      if (out.created || out.renamed) {
        await record(ctx.db, 'client_updated', actorOf(req), {
          clientId: id,
          detail: {
            clientCode: input.clientCode,
            displayName: input.displayName,
            from: 'cabinet_list',
          },
        });
      }
      res.json({ ok: true, ...(out.kept ? { kept: true } : {}) });
    }),
  );

  r.delete(
    '/:clientId',
    h(async (req, res) => {
      const id = clientId(req);
      const { headRev } = GoneQuery.parse(req.query);
      const kept = await ctx.db.transaction(async (tx) => {
        const [c] = await tx
          .select()
          .from(schema.clients)
          .where(eq(schema.clients.id, id))
          .for('no key update');
        if (!c) return false;
        // A PC that has seen less of the bucket than the one that sent the list may simply not
        // know the client yet.
        if ((c.cabinetHeadRev ?? 0) > headRev) return c.cabinetHash !== null;
        if (c.cabinetHash !== null) {
          await tx.delete(schema.cabinetFile).where(eq(schema.cabinetFile.clientId, id));
        }
        // How much the clearer had seen is kept (also when there was no list to clear), so a PC
        // that has seen less cannot bring the list back.
        await tx
          .update(schema.clients)
          .set({ ...NO_LIST, cabinetHeadRev: headRev })
          .where(eq(schema.clients.id, id));
        return false;
      });
      res.json({ ok: true, ...(kept ? { kept: true } : {}) });
    }),
  );

  r.delete(
    '/',
    h(async (req, res) => {
      const cleared = await ctx.db.transaction(async (tx) => {
        // The clients first, then their rows: the order a list being sent takes them in, so
        // the two wait for each other instead of one being refused, and a list that arrives
        // while this runs is cleared with the rest.
        const had = await tx
          .select({ id: schema.clients.id })
          .from(schema.clients)
          .where(isNotNull(schema.clients.cabinetHash))
          .for('no key update');
        // What cleared lists remembered goes too: after a tick again, every PC starts afresh.
        await tx
          .update(schema.clients)
          .set({ ...NO_LIST, cabinetHeadRev: null })
          .where(
            or(isNotNull(schema.clients.cabinetHash), isNotNull(schema.clients.cabinetHeadRev)),
          );
        await tx.delete(schema.cabinetFile);
        return had.length;
      });
      if (cleared) {
        await record(ctx.db, 'cabinet_lists_cleared', actorOf(req), {
          detail: { clients: cleared },
        });
      }
      res.json({ ok: true, clients: cleared });
    }),
  );

  return r;
}

/**
 * GET /clients/:id/cabinet-files: one client's list, by place in its folder, each with the id of
 * the same document on the portal when it is shared. Mounted under `/clients/:id`, so a staff
 * member limited to some clients reaches only theirs (P48).
 */
export function cabinetFilesOf(ctx: Ctx): RequestHandler {
  return h(async (req, res) => {
    const id = clientId(req);
    const [c] = await ctx.db
      .select({ listedAt: schema.clients.cabinetListedAt, hash: schema.clients.cabinetHash })
      .from(schema.clients)
      .where(eq(schema.clients.id, id));
    if (!c) throw new HttpError(404, 'client_not_found');
    const rows = await ctx.db
      .select({
        docId: schema.cabinetFile.docId,
        path: schema.cabinetFile.path,
        size: schema.cabinetFile.size,
        taxYear: schema.cabinetFile.taxYear,
        fileId: schema.files.id,
      })
      .from(schema.cabinetFile)
      .leftJoin(
        schema.files,
        and(
          eq(schema.files.clientId, schema.cabinetFile.clientId),
          eq(schema.files.vfDocumentId, schema.cabinetFile.docId),
          isNull(schema.files.removedAt),
        ),
      )
      .where(eq(schema.cabinetFile.clientId, id))
      .orderBy(asc(sql`lower(${schema.cabinetFile.path})`));
    res.json({
      // Null: Vibe Files has sent no list for this client.
      listedAt: c.hash === null ? null : c.listedAt,
      // P91: the portal can read these documents (the sync passphrase was entered).
      canAdd: (await firmRow(ctx)).vfSyncEnc !== null,
      files: rows,
    });
  });
}

/** What reading Vibe Files' part of the bucket answers when it cannot give the document. */
const VF_STATUS: Record<VfError['code'], number> = {
  vf_no_cabinet: 409,
  vf_wrong_passphrase: 409,
  // The key changed since the passphrase was entered: it is entered again.
  vf_key: 409,
  vf_gone: 409,
  vf_missing: 409,
  vf_format: 502,
  vf_damaged: 502,
};

/** One document at a time is read from the bucket and opened: each is held whole in memory,
 *  and opening it keeps the server busy, so two staff pressing Add wait their turn. */
let adding: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(job: () => Promise<T>): Promise<T> {
  const run = adding.then(job, job);
  adding = run.catch(() => undefined);
  return run;
}

/**
 * POST /clients/:id/cabinet-files/:docId (staff, P91): puts one listed document on the portal.
 * Read from the bucket as it is now (not from the list): one deleted or taken out of B2 since
 * is refused. The copy is the portal's own, under the document's id, so Vibe Files finds it as
 * a file it shared itself. Shown to nobody: who sees it is chosen as for any file.
 */
export function cabinetAdd(ctx: Ctx): RequestHandler {
  return h(async (req, res) => {
    const id = clientId(req);
    const docId = req.params['docId'] ?? '';
    const actor: Actor = { kind: 'staff', name: req.staff?.email ?? 'staff' };
    const [client] = await ctx.db.select().from(schema.clients).where(eq(schema.clients.id, id));
    if (!client) throw new HttpError(404, 'client_not_found');
    if (!client.active) throw new HttpError(409, 'client_inactive');
    const [listed] = await ctx.db
      .select({ docId: schema.cabinetFile.docId })
      .from(schema.cabinetFile)
      .where(and(eq(schema.cabinetFile.clientId, id), eq(schema.cabinetFile.docId, docId)));
    // Off the list since the page was read (Vibe Files sent a new one).
    if (!listed) throw new HttpError(404, 'vf_unlisted');
    const live = and(
      eq(schema.files.clientId, id),
      eq(schema.files.vfDocumentId, docId),
      isNull(schema.files.removedAt),
    );
    const [existing] = await ctx.db.select({ id: schema.files.id }).from(schema.files).where(live);
    if (existing) {
      res.json({ fileId: existing.id, existing: true });
      return;
    }
    const f = await firmRow(ctx);
    const access = vfAccess(ctx, f);
    const s = b2Settings(ctx, f);
    if (!access || !s) throw new HttpError(409, 'vf_not_set_up');
    const bucket = openB2(ctx, s);
    const limit = await uploadLimit(ctx);
    let stored;
    let name;
    let taxYear: number | null;
    try {
      const got = await oneAtATime(async () => {
        const doc = await find(bucket, access, id, docId);
        // The object opens in one piece, in memory: refused by its size before it is fetched.
        if (doc.size > limit) throw new HttpError(413, 'vf_too_large');
        const plain = await content(bucket, access, doc);
        const dek = generateKey();
        const put = await ctx.blobs.put(Readable.from([plain]), dek, limit);
        if (put.sha256 !== doc.sha256) {
          await ctx.blobs.remove(put.blobKey);
          throw new VfError('vf_damaged', 'stored copy');
        }
        return { doc, put, dekWrapped: Buffer.from(ctx.keyring.wrap(dek)) };
      });
      name = cleanName(got.doc.name);
      const year = got.doc.taxYear;
      taxYear = year !== null && year >= 1990 && year <= 2100 ? year : null;
      stored = { ...got.put, dekWrapped: got.dekWrapped };
    } catch (err) {
      if (err instanceof TooLarge) throw new HttpError(413, 'vf_too_large');
      if (err instanceof VfError) {
        // The code and the object's place in the bucket; never a file name.
        ctx.log.warn({ reason: err.message }, 'a document in B2 could not be put on the portal');
        throw new HttpError(VF_STATUS[err.code], err.code);
      }
      if (err instanceof HttpError) throw err;
      ctx.log.error({ err }, 'reading a document from B2 failed');
      throw new HttpError(502, 'vf_read_failed');
    }
    let row;
    try {
      [row] = await ctx.db
        .insert(schema.files)
        .values({
          clientId: id,
          vfDocumentId: docId,
          name,
          contentType: contentTypeOf(name),
          size: stored.size,
          sha256: stored.sha256,
          blobKey: stored.blobKey,
          dekWrapped: stored.dekWrapped,
          sharedAt: ctx.now(),
          updatedAt: ctx.now(),
          sharedBy: actor.name,
          taxYear,
        })
        .returning({ id: schema.files.id });
    } catch (err) {
      await ctx.blobs.remove(stored.blobKey);
      // Added meanwhile, by Vibe Files or another staff member: theirs is kept.
      if ((err as { code?: string }).code === '23505') {
        const [now] = await ctx.db.select({ id: schema.files.id }).from(schema.files).where(live);
        if (now) {
          res.json({ fileId: now.id, existing: true });
          return;
        }
      }
      throw err;
    }
    if (!row) throw new Error('file insert returned nothing');
    await record(ctx.db, 'file_added', actor, {
      clientId: id,
      fileId: row.id,
      detail: { name, size: stored.size, vfDocumentId: docId, from: 'b2' },
    });
    res.status(201).json({ fileId: row.id });
  });
}
