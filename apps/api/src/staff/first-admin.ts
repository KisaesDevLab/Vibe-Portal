// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// The first staff account without a command (P52). Whoever sets up the appliance enters the
// first admin's email with the portal's other settings (FIRST_ADMIN_EMAIL). While no staff
// account is finished, the portal emails that address a setup link when it starts, and the
// staff sign-in page offers to send it again.
//
// Safe to offer to anyone who opens the page: it only ever sends to the address the appliance
// set, never to one typed on the page; a few times an hour at most, counted for the whole
// portal (the cost is mail to one inbox, whoever asks); and each new link ends the one before.
// The page sees the address masked, and whether the email went, never an SMTP error.

import { and, eq, isNull } from 'drizzle-orm';
import { schema } from '@vibe-portal/db';

import { firmName, type Ctx } from '../context';
import { messageTo } from '../lib/notify';
import { hit } from '../lib/rate-limit';
import { createSetupLink, finishedCount } from './auth';

/** Who made a setup link this way (staff_setup_token.created_by). */
export const BY_EMAIL = 'first-admin-email';
/** "Send again" for the whole portal. */
const RESEND = { max: 3, windowSeconds: 60 * 60 };

export type FirstAdminMail = schema.FirstAdminMail;

/** k•••@yourfirm.com */
export function masked(email: string): string {
  const at = email.indexOf('@');
  return at <= 0 ? '•••' : `${email[0]}•••${email.slice(at)}`;
}

async function saved(ctx: Ctx): Promise<FirstAdminMail | null> {
  const [f] = await ctx.db.select({ m: schema.firm.firstAdminMail }).from(schema.firm);
  return f?.m ?? null;
}

/** Makes a new first-account link (earlier emailed ones stop working) and emails it. */
async function send(ctx: Ctx, email: string): Promise<FirstAdminMail> {
  await ctx.db
    .update(schema.staffSetupToken)
    .set({ usedAt: ctx.now() })
    .where(
      and(
        eq(schema.staffSetupToken.first, true),
        eq(schema.staffSetupToken.createdBy, BY_EMAIL),
        isNull(schema.staffSetupToken.usedAt),
      ),
    );
  const link = await createSetupLink(ctx, null, BY_EMAIL);
  const firm = await firmName(ctx);
  let ok = true;
  try {
    // Awaited, not deliver(): the page says whether it went.
    await ctx.notifier.send(
      messageTo(
        email,
        `Set up ${firm}'s client portal`,
        `The client portal is ready. Make your staff account (within 3 days): choose a ` +
          `password and add the portal to an authenticator app on your phone.\n\n${link}\n\n` +
          `You are the portal's first admin: you can then add the other staff.`,
      ),
    );
  } catch (err) {
    ok = false;
    ctx.log.error({ err }, 'first admin setup email failed');
  }
  const m: FirstAdminMail = { email, at: ctx.now().toISOString(), ok };
  await ctx.db.update(schema.firm).set({ firstAdminMail: m });
  return m;
}

/**
 * At startup: emails the first admin a setup link while no staff account is finished, unless
 * one already went to this address. A changed address, or an email that failed (wrong SMTP
 * password, since put right), sends again; a restart alone does not.
 */
export async function firstAdminOnStart(ctx: Ctx): Promise<FirstAdminMail | null> {
  const email = ctx.firstAdminEmail;
  if (!email || (await finishedCount(ctx.db)) > 0) return null;
  const last = await saved(ctx);
  if (last && last.email === email && last.ok) return null;
  return send(ctx, email);
}

/** "Send again" on the sign-in page. Null when there is nothing to send (see the route). */
export async function firstAdminResend(ctx: Ctx): Promise<FirstAdminMail | 'limited' | null> {
  const email = ctx.firstAdminEmail;
  if (!email || (await finishedCount(ctx.db)) > 0) return null;
  if (!(await hit(ctx.db, 'firstadmin:resend', RESEND, ctx.now()))) return 'limited';
  return send(ctx, email);
}

/** What the sign-in page may know: the address masked, when, and whether it went. */
export async function firstAdminStatus(
  ctx: Ctx,
): Promise<{ to: string; at: string; ok: boolean } | null> {
  const email = ctx.firstAdminEmail;
  if (!email) return null;
  const last = await saved(ctx);
  // Sent to an address since changed on the appliance: as if not sent yet.
  if (!last || last.email !== email) return { to: masked(email), at: '', ok: false };
  return { to: masked(email), at: last.at, ok: last.ok };
}
