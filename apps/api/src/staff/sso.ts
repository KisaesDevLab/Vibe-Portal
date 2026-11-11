// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Staff sign-in through Vibe Auth (P44), with @kisaesdevlab/vibe-auth: Authorization Code + PKCE
// against the firm's Vibe Auth (authentik) on the appliance. Beside the portal's own sign-in
// (email, password and authenticator code), never instead of it unless the firm chooses
// "single sign-on only" on Settings › Authentication. Staff only: clients, people sent secure
// links and Vibe Files never meet it.
//
// Owner 2026-11-10:
//   - anyone the firm's Vibe Auth lets in gets a staff account on first sign-in (JIT);
//   - Vibe Auth groups decide who is an admin, at every sign-in (vibe-admin, vibe-it and
//     vibe-partner are admins; the last admin is never demoted);
//   - Vibe Auth's own second-factor policy is trusted (the portal does not ask for its code).
//
// Everything lives under /api/staff/sso/auth/...: the portal is served from the root, and its
// client pages already use /auth/verify. Three things the appliance expects at the root are also
// answered there (ssoRouter): GET /auth/status (the console's check before it registers the
// portal) and GET /auth/oidc/logged-out (the only sign-out return address the broker registers
// with Vibe Auth, baseUrl + /auth/oidc/logged-out); sign-out names that root address; and
// GET /login/local, the emergency sign-in the appliance points operators to.

import {
  createPgStores,
  createVibeAuth,
  sendHttpResponse,
  toHttpRequest,
  type AuditSink,
  type QueryFn,
  type SecretWrap,
  type SessionAdapter,
  type SessionIdentity,
  type UserAdapter,
  type VibeAuth,
  type VibeUser,
} from '@kisaesdevlab/vibe-auth';
import { and, count, eq, ne, or, sql, type SQL } from 'drizzle-orm';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { schema, type Database } from '@vibe-portal/db';

import type { Ctx } from '../context';
import type { Keyring } from '../files/keyring';
import { normalizeEmail } from '../lib/contact';
import { record } from '../lib/events';
import { rowsOf } from '../lib/rows';
import { hashPassword, verifyPassword } from './credentials';

/** Where the package's routes live: /api/staff/sso/auth/status, …/oidc/callback, … */
export const SSO_BASE = '/api/staff/sso';
/** The emergency local admin Vibe Auth provisions (its CLI, run by the appliance). */
export const BREAKGLASS_USERNAME = 'vibe-breakglass';
export const BREAKGLASS_EMAIL = 'vibe-breakglass@vibe-auth.local';

const ROLES = {
  roles: ['admin', 'staff'] as const,
  adminRole: 'admin',
  defaultRoleMap: {
    'vibe-admin': 'admin',
    'vibe-it': 'admin',
    'vibe-partner': 'admin',
    'vibe-manager': 'staff',
    'vibe-staff': 'staff',
  },
};

type StaffRow = typeof schema.staffUsers.$inferSelect;

export const isBreakglass = (email: string): boolean => email.toLowerCase() === BREAKGLASS_EMAIL;

function toUser(u: StaffRow): VibeUser {
  const bg = isBreakglass(u.email);
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.admin ? 'admin' : 'staff',
    active: u.active,
    ...(bg ? { local: true, username: BREAKGLASS_USERNAME } : {}),
  };
}

/** The package's SQL ($1, $2 … placeholders) through the portal's database. */
export function queryFn(db: Pick<Database, 'execute'>): QueryFn {
  return async (text, params = []) => {
    const chunks: SQL[] = [];
    const re = /\$(\d+)/g;
    let last = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      chunks.push(sql.raw(text.slice(last, m.index)));
      // Dates as ISO text: Drizzle turns off postgres-js's own date handling, so a Date
      // parameter fails on a real server (pglite in the tests takes it either way).
      const v = params[Number(m[1]) - 1];
      chunks.push(sql`${v instanceof Date ? v.toISOString() : v}`);
      last = re.lastIndex;
    }
    chunks.push(sql.raw(text.slice(last)));
    return rowsOf<Record<string, unknown>>(await db.execute(sql.join(chunks)));
  };
}

/** Staff accounts as Vibe Auth sees them. */
export function staffUsers(db: Database): UserAdapter {
  const one = async (where: SQL | undefined): Promise<VibeUser | null> => {
    const [u] = await db.select().from(schema.staffUsers).where(where);
    return u ? toUser(u) : null;
  };
  const byEmail = (email: string) =>
    one(eq(schema.staffUsers.email, normalizeEmail(email) ?? email.trim().toLowerCase()));
  // Security review: a Vibe Auth sign-in is linked to a staff account by its verified email.
  // Never to the emergency account, whatever email a Vibe Auth user may give themselves.
  const linkable = async (email: string) => (isBreakglass(email) ? null : byEmail(email));
  const otherAdmins = async (excludeUserId: string): Promise<number> => {
    const [r] = await db
      .select({ n: count() })
      .from(schema.staffUsers)
      .where(
        and(
          eq(schema.staffUsers.admin, true),
          eq(schema.staffUsers.active, true),
          ne(schema.staffUsers.id, excludeUserId),
          ne(schema.staffUsers.email, BREAKGLASS_EMAIL),
        ),
      );
    return Number(r?.n ?? 0);
  };
  return {
    findById: (id) => one(eq(schema.staffUsers.id, id)),
    findByEmail: linkable,
    findByUsername: (username) =>
      byEmail(username.toLowerCase() === BREAKGLASS_USERNAME ? BREAKGLASS_EMAIL : username),
    async create(input) {
      // Anyone the firm's Vibe Auth lets in (owner 2026-11-10). Sees every client until an
      // admin limits them, like a staff member added on Settings.
      const email = normalizeEmail(input.email) ?? input.email.trim().toLowerCase();
      const [u] = await db
        .insert(schema.staffUsers)
        .values({ email, name: input.name?.trim() || email, admin: input.role === 'admin' })
        .returning();
      if (!u) throw new Error('staff account not created');
      return toUser(u);
    },
    async setRole(userId, role) {
      const admin = role === 'admin';
      const [u] = await db.select().from(schema.staffUsers).where(eq(schema.staffUsers.id, userId));
      if (!u) return false;
      // Never the last admin: the firm would be locked out of Settings.
      if (u.admin && !admin && (await otherAdmins(userId)) === 0) return false;
      if (u.admin !== admin) {
        await db.update(schema.staffUsers).set({ admin }).where(eq(schema.staffUsers.id, userId));
      }
      return true;
    },
    countOtherActiveAdmins: otherAdmins,
    async verifyLocalPassword(userId, password) {
      const [u] = await db.select().from(schema.staffUsers).where(eq(schema.staffUsers.id, userId));
      return Boolean(u?.passwordHash && (await verifyPassword(u.passwordHash, password)));
    },
    async createLocalUser(input) {
      const [u] = await db
        .insert(schema.staffUsers)
        .values({
          email: BREAKGLASS_EMAIL,
          name: 'Emergency sign-in (Vibe Auth)',
          passwordHash: await hashPassword(input.password),
          admin: true,
        })
        .returning();
      if (!u) throw new Error('break-glass account not created');
      return toUser(u);
    },
    async setLocalPassword(userId, password) {
      await db
        .update(schema.staffUsers)
        .set({ passwordHash: await hashPassword(password), failedLogins: 0, lockedUntil: null })
        .where(eq(schema.staffUsers.id, userId));
    },
    async setActive(userId, active) {
      await db.update(schema.staffUsers).set({ active }).where(eq(schema.staffUsers.id, userId));
    },
  };
}

/** Vibe Auth's events in History, without tokens. */
export function historySink(db: Database): AuditSink {
  return {
    async emit(event) {
      const detail: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(event)) {
        if (/token|secret|password/i.test(k)) continue;
        detail[k] = v;
      }
      await record(db, 'staff_sso', { kind: 'system', name: 'vibe-auth' }, { detail }).catch(
        () => undefined,
      );
    },
  };
}

/** Client secrets saved on Settings › Authentication, wrapped with the firm key. */
export function keyringWrap(keyring: Keyring): SecretWrap {
  return {
    wrap: async (plain) => Buffer.from(keyring.wrap(Buffer.from(plain, 'utf8'))).toString('base64'),
    unwrap: async (wrapped) =>
      Buffer.from(keyring.unwrap(new Uint8Array(Buffer.from(wrapped, 'base64')))).toString('utf8'),
  };
}

/** What auth.ts gives this module: the portal's own staff sessions. */
export interface StaffSessions {
  start(
    res: Response,
    staffId: string,
    email: string,
    oidc: { issuer: string; subject: string; sid?: string; idToken?: string },
  ): Promise<void>;
  /** The signed-in staff member's id and session, or null. */
  current(req: Request): Promise<{ staffId: string; idHash: string } | null>;
  end(res: Response, idHash: string | null): Promise<void>;
}

function sessionAdapter(db: Database, sessions: StaffSessions): SessionAdapter<Request, Response> {
  return {
    async create(_req, res, user, identity) {
      await sessions.start(res, user.id, user.email, {
        issuer: identity.issuer,
        subject: identity.subject,
        ...(identity.sid ? { sid: identity.sid } : {}),
        ...(identity.idToken ? { idToken: identity.idToken } : {}),
      });
    },
    async destroy(req, res) {
      const s = await sessions.current(req);
      await sessions.end(res, s?.idHash ?? null);
    },
    async currentUserId(req) {
      return (await sessions.current(req))?.staffId ?? null;
    },
    async currentIdentity(req): Promise<SessionIdentity | null> {
      const s = await sessions.current(req);
      if (!s) return null;
      const [row] = await db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.idHash, s.idHash));
      if (!row?.oidcIssuer || !row.oidcSubject) return null;
      return {
        issuer: row.oidcIssuer,
        subject: row.oidcSubject,
        ...(row.oidcSid ? { sid: row.oidcSid } : {}),
        ...(row.oidcIdToken ? { idToken: row.oidcIdToken } : {}),
      };
    },
    // Vibe Auth 1.0.21: a re-sign-in (Settings' Test connection) makes Vibe Auth replace its own
    // session; this staff session follows the new one instead of being signed out.
    async rebindIdentity(req, _res, identity) {
      const s = await sessions.current(req);
      if (!s) throw new Error('no staff session to move');
      await db
        .update(schema.sessions)
        .set({ oidcSid: identity.sid ?? null, oidcIdToken: identity.idToken ?? null })
        .where(eq(schema.sessions.idHash, s.idHash));
    },
    // Back-channel logout: Vibe Auth ended the person's session there, so it ends here too.
    async destroyByIdentity(id) {
      const conds: SQL[] = [];
      if (id.sid) conds.push(eq(schema.sessions.oidcSid, id.sid));
      if (id.subject) {
        conds.push(
          and(
            eq(schema.sessions.oidcIssuer, id.issuer),
            eq(schema.sessions.oidcSubject, id.subject),
          ) as SQL,
        );
      }
      if (id.userId) conds.push(eq(schema.sessions.subjectId, id.userId));
      if (!conds.length) return 0;
      const gone = await db
        .delete(schema.sessions)
        .where(and(eq(schema.sessions.kind, 'staff'), or(...conds)))
        .returning({ id: schema.sessions.idHash });
      return gone.length;
    },
  };
}

/** The Vibe Auth engine for the staff page. In "local" mode (the default) it only answers
 *  /status; nothing changes for the firm until Vibe Auth is set up and the mode is changed. */
export function createStaffSso(ctx: Ctx, sessions: StaffSessions): VibeAuth {
  const env = {
    ...process.env,
    // Anyone the firm's Vibe Auth lets in, even in no Vibe group, is staff (owner 2026-11-10).
    VIBE_OIDC_DEFAULT_ROLE: process.env.VIBE_OIDC_DEFAULT_ROLE ?? 'staff',
  };
  const publicUrl = `${(process.env.VIBE_OIDC_PUBLIC_URL ?? ctx.portalUrl).replace(/\/+$/, '')}${SSO_BASE}`;
  return createVibeAuth({
    product: { slug: 'vibe-files-portal', name: 'Vibe Portal', roles: ROLES },
    users: staffUsers(ctx.db),
    session: sessionAdapter(ctx.db, sessions),
    ...createPgStores({ query: queryFn(ctx.db) }),
    secretWrap: keyringWrap(ctx.keyring),
    audit: historySink(ctx.db),
    env,
    basePath: SSO_BASE,
    // The engine joins these to basePath; the staff sign-in page is /staff/login, three levels up.
    loginPath: '/../../../staff/login',
    breakglassLoginPath: '/../../../staff/login?local=1',
    breakglassEmail: BREAKGLASS_EMAIL,
    publicUrl,
    trustProxy: true,
    defaultReturnTo: '/staff',
    logger: {
      info: (m, meta) => ctx.log.info(meta ?? {}, m),
      warn: (m, meta) => ctx.log.warn(meta ?? {}, m),
      error: (m, meta) => ctx.log.error(meta ?? {}, m),
    },
  });
}

/** Where Vibe Auth sends the browser after signing out: the root address the broker registers. */
export function rootLogoutReturn(location: string): string {
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return location;
  }
  const back = url.searchParams.get('post_logout_redirect_uri');
  if (!back) return location;
  try {
    const b = new URL(back);
    const tail = `${SSO_BASE}/auth/oidc/logged-out`;
    if (!b.pathname.endsWith(tail)) return location;
    b.pathname = b.pathname.slice(0, -tail.length) + '/auth/oidc/logged-out';
    url.searchParams.set('post_logout_redirect_uri', b.toString());
    return url.toString();
  } catch {
    return location;
  }
}

/**
 * Vibe Auth's routes for the app: under SSO_BASE as mounted, plus the two root addresses the
 * appliance expects (see the top of this file).
 */
export function ssoRouter(auth: VibeAuth): Router {
  const r = express.Router();
  const run =
    (path?: string) =>
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const httpReq = toHttpRequest(req, res);
        if (path) httpReq.url = SSO_BASE + path;
        const out = await auth.handle(httpReq);
        if (!out) return next();
        for (const k of Object.keys(out.headers)) {
          const v = out.headers[k];
          if (k.toLowerCase() === 'location' && typeof v === 'string') {
            out.headers[k] = rootLogoutReturn(v);
          }
        }
        sendHttpResponse(res, out);
      } catch (err) {
        next(err);
      }
    };
  r.get('/auth/status', run('/auth/status'));
  r.get('/auth/oidc/logged-out', run('/auth/oidc/logged-out'));
  // The appliance tells operators to use "the product's /login/local page" when Vibe Auth is
  // down: here that is the staff sign-in's emergency form, not the client sign-in.
  r.get('/login/local', (_req, res) => res.redirect(302, '/staff/login?local=1'));
  // The identity provider posts back-channel logout as a form.
  r.use(SSO_BASE, express.urlencoded({ extended: false, limit: '64kb' }), run());
  return r;
}
