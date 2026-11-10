// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// The recipient's side of a secure link (P49, see firm/shares.ts). They have no account: the
// link's secret (sent in the body, never in a URL the server sees) finds the share, a 6-digit
// code sent to their mailbox proves it is them, and a cookie then opens the files for half an
// hour. Every call checks that the link is still good: not ended, not expired, client still on.
//
//   POST /api/portal/shared/:id/open     { key }         what the page shows; files once verified
//   POST /api/portal/shared/:id/code     { key }         emails a code
//   POST /api/portal/shared/:id/verify   { key, code }   the code; sets the cookie
//   GET  /api/portal/shared/:id/files/:fileId/content?mode=view|download
//
// A wrong id or key is "not found", whatever else is wrong with the request.

import express, { type Request, type Response, type Router } from 'express';
import { and, asc, desc, eq, gt, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm';
import { parse, serialize } from 'cookie';
import { z } from 'zod';
import { schema } from '@vibe-portal/db';

import { firmName, type Ctx } from '../context';
import { wontFit } from '../firm/shares';
import { cannotMark, dropMarksOfShare, markedCopy } from '../files/marks';
import { sendStored } from '../files/send';
import { previewOf } from '../files/types';
import { maskContact } from '../lib/contact';
import { record, type Actor } from '../lib/events';
import { clientIp, h, HttpError } from '../lib/http';
import { messageTo } from '../lib/notify';
import { hit, LIMITS, refund } from '../lib/rate-limit';
import { randomToken, sameHash, sha256, sixDigitCode } from '../lib/secrets';

export const SHARE_COOKIE = '__vibe_share';
export const SHARE_CODE_MINUTES = 10;
export const SHARE_GRANT_MINUTES = 30;
/** Wrong tries one code takes before a new one is needed. */
export const SHARE_CODE_TRIES = 5;
/** Wrong codes since the last right one that end the link: staff must send a new one. */
export const SHARE_MAX_WRONG = 15;
const CODE_WAIT_SECONDS = 60;

const Uuid = z.string().uuid();
const KeySchema = z.object({ key: z.string().min(1).max(200) });
const ContentQuery = z.object({ mode: z.enum(['view', 'download']).default('download') });

type Share = typeof schema.fileShare.$inferSelect;

export function sharedRouter(ctx: Ctx): Router {
  const r = express.Router();

  r.use(
    h(async (req, _res, next) => {
      if (!(await hit(ctx.db, `outside:ip:${clientIp(req)}`, LIMITS.outsidePerIp, ctx.now()))) {
        throw new HttpError(429, 'too_many_requests');
      }
      next();
    }),
  );

  const recipient = (s: Share): Actor => ({ kind: 'recipient', name: s.recipientEmail });

  /** 410 unless the link still works. */
  const usable = async (s: Share): Promise<void> => {
    if (s.revokedAt) {
      throw new HttpError(410, s.revokedBy === 'lockout' ? 'share_locked' : 'share_revoked');
    }
    if (s.expiresAt.getTime() <= ctx.now().getTime()) throw new HttpError(410, 'share_expired');
    // A client turned off takes their links with them, for as long as they are off.
    const [c] = await ctx.db
      .select({ active: schema.clients.active })
      .from(schema.clients)
      .where(eq(schema.clients.id, s.clientId));
    if (!c?.active) throw new HttpError(410, 'share_revoked');
  };

  /** The share the request's id and key name, if it still works. */
  const load = async (req: Request): Promise<Share> => {
    const id = Uuid.safeParse(req.params['id']);
    const k = KeySchema.safeParse(req.body);
    if (!id.success || !k.success) throw new HttpError(404, 'not_found');
    const [s] = await ctx.db
      .select()
      .from(schema.fileShare)
      .where(eq(schema.fileShare.id, id.data));
    // Hashed either way, so an id that exists takes no longer to refuse than one that does not.
    const given = sha256(k.data.key);
    if (!s || !sameHash(s.secretHash, given)) throw new HttpError(404, 'not_found');
    await usable(s);
    return s;
  };

  /** Until when this browser may open the share's files; null when it has not given a code. */
  const granted = async (req: Request, shareId: string): Promise<Date | null> => {
    const token = parse(req.headers.cookie ?? '')[SHARE_COOKIE];
    if (!token) return null;
    const [g] = await ctx.db
      .select({ expiresAt: schema.fileShareGrant.expiresAt })
      .from(schema.fileShareGrant)
      .where(
        and(
          eq(schema.fileShareGrant.tokenHash, sha256(token)),
          eq(schema.fileShareGrant.shareId, shareId),
          gt(schema.fileShareGrant.expiresAt, ctx.now()),
        ),
      );
    return g?.expiresAt ?? null;
  };

  /** What the page shows. File names only once the code has been given. */
  const shown = async (s: Share, verifiedUntil: Date | null) => {
    const files = await ctx.db
      .select({
        id: schema.files.id,
        name: schema.files.name,
        size: schema.files.size,
        contentType: schema.files.contentType,
        blobKey: schema.files.blobKey,
      })
      .from(schema.fileShareItem)
      .innerJoin(schema.files, eq(schema.files.id, schema.fileShareItem.fileId))
      .where(
        and(
          eq(schema.fileShareItem.shareId, s.id),
          isNull(schema.files.removedAt),
          isNotNull(schema.files.blobKey),
        ),
      )
      .orderBy(asc(schema.files.name), asc(schema.files.id));
    const base = {
      firmName: await firmName(ctx),
      emailMasked: maskContact(s.recipientEmail),
      expiresAt: s.expiresAt,
      canDownload: s.canDownload,
      count: files.length,
      verified: false,
    };
    if (!verifiedUntil) return base;
    return {
      ...base,
      verified: true,
      recipientName: s.recipientName,
      organization: s.organization,
      verifiedUntil,
      files: files.map((f) => ({
        id: f.id,
        name: f.name,
        size: f.size,
        preview: previewOf(f.contentType),
        // False when the file has since changed into something this link does not allow
        // (Vibe Files replaced its content): listed, but it does not open.
        // Or a marked link's PDF found not to be markable (a locked or damaged new version).
        available:
          wontFit(s, f) === null &&
          !(s.watermark && previewOf(f.contentType) === 'pdf' && cannotMark(f.blobKey)),
      })),
    };
  };

  const setCookie = (res: Response, shareId: string, token: string): void => {
    res.append(
      'Set-Cookie',
      serialize(SHARE_COOKIE, token, {
        httpOnly: true,
        sameSite: 'strict',
        secure: ctx.cookie.secure,
        // Sent only to this share's calls: another share in the same browser has its own.
        path: `/api/portal/shared/${shareId}`,
        maxAge: SHARE_GRANT_MINUTES * 60,
      }),
    );
  };

  r.post(
    '/:id/open',
    h(async (req, res) => {
      const s = await load(req);
      res.json(await shown(s, await granted(req, s.id)));
    }),
  );

  r.post(
    '/:id/code',
    h(async (req, res) => {
      const s = await load(req);
      const now = ctx.now();
      if (!(await hit(ctx.db, `outside:code:ip:${clientIp(req)}`, LIMITS.outsideCodePerIp, now))) {
        throw new HttpError(429, 'too_many_requests');
      }
      const [last] = await ctx.db
        .select({ createdAt: schema.fileShareCode.createdAt })
        .from(schema.fileShareCode)
        .where(eq(schema.fileShareCode.shareId, s.id))
        .orderBy(desc(schema.fileShareCode.createdAt))
        .limit(1);
      if (last && now.getTime() - last.createdAt.getTime() < CODE_WAIT_SECONDS * 1000) {
        throw new HttpError(429, 'code_wait');
      }
      // Counted in one statement, so two calls at once cannot both get a code. Given back if
      // the email then fails: a code never sent does not use up the minute or the day.
      const perMinute = `outside:code:min:${s.id}`;
      const perDay = `outside:code:day:${s.id}`;
      if (!(await hit(ctx.db, perMinute, LIMITS.outsideCodeMinute, now))) {
        throw new HttpError(429, 'code_wait');
      }
      if (!(await hit(ctx.db, perDay, LIMITS.outsideCodeDay, now))) {
        await refund(ctx.db, perMinute, LIMITS.outsideCodeMinute, now);
        throw new HttpError(429, 'too_many_codes');
      }
      const code = sixDigitCode();
      const [row] = await ctx.db
        .insert(schema.fileShareCode)
        .values({
          shareId: s.id,
          codeHash: sha256(`${s.id}:${code}`),
          createdAt: now,
          expiresAt: new Date(now.getTime() + SHARE_CODE_MINUTES * 60_000),
        })
        .returning({ id: schema.fileShareCode.id });
      if (!row) throw new Error('code not stored');
      const text = [
        `Your access code is: ${code}`,
        '',
        `Enter it on the page you opened from ${await firmName(ctx)}'s email. The code expires in ` +
          `${SHARE_CODE_MINUTES} minutes.`,
        '',
        'If you did not request this, you can ignore this message.',
      ].join('\n');
      try {
        await ctx.notifier.send(messageTo(s.recipientEmail, 'Your document access code', text));
      } catch (err) {
        ctx.log.error({ err, channel: 'email' }, 'notification failed');
        // The earlier code, if any, still works: nothing new reached the mailbox.
        await ctx.db.delete(schema.fileShareCode).where(eq(schema.fileShareCode.id, row.id));
        await refund(ctx.db, perMinute, LIMITS.outsideCodeMinute, now);
        await refund(ctx.db, perDay, LIMITS.outsideCodeDay, now);
        throw new HttpError(502, 'email_failed');
      }
      // One live code: once the new one is sent, the earlier ones stop working.
      await ctx.db
        .update(schema.fileShareCode)
        .set({ usedAt: now })
        .where(
          and(
            eq(schema.fileShareCode.shareId, s.id),
            isNull(schema.fileShareCode.usedAt),
            ne(schema.fileShareCode.id, row.id),
          ),
        );
      await record(ctx.db, 'outside_code_sent', recipient(s), {
        clientId: s.clientId,
        detail: { shareId: s.id },
      });
      res.json({ ok: true, emailMasked: maskContact(s.recipientEmail) });
    }),
  );

  r.post(
    '/:id/verify',
    h(async (req, res) => {
      const s = await load(req);
      const now = ctx.now();
      if (
        !(await hit(ctx.db, `outside:verify:ip:${clientIp(req)}`, LIMITS.outsideVerifyPerIp, now))
      ) {
        throw new HttpError(429, 'too_many_requests');
      }
      const raw = (req.body as { code?: unknown }).code;
      const code = typeof raw === 'string' ? raw.trim() : '';
      // Not a code at all (a slip of the hand, an empty box): no try is used.
      if (!/^\d{6}$/.test(code)) throw new HttpError(400, 'code_wrong');

      const [live] = await ctx.db
        .select()
        .from(schema.fileShareCode)
        .where(
          and(
            eq(schema.fileShareCode.shareId, s.id),
            isNull(schema.fileShareCode.usedAt),
            gt(schema.fileShareCode.expiresAt, now),
            lt(schema.fileShareCode.attempts, SHARE_CODE_TRIES),
          ),
        )
        .orderBy(desc(schema.fileShareCode.createdAt))
        .limit(1);
      if (!live) throw new HttpError(400, 'code_expired');
      // The try is counted before the code is compared, so tries at once cannot share one.
      const [tried] = await ctx.db
        .update(schema.fileShareCode)
        .set({ attempts: sql`${schema.fileShareCode.attempts} + 1` })
        .where(
          and(
            eq(schema.fileShareCode.id, live.id),
            isNull(schema.fileShareCode.usedAt),
            lt(schema.fileShareCode.attempts, SHARE_CODE_TRIES),
          ),
        )
        .returning();
      if (!tried) throw new HttpError(400, 'code_expired');

      if (!sameHash(tried.codeHash, sha256(`${s.id}:${code}`))) {
        const [after] = await ctx.db
          .update(schema.fileShare)
          .set({ wrongTries: sql`${schema.fileShare.wrongTries} + 1` })
          .where(eq(schema.fileShare.id, s.id))
          .returning({ wrongTries: schema.fileShare.wrongTries });
        if ((after?.wrongTries ?? 0) >= SHARE_MAX_WRONG) {
          // Someone holds the link and is guessing: it ends, and staff see why.
          const ended = await ctx.db
            .update(schema.fileShare)
            .set({ revokedAt: now, revokedBy: 'lockout' })
            .where(and(eq(schema.fileShare.id, s.id), isNull(schema.fileShare.revokedAt)))
            .returning({ id: schema.fileShare.id });
          await ctx.db.delete(schema.fileShareGrant).where(eq(schema.fileShareGrant.shareId, s.id));
          await dropMarksOfShare(ctx, s.id);
          if (ended.length > 0) {
            await record(
              ctx.db,
              'outside_locked',
              { kind: 'system', name: 'portal' },
              {
                clientId: s.clientId,
                detail: { shareId: s.id, to: s.recipientEmail, ip: clientIp(req) },
              },
            );
          }
          throw new HttpError(410, 'share_locked');
        }
        throw new HttpError(400, tried.attempts >= SHARE_CODE_TRIES ? 'code_locked' : 'code_wrong');
      }

      const [used] = await ctx.db
        .update(schema.fileShareCode)
        .set({ usedAt: now })
        .where(and(eq(schema.fileShareCode.id, tried.id), isNull(schema.fileShareCode.usedAt)))
        .returning({ id: schema.fileShareCode.id });
      if (!used) throw new HttpError(400, 'code_expired');

      const token = randomToken();
      const until = new Date(now.getTime() + SHARE_GRANT_MINUTES * 60_000);
      await ctx.db
        .insert(schema.fileShareGrant)
        .values({ tokenHash: sha256(token), shareId: s.id, expiresAt: until });
      await ctx.db
        .update(schema.fileShare)
        .set({
          opens: sql`${schema.fileShare.opens} + 1`,
          firstOpenedAt: sql`coalesce(${schema.fileShare.firstOpenedAt}, ${now.toISOString()}::timestamptz)`,
          lastOpenedAt: now,
          wrongTries: 0,
        })
        .where(eq(schema.fileShare.id, s.id));
      setCookie(res, s.id, token);
      await record(ctx.db, 'outside_verified', recipient(s), {
        clientId: s.clientId,
        detail: { shareId: s.id, ip: clientIp(req) },
      });
      res.json(await shown(s, until));
    }),
  );

  r.get(
    '/:id/files/:fileId/content',
    h(async (req, res) => {
      // The cookie first: without it nothing is said about the share, not even that it exists.
      const id = Uuid.safeParse(req.params['id']);
      if (!id.success || !(await granted(req, id.data))) throw new HttpError(401, 'not_verified');
      const [s] = await ctx.db
        .select()
        .from(schema.fileShare)
        .where(eq(schema.fileShare.id, id.data));
      if (!s) throw new HttpError(401, 'not_verified');
      await usable(s);
      const fileId = Uuid.safeParse(req.params['fileId']);
      if (!fileId.success) throw new HttpError(404, 'not_found');
      const { mode } = ContentQuery.parse(req.query);
      const [row] = await ctx.db
        .select({ f: schema.files })
        .from(schema.fileShareItem)
        .innerJoin(schema.files, eq(schema.files.id, schema.fileShareItem.fileId))
        .where(
          and(
            eq(schema.fileShareItem.shareId, s.id),
            eq(schema.fileShareItem.fileId, fileId.data),
            isNull(schema.files.removedAt),
          ),
        );
      const f = row?.f;
      if (!f || !f.blobKey || !f.dekWrapped) throw new HttpError(404, 'not_found');
      // The file may have changed since the link was made: the link's rules hold for it as it is.
      if (wontFit(s, f)) throw new HttpError(409, 'not_available');

      const preview = previewOf(f.contentType);
      const inline = mode === 'view' && preview !== null;
      // View only: nothing is sent as a file to keep.
      if (!inline && !s.canDownload) throw new HttpError(403, 'view_only');

      const blobKey = f.blobKey;
      const dekWrapped = f.dekWrapped;
      const noted = async (): Promise<void> => {
        await record(ctx.db, inline ? 'outside_view' : 'outside_download', recipient(s), {
          clientId: s.clientId,
          fileId: f.id,
          detail: { shareId: s.id, ip: clientIp(req) },
        });
      };
      const inlineType = inline ? f.contentType : null;

      if (s.watermark && preview === 'pdf') {
        // Marked or not sent: an unmarked copy never goes out in place of a marked one. The
        // marked copy is made once a day (in a worker) and kept; see files/marks.ts.
        const source = { id: f.id, blobKey, dekWrapped, size: f.size };
        const send = async (fresh: boolean): Promise<void> => {
          const m = await markedCopy(ctx, s, source, fresh);
          await sendStored(
            ctx,
            res,
            {
              id: f.id,
              blobKey: m.blobKey,
              dekWrapped: m.dekWrapped,
              size: m.size,
              name: f.name,
              inlineType,
            },
            noted,
          );
        };
        try {
          await send(false);
        } catch (err) {
          // A kept copy that cannot be read is made again, once, before anything was sent.
          if (!(err instanceof HttpError) || err.code !== 'file_unreadable' || res.headersSent) {
            throw err;
          }
          await send(true);
        }
        return;
      }

      await sendStored(
        ctx,
        res,
        { id: f.id, blobKey, dekWrapped, size: f.size, name: f.name, inlineType },
        noted,
      );
    }),
  );

  return r;
}
