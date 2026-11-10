// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Staff sign-in for the staff web page (D13, P9): email, password (Argon2id) and an
// authenticator code. Five wrong tries lock the account for 15 minutes. Accounts are finished
// from one-time setup links (the first one printed on the appliance, P36; others made in
// Settings): the person sets a password, adds the portal to an authenticator app, and enters a
// code to finish.
//
//   GET  /api/staff/auth/status            { setupNeeded }   (no staff account exists)
//   POST /api/staff/auth/setup/preview     { token }  -> { first, email, name }
//   POST /api/staff/auth/setup             { token, email?, name?, password } -> { otpauthUrl, secret }
//   POST /api/staff/auth/setup/confirm     { token, code }   (signs in)
//   POST /api/staff/auth/login             { email, password, code }
//   POST /api/staff/auth/logout
//   GET  /api/staff/auth/me

import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  type Router,
} from 'express';
import { parse, serialize } from 'cookie';
import { and, count, eq, gt, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Database } from '@vibe-portal/db';

import { firmName, type Ctx } from '../context';
import { normalizeEmail } from '../lib/contact';
import { record } from '../lib/events';
import { body, clientIp, h, HttpError } from '../lib/http';
import { hit, LIMITS } from '../lib/rate-limit';
import { randomToken, sha256 } from '../lib/secrets';
import {
  dummyHash,
  hashPassword,
  MIN_PASSWORD,
  newTotpSecret,
  otpauthUrl,
  verifyPassword,
  totpStep,
  verifyTotp,
} from './credentials';

export const STAFF_COOKIE = '__vibe_portal_staff';
export const STAFF_HOURS = 12;
export const STAFF_IDLE_MINUTES = 30;
export const MAX_FAILED = 5;
export const LOCK_MINUTES = 15;
export const SETUP_HOURS = 72;

export interface StaffSession {
  idHash: string;
  staffId: string;
  email: string;
  name: string;
  /** Uses Settings (P48). */
  admin: boolean;
  /** Sees only the clients in `staff_client`, not every client (P48). */
  limited: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      staff?: StaffSession;
    }
  }
}

const LoginSchema = z.object({
  email: z.string().trim().max(254),
  password: z.string().max(200),
  code: z.string().trim().max(10),
});
const TokenSchema = z.object({ token: z.string().min(20).max(200) });
const SetupSchema = TokenSchema.extend({
  email: z.string().trim().max(254).optional(),
  name: z.string().trim().max(120).optional(),
  password: z.string().min(MIN_PASSWORD).max(200),
});
const ConfirmSchema = TokenSchema.extend({ code: z.string().trim().max(10) });

function writeCookie(res: Response, id: string, secure: boolean): void {
  res.append(
    'Set-Cookie',
    serialize(STAFF_COOKIE, id, { httpOnly: true, sameSite: 'strict', secure, path: '/' }),
  );
}

function clearCookie(res: Response, secure: boolean): void {
  res.append(
    'Set-Cookie',
    serialize(STAFF_COOKIE, '', {
      httpOnly: true,
      sameSite: 'strict',
      secure,
      path: '/',
      maxAge: 0,
    }),
  );
}

async function startSession(
  ctx: Ctx,
  res: Response,
  staffId: string,
  email: string,
): Promise<void> {
  const id = randomToken();
  const now = ctx.now();
  await ctx.db.insert(schema.sessions).values({
    idHash: sha256(id),
    kind: 'staff',
    subjectId: staffId,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + STAFF_HOURS * 3_600_000),
  });
  await ctx.db
    .update(schema.staffUsers)
    .set({ lastSignInAt: now, failedLogins: 0, lockedUntil: null })
    .where(eq(schema.staffUsers.id, staffId));
  await record(ctx.db, 'staff_sign_in', { kind: 'staff', name: email });
  writeCookie(res, id, ctx.cookie.secure);
}

async function resolve(ctx: Ctx, req: Request): Promise<StaffSession | null> {
  const id = req.headers.cookie ? parse(req.headers.cookie)[STAFF_COOKIE] : undefined;
  if (!id) return null;
  const now = ctx.now();
  const idHash = sha256(id);
  const [row] = await ctx.db
    .select({ s: schema.sessions, u: schema.staffUsers })
    .from(schema.sessions)
    .innerJoin(schema.staffUsers, eq(schema.staffUsers.id, schema.sessions.subjectId))
    .where(
      and(
        eq(schema.sessions.idHash, idHash),
        eq(schema.sessions.kind, 'staff'),
        gt(schema.sessions.expiresAt, now),
      ),
    );
  if (!row || !row.u.active || !row.u.totpConfirmedAt) return null;
  if (now.getTime() - row.s.lastSeenAt.getTime() > STAFF_IDLE_MINUTES * 60_000) {
    await ctx.db.delete(schema.sessions).where(eq(schema.sessions.idHash, idHash));
    return null;
  }
  await ctx.db
    .update(schema.sessions)
    .set({ lastSeenAt: now })
    .where(eq(schema.sessions.idHash, idHash));
  return {
    idHash,
    staffId: row.u.id,
    email: row.u.email,
    name: row.u.name,
    admin: row.u.admin,
    // Read on every call, so a change an admin makes applies at once. An admin sees every client.
    limited: !row.u.admin && !row.u.allClients,
  };
}

/** Requires a signed-in staff member; their actions are recorded as theirs. */
export function requireStaff(ctx: Ctx): RequestHandler {
  return h(async (req: Request, res: Response, next: NextFunction) => {
    const s = await resolve(ctx, req);
    if (!s) {
      clearCookie(res, ctx.cookie.secure);
      throw new HttpError(401, 'signed_out');
    }
    req.staff = s;
    req.firmActor = { kind: 'staff', name: s.email };
    next();
  });
}

async function finishedCount(db: Database): Promise<number> {
  const [r] = await db
    .select({ n: count() })
    .from(schema.staffUsers)
    .where(isNotNull(schema.staffUsers.totpConfirmedAt));
  return Number(r?.n ?? 0);
}

/** Ends a staff member's unused setup links (a newer link, turned off, or finished). */
export async function cancelSetupLinks(
  db: Database,
  staffId: string,
  now: Date,
  except?: string,
): Promise<void> {
  await db
    .update(schema.staffSetupToken)
    .set({ usedAt: now })
    .where(
      and(
        eq(schema.staffSetupToken.staffId, staffId),
        isNull(schema.staffSetupToken.usedAt),
        except ? ne(schema.staffSetupToken.id, except) : undefined,
      ),
    );
}

/** Makes a one-time setup link (the first account when `staffId` is null). A staff member's
 *  earlier links stop working: only the newest one sent can finish the account. */
export async function createSetupLink(
  ctx: Pick<Ctx, 'db' | 'now' | 'portalUrl'>,
  staffId: string | null,
  by: string,
): Promise<string> {
  const token = randomToken();
  if (staffId) await cancelSetupLinks(ctx.db, staffId, ctx.now());
  await ctx.db.insert(schema.staffSetupToken).values({
    staffId,
    first: staffId === null,
    tokenHash: sha256(token),
    expiresAt: new Date(ctx.now().getTime() + SETUP_HOURS * 3_600_000),
    createdBy: by,
  });
  return `${ctx.portalUrl}/staff/setup#t=${token}`;
}

/** The appliance's `staff-setup reset <email> [--admin]`: the account is turned on, its
 *  password and authenticator are set again from a new link, and its sessions end. It also
 *  becomes an admin who sees every client (P48) when asked (`--admin`: the admin left the firm
 *  or lost their phone, which the portal cannot tell from an admin who is only away), or when
 *  no other admin has a finished account at all, so the firm is never locked out of Settings.
 *  Null when no account has that email. */
export async function applianceReset(
  ctx: Pick<Ctx, 'db' | 'now' | 'portalUrl'>,
  email: string,
  opts: { admin?: boolean } = {},
): Promise<{ email: string; link: string; madeAdmin: boolean } | null> {
  const [u] = await ctx.db
    .select()
    .from(schema.staffUsers)
    .where(eq(schema.staffUsers.email, email.trim().toLowerCase()));
  if (!u) return null;
  const [admins] = await ctx.db
    .select({ n: count() })
    .from(schema.staffUsers)
    .where(
      and(
        eq(schema.staffUsers.admin, true),
        eq(schema.staffUsers.active, true),
        isNotNull(schema.staffUsers.totpConfirmedAt),
        ne(schema.staffUsers.id, u.id),
      ),
    );
  const madeAdmin = !u.admin && (opts.admin === true || Number(admins?.n ?? 0) === 0);
  await ctx.db
    .update(schema.staffUsers)
    .set({
      passwordHash: null,
      totpSecretEnc: null,
      totpConfirmedAt: null,
      failedLogins: 0,
      lockedUntil: null,
      active: true,
      ...(madeAdmin ? { admin: true, allClients: true } : {}),
    })
    .where(eq(schema.staffUsers.id, u.id));
  if (madeAdmin) {
    await ctx.db.delete(schema.staffClient).where(eq(schema.staffClient.staffId, u.id));
  }
  await ctx.db.delete(schema.sessions).where(eq(schema.sessions.subjectId, u.id));
  await record(
    ctx.db,
    'staff_reset',
    { kind: 'system', name: 'appliance' },
    { detail: { staffId: u.id, ...(madeAdmin ? { madeAdmin: true } : {}) } },
  );
  return { email: u.email, link: await createSetupLink(ctx, u.id, 'appliance'), madeAdmin };
}

/** Accepts a code once: its step must be newer than the last one used (RFC 6238 §5.2). */
async function useTotp(
  db: Database,
  staffId: string,
  secret: string,
  code: string,
  now: Date,
): Promise<boolean> {
  const step = totpStep(secret, code, now);
  if (step === null) return false;
  const took = await db
    .update(schema.staffUsers)
    .set({ totpLastStep: step })
    .where(
      and(
        eq(schema.staffUsers.id, staffId),
        or(isNull(schema.staffUsers.totpLastStep), lt(schema.staffUsers.totpLastStep, step)),
      ),
    )
    .returning({ id: schema.staffUsers.id });
  return took.length > 0;
}

export function staffAuthRouter(ctx: Ctx): Router {
  const r = express.Router();

  const liveToken = async (token: string) => {
    const [t] = await ctx.db
      .select()
      .from(schema.staffSetupToken)
      .where(
        and(
          eq(schema.staffSetupToken.tokenHash, sha256(token)),
          isNull(schema.staffSetupToken.usedAt),
          gt(schema.staffSetupToken.expiresAt, ctx.now()),
        ),
      );
    if (!t) throw new HttpError(404, 'setup_link_expired');
    // A first-account link works only while no account is finished (checked again when it
    // finishes, as it names the account it made by then).
    if (t.first && (await finishedCount(ctx.db)) > 0) {
      throw new HttpError(404, 'setup_link_expired');
    }
    if (t.staffId && !t.first) {
      // A turned-off staff member's link does not turn them back on.
      const [u] = await ctx.db
        .select({ active: schema.staffUsers.active })
        .from(schema.staffUsers)
        .where(eq(schema.staffUsers.id, t.staffId));
      if (!u?.active) throw new HttpError(404, 'setup_link_expired');
    }
    return t;
  };

  const limit = async (req: Request, bucket: string, max = LIMITS.verifyPerIp) => {
    if (!(await hit(ctx.db, `${bucket}:ip:${clientIp(req)}`, max, ctx.now()))) {
      throw new HttpError(429, 'too_many_requests');
    }
  };

  r.get(
    '/status',
    h(async (_req, res) => {
      res.json({ setupNeeded: (await finishedCount(ctx.db)) === 0 });
    }),
  );

  r.post(
    '/setup/preview',
    h(async (req, res) => {
      await limit(req, 'staffsetup');
      const t = await liveToken(body(TokenSchema, req).token);
      const [u] = t.staffId
        ? await ctx.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.id, t.staffId))
        : [];
      res.json({
        first: !t.staffId,
        email: u?.email ?? '',
        name: u?.name ?? '',
        firmName: await firmName(ctx),
      });
    }),
  );

  r.post(
    '/setup',
    h(async (req, res) => {
      await limit(req, 'staffsetup');
      const input = body(SetupSchema, req);
      const t = await liveToken(input.token);
      const secret = newTotpSecret();
      const enc = Buffer.from(ctx.keyring.wrap(Buffer.from(secret)));
      const passwordHash = await hashPassword(input.password);
      let staffId = t.staffId;
      let email: string;
      if (staffId) {
        const [u] = await ctx.db
          .update(schema.staffUsers)
          .set({ passwordHash, totpSecretEnc: enc, totpConfirmedAt: null })
          .where(eq(schema.staffUsers.id, staffId))
          .returning();
        if (!u) throw new HttpError(404, 'setup_link_expired');
        email = u.email;
      } else {
        const e = normalizeEmail(input.email);
        if (!e) throw new HttpError(400, 'invalid_email');
        if (!input.name) throw new HttpError(400, 'name_required');
        // The first account. Trying again (this link, or a new one after giving up half way)
        // takes over the unfinished account with that email; nothing is ever deleted.
        const [taken] = await ctx.db
          .select()
          .from(schema.staffUsers)
          .where(eq(schema.staffUsers.email, e));
        if (taken?.totpConfirmedAt) throw new HttpError(409, 'email_taken');
        const [u] = taken
          ? await ctx.db
              .update(schema.staffUsers)
              .set({
                name: input.name,
                passwordHash,
                totpSecretEnc: enc,
                active: true,
                admin: true,
                allClients: true,
              })
              .where(eq(schema.staffUsers.id, taken.id))
              .returning()
          : await ctx.db
              .insert(schema.staffUsers)
              // The first account is the firm's admin.
              .values({ email: e, name: input.name, passwordHash, totpSecretEnc: enc, admin: true })
              .returning();
        if (!u) throw new Error('staff insert returned nothing');
        staffId = u.id;
        email = e;
        await ctx.db
          .update(schema.staffSetupToken)
          .set({ staffId })
          .where(eq(schema.staffSetupToken.id, t.id));
      }
      res.json({ otpauthUrl: otpauthUrl(`${await firmName(ctx)} portal`, email, secret), secret });
    }),
  );

  r.post(
    '/setup/confirm',
    h(async (req, res) => {
      await limit(req, 'staffsetup');
      const input = body(ConfirmSchema, req);
      const t = await liveToken(input.token);
      if (!t.staffId) throw new HttpError(400, 'setup_not_started');
      const [u] = await ctx.db
        .select()
        .from(schema.staffUsers)
        .where(eq(schema.staffUsers.id, t.staffId));
      if (!u?.totpSecretEnc || !u.passwordHash) throw new HttpError(400, 'setup_not_started');
      const secret = Buffer.from(ctx.keyring.unwrap(new Uint8Array(u.totpSecretEnc))).toString();
      if (!(await useTotp(ctx.db, u.id, secret, input.code, ctx.now()))) {
        throw new HttpError(400, 'code_wrong');
      }
      const used = await ctx.db
        .update(schema.staffSetupToken)
        .set({ usedAt: ctx.now() })
        .where(and(eq(schema.staffSetupToken.id, t.id), isNull(schema.staffSetupToken.usedAt)))
        .returning({ id: schema.staffSetupToken.id });
      if (!used.length) throw new HttpError(404, 'setup_link_expired');
      await ctx.db
        .update(schema.staffUsers)
        .set({ totpConfirmedAt: ctx.now() })
        .where(eq(schema.staffUsers.id, u.id));
      await cancelSetupLinks(ctx.db, u.id, ctx.now());
      if (t.first) {
        // The first account is made: every other first-account link stops working.
        await ctx.db
          .update(schema.staffSetupToken)
          .set({ usedAt: ctx.now() })
          .where(
            and(eq(schema.staffSetupToken.first, true), isNull(schema.staffSetupToken.usedAt)),
          );
      }
      await startSession(ctx, res, u.id, u.email);
      res.json({ ok: true });
    }),
  );

  r.post(
    '/login',
    h(async (req, res) => {
      const input = body(LoginSchema, req);
      await limit(req, 'stafflogin', LIMITS.loginPerIp);
      const email = normalizeEmail(input.email) ?? '';
      const now = ctx.now();
      const [u] = email
        ? await ctx.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.email, email))
        : [];
      const usable = u && u.active && u.passwordHash && u.totpConfirmedAt && u.totpSecretEnc;
      if (!usable) {
        await verifyPassword(await dummyHash(), input.password);
        throw new HttpError(401, 'sign_in_failed');
      }
      const secret = Buffer.from(
        ctx.keyring.unwrap(new Uint8Array(u.totpSecretEnc as Buffer)),
      ).toString();
      const passwordOk = await verifyPassword(u.passwordHash as string, input.password);
      if (u.lockedUntil && u.lockedUntil > now) {
        // Only someone with the right password and code learns the account is locked; to
        // anyone else it looks like any wrong try (or an unknown email).
        if (passwordOk && verifyTotp(secret, input.code, now)) {
          throw new HttpError(423, 'locked');
        }
        throw new HttpError(401, 'sign_in_failed');
      }
      const ok = passwordOk && (await useTotp(ctx.db, u.id, secret, input.code, now));
      if (!ok) {
        // Counted in the database, so tries at the same moment are all counted.
        const [f] = await ctx.db
          .update(schema.staffUsers)
          .set({ failedLogins: sql`${schema.staffUsers.failedLogins} + 1` })
          .where(eq(schema.staffUsers.id, u.id))
          .returning({ failed: schema.staffUsers.failedLogins });
        if ((f?.failed ?? 0) >= MAX_FAILED) {
          await ctx.db
            .update(schema.staffUsers)
            .set({ failedLogins: 0, lockedUntil: new Date(now.getTime() + LOCK_MINUTES * 60_000) })
            .where(eq(schema.staffUsers.id, u.id));
        }
        throw new HttpError(401, 'sign_in_failed');
      }
      await startSession(ctx, res, u.id, u.email);
      res.json({ ok: true });
    }),
  );

  r.post(
    '/logout',
    h(async (req, res) => {
      const s = await resolve(ctx, req);
      if (s) await ctx.db.delete(schema.sessions).where(eq(schema.sessions.idHash, s.idHash));
      clearCookie(res, ctx.cookie.secure);
      res.json({ ok: true });
    }),
  );

  r.get(
    '/me',
    requireStaff(ctx),
    h(async (req, res) => {
      const s = req.staff as StaffSession;
      res.json({
        email: s.email,
        name: s.name,
        firmName: await firmName(ctx),
        admin: s.admin,
        allClients: !s.limited,
      });
    }),
  );

  return r;
}
