// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Files sent to someone outside the client (P49): a lender, a lawyer, another accountant. As
// Vibe Time & Billing's secure share. Staff pick files already on the portal for one client and
// give the recipient's email; the recipient gets a private link (see portal/shared.ts for their
// side). Only the staff page has this: Vibe Files, with the firm key, does not.
//
//   POST   /api/staff/v1/shares            { clientId, fileIds, email, name?, organization?,
//                                            message?, canDownload?, watermark?, days? }
//   GET    /api/staff/v1/shares?clientId=
//   DELETE /api/staff/v1/shares/:id        ends the link (again is fine)

import { randomUUID } from 'node:crypto';

import express, { type Request, type Router } from 'express';
import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@vibe-portal/db';

import { firmName, type Ctx } from '../context';
import { previewOf } from '../files/types';
import { WATERMARK_MAX_BYTES, watermarkPdf, watermarkText } from '../files/watermark';
import { normalizeEmail } from '../lib/contact';
import { record, type Actor } from '../lib/events';
import { body, h, HttpError } from '../lib/http';
import { messageTo } from '../lib/notify';
import { hit, LIMITS } from '../lib/rate-limit';
import { randomToken, sha256 } from '../lib/secrets';
import type { StaffSession } from '../staff/auth';
import { mustSee } from '../staff/scope';

export const SHARE_MAX_FILES = 20;
export const SHARE_MAX_DAYS = 90;
/** Links one recipient may hold at a time, across the firm (as Time & Billing). */
export const SHARE_MAX_PER_RECIPIENT = 5;
const LIST_MAX = 200;

const Uuid = z.string().uuid();
const CreateSchema = z.object({
  clientId: Uuid,
  fileIds: z.array(Uuid).min(1).max(SHARE_MAX_FILES),
  email: z.string().trim().max(254),
  name: z.string().trim().max(120).default(''),
  organization: z.string().trim().max(120).default(''),
  message: z.string().trim().max(1000).default(''),
  canDownload: z.boolean().default(false),
  watermark: z.boolean().default(false),
  days: z.number().int().min(1).max(SHARE_MAX_DAYS).default(30),
});
const ListQuery = z.object({ clientId: Uuid });

/** One line of text: control characters (a line break above all) become spaces. */
function oneLine(s: string): string {
  return s.replace(/\p{Cc}+/gu, ' ').trim();
}

/** Text that keeps its line breaks and loses every other control character. */
function lines(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[^\P{Cc}\n]/gu, '')
    .trim();
}

function actorOf(req: Request): Actor {
  return req.firmActor ?? { kind: 'staff', name: (req.staff as StaffSession).email };
}

/** The link's token: the share's id, a dot, and the secret only the email holds. */
export function shareLink(ctx: Pick<Ctx, 'portalUrl'>, id: string, secret: string): string {
  return `${ctx.portalUrl}/shared#t=${id}.${secret}`;
}

type ShareRow = typeof schema.fileShare.$inferSelect;

export function shareStatus(
  s: Pick<ShareRow, 'revokedAt' | 'revokedBy' | 'expiresAt' | 'opens'>,
  now: Date,
): 'locked' | 'revoked' | 'expired' | 'opened' | 'sent' {
  if (s.revokedAt) return s.revokedBy === 'lockout' ? 'locked' : 'revoked';
  if (s.expiresAt.getTime() <= now.getTime()) return 'expired';
  return s.opens > 0 ? 'opened' : 'sent';
}

export function firmSharesRouter(ctx: Ctx): Router {
  const r = express.Router();

  r.post(
    '/',
    h(async (req, res) => {
      const staff = req.staff as StaffSession;
      const input = body(CreateSchema, req);
      mustSee(req, input.clientId, 'client_not_found');
      const [client] = await ctx.db
        .select()
        .from(schema.clients)
        .where(eq(schema.clients.id, input.clientId));
      if (!client) throw new HttpError(404, 'client_not_found');
      if (!client.active) throw new HttpError(409, 'client_inactive');
      const email = normalizeEmail(input.email);
      if (!email) throw new HttpError(400, 'invalid_email');
      const name = oneLine(input.name);
      const organization = oneLine(input.organization);
      const message = lines(input.message);

      // Every file is this client's, and still on the portal.
      const ids = [...new Set(input.fileIds.map((id) => id.toLowerCase()))];
      const files = await ctx.db
        .select()
        .from(schema.files)
        .where(
          and(
            inArray(schema.files.id, ids),
            eq(schema.files.clientId, client.id),
            isNull(schema.files.removedAt),
          ),
        );
      if (files.length !== ids.length || files.some((f) => !f.blobKey || !f.dekWrapped)) {
        throw new HttpError(400, 'file_not_found');
      }
      // "View only" means the page shows it: a file the page cannot show could only be saved.
      if (!input.canDownload && files.some((f) => previewOf(f.contentType) === null)) {
        throw new HttpError(400, 'view_only_needs_preview');
      }
      const pdfs = input.watermark ? files.filter((f) => previewOf(f.contentType) === 'pdf') : [];
      if (pdfs.some((f) => f.size > WATERMARK_MAX_BYTES)) {
        throw new HttpError(400, 'too_large_to_watermark');
      }

      const now = ctx.now();
      const [held] = await ctx.db
        .select({ n: sql<number>`count(*)` })
        .from(schema.fileShare)
        .where(
          and(
            eq(schema.fileShare.recipientEmail, email),
            isNull(schema.fileShare.revokedAt),
            gt(schema.fileShare.expiresAt, now),
          ),
        );
      if (Number(held?.n ?? 0) >= SHARE_MAX_PER_RECIPIENT) {
        throw new HttpError(429, 'recipient_has_too_many');
      }
      if (
        !(await hit(ctx.db, `outside-share:${staff.staffId}`, LIMITS.outsideSharePerStaff, now))
      ) {
        throw new HttpError(429, 'too_many_shares');
      }

      // A PDF that cannot be marked (locked with a password, damaged) is found out now, by the
      // staff member, not later by the recipient.
      const sample = watermarkText({ name, email, organization }, now);
      for (const f of pdfs) {
        let plain: Buffer;
        try {
          plain = await ctx.blobs.read(
            f.blobKey as string,
            ctx.keyring.unwrap(new Uint8Array(f.dekWrapped as Buffer)),
          );
        } catch (err) {
          ctx.log.error({ err, id: f.id }, 'stored file failed to decrypt');
          throw new HttpError(500, 'file_unreadable');
        }
        try {
          await watermarkPdf(plain, sample);
        } catch {
          throw new HttpError(400, 'cannot_watermark');
        }
      }

      const id = randomUUID();
      const secret = randomToken();
      const expiresAt = new Date(now.getTime() + input.days * 86_400_000);
      const actor = actorOf(req);
      await ctx.db.transaction(async (tx) => {
        await tx.insert(schema.fileShare).values({
          id,
          clientId: client.id,
          secretHash: sha256(secret),
          recipientEmail: email,
          recipientName: name,
          organization,
          message,
          canDownload: input.canDownload,
          watermark: input.watermark,
          createdBy: actor.name,
          createdAt: now,
          expiresAt,
        });
        await tx
          .insert(schema.fileShareItem)
          .values(files.map((f) => ({ shareId: id, fileId: f.id })));
      });

      // The link exists nowhere but in this email: if it cannot be sent, there is no share.
      const firm = await firmName(ctx);
      const what = files.length === 1 ? 'a document' : `${files.length} documents`;
      const text = [
        name ? `Hello ${name},` : 'Hello,',
        '',
        `${firm} has shared ${what} with you securely.`,
        ...(message ? ['', message] : []),
        '',
        `View ${files.length === 1 ? 'it' : 'them'} here (expires ${expiresAt.toISOString().slice(0, 10)}):`,
        shareLink(ctx, id, secret),
        '',
        "When you open the page, you'll receive a one-time access code at this address to unlock " +
          `the ${files.length === 1 ? 'document' : 'documents'}.`,
        '',
        'This link is private. Please do not forward it.',
      ].join('\n');
      try {
        await ctx.notifier.send(
          messageTo(email, `${firm} shared a secure document with you`, text),
        );
      } catch (err) {
        ctx.log.error({ err, channel: 'email' }, 'notification failed');
        await ctx.db.delete(schema.fileShare).where(eq(schema.fileShare.id, id));
        throw new HttpError(502, 'email_failed');
      }

      await record(ctx.db, 'outside_share', actor, {
        clientId: client.id,
        fileId: files.length === 1 ? files[0]?.id : null,
        detail: {
          shareId: id,
          to: email,
          files: files.length,
          days: input.days,
          canDownload: input.canDownload,
          watermark: input.watermark,
        },
      });
      res.status(201).json({ shareId: id, expiresAt });
    }),
  );

  r.get(
    '/',
    h(async (req, res) => {
      const q = ListQuery.parse(req.query);
      mustSee(req, q.clientId, 'client_not_found');
      const now = ctx.now();
      const shares = await ctx.db
        .select()
        .from(schema.fileShare)
        .where(eq(schema.fileShare.clientId, q.clientId))
        .orderBy(desc(schema.fileShare.createdAt), desc(schema.fileShare.id))
        .limit(LIST_MAX);
      const items =
        shares.length === 0
          ? []
          : await ctx.db
              .select({
                shareId: schema.fileShareItem.shareId,
                fileId: schema.files.id,
                name: schema.files.name,
                removedAt: schema.files.removedAt,
              })
              .from(schema.fileShareItem)
              .innerJoin(schema.files, eq(schema.files.id, schema.fileShareItem.fileId))
              .where(
                inArray(
                  schema.fileShareItem.shareId,
                  shares.map((s) => s.id),
                ),
              )
              .orderBy(asc(schema.files.name), asc(schema.files.id));
      res.json({
        shares: shares.map((s) => ({
          id: s.id,
          email: s.recipientEmail,
          name: s.recipientName,
          organization: s.organization,
          canDownload: s.canDownload,
          watermark: s.watermark,
          createdAt: s.createdAt,
          createdBy: s.createdBy,
          expiresAt: s.expiresAt,
          revokedAt: s.revokedAt,
          opens: s.opens,
          lastOpenedAt: s.lastOpenedAt,
          status: shareStatus(s, now),
          files: items
            .filter((i) => i.shareId === s.id)
            .map((i) => ({ fileId: i.fileId, name: i.name, removed: i.removedAt !== null })),
        })),
      });
    }),
  );

  r.delete(
    '/:id',
    h(async (req, res) => {
      const id = Uuid.safeParse(req.params['id']);
      if (!id.success) throw new HttpError(404, 'not_found');
      const [share] = await ctx.db
        .select()
        .from(schema.fileShare)
        .where(eq(schema.fileShare.id, id.data));
      if (!share) throw new HttpError(404, 'not_found');
      mustSee(req, share.clientId);
      const actor = actorOf(req);
      const ended = await ctx.db
        .update(schema.fileShare)
        .set({ revokedAt: ctx.now(), revokedBy: actor.name })
        .where(and(eq(schema.fileShare.id, share.id), isNull(schema.fileShare.revokedAt)))
        .returning({ id: schema.fileShare.id });
      // A browser that had given the code stops at once.
      await ctx.db.delete(schema.fileShareGrant).where(eq(schema.fileShareGrant.shareId, share.id));
      if (ended.length > 0) {
        await record(ctx.db, 'outside_share_revoked', actor, {
          clientId: share.clientId,
          detail: { shareId: share.id, to: share.recipientEmail },
        });
      }
      res.json({ ok: true });
    }),
  );

  return r;
}
