// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// A signed-in person's own account (P50): the mobile number they sign in with by text.
//
// The number is stored only after a code texted to it is typed back, so it is proved like every
// other contact on an account (P45). The code is its own kind of secret (`phone_confirm`), never
// a sign-in code: a sign-in code signs in whoever receives it, and a mistyped number must not
// give a stranger the account. Asking for a code answers the same whether or not the number is
// on another account (a signed-in person cannot probe which numbers have accounts); that is
// refused only once the code proves the person holds the number.
//
//   POST   /api/portal/account/phone          { phone }  -> a code texted to the number
//   POST   /api/portal/account/phone/verify   { code }   -> the number is stored
//   DELETE /api/portal/account/phone                     -> back to signing in by email
//
// A firm without text messages (SMS_PROVIDER=none) offers none of this (`texts_off`); /auth/me
// says so (`textsOn`), and removing a number still works.

import express, { type Router } from 'express';
import { and, eq, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@vibe-portal/db';

import { checkCode, issue } from '../auth/challenges';
import { CODE_MINUTES, requireClient } from '../auth/client-auth';
import { deliver, firmName, type Ctx } from '../context';
import { isUsCanadaPhone, maskContact, normalizePhone } from '../lib/contact';
import { record } from '../lib/events';
import { body, clientIp, h, HttpError } from '../lib/http';
import { messageTo } from '../lib/notify';
import { hit, LIMITS } from '../lib/rate-limit';
import { sha256, sixDigitCode } from '../lib/secrets';

/** How long a code to confirm a number works: as long as a sign-in code. */
export const PHONE_CODE_MINUTES = CODE_MINUTES;

const PhoneSchema = z.object({ phone: z.string().min(7).max(32) });
const CodeSchema = z.object({ code: z.string().regex(/^\d{6}$/) });

async function identityOf(ctx: Ctx, id: string) {
  const [who] = await ctx.db
    .select()
    .from(schema.portalIdentity)
    .where(eq(schema.portalIdentity.id, id));
  if (!who) throw new HttpError(401, 'signed_out');
  return who;
}

/**
 * Texts a code to confirm `phone` (normalised) for the identity. Checks the number is US or
 * Canadian, not already theirs, and within the limits. Used here and when an invitation is
 * accepted with "also sign in by text".
 */
export async function sendPhoneCode(ctx: Ctx, identityId: string, phone: string): Promise<void> {
  if (ctx.textsOff) throw new HttpError(409, 'texts_off');
  if (!isUsCanadaPhone(phone)) throw new HttpError(400, 'phone_us_only');
  const who = await identityOf(ctx, identityId);
  if (who.phone === phone) throw new HttpError(409, 'phone_already_yours');
  const now = ctx.now();
  if (
    !(await hit(ctx.db, `phone:identity:${identityId}`, LIMITS.phoneConfirmPerIdentity, now)) ||
    !(await hit(ctx.db, `phone:to:${phone}`, LIMITS.phoneConfirmPerPhone, now))
  ) {
    throw new HttpError(429, 'too_many_requests');
  }
  const code = sixDigitCode();
  await issue(
    ctx.db,
    {
      kind: 'phone_confirm',
      identityId,
      contact: phone,
      secretHash: sha256(code),
      expiresAt: new Date(now.getTime() + PHONE_CODE_MINUTES * 60_000),
    },
    now,
  );
  const firm = await firmName(ctx);
  deliver(
    ctx,
    messageTo(
      phone,
      '',
      `${code} is your code to sign in to ${firm}'s portal by text. If you did not ask, ignore it.`,
    ),
  );
}

/** Tells the account's email that its way of signing in changed (a stolen session cannot add a
 *  way back in quietly). */
async function warnEmail(ctx: Ctx, email: string | null, what: string): Promise<void> {
  if (!email) return;
  const firm = await firmName(ctx);
  deliver(
    ctx,
    messageTo(
      email,
      `Your ${firm} portal account changed`,
      `${what}\n\nIf you did not do this, contact ${firm} straight away.`,
    ),
  );
}

export function accountRouter(ctx: Ctx): Router {
  const r = express.Router();
  r.use(requireClient(ctx));

  r.post(
    '/phone',
    h(async (req, res) => {
      const input = body(PhoneSchema, req);
      const phone = normalizePhone(input.phone);
      if (!phone) throw new HttpError(400, 'invalid_phone');
      const s = req.clientSession;
      if (!s) throw new HttpError(401, 'signed_out');
      await sendPhoneCode(ctx, s.identityId, phone);
      res.json({ ok: true, phone: maskContact(phone), minutes: PHONE_CODE_MINUTES });
    }),
  );

  r.post(
    '/phone/verify',
    h(async (req, res) => {
      const { code } = body(CodeSchema, req);
      const now = ctx.now();
      if (!(await hit(ctx.db, `verify:ip:${clientIp(req)}`, LIMITS.verifyPerIp, now))) {
        throw new HttpError(429, 'too_many_requests');
      }
      const s = req.clientSession;
      if (!s) throw new HttpError(401, 'signed_out');
      // Only this person's own code, whatever number it went to.
      const ch = await checkCode(
        ctx.db,
        and(
          eq(schema.signInChallenge.kind, 'phone_confirm'),
          eq(schema.signInChallenge.identityId, s.identityId),
        ),
        code,
        now,
      );
      if (!ch) throw new HttpError(400, 'code_wrong');
      const phone = ch.contact;
      const [taken] = await ctx.db
        .select({ id: schema.portalIdentity.id })
        .from(schema.portalIdentity)
        .where(
          and(eq(schema.portalIdentity.phone, phone), ne(schema.portalIdentity.id, s.identityId)),
        );
      if (taken) throw new HttpError(409, 'phone_in_use');
      const before = await identityOf(ctx, s.identityId);
      try {
        await ctx.db
          .update(schema.portalIdentity)
          .set({ phone })
          .where(eq(schema.portalIdentity.id, s.identityId));
      } catch (err) {
        // Another account confirmed the same number a moment earlier.
        if ((err as { code?: unknown }).code === '23505') throw new HttpError(409, 'phone_in_use');
        throw err;
      }
      // An earlier number's sign-in codes stop working with it.
      if (before.phone) await voidSmsCodes(ctx, s.identityId);
      await record(
        ctx.db,
        'phone_added',
        { kind: 'client', name: s.identityId },
        { identityId: s.identityId, detail: { phone: maskContact(phone) } },
      );
      await warnEmail(
        ctx,
        before.email,
        `The mobile number ${maskContact(phone)} can now be used to sign in to your portal ` +
          `account by text.`,
      );
      res.json({ ok: true, phone });
    }),
  );

  r.delete(
    '/phone',
    h(async (req, res) => {
      const s = req.clientSession;
      if (!s) throw new HttpError(401, 'signed_out');
      const who = await identityOf(ctx, s.identityId);
      if (!who.phone) {
        res.json({ ok: true });
        return;
      }
      // The number is the only way this person signs in.
      if (!who.email) throw new HttpError(409, 'phone_only_contact');
      await ctx.db
        .update(schema.portalIdentity)
        .set({ phone: null, notify: who.notify === 'none' ? 'none' : 'email' })
        .where(eq(schema.portalIdentity.id, s.identityId));
      // A sign-in code already texted to it no longer works (verify-code looks codes up by the
      // number, not by the account's current phone).
      await voidSmsCodes(ctx, s.identityId);
      await record(
        ctx.db,
        'phone_removed',
        { kind: 'client', name: s.identityId },
        { identityId: s.identityId, detail: { phone: maskContact(who.phone) } },
      );
      await warnEmail(
        ctx,
        who.email,
        `The mobile number ${maskContact(who.phone)} was removed from your portal account. ` +
          `You sign in by email.`,
      );
      res.json({ ok: true });
    }),
  );

  return r;
}

/** Ends this person's unused sign-in and confirm codes sent by text. */
async function voidSmsCodes(ctx: Ctx, identityId: string): Promise<void> {
  await ctx.db
    .update(schema.signInChallenge)
    .set({ usedAt: ctx.now() })
    .where(
      and(
        eq(schema.signInChallenge.identityId, identityId),
        isNull(schema.signInChallenge.usedAt),
        eq(schema.signInChallenge.kind, 'sms_code'),
      ),
    );
}
