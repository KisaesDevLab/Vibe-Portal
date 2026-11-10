// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// "Request access" (D5). The person confirms their email or phone with a code first; only
// confirmed requests reach staff (P16).
//
//   POST /api/portal/access-requests              { name, email?, phone?, clientAs, note? }
//        -> { requestId, sentTo }  (code by email when given, else by text)
//   POST /api/portal/access-requests/:id/confirm  { code }

import express, { type Router } from 'express';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@vibe-portal/db';

import { MAX_ATTEMPTS } from '../auth/client-auth';
import { firmName, type Ctx } from '../context';
import { maskContact, normalizeEmail, normalizePhone } from '../lib/contact';
import { record } from '../lib/events';
import { body, clientIp, h, HttpError } from '../lib/http';
import { messageTo } from '../lib/notify';
import { hit, LIMITS } from '../lib/rate-limit';
import { sameHash, sha256, sixDigitCode } from '../lib/secrets';

export const CONFIRM_MINUTES = 15;

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().max(254).optional(),
  phone: z.string().trim().max(32).optional(),
  clientAs: z.string().trim().min(1).max(200),
  note: z.string().trim().max(1000).optional(),
});
const ConfirmSchema = z.object({ code: z.string().regex(/^\d{6}$/) });

export function accessRequestsRouter(ctx: Ctx): Router {
  const r = express.Router();

  r.post(
    '/',
    h(async (req, res) => {
      const input = body(CreateSchema, req);
      const now = ctx.now();
      if (!(await hit(ctx.db, `request:ip:${clientIp(req)}`, LIMITS.requestPerIp, now))) {
        throw new HttpError(429, 'too_many_requests');
      }
      const email = input.email ? normalizeEmail(input.email) : null;
      const phone = input.phone ? normalizePhone(input.phone) : null;
      if (input.email && !email) throw new HttpError(400, 'invalid_email');
      if (input.phone && !phone) throw new HttpError(400, 'invalid_phone');
      const sendTo = email ?? phone;
      if (!sendTo) throw new HttpError(400, 'contact_required');

      const [request] = await ctx.db
        .insert(schema.accessRequest)
        .values({
          name: input.name,
          email,
          phone,
          clientAs: input.clientAs,
          note: input.note ?? '',
        })
        .returning({ id: schema.accessRequest.id });
      if (!request) throw new Error('access request insert returned nothing');
      const code = sixDigitCode();
      await ctx.db.insert(schema.signInChallenge).values({
        kind: 'request_confirm',
        accessRequestId: request.id,
        contact: sendTo,
        secretHash: sha256(code),
        expiresAt: new Date(now.getTime() + CONFIRM_MINUTES * 60_000),
      });
      const firm = await firmName(ctx);
      await ctx.notifier.send(
        messageTo(
          sendTo,
          `Confirm your request to ${firm}`,
          `${code} is your code to confirm your request for access to ${firm}'s client portal.`,
        ),
      );
      await record(
        ctx.db,
        'request',
        { kind: 'system', name: 'portal' },
        {
          detail: { accessRequestId: request.id },
        },
      );
      res.status(201).json({ requestId: request.id, sentTo: maskContact(sendTo) });
    }),
  );

  r.post(
    '/:id/confirm',
    h(async (req, res) => {
      const id = z.string().uuid().safeParse(req.params['id']);
      if (!id.success) throw new HttpError(404, 'not_found');
      const { code } = body(ConfirmSchema, req);
      const now = ctx.now();
      if (!(await hit(ctx.db, `verify:ip:${clientIp(req)}`, LIMITS.verifyPerIp, now))) {
        throw new HttpError(429, 'too_many_requests');
      }
      const [ch] = await ctx.db
        .select()
        .from(schema.signInChallenge)
        .where(
          and(
            eq(schema.signInChallenge.kind, 'request_confirm'),
            eq(schema.signInChallenge.accessRequestId, id.data),
            isNull(schema.signInChallenge.usedAt),
            gt(schema.signInChallenge.expiresAt, now),
          ),
        )
        .orderBy(desc(schema.signInChallenge.createdAt))
        .limit(1);
      if (!ch || ch.attempts >= MAX_ATTEMPTS) throw new HttpError(400, 'code_wrong');
      const right = sameHash(ch.secretHash, sha256(code));
      await ctx.db
        .update(schema.signInChallenge)
        .set(right ? { usedAt: now } : { attempts: ch.attempts + 1 })
        .where(eq(schema.signInChallenge.id, ch.id));
      if (!right) throw new HttpError(400, 'code_wrong');
      await ctx.db
        .update(schema.accessRequest)
        .set({ confirmedAt: now })
        .where(eq(schema.accessRequest.id, id.data));
      await record(
        ctx.db,
        'request_confirmed',
        { kind: 'system', name: 'portal' },
        {
          detail: { accessRequestId: id.data },
        },
      );
      res.json({
        ok: true,
        message: 'Thank you. The firm will confirm your access and let you know.',
      });
    }),
  );

  return r;
}
