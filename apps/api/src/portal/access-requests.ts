// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// "Request access" (D5). The person confirms their email or phone with a code first; only
// confirmed requests reach staff (P16). The code goes to the email when one is given, else by
// text; only that contact counts as confirmed and is used when staff approve (QA 2026-11-09).
//
//   POST /api/portal/access-requests              { name, email?, phone?, clientAs, note? }
//        -> { requestId, sentTo }
//   POST /api/portal/access-requests/:id/resend   -> { sentTo }  (a new code)
//   POST /api/portal/access-requests/:id/id-photo  the photo ID (P67), before confirming
//   POST /api/portal/access-requests/:id/confirm  { code }   needs the photo ID (P67)

import express, { type Router } from 'express';
import { and, eq, isNull, ne, or } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@vibe-portal/db';

import { checkCode, issue } from '../auth/challenges';
import { deliver, firmName, type Ctx } from '../context';
import { isUsCanadaPhone, maskContact, normalizeEmail, normalizePhone } from '../lib/contact';
import { record } from '../lib/events';
import { body, clientIp, h, HttpError } from '../lib/http';
import { messageTo } from '../lib/notify';
import { hit, LIMITS } from '../lib/rate-limit';
import { sha256, sixDigitCode } from '../lib/secrets';
import { BREAKGLASS_EMAIL } from '../staff/sso';
import type { BarcodeReader } from '../files/barcode';
import type { HeicConverter } from './uploads';
import { dropUnasked, storeIdPhoto } from './access-id';

export const CONFIRM_MINUTES = 15;

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().max(254).optional(),
  phone: z.string().trim().max(32).optional(),
  clientAs: z.string().trim().min(1).max(200),
  note: z.string().trim().max(1000).optional(),
});
const ConfirmSchema = z.object({
  code: z.string().regex(/^\d{6}$/),
  /** Layer A: "My ID has no barcode" (a passport, a foreign ID): the front alone, flagged. */
  noBarcode: z.boolean().optional(),
});
const Side = z.enum(['front', 'back']).default('front');

export function accessRequestsRouter(
  ctx: Ctx,
  convertHeic?: HeicConverter,
  readBarcode?: BarcodeReader,
): Router {
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
      // P47: this page is open to anyone, so it only texts US and Canadian numbers.
      if (phone && !email && !isUsCanadaPhone(phone)) throw new HttpError(400, 'phone_us_only');
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

  // P67: the photo ID, sent after the request is made and before the code is given. Sent again,
  // it replaces the first. Only for a request still waiting for its code. Layer A: `?side=back`
  // is the back, whose barcode is read (the front when left out, as the page before sent it).
  r.post(
    '/:id/id-photo',
    h(async (req, res) => {
      const id = requestId(req.params['id']);
      const side = Side.safeParse(req.query['side']);
      if (!side.success) throw new HttpError(400, 'invalid_side');
      const now = ctx.now();
      if (!(await hit(ctx.db, `id-photo:ip:${clientIp(req)}`, LIMITS.idPhotoPerIp, now))) {
        throw new HttpError(429, 'too_many_requests');
      }
      const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
      if (type !== 'application/octet-stream') throw new HttpError(415, 'id_type');
      // Its kind is read from its content: no file name (it would reach proxy logs, P47).
      const [request] = await ctx.db
        .select({ id: schema.accessRequest.id })
        .from(schema.accessRequest)
        .where(
          and(
            eq(schema.accessRequest.id, id),
            eq(schema.accessRequest.status, 'pending'),
            isNull(schema.accessRequest.confirmedAt),
          ),
        );
      if (!request) throw new HttpError(404, 'not_found');
      // Only what the firm asks for is kept (P88): no ID at all with "none", and the back
      // only with "front and back". A picture of an ID nobody asked for is not held.
      const [firm] = await ctx.db.select({ mode: schema.firm.requestIdMode }).from(schema.firm);
      const mode = firm?.mode ?? 'photo';
      if (mode === 'none' || (side.data === 'back' && mode !== 'scan')) {
        throw new HttpError(400, 'id_not_asked');
      }
      const stored = await storeIdPhoto(ctx, request.id, req, side.data, convertHeic, readBarcode);
      res.status(201).json({
        ok: true,
        contentType: stored.contentType,
        // The back only: false when no licence barcode was read (the page asks once more).
        ...(stored.readable === undefined ? {} : { readable: stored.readable }),
      });
    }),
  );

  r.post(
    '/:id/confirm',
    h(async (req, res) => {
      const id = requestId(req.params['id']);
      const { code, noBarcode } = body(ConfirmSchema, req);
      const now = ctx.now();
      if (!(await hit(ctx.db, `verify:ip:${clientIp(req)}`, LIMITS.verifyPerIp, now))) {
        throw new HttpError(429, 'too_many_requests');
      }
      // P67: no request reaches staff without a photo ID (asked before the code is used up).
      // P88: unless the firm asks for none; and with "front and back", the back too, or the
      // person's word that the ID has no barcode.
      const [held] = await ctx.db
        .select({
          front: schema.accessRequest.idBlobKey,
          back: schema.accessRequest.idBackBlobKey,
        })
        .from(schema.accessRequest)
        .where(eq(schema.accessRequest.id, id));
      const [firm] = await ctx.db.select({ mode: schema.firm.requestIdMode }).from(schema.firm);
      const mode = firm?.mode ?? 'photo';
      if (held && mode !== 'none') {
        if (!held.front) throw new HttpError(400, 'id_required');
        if (mode === 'scan' && !held.back && !noBarcode) {
          throw new HttpError(400, 'id_back_required');
        }
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
      const [confirmed] = await ctx.db
        .update(schema.accessRequest)
        .set({
          confirmedAt: now,
          confirmedContact: ch.contact,
          // Said to have no barcode, and no back was sent: flagged for staff.
          ...(mode === 'scan' && held && !held.back ? { idFlags: ['no_barcode' as const] } : {}),
        })
        .where(and(eq(schema.accessRequest.id, id), isNull(schema.accessRequest.confirmedAt)))
        .returning({ name: schema.accessRequest.name, clientAs: schema.accessRequest.clientAs });
      // Pictures sent while the firm asked for more than it does now are not kept.
      if (confirmed) await dropUnasked(ctx, id, mode);
      // P59: the request is now on the staff page; tell the staff an admin ticked (once).
      if (confirmed) await tellStaff(ctx, confirmed);
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

/**
 * P59: emails the staff an admin ticked ("Email new access requests") that a confirmed request is
 * waiting. Only staff who see every client (they alone see and approve requests), active, and
 * never the Vibe Auth emergency account. The person's name and what they typed only: their
 * contact and note stay on the staff page.
 */
export async function tellStaff(ctx: Ctx, r: { name: string; clientAs: string }): Promise<number> {
  const staff = await ctx.db
    .select({ email: schema.staffUsers.email })
    .from(schema.staffUsers)
    .where(
      and(
        eq(schema.staffUsers.notifyAccessRequests, true),
        eq(schema.staffUsers.active, true),
        or(eq(schema.staffUsers.admin, true), eq(schema.staffUsers.allClients, true)),
        ne(schema.staffUsers.email, BREAKGLASS_EMAIL),
      ),
    );
  if (!staff.length) return 0;
  const firm = await firmName(ctx);
  const link = `${ctx.portalUrl}/staff/requests`;
  for (const s of staff) {
    deliver(
      ctx,
      messageTo(
        s.email,
        `Access request from ${r.name}`,
        `${r.name} asked for access to ${firm}'s client portal and confirmed their contact. ` +
          `They say they are with: ${r.clientAs}\n\nChoose their clients and approve or deny the ` +
          `request on the staff page: ${link}`,
      ),
    );
  }
  return staff.length;
}
