// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// The firm API Vibe Files uses (BUILD_PLAN.md §3), Phase 2 part: status, clients, users,
// invitations and access requests. Every call needs the firm key; every change is recorded.
//
//   GET    /api/firm/v1/status
//   GET    /api/firm/v1/clients/:id                        one client, with its counts (P54)
//   PUT    /api/firm/v1/clients/:id                        { clientCode, displayName, active? }
//   GET    /api/firm/v1/clients/:id/users
//   POST   /api/firm/v1/clients/:id/invites                { email?, phone?, name, roleLabel? }
//   DELETE /api/firm/v1/clients/:id/invites/:invitationId
//   PATCH  /api/firm/v1/clients/:id/users/:identityId      { active }
//   GET    /api/firm/v1/people?q=…                          people on the portal, by name or contact (P63)
//   GET    /api/firm/v1/access-requests                     (confirmed, pending)
//   POST   /api/firm/v1/access-requests/:id/approve         { clientId | clientIds[], roleLabel? }
//   POST   /api/firm/v1/access-requests/:id/deny

import express, { type Request, type RequestHandler, type Router } from 'express';
import { and, asc, eq, ilike, inArray, isNotNull, isNull, like, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@vibe-portal/db';

import { grantAccess, type Executor } from '../auth/grant';
import { endSessionsOf } from '../auth/sessions';
import { deliver, firmName, type Ctx } from '../context';
import { normalizeEmail, normalizePhone } from '../lib/contact';
import { record, type Actor } from '../lib/events';
import { body, h, HttpError } from '../lib/http';
import { messageTo } from '../lib/notify';
import { hit, LIMITS } from '../lib/rate-limit';
import { randomToken, sha256 } from '../lib/secrets';
import { inScope, mustSee, requireAllClients } from '../staff/scope';
import { storageSummary } from '../files/storage';
import { VERSION } from '../version';
import { setAccess, withdrawInvites } from './access';
import { firmFilesRouter } from './files';
import { historyRows, HistoryQuery } from './history';
import { staffPeopleRouter } from './people';
import { staffClientLinksRouter } from './client-links';
import { fileRequestRecord, readIdPhoto } from '../portal/access-id';
import { requireFirmKey } from './keys';
import { firmEventsRouter } from './events';
import { firmSharesRouter } from './shares';
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
// P63: at least two letters or digits, so the whole list is never read by accident.
const PeopleQuery = z.object({ q: z.string().trim().min(2).max(100) });
export const PEOPLE_SHOWN = 20;

/** `%text%` for LIKE, with LIKE's own characters taken literally. */
function likeText(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
// P61: one or more clients. Vibe Files sends `clientId`; the staff page sends `clientIds`.
const ApproveSchema = z
  .object({
    clientId: Uuid.optional(),
    clientIds: z.array(Uuid).min(1).max(50).optional(),
    roleLabel: z.string().trim().max(60).default(''),
  })
  .refine((a) => a.clientId || a.clientIds?.length, 'clientId or clientIds');

function param(req: Request, name: string): string {
  const v = Uuid.safeParse(req.params[name]);
  if (!v.success) throw new HttpError(404, 'not_found');
  return v.data;
}

function actorOf(req: Request): Actor {
  return req.firmActor ?? { kind: 'firm_key', name: 'Vibe Files' };
}

/** Vibe Files' firm API, authorised by the firm key. */
/** A client and its counts, for the client list and a client's page (P54). The counts name
 *  `clients.id` in full: inside `FROM files f` a bare "id" would be the file's own. */
const clientColumns = {
  id: schema.clients.id,
  clientCode: schema.clients.clientCode,
  displayName: schema.clients.displayName,
  active: schema.clients.active,
  users: sql<number>`(SELECT count(*) FROM client_access a WHERE a.client_id = clients.id AND a.active)`,
  files: sql<number>`(SELECT count(*) FROM files f WHERE f.client_id = clients.id AND f.removed_at IS NULL)`,
  waiting: sql<number>`(SELECT count(*) FROM uploads u WHERE u.client_id = clients.id AND u.fetched_at IS NULL AND u.removed_at IS NULL)`,
};

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

function firmApi(ctx: Ctx, auth: RequestHandler, staff: boolean): Router {
  const r = express.Router();
  r.use(auth);
  r.use('/files', firmFilesRouter(ctx, staff));
  r.use('/uploads', firmUploadsRouter(ctx, staff));
  r.use('/events', firmEventsRouter(ctx));
  // Secure links to people outside the client (P49), from the staff page and (P68) from Vibe
  // Files' Send secure link… with the firm key.
  r.use('/shares', firmSharesRouter(ctx, staff));
  // P48: a staff member limited to some clients reaches only those; any other answers as if it
  // were not on the portal. Access requests are not about one client yet, so they are for staff
  // who see every client. (Vibe Files, with the firm key, sees everything.)
  r.use(
    '/clients/:id',
    h(async (req, _res, next) => {
      await mustSee(ctx.db, req, req.params['id'] ?? '', 'client_not_found');
      next();
    }),
  );
  r.use('/access-requests', requireAllClients);
  // P63: everyone on the portal, whatever their client: for staff who see every client.
  r.use('/people', requireAllClients);
  // P66: the staff page's People view (a person's details, clients, account, activity).
  if (staff) r.use('/people', staffPeopleRouter(ctx));
  // P76: each client's link at the top of its portal: any staff member, for their clients.
  if (staff) r.use(staffClientLinksRouter(ctx));

  const clientExists = async (id: string): Promise<boolean> =>
    (
      await ctx.db
        .select({ id: schema.clients.id })
        .from(schema.clients)
        .where(eq(schema.clients.id, id))
    ).length > 0;

  r.get(
    '/status',
    h(async (_req, res) => {
      // P51: where stored files are, for Vibe Files' Admin > Portal > Test.
      res.json({
        version: VERSION,
        firmName: await firmName(ctx),
        portalUrl: ctx.portalUrl,
        ...(await storageSummary(ctx)),
      });
    }),
  );

  // Every client on the portal, with how many people and live files each has.
  // The counts name `clients.id` in full: Drizzle writes a column of the selected table as a
  // bare "id", which inside `FROM files f` would mean the file's own id.
  r.get(
    '/clients',
    h(async (req, res) => {
      const rows = await ctx.db
        .select(clientColumns)
        .from(schema.clients)
        .where(inScope(req, schema.clients.id))
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

  // P54: one client, for the heading of its page on the staff page.
  r.get(
    '/clients/:id',
    h(async (req, res) => {
      const id = param(req, 'id');
      const [c] = await ctx.db
        .select(clientColumns)
        .from(schema.clients)
        .where(eq(schema.clients.id, id));
      if (!c) throw new HttpError(404, 'client_not_found');
      res.json({
        ...c,
        users: Number(c.users),
        files: Number(c.files),
        waiting: Number(c.waiting),
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
        await withdrawInvites(ctx, id);
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

  // P65: what happened on one client, newest first, for the client's page: its files, uploads,
  // people and secure links, and the sign-ins of the people who can see it.
  const PERSONAL = [
    'sign_in',
    'sign_out',
    'phone_added',
    'phone_removed',
    // P66: their account turned off or on, their details or contact changed.
    'account_off',
    'account_on',
    'person_updated',
    'contact_change_sent',
    'contact_changed',
    'sign_in_link_sent',
  ] as const;
  r.get(
    '/clients/:id/history',
    h(async (req, res) => {
      const id = param(req, 'id');
      if (!(await clientExists(id))) throw new HttpError(404, 'client_not_found');
      const q = HistoryQuery.parse(req.query);
      const events = await historyRows(
        ctx,
        or(
          eq(schema.events.clientId, id),
          // Sign-ins are not about one client: those of the people who can see this one.
          and(
            isNull(schema.events.clientId),
            inArray(schema.events.kind, [...PERSONAL]),
            inArray(
              schema.events.identityId,
              ctx.db
                .select({ id: schema.clientAccess.identityId })
                .from(schema.clientAccess)
                .where(eq(schema.clientAccess.clientId, id)),
            ),
          ),
        ),
        q,
      );
      res.json({ events });
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
      // P62: every client each person can see (this one too), for the tags under their name.
      // Staff limited to some clients see only those among them.
      const theirs = users.length
        ? await ctx.db
            .select({
              identityId: schema.clientAccess.identityId,
              id: schema.clients.id,
              name: schema.clients.displayName,
            })
            .from(schema.clientAccess)
            .innerJoin(schema.clients, eq(schema.clients.id, schema.clientAccess.clientId))
            .where(
              and(
                inArray(
                  schema.clientAccess.identityId,
                  users.map((u) => u.identityId),
                ),
                eq(schema.clientAccess.active, true),
                inScope(req, schema.clientAccess.clientId),
              ),
            )
            .orderBy(asc(schema.clients.displayName))
        : [];
      const clientsOf = (identityId: string): { id: string; name: string }[] =>
        theirs
          .filter((c) => c.identityId === identityId)
          .map(({ id: cid, name }) => ({ id: cid, name }));
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
        users: users.map((u) => ({
          ...u,
          status: u.active ? 'active' : 'disabled',
          clients: clientsOf(u.identityId),
        })),
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
      // P66 QA: an invitation to a turned-off account could not be accepted.
      const [off] = await ctx.db
        .select({ id: schema.portalIdentity.id })
        .from(schema.portalIdentity)
        .where(and(contactMatch, eq(schema.portalIdentity.status, 'disabled')));
      if (off) throw new HttpError(409, 'account_off');

      const actor = actorOf(req);
      const now = ctx.now();
      // A new invitation replaces any earlier one to the same contact for this client (Resend).
      const replaced = await withdrawInvites(ctx, clientId, [sendTo]);

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
      if (!(await setAccess(ctx, clientId, identityId, active))) {
        throw new HttpError(404, 'not_found');
      }
      await record(ctx.db, active ? 'enable' : 'disable', actorOf(req), { clientId, identityId });
      res.json({ ok: true });
    }),
  );

  // P63: people already on the portal whose name, email or mobile number has the words typed,
  // with the clients they can see, so Vibe Files can invite one to another client without
  // retyping their contact. Turned-off accounts are left out. Reading changes nothing.
  r.get(
    '/people',
    h(async (req, res) => {
      const parsed = PeopleQuery.safeParse(req.query);
      if (!parsed.success) throw new HttpError(400, 'query_too_short');
      const words = parsed.data.q.split(/\s+/).filter(Boolean);
      const id = schema.portalIdentity;
      const each = words.map((w) => {
        const digits = w.replace(/\D/g, '');
        return or(
          ilike(id.name, likeText(w)),
          ilike(id.email, likeText(w)),
          // A number typed with spaces, dashes or brackets still finds the stored +15551234567.
          digits.length >= 3 ? like(id.phone, likeText(digits)) : undefined,
        );
      });
      const people = await ctx.db
        .select({ identityId: id.id, name: id.name, email: id.email, phone: id.phone })
        .from(id)
        .where(and(eq(id.status, 'active'), ...each))
        .orderBy(asc(id.name), asc(id.email))
        .limit(PEOPLE_SHOWN);
      const theirs = people.length
        ? await ctx.db
            .select({
              identityId: schema.clientAccess.identityId,
              id: schema.clients.id,
              name: schema.clients.displayName,
            })
            .from(schema.clientAccess)
            .innerJoin(schema.clients, eq(schema.clients.id, schema.clientAccess.clientId))
            .where(
              and(
                inArray(
                  schema.clientAccess.identityId,
                  people.map((p) => p.identityId),
                ),
                eq(schema.clientAccess.active, true),
              ),
            )
            .orderBy(asc(schema.clients.displayName))
        : [];
      res.json({
        people: people.map((p) => ({
          ...p,
          clients: theirs
            .filter((c) => c.identityId === p.identityId)
            .map(({ id: cid, name }) => ({ id: cid, name })),
        })),
      });
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
          // P67: the photo ID sent with it (shown from the route below).
          idPhoto: a.idBlobKey ? { contentType: a.idContentType, size: a.idSize } : null,
        })),
      });
    }),
  );

  // P67: the photo ID of a request (also after it is decided, until it is deleted), shown in the
  // page. History has who looked (once an hour each: the page shows it on every load).
  r.get(
    '/access-requests/:id/id-photo',
    h(async (req, res) => {
      const id = z.string().uuid().safeParse(req.params['id']);
      if (!id.success) throw new HttpError(404, 'not_found');
      const [request] = await ctx.db
        .select()
        .from(schema.accessRequest)
        .where(eq(schema.accessRequest.id, id.data));
      const photo = request ? await readIdPhoto(ctx, request) : null;
      if (!request || !photo) throw new HttpError(404, 'not_found');
      const actor = actorOf(req);
      if (
        await hit(ctx.db, `id-view:${actor.name}:${request.id}`, LIMITS.idViewRecord, ctx.now())
      ) {
        await record(ctx.db, 'id_viewed', actor, { detail: { accessRequestId: request.id } });
      }
      res.setHeader('Content-Type', photo.contentType);
      res.setHeader('Content-Disposition', 'inline; filename="photo-id"');
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(photo.bytes);
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
      const clientIds = [
        ...new Set([...(input.clientIds ?? []), ...(input.clientId ? [input.clientId] : [])]),
      ];
      const found = await ctx.db
        .select()
        .from(schema.clients)
        .where(inArray(schema.clients.id, clientIds));
      // Every client must exist and be switched on, or none is given (P61).
      if (found.length !== clientIds.length) throw new HttpError(404, 'client_not_found');
      if (found.some((c) => !c.active)) throw new HttpError(409, 'client_inactive');
      const actor = actorOf(req);
      const done = await ctx.db.transaction(async (tx) => {
        const [request] = await decide(tx, id, {
          status: 'approved',
          // The request keeps the first; History has one entry per client.
          clientId: clientIds[0],
          decidedBy: actor.name,
        });
        if (!request) return null;
        if (!request.confirmedContact) throw new Error('confirmed request without its contact');
        // Only the contact the person proved is used (QA 2026-11-09).
        let identityId = '';
        for (const clientId of clientIds) {
          const granted = await grantAccess(tx, {
            clientId,
            proved: request.confirmedContact,
            name: request.name,
            roleLabel: input.roleLabel,
            by: actor.name,
          });
          identityId = granted.identityId;
        }
        // P67: kept for the record of the approval (made after, and again if it fails).
        await tx
          .update(schema.accessRequest)
          .set({ identityId, clientIds, roleLabel: input.roleLabel })
          .where(eq(schema.accessRequest.id, id));
        return { to: request.confirmedContact, identityId };
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
      for (const clientId of clientIds) {
        await record(ctx.db, 'approve', actor, {
          clientId,
          identityId: done.identityId,
          detail: { accessRequestId: id },
        });
      }
      // P67: the request and its photo ID, as a PDF for Vibe Files' Portal inbox (first client).
      // When it cannot be made, the hourly purge tries again while the photo ID is kept.
      const recorded = await fileRequestRecord(ctx, {
        requestId: id,
        identityId: done.identityId,
        clientIds,
        approvedBy: actor.name,
        roleLabel: input.roleLabel,
        firmName: firm,
      });
      res.json({ ok: true, identityId: done.identityId, clientIds, recorded });
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
