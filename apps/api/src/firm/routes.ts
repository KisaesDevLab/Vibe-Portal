// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// The firm API Vibe Files uses (BUILD_PLAN.md §3), Phase 2 part: status, clients, users,
// invitations and access requests. Every call needs the firm key; every change is recorded.
//
//   GET    /api/firm/v1/status
//   PUT    /api/firm/v1/clients/:id                        { clientCode, displayName, active? }
//   GET    /api/firm/v1/clients/:id/users
//   POST   /api/firm/v1/clients/:id/invites                { email?, phone?, name, roleLabel? }
//   DELETE /api/firm/v1/clients/:id/invites/:invitationId
//   PATCH  /api/firm/v1/clients/:id/users/:identityId      { active }
//   GET    /api/firm/v1/access-requests                     (confirmed, pending)
//   POST   /api/firm/v1/access-requests/:id/approve         { clientId, roleLabel? }
//   POST   /api/firm/v1/access-requests/:id/deny

import express, { type Request, type RequestHandler, type Router } from 'express';
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@vibe-portal/db';

import { voidChallenges } from '../auth/client-auth';
import { grantAccess, type Executor } from '../auth/grant';
import { endSessionsOf } from '../auth/sessions';
import { deliver, firmName, type Ctx } from '../context';
import { normalizeEmail, normalizePhone } from '../lib/contact';
import { record, type Actor } from '../lib/events';
import { body, h, HttpError } from '../lib/http';
import { messageTo } from '../lib/notify';
import { randomToken, sha256 } from '../lib/secrets';
import { VERSION } from '../version';
import { firmFilesRouter } from './files';
import { requireFirmKey } from './keys';
import { firmEventsRouter } from './events';
import { firmUploadsRouter } from './uploads';

export const INVITE_DAYS = 7;

const Uuid = z.string().uuid();
const ClientSchema = z.object({
  clientCode: z.string().trim().max(64).default(''),
  displayName: z.string().trim().min(1).max(200),
  active: z.boolean().optional(),
});
const InviteSchema = z.object({
  email: z.string().trim().max(254).optional(),
  phone: z.string().trim().max(32).optional(),
  name: z.string().trim().max(120).default(''),
  roleLabel: z.string().trim().max(60).default(''),
});
const AccessSchema = z.object({ active: z.boolean() });
const ApproveSchema = z.object({
  clientId: Uuid,
  roleLabel: z.string().trim().max(60).default(''),
});

function param(req: Request, name: string): string {
  const v = Uuid.safeParse(req.params[name]);
  if (!v.success) throw new HttpError(404, 'not_found');
  return v.data;
}

function actorOf(req: Request): Actor {
  return req.firmActor ?? { kind: 'firm_key', name: 'Vibe Files' };
}

/** Vibe Files' firm API, authorised by the firm key. */
export function firmRouter(ctx: Ctx): Router {
  return firmApi(ctx, requireFirmKey(ctx), false);
}

/**
 * The same API for the staff web page (D13), authorised by a staff session. Staff cannot share
 * new files or replace their content (only Vibe Files reaches the cabinet), and downloading an
 * upload never marks it fetched (P10): it still reaches Intake.
 */
export function staffApi(ctx: Ctx, auth: RequestHandler): Router {
  return firmApi(ctx, auth, true);
}

const NOT_FOR_STAFF = [
  ['POST', /^\/files\/?$/],
  ['PUT', /^\/files\/[^/]+\/content\/?$/],
  ['POST', /^\/uploads\/[^/]+\/fetched\/?$/],
] as const;

function firmApi(ctx: Ctx, auth: RequestHandler, staff: boolean): Router {
  const r = express.Router();
  r.use(auth);
  if (staff) {
    r.use((req, res, next) => {
      if (NOT_FOR_STAFF.some(([m, p]) => req.method === m && p.test(req.path))) {
        res.status(403).json({ error: 'not_for_staff' });
        return;
      }
      next();
    });
  }
  r.use('/files', firmFilesRouter(ctx));
  r.use('/uploads', firmUploadsRouter(ctx));
  r.use('/events', firmEventsRouter(ctx));

  const clientExists = async (id: string): Promise<boolean> =>
    (
      await ctx.db
        .select({ id: schema.clients.id })
        .from(schema.clients)
        .where(eq(schema.clients.id, id))
    ).length > 0;

  /** Withdraws a client's pending invitations: all of them, or those to some contacts. */
  const withdrawInvites = async (clientId: string, to?: (string | null)[]) => {
    const contacts = (to ?? []).filter((c): c is string => !!c);
    if (to && contacts.length === 0) return [];
    return ctx.db
      .update(schema.portalInvitation)
      .set({ revokedAt: ctx.now() })
      .where(
        and(
          eq(schema.portalInvitation.clientId, clientId),
          isNull(schema.portalInvitation.acceptedAt),
          isNull(schema.portalInvitation.revokedAt),
          to
            ? or(
                inArray(schema.portalInvitation.email, contacts),
                inArray(schema.portalInvitation.phone, contacts),
              )
            : undefined,
        ),
      )
      .returning({ id: schema.portalInvitation.id });
  };

  r.get(
    '/status',
    h(async (_req, res) => {
      res.json({ version: VERSION, firmName: await firmName(ctx), portalUrl: ctx.portalUrl });
    }),
  );

  // Every client on the portal, with how many people and live files each has.
  // The counts name `clients.id` in full: Drizzle writes a column of the selected table as a
  // bare "id", which inside `FROM files f` would mean the file's own id.
  r.get(
    '/clients',
    h(async (_req, res) => {
      const rows = await ctx.db
        .select({
          id: schema.clients.id,
          clientCode: schema.clients.clientCode,
          displayName: schema.clients.displayName,
          active: schema.clients.active,
          users: sql<number>`(SELECT count(*) FROM client_access a WHERE a.client_id = clients.id AND a.active)`,
          files: sql<number>`(SELECT count(*) FROM files f WHERE f.client_id = clients.id AND f.removed_at IS NULL)`,
          waiting: sql<number>`(SELECT count(*) FROM uploads u WHERE u.client_id = clients.id AND u.fetched_at IS NULL AND u.removed_at IS NULL)`,
        })
        .from(schema.clients)
        .orderBy(asc(schema.clients.displayName));
      res.json({
        clients: rows.map((c) => ({
          ...c,
          users: Number(c.users),
          files: Number(c.files),
          waiting: Number(c.waiting),
        })),
      });
    }),
  );

  r.put(
    '/clients/:id',
    h(async (req, res) => {
      const id = param(req, 'id');
      const input = body(ClientSchema, req);
      const now = ctx.now();
      await ctx.db
        .insert(schema.clients)
        .values({
          id,
          clientCode: input.clientCode,
          displayName: input.displayName,
          active: input.active ?? true,
        })
        .onConflictDoUpdate({
          target: schema.clients.id,
          set: {
            clientCode: input.clientCode,
            displayName: input.displayName,
            ...(input.active === undefined ? {} : { active: input.active }),
            updatedAt: now,
          },
        });
      if (input.active === false) {
        // A client switched off: its invitations stop working and its users are signed out
        // (they can sign in again to their other clients).
        await withdrawInvites(id);
        const users = await ctx.db
          .select({ identityId: schema.clientAccess.identityId })
          .from(schema.clientAccess)
          .where(eq(schema.clientAccess.clientId, id));
        for (const u of users) await endSessionsOf(ctx.db, u.identityId);
      }
      await record(ctx.db, 'client_updated', actorOf(req), {
        clientId: id,
        detail: {
          clientCode: input.clientCode,
          displayName: input.displayName,
          ...(input.active === undefined ? {} : { active: input.active }),
        },
      });
      res.json({ ok: true });
    }),
  );

  r.get(
    '/clients/:id/users',
    h(async (req, res) => {
      const id = param(req, 'id');
      if (!(await clientExists(id))) throw new HttpError(404, 'client_not_found');
      const users = await ctx.db
        .select({
          identityId: schema.portalIdentity.id,
          name: schema.portalIdentity.name,
          email: schema.portalIdentity.email,
          phone: schema.portalIdentity.phone,
          roleLabel: schema.clientAccess.roleLabel,
          active: schema.clientAccess.active,
          lastSignInAt: schema.portalIdentity.lastSignInAt,
        })
        .from(schema.clientAccess)
        .innerJoin(
          schema.portalIdentity,
          eq(schema.portalIdentity.id, schema.clientAccess.identityId),
        )
        .where(eq(schema.clientAccess.clientId, id))
        .orderBy(asc(schema.portalIdentity.name));
      const now = ctx.now();
      const invites = await ctx.db
        .select()
        .from(schema.portalInvitation)
        .where(
          and(
            eq(schema.portalInvitation.clientId, id),
            isNull(schema.portalInvitation.acceptedAt),
            isNull(schema.portalInvitation.revokedAt),
          ),
        )
        .orderBy(asc(schema.portalInvitation.createdAt));
      res.json({
        users: users.map((u) => ({ ...u, status: u.active ? 'active' : 'disabled' })),
        invitations: invites.map((i) => ({
          invitationId: i.id,
          name: i.name,
          email: i.email,
          phone: i.phone,
          roleLabel: i.roleLabel,
          expiresAt: i.expiresAt,
          status: i.expiresAt > now ? 'invited' : 'expired',
        })),
      });
    }),
  );

  r.post(
    '/clients/:id/invites',
    h(async (req, res) => {
      const clientId = param(req, 'id');
      const input = body(InviteSchema, req);
      const email = input.email ? normalizeEmail(input.email) : null;
      const phone = input.phone ? normalizePhone(input.phone) : null;
      if (input.email && !email) throw new HttpError(400, 'invalid_email');
      if (input.phone && !phone) throw new HttpError(400, 'invalid_phone');
      const sendTo = email ?? phone;
      if (!sendTo) throw new HttpError(400, 'contact_required');
      const [client] = await ctx.db
        .select()
        .from(schema.clients)
        .where(eq(schema.clients.id, clientId));
      if (!client) throw new HttpError(404, 'client_not_found');
      if (!client.active) throw new HttpError(409, 'client_inactive');

      // The person the link goes to already has active access to this client. Only the contact
      // the link goes to counts: a couple can share a phone (QA 2026-11-09).
      const contactMatch = email
        ? eq(schema.portalIdentity.email, email)
        : eq(schema.portalIdentity.phone, sendTo);
      const has = await ctx.db
        .select({ id: schema.portalIdentity.id })
        .from(schema.clientAccess)
        .innerJoin(
          schema.portalIdentity,
          eq(schema.portalIdentity.id, schema.clientAccess.identityId),
        )
        .where(
          and(
            eq(schema.clientAccess.clientId, clientId),
            eq(schema.clientAccess.active, true),
            contactMatch,
          ),
        );
      if (has.length) throw new HttpError(409, 'already_has_access');

      const actor = actorOf(req);
      const now = ctx.now();
      // A new invitation replaces any earlier one to the same contact for this client (Resend).
      const replaced = await withdrawInvites(clientId, [sendTo]);

      const token = randomToken();
      const expiresAt = new Date(now.getTime() + INVITE_DAYS * 86_400_000);
      const [inv] = await ctx.db
        .insert(schema.portalInvitation)
        .values({
          clientId,
          email,
          phone,
          name: input.name,
          roleLabel: input.roleLabel,
          tokenHash: sha256(token),
          invitedBy: actor.name,
          expiresAt,
        })
        .returning({ id: schema.portalInvitation.id });
      if (!inv) throw new Error('invitation insert returned nothing');
      const firm = await firmName(ctx);
      const link = `${ctx.portalUrl}/invite#t=${token}`;
      deliver(
        ctx,
        messageTo(
          sendTo,
          `${firm} invites you to its client portal`,
          `${firm} has invited you to its client portal for ${client.displayName}, where you can ` +
            `get files from the firm and send files to it.\n\n` +
            `Accept the invitation (within ${INVITE_DAYS} days): ${link}`,
        ),
      );
      await record(ctx.db, 'invite', actor, {
        clientId,
        detail: { invitationId: inv.id, replaced: replaced.map((x) => x.id) },
      });
      res.status(201).json({ invitationId: inv.id, expiresAt });
    }),
  );

  r.delete(
    '/clients/:id/invites/:invitationId',
    h(async (req, res) => {
      const clientId = param(req, 'id');
      const invitationId = param(req, 'invitationId');
      const rows = await ctx.db
        .update(schema.portalInvitation)
        .set({ revokedAt: ctx.now() })
        .where(
          and(
            eq(schema.portalInvitation.id, invitationId),
            eq(schema.portalInvitation.clientId, clientId),
            isNull(schema.portalInvitation.acceptedAt),
            isNull(schema.portalInvitation.revokedAt),
          ),
        )
        .returning({ id: schema.portalInvitation.id });
      if (!rows.length) throw new HttpError(404, 'not_found');
      await record(ctx.db, 'invite_revoked', actorOf(req), {
        clientId,
        detail: { invitationId },
      });
      res.json({ ok: true });
    }),
  );

  r.patch(
    '/clients/:id/users/:identityId',
    h(async (req, res) => {
      const clientId = param(req, 'id');
      const identityId = param(req, 'identityId');
      const { active } = body(AccessSchema, req);
      const rows = await ctx.db
        .update(schema.clientAccess)
        .set({ active })
        .where(
          and(
            eq(schema.clientAccess.clientId, clientId),
            eq(schema.clientAccess.identityId, identityId),
          ),
        )
        .returning({ id: schema.clientAccess.identityId });
      if (!rows.length) throw new HttpError(404, 'not_found');
      if (!active) {
        // Signed-in sessions end at once; the person can sign in again to their other clients.
        await endSessionsOf(ctx.db, identityId);
        await voidChallenges(ctx, identityId);
        // An invitation still waiting would quietly turn them back on (QA 2026-11-09).
        const [who] = await ctx.db
          .select({ email: schema.portalIdentity.email, phone: schema.portalIdentity.phone })
          .from(schema.portalIdentity)
          .where(eq(schema.portalIdentity.id, identityId));
        await withdrawInvites(clientId, [who?.email ?? null, who?.phone ?? null]);
      }
      await record(ctx.db, active ? 'enable' : 'disable', actorOf(req), { clientId, identityId });
      res.json({ ok: true });
    }),
  );

  r.get(
    '/access-requests',
    h(async (_req, res) => {
      const rows = await ctx.db
        .select()
        .from(schema.accessRequest)
        .where(
          and(
            eq(schema.accessRequest.status, 'pending'),
            isNotNull(schema.accessRequest.confirmedAt),
          ),
        )
        .orderBy(asc(schema.accessRequest.createdAt));
      res.json({
        requests: rows.map((a) => ({
          id: a.id,
          name: a.name,
          email: a.email,
          phone: a.phone,
          // The contact that received and returned the code; only it is used on approval.
          confirmedContact: a.confirmedContact,
          clientAs: a.clientAs,
          note: a.note,
          createdAt: a.createdAt,
        })),
      });
    }),
  );

  /** Moves a pending, confirmed request on, in one conditional update; nothing comes back when
   *  it was not pending (already decided, or decided at the same moment by another call). */
  const decide = (
    db: Executor,
    id: string,
    set: Partial<typeof schema.accessRequest.$inferInsert>,
  ) =>
    db
      .update(schema.accessRequest)
      .set({ ...set, decidedAt: ctx.now() })
      .where(
        and(
          eq(schema.accessRequest.id, id),
          eq(schema.accessRequest.status, 'pending'),
          isNotNull(schema.accessRequest.confirmedAt),
        ),
      )
      .returning();

  r.post(
    '/access-requests/:id/approve',
    h(async (req, res) => {
      const id = param(req, 'id');
      const input = body(ApproveSchema, req);
      const [client] = await ctx.db
        .select()
        .from(schema.clients)
        .where(eq(schema.clients.id, input.clientId));
      if (!client) throw new HttpError(404, 'client_not_found');
      if (!client.active) throw new HttpError(409, 'client_inactive');
      const actor = actorOf(req);
      const done = await ctx.db.transaction(async (tx) => {
        const [request] = await decide(tx, id, {
          status: 'approved',
          clientId: input.clientId,
          decidedBy: actor.name,
        });
        if (!request) return null;
        if (!request.confirmedContact) throw new Error('confirmed request without its contact');
        // Only the contact the person proved is used (QA 2026-11-09).
        const granted = await grantAccess(tx, {
          clientId: input.clientId,
          proved: request.confirmedContact,
          other: null,
          name: request.name,
          roleLabel: input.roleLabel,
          by: actor.name,
        });
        return { to: request.confirmedContact, identityId: granted.identityId };
      });
      if (!done) throw new HttpError(404, 'not_found');
      const firm = await firmName(ctx);
      deliver(
        ctx,
        messageTo(
          done.to,
          `Your access to ${firm}'s client portal`,
          `${firm} has given you access to its client portal. Sign in at ${ctx.portalUrl}`,
        ),
      );
      await record(ctx.db, 'approve', actor, {
        clientId: input.clientId,
        identityId: done.identityId,
        detail: { accessRequestId: id },
      });
      res.json({ ok: true, identityId: done.identityId });
    }),
  );

  r.post(
    '/access-requests/:id/deny',
    h(async (req, res) => {
      const id = param(req, 'id');
      const actor = actorOf(req);
      const [request] = await decide(ctx.db, id, { status: 'denied', decidedBy: actor.name });
      if (!request) throw new HttpError(404, 'not_found');
      await record(ctx.db, 'deny', actor, { detail: { accessRequestId: id } });
      res.json({ ok: true });
    }),
  );

  return r;
}
