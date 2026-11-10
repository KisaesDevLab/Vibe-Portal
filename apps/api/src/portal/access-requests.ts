// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// "Request access" (D5). The person confirms their email or phone with a code first; only
// confirmed requests reach staff (P16). The code goes to the email when one is given, else by
// text; only that contact counts as confirmed and is used when staff approve (QA 2026-11-09).
//
//   POST /api/portal/access-requests              { name, email?, phone?, clientAs, note? }
//        -> { requestId, sentTo }
//   POST /api/portal/access-requests/:id/resend   -> { sentTo }  (a new code)
//   POST /api/portal/access-requests/:id/confirm  { code }

import express, { type Router } from 'express';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@vibe-portal/db';

import { checkCode, issue } from '../auth/challenges';
import { deliver, firmName, type Ctx } from '../context';
import { maskContact, normalizeEmail, normalizePhone } from '../lib/contact';
import { record } from '../lib/events';
import { body, clientIp, h, HttpError } from '../lib/http';
import { messageTo } from '../lib/notify';
import { hit, LIMITS } from '../lib/rate-limit';
import { sha256, sixDigitCode } from '../lib/secrets';

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

  /** Sends a new confirmation code for a request to `to`. */
  async function sendCode(requestId: string, to: string, now: Date): Promise<void> {
    const code = sixDigitCode();
    await issue(
      ctx.db,
      {
        kind: 'request_confirm',
        accessRequestId: requestId,
        contact: to,
        secretHash: sha256(code),
        expiresAt: new Date(now.getTime() + CONFIRM_MINUTES * 60_000),
      },
      now,
    );
    const firm = await firmName(ctx);
    deliver(
      ctx,
      messageTo(
        to,
        `Confirm your request to ${firm}`,
        `${code} is your code to confirm your request for access to ${firm}'s client portal.`,
      ),
    );
  }

  const requestId = (raw: string | undefined): string => {
    const id = z.string().uuid().safeParse(raw);
    if (!id.success) throw new HttpError(404, 'not_found');
    return id.data;
  };

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
      if (!(await hit(ctx.db, `request:contact:${sendTo}`, LIMITS.requestPerContact, now))) {
        throw new HttpError(429, 'too_many_requests');
      }

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
      await sendCode(request.id, sendTo, now);
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
    '/:id/resend',
    h(async (req, res) => {
      const id = requestId(req.params['id']);
      const now = ctx.now();
      if (!(await hit(ctx.db, `request:ip:${clientIp(req)}`, LIMITS.requestPerIp, now))) {
        throw new HttpError(429, 'too_many_requests');
      }
      const [request] = await ctx.db
        .select()
        .from(schema.accessRequest)
        .where(
          and(
            eq(schema.accessRequest.id, id),
            eq(schema.accessRequest.status, 'pending'),
            isNull(schema.accessRequest.confirmedAt),
          ),
        );
      const sendTo = request?.email ?? request?.phone;
      if (!request || !sendTo) throw new HttpError(404, 'not_found');
      if (!(await hit(ctx.db, `request:contact:${sendTo}`, LIMITS.requestPerContact, now))) {
        throw new HttpError(429, 'too_many_requests');
      }
      await sendCode(id, sendTo, now);
      res.json({ sentTo: maskContact(sendTo) });
    }),
  );

  r.post(
    '/:id/confirm',
    h(async (req, res) => {
      const id = requestId(req.params['id']);
      const { code } = body(ConfirmSchema, req);
      const now = ctx.now();
      if (!(await hit(ctx.db, `verify:ip:${clientIp(req)}`, LIMITS.verifyPerIp, now))) {
        throw new HttpError(429, 'too_many_requests');
      }
      const ch = await checkCode(
        ctx.db,
        and(
          eq(schema.signInChallenge.kind, 'request_confirm'),
          eq(schema.signInChallenge.accessRequestId, id),
        ),
        code,
        now,
      );
      if (!ch) throw new HttpError(400, 'code_wrong');
      await ctx.db
        .update(schema.accessRequest)
        .set({ confirmedAt: now, confirmedContact: ch.contact })
        .where(and(eq(schema.accessRequest.id, id), isNull(schema.accessRequest.confirmedAt)));
      await record(
        ctx.db,
        'request_confirmed',
        { kind: 'system', name: 'portal' },
        {
          detail: { accessRequestId: id },
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
