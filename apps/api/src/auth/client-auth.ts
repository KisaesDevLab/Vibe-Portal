// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Client sign-in (D4), the flow of Vibe-Time-Billing apps/api/src/auth/portal-routes.ts:
//   email -> a one-time sign-in link (15 minutes)
//   phone -> a 6-digit code by text (5 minutes, 5 tries)
// The answer to /login never says whether the email or phone is known.
//
//   POST /api/portal/auth/login          { contact, keepSignedIn? }
//   POST /api/portal/auth/verify-link    { token }
//   POST /api/portal/auth/verify-code    { phone, code }
//   POST /api/portal/auth/logout
//   GET  /api/portal/auth/me
//   POST /api/portal/auth/switch-client  { clientId }

import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  type Router,
} from 'express';
import { and, desc, eq, gt, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@vibe-portal/db';

import { firmName, type Ctx } from '../context';
import { detectLoginKind, normalizeEmail, normalizePhone } from '../lib/contact';
import { record } from '../lib/events';
import { body, clientIp, h, HttpError } from '../lib/http';
import { messageTo } from '../lib/notify';
import { hit, LIMITS } from '../lib/rate-limit';
import { randomToken, sameHash, sha256, sixDigitCode } from '../lib/secrets';
import { activeClientsOf } from './grant';
import {
  clearSessionCookie,
  createSession,
  endSession,
  readSessionCookie,
  resolveSession,
  setActiveClient,
  writeSessionCookie,
  type ClientSession,
} from './sessions';

export const LINK_MINUTES = 15;
export const CODE_MINUTES = 5;
export const MAX_ATTEMPTS = 5;

export const GENERIC_LOGIN = {
  ok: true,
  message: 'If that email or phone has access, a sign-in link or code is on its way.',
};

const LoginSchema = z.object({
  contact: z.string().min(3).max(254),
  keepSignedIn: z.boolean().optional().default(false),
});
const LinkSchema = z.object({ token: z.string().min(20).max(200) });
const CodeSchema = z.object({
  phone: z.string().min(7).max(32),
  code: z.string().regex(/^\d{6}$/),
});
const SwitchSchema = z.object({ clientId: z.string().uuid() });

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      clientSession?: ClientSession;
    }
  }
}

/** Requires a signed-in client; sets req.clientSession. */
export function requireClient(ctx: Ctx): RequestHandler {
  return h(async (req: Request, res: Response, next: NextFunction) => {
    const id = readSessionCookie(req);
    const session = id ? await resolveSession(ctx.db, id, ctx.now()) : null;
    if (!session) {
      clearSessionCookie(res, ctx.cookie);
      throw new HttpError(401, 'signed_out');
    }
    req.clientSession = session;
    next();
  });
}

/** Starts a session for an identity, choosing its first client, and sets the cookie. */
export async function signIn(
  ctx: Ctx,
  res: Response,
  identityId: string,
  keepSignedIn: boolean,
): Promise<void> {
  const clients = await activeClientsOf(ctx.db, identityId);
  if (clients.length === 0) throw new HttpError(403, 'no_access');
  const now = ctx.now();
  const id = await createSession(ctx.db, identityId, clients[0]?.id ?? null, keepSignedIn, now);
  await ctx.db
    .update(schema.portalIdentity)
    .set({ lastSignInAt: now })
    .where(eq(schema.portalIdentity.id, identityId));
  await record(ctx.db, 'sign_in', { kind: 'client', name: identityId }, { identityId });
  writeSessionCookie(res, id, keepSignedIn, ctx.cookie);
}

export function clientAuthRouter(ctx: Ctx): Router {
  const r = express.Router();

  r.post(
    '/login',
    h(async (req, res) => {
      const { contact, keepSignedIn } = body(LoginSchema, req);
      const now = ctx.now();
      if (!(await hit(ctx.db, `login:ip:${clientIp(req)}`, LIMITS.loginPerIp, now))) {
        throw new HttpError(429, 'too_many_requests');
      }
      const kind = detectLoginKind(contact);
      const value = kind === 'email' ? normalizeEmail(contact) : normalizePhone(contact);
      if (kind === 'unknown' || !value) throw new HttpError(400, 'invalid_contact');
      // Over the per-contact limit: answer as usual but send nothing.
      if (!(await hit(ctx.db, `login:contact:${value}`, LIMITS.loginPerContact, now))) {
        res.json(GENERIC_LOGIN);
        return;
      }
      const field = kind === 'email' ? schema.portalIdentity.email : schema.portalIdentity.phone;
      const [identity] = await ctx.db
        .select()
        .from(schema.portalIdentity)
        .where(and(eq(field, value), eq(schema.portalIdentity.status, 'active')));
      if (identity && (await activeClientsOf(ctx.db, identity.id)).length > 0) {
        const firm = await firmName(ctx);
        if (kind === 'email') {
          const token = randomToken();
          await ctx.db.insert(schema.signInChallenge).values({
            kind: 'magic_link',
            identityId: identity.id,
            contact: value,
            secretHash: sha256(token),
            keepSignedIn,
            expiresAt: new Date(now.getTime() + LINK_MINUTES * 60_000),
          });
          await ctx.notifier.send(
            messageTo(
              value,
              `Sign in to ${firm}'s client portal`,
              `Use this link to sign in. It works once, for ${LINK_MINUTES} minutes.\n\n` +
                `${ctx.portalUrl}/auth/verify#t=${token}\n\n` +
                `If you did not ask to sign in, ignore this email.`,
            ),
          );
        } else {
          const code = sixDigitCode();
          await ctx.db.insert(schema.signInChallenge).values({
            kind: 'sms_code',
            identityId: identity.id,
            contact: value,
            secretHash: sha256(code),
            keepSignedIn,
            expiresAt: new Date(now.getTime() + CODE_MINUTES * 60_000),
          });
          await ctx.notifier.send(
            messageTo(value, '', `${code} is your ${firm} portal sign-in code.`),
          );
        }
      }
      res.json({ ...GENERIC_LOGIN, kind });
    }),
  );

  r.post(
    '/verify-link',
    h(async (req, res) => {
      const { token } = body(LinkSchema, req);
      const now = ctx.now();
      if (!(await hit(ctx.db, `verify:ip:${clientIp(req)}`, LIMITS.verifyPerIp, now))) {
        throw new HttpError(429, 'too_many_requests');
      }
      const [ch] = await ctx.db
        .update(schema.signInChallenge)
        .set({ usedAt: now })
        .where(
          and(
            eq(schema.signInChallenge.kind, 'magic_link'),
            eq(schema.signInChallenge.secretHash, sha256(token)),
            isNull(schema.signInChallenge.usedAt),
            gt(schema.signInChallenge.expiresAt, now),
          ),
        )
        .returning();
      if (!ch?.identityId) throw new HttpError(400, 'link_expired');
      await signIn(ctx, res, ch.identityId, ch.keepSignedIn);
      res.json({ ok: true });
    }),
  );

  r.post(
    '/verify-code',
    h(async (req, res) => {
      const input = body(CodeSchema, req);
      const now = ctx.now();
      if (!(await hit(ctx.db, `verify:ip:${clientIp(req)}`, LIMITS.verifyPerIp, now))) {
        throw new HttpError(429, 'too_many_requests');
      }
      const phone = normalizePhone(input.phone);
      if (!phone) throw new HttpError(400, 'code_wrong');
      const [ch] = await ctx.db
        .select()
        .from(schema.signInChallenge)
        .where(
          and(
            eq(schema.signInChallenge.kind, 'sms_code'),
            eq(schema.signInChallenge.contact, phone),
            isNull(schema.signInChallenge.usedAt),
            gt(schema.signInChallenge.expiresAt, now),
          ),
        )
        .orderBy(desc(schema.signInChallenge.createdAt))
        .limit(1);
      if (!ch?.identityId || ch.attempts >= MAX_ATTEMPTS) throw new HttpError(400, 'code_wrong');
      const right = sameHash(ch.secretHash, sha256(input.code));
      await ctx.db
        .update(schema.signInChallenge)
        .set(right ? { usedAt: now } : { attempts: ch.attempts + 1 })
        .where(eq(schema.signInChallenge.id, ch.id));
      if (!right) throw new HttpError(400, 'code_wrong');
      await signIn(ctx, res, ch.identityId, ch.keepSignedIn);
      res.json({ ok: true });
    }),
  );

  r.post(
    '/logout',
    h(async (req, res) => {
      const id = readSessionCookie(req);
      const session = id ? await resolveSession(ctx.db, id, ctx.now()) : null;
      if (session) {
        await endSession(ctx.db, session.idHash);
        await record(
          ctx.db,
          'sign_out',
          { kind: 'client', name: session.identityId },
          { identityId: session.identityId },
        );
      }
      clearSessionCookie(res, ctx.cookie);
      res.json({ ok: true });
    }),
  );

  r.get(
    '/me',
    requireClient(ctx),
    h(async (req, res) => {
      const s = req.clientSession as ClientSession;
      const [identity] = await ctx.db
        .select()
        .from(schema.portalIdentity)
        .where(eq(schema.portalIdentity.id, s.identityId));
      const clients = await activeClientsOf(ctx.db, s.identityId);
      if (!identity || clients.length === 0) {
        await endSession(ctx.db, s.idHash);
        clearSessionCookie(res, ctx.cookie);
        throw new HttpError(401, 'signed_out');
      }
      let active = clients.find((c) => c.id === s.activeClientId)?.id;
      if (!active) {
        active = clients[0]?.id;
        if (active) await setActiveClient(ctx.db, s.idHash, active);
      }
      res.json({
        identity: {
          id: identity.id,
          name: identity.name,
          email: identity.email,
          phone: identity.phone,
          notify: identity.notify,
        },
        clients: clients.map((c) => ({ id: c.id, name: c.displayName })),
        activeClientId: active,
        firmName: await firmName(ctx),
      });
    }),
  );

  r.post(
    '/switch-client',
    requireClient(ctx),
    h(async (req, res) => {
      const s = req.clientSession as ClientSession;
      const { clientId } = body(SwitchSchema, req);
      const clients = await activeClientsOf(ctx.db, s.identityId);
      if (!clients.some((c) => c.id === clientId)) throw new HttpError(404, 'not_found');
      await setActiveClient(ctx.db, s.idHash, clientId);
      res.json({ ok: true, activeClientId: clientId });
    }),
  );

  return r;
}

/** Ends unused sign-in challenges for a contact (e.g. when access is removed). */
export async function voidChallenges(ctx: Ctx, identityId: string): Promise<void> {
  await ctx.db
    .update(schema.signInChallenge)
    .set({ usedAt: ctx.now() })
    .where(
      and(
        eq(schema.signInChallenge.identityId, identityId),
        isNull(schema.signInChallenge.usedAt),
        or(
          eq(schema.signInChallenge.kind, 'magic_link'),
          eq(schema.signInChallenge.kind, 'sms_code'),
        ),
      ),
    );
}
