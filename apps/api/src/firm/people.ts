// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P66: the staff page's People view, for staff who see every client (the router is mounted
// after requireAllClients, and only on the staff API: Vibe Files keeps P63's search).
//
//   GET    /api/staff/v1/people/list?q=&offset=         everyone, turned-off accounts too
//   GET    /api/staff/v1/people/:id                     details, clients, a contact change waiting
//   PATCH  /api/staff/v1/people/:id                     { name?, notify? }
//   POST   /api/staff/v1/people/:id/turn-off | turn-on  the whole account
//   POST   /api/staff/v1/people/:id/clients             { clientId, roleLabel? }  access at once
//   DELETE /api/staff/v1/people/:id/clients/:clientId   turns their access to it off
//   POST   /api/staff/v1/people/:id/contact             { email } | { phone }  sends a link to it
//   DELETE /api/staff/v1/people/:id/contact             withdraws the change waiting
//   DELETE /api/staff/v1/people/:id/phone               removes the number (an email stays)
//   POST   /api/staff/v1/people/:id/sign-in-link        sends them a sign-in link
//   GET    /api/staff/v1/people/:id/history?limit=&before=
//
// The portal signs people in by their email or number, so staff never set one directly (P45): a
// mistyped one would let a stranger in. A new one is stored when the link sent to it is opened
// (POST /api/portal/auth/confirm-contact).

import express, { type Request, type Router } from 'express';
import { and, asc, eq, gt, ilike, isNull, like, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@vibe-portal/db';

import { issue } from '../auth/challenges';
import { voidChallenges } from '../auth/client-auth';
import { activeClientsOf } from '../auth/grant';
import { endSessionsOf } from '../auth/sessions';
import { firmName, type Ctx } from '../context';
import { normalizeEmail, normalizePhone } from '../lib/contact';
import { record, type Actor } from '../lib/events';
import { body, h, HttpError } from '../lib/http';
import { messageTo } from '../lib/notify';
import { hit, LIMITS } from '../lib/rate-limit';
import { randomToken, sha256 } from '../lib/secrets';
import type { StaffSession } from '../staff/auth';
import { setAccess, withdrawInvites } from './access';
import { historyRows, HistoryQuery } from './history';

const PAGE = 100;
/** A sign-in link staff send lasts longer than one asked for (15 minutes): it may wait in an
 *  inbox. It still works once. */
export const STAFF_LINK_HOURS = 24;
/** The link that confirms a new email or number. */
export const CONTACT_HOURS = 48;

const Id = z.string().uuid();
const ListQuery = z.object({
  q: z.string().trim().max(100).default(''),
  offset: z.coerce.number().int().min(0).default(0),
});
const PatchSchema = z
  .object({
    name: z.string().trim().max(120).optional(),
    notify: z.enum(['email', 'sms', 'both', 'none']).optional(),
  })
  .refine((v) => v.name !== undefined || v.notify !== undefined);
const AddClientSchema = z.object({
  clientId: Id,
  roleLabel: z.string().trim().max(60).default(''),
});
const ContactSchema = z.union([
  z.object({ email: z.string().trim().max(254) }).strict(),
  z.object({ phone: z.string().trim().max(32) }).strict(),
]);

function likeText(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const staffActor = (req: Request): Actor => ({
  kind: 'staff',
  name: (req.staff as StaffSession).email,
});

type Identity = typeof schema.portalIdentity.$inferSelect;

export function staffPeopleRouter(ctx: Ctx): Router {
  const r = express.Router();

  const identityOf = async (req: Request): Promise<Identity> => {
    const id = Id.safeParse(req.params['identityId']);
    if (!id.success) throw new HttpError(404, 'not_found');
    const [who] = await ctx.db
      .select()
      .from(schema.portalIdentity)
      .where(eq(schema.portalIdentity.id, id.data));
    if (!who) throw new HttpError(404, 'not_found');
    return who;
  };

  /** Every client the person has (or had) access to, with whether it is on. */
  const clientsOf = (identityId: string) =>
    ctx.db
      .select({
        id: schema.clients.id,
        name: schema.clients.displayName,
        roleLabel: schema.clientAccess.roleLabel,
        active: schema.clientAccess.active,
        clientActive: schema.clients.active,
      })
      .from(schema.clientAccess)
      .innerJoin(schema.clients, eq(schema.clients.id, schema.clientAccess.clientId))
      .where(eq(schema.clientAccess.identityId, identityId))
      .orderBy(asc(schema.clients.displayName));

  /** Sign-in links and contact links for one person: a few an hour, so staff cannot flood them. */
  const limit = async (identityId: string): Promise<void> => {
    if (!(await hit(ctx.db, `staff-send:${identityId}`, LIMITS.staffSendPerPerson, ctx.now()))) {
      throw new HttpError(429, 'too_many_requests');
    }
  };

  r.get(
    '/list',
    h(async (req, res) => {
      const q = ListQuery.parse(req.query);
      const id = schema.portalIdentity;
      const words = q.q.split(/\s+/).filter(Boolean);
      const each = words.map((w) => {
        const digits = w.replace(/\D/g, '');
        return or(
          ilike(id.name, likeText(w)),
          ilike(id.email, likeText(w)),
          digits.length >= 3 ? like(id.phone, likeText(digits)) : undefined,
        );
      });
      const people = await ctx.db
        .select({
          identityId: id.id,
          name: id.name,
          email: id.email,
          phone: id.phone,
          status: id.status,
          lastSignInAt: id.lastSignInAt,
        })
        .from(id)
        .where(and(...each))
        .orderBy(asc(id.name), asc(id.email), asc(id.phone), asc(id.id))
        .limit(PAGE + 1)
        .offset(q.offset);
      const shown = people.slice(0, PAGE);
      const access = shown.length
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
                eq(schema.clientAccess.active, true),
                sql`${schema.clientAccess.identityId} in (${sql.join(
                  shown.map((p) => sql`${p.identityId}`),
                  sql`, `,
                )})`,
              ),
            )
            .orderBy(asc(schema.clients.displayName))
        : [];
      res.json({
        people: shown.map((p) => ({
          ...p,
          clients: access
            .filter((a) => a.identityId === p.identityId)
            .map(({ id: cid, name }) => ({ id: cid, name })),
        })),
        more: people.length > PAGE,
      });
    }),
  );

  r.get(
    '/:identityId',
    h(async (req, res) => {
      const who = await identityOf(req);
      const [pending] = await ctx.db
        .select({
          contact: schema.signInChallenge.contact,
          expiresAt: schema.signInChallenge.expiresAt,
        })
        .from(schema.signInChallenge)
        .where(
          and(
            eq(schema.signInChallenge.identityId, who.id),
            eq(schema.signInChallenge.kind, 'contact_confirm'),
            isNull(schema.signInChallenge.usedAt),
            gt(schema.signInChallenge.expiresAt, ctx.now()),
          ),
        );
      res.json({
        person: {
          identityId: who.id,
          name: who.name,
          email: who.email,
          phone: who.phone,
          notify: who.notify,
          status: who.status,
          createdAt: who.createdAt,
          lastSignInAt: who.lastSignInAt,
        },
        clients: await clientsOf(who.id),
        pendingContact: pending ?? null,
        textsOn: !ctx.textsOff,
      });
    }),
  );

  r.patch(
    '/:identityId',
    h(async (req, res) => {
      const who = await identityOf(req);
      const input = body(PatchSchema, req);
      if (input.notify) {
        const wantsEmail = input.notify === 'email' || input.notify === 'both';
        const wantsText = input.notify === 'sms' || input.notify === 'both';
        if ((wantsEmail && !who.email) || (wantsText && (!who.phone || ctx.textsOff))) {
          throw new HttpError(400, 'notify_unreachable');
        }
      }
      await ctx.db
        .update(schema.portalIdentity)
        .set(input)
        .where(eq(schema.portalIdentity.id, who.id));
      await record(ctx.db, 'person_updated', staffActor(req), {
        identityId: who.id,
        detail: { fields: Object.keys(input).join(',') },
      });
      res.json({ ok: true });
    }),
  );

  // The whole account: off signs them out everywhere, ends every sign-in link and code, and
  // withdraws invitations to their email or number (accepting one would not turn them on, but
  // it would look as if it had). Their clients and history stay.
  for (const on of [false, true]) {
    r.post(
      `/:identityId/${on ? 'turn-on' : 'turn-off'}`,
      h(async (req, res) => {
        const who = await identityOf(req);
        await ctx.db
          .update(schema.portalIdentity)
          .set({ status: on ? 'active' : 'disabled' })
          .where(eq(schema.portalIdentity.id, who.id));
        if (!on) {
          await endSessionsOf(ctx.db, who.id);
          await voidChallenges(ctx, who.id);
          await withdrawInvites(ctx, null, [who.email, who.phone]);
        }
        if ((who.status === 'active') !== on) {
          await record(ctx.db, on ? 'account_on' : 'account_off', staffActor(req), {
            identityId: who.id,
          });
        }
        res.json({ ok: true });
      }),
    );
  }

  r.post(
    '/:identityId/clients',
    h(async (req, res) => {
      const who = await identityOf(req);
      const input = body(AddClientSchema, req);
      const [client] = await ctx.db
        .select()
        .from(schema.clients)
        .where(eq(schema.clients.id, input.clientId));
      if (!client) throw new HttpError(404, 'client_not_found');
      if (!client.active) throw new HttpError(409, 'client_inactive');
      const [had] = await ctx.db
        .select({ active: schema.clientAccess.active })
        .from(schema.clientAccess)
        .where(
          and(
            eq(schema.clientAccess.identityId, who.id),
            eq(schema.clientAccess.clientId, client.id),
          ),
        );
      if (had?.active) throw new HttpError(409, 'already_has_access');
      const by = staffActor(req);
      await ctx.db
        .insert(schema.clientAccess)
        .values({
          identityId: who.id,
          clientId: client.id,
          roleLabel: input.roleLabel,
          active: true,
          invitedBy: by.name,
        })
        .onConflictDoUpdate({
          target: [schema.clientAccess.identityId, schema.clientAccess.clientId],
          set: { active: true, roleLabel: input.roleLabel, invitedBy: by.name },
        });
      await record(ctx.db, 'client_added', by, { clientId: client.id, identityId: who.id });
      // Told where they asked to hear from the portal; nothing for a turned-off account.
      let told = false;
      if (who.status === 'active' && who.notify !== 'none') {
        const firm = await firmName(ctx);
        const to = [
          ...(who.email && who.notify !== 'sms' ? [who.email] : []),
          ...(who.phone && !ctx.textsOff && who.notify !== 'email' ? [who.phone] : []),
        ];
        for (const c of to) {
          const email = c.includes('@');
          try {
            await ctx.notifier.send(
              messageTo(
                c,
                email ? `${client.displayName} on ${firm}'s client portal` : '',
                email
                  ? `${firm} has given you access to ${client.displayName} on its client portal.\n\n` +
                      `Sign in to see it: ${ctx.portalUrl}/\n\n` +
                      'If you have more than one client, choose it at the top of the page.'
                  : `${firm}: you can now see ${client.displayName} on the client portal. Sign in at ${ctx.portalUrl}/`,
              ),
            );
            told = true;
          } catch (err) {
            ctx.log.error({ err, channel: email ? 'email' : 'sms' }, 'client added notice failed');
          }
        }
      }
      res.status(201).json({ ok: true, told });
    }),
  );

  r.delete(
    '/:identityId/clients/:clientId',
    h(async (req, res) => {
      const who = await identityOf(req);
      const clientId = Id.safeParse(req.params['clientId']);
      if (!clientId.success) throw new HttpError(404, 'not_found');
      if (!(await setAccess(ctx, clientId.data, who.id, false))) {
        throw new HttpError(404, 'not_found');
      }
      await record(ctx.db, 'disable', staffActor(req), {
        clientId: clientId.data,
        identityId: who.id,
      });
      res.json({ ok: true });
    }),
  );

  r.post(
    '/:identityId/contact',
    h(async (req, res) => {
      const who = await identityOf(req);
      if (who.status !== 'active') throw new HttpError(409, 'account_off');
      const input = body(ContactSchema, req);
      const field = 'email' in input ? 'email' : 'phone';
      const value = 'email' in input ? normalizeEmail(input.email) : normalizePhone(input.phone);
      if (!value) throw new HttpError(400, field === 'email' ? 'invalid_email' : 'invalid_phone');
      if (field === 'phone' && ctx.textsOff) throw new HttpError(409, 'texts_off');
      if (who[field] === value) throw new HttpError(400, 'same_contact');
      const col = schema.portalIdentity[field];
      const [taken] = await ctx.db
        .select({ id: schema.portalIdentity.id })
        .from(schema.portalIdentity)
        .where(and(eq(col, value), ne(schema.portalIdentity.id, who.id)));
      if (taken) throw new HttpError(409, 'contact_taken');
      await limit(who.id);
      const token = randomToken();
      const now = ctx.now();
      await issue(
        ctx.db,
        {
          kind: 'contact_confirm',
          identityId: who.id,
          contact: value,
          secretHash: sha256(token),
          expiresAt: new Date(now.getTime() + CONTACT_HOURS * 3_600_000),
        },
        now,
      );
      const firm = await firmName(ctx);
      const link = `${ctx.portalUrl}/auth/confirm-contact#t=${token}`;
      // Nothing about the person or their files: a mistyped address gets only this.
      const msg =
        field === 'email'
          ? messageTo(
              value,
              `Confirm your email for ${firm}'s client portal`,
              `${firm} asked to use this email address for signing in to its client portal. ` +
                `To confirm, open this link. It works once, for ${CONTACT_HOURS} hours.\n\n${link}\n\n` +
                `If you don't know ${firm} or did not expect this, ignore this email: nothing changes.`,
            )
          : messageTo(
              value,
              '',
              `${firm}: open this link to use this number for signing in to its client portal: ${link} ` +
                'If you did not expect this, ignore it.',
            );
      try {
        await ctx.notifier.send(msg);
      } catch (err) {
        ctx.log.error({ err, channel: field === 'email' ? 'email' : 'sms' }, 'contact link failed');
        await voidChallenges(ctx, who.id);
        throw new HttpError(502, 'send_failed');
      }
      await record(ctx.db, 'contact_change_sent', staffActor(req), {
        identityId: who.id,
        detail: { field, to: value },
      });
      res.json({ ok: true });
    }),
  );

  r.delete(
    '/:identityId/contact',
    h(async (req, res) => {
      const who = await identityOf(req);
      await ctx.db
        .update(schema.signInChallenge)
        .set({ usedAt: ctx.now() })
        .where(
          and(
            eq(schema.signInChallenge.identityId, who.id),
            eq(schema.signInChallenge.kind, 'contact_confirm'),
            isNull(schema.signInChallenge.usedAt),
          ),
        );
      res.json({ ok: true });
    }),
  );

  // Removing the number is safe (it lets nobody in); the email stays, so they can still sign in.
  r.delete(
    '/:identityId/phone',
    h(async (req, res) => {
      const who = await identityOf(req);
      if (!who.phone) throw new HttpError(404, 'not_found');
      if (!who.email) throw new HttpError(409, 'only_contact');
      await ctx.db
        .update(schema.portalIdentity)
        .set({
          phone: null,
          ...(who.notify === 'sms' || who.notify === 'both' ? { notify: 'email' } : {}),
        })
        .where(eq(schema.portalIdentity.id, who.id));
      // Codes already texted to it stop working.
      await ctx.db
        .update(schema.signInChallenge)
        .set({ usedAt: ctx.now() })
        .where(
          and(
            eq(schema.signInChallenge.identityId, who.id),
            eq(schema.signInChallenge.contact, who.phone),
            isNull(schema.signInChallenge.usedAt),
          ),
        );
      await record(ctx.db, 'phone_removed', staffActor(req), { identityId: who.id });
      res.json({ ok: true });
    }),
  );

  r.post(
    '/:identityId/sign-in-link',
    h(async (req, res) => {
      const who = await identityOf(req);
      if (who.status !== 'active') throw new HttpError(409, 'account_off');
      if ((await activeClientsOf(ctx.db, who.id)).length === 0) {
        throw new HttpError(409, 'no_access');
      }
      const to = who.email ?? (ctx.textsOff ? null : who.phone);
      if (!to) throw new HttpError(409, 'texts_off');
      await limit(who.id);
      const token = randomToken();
      const now = ctx.now();
      await issue(
        ctx.db,
        {
          kind: 'magic_link',
          identityId: who.id,
          contact: to,
          secretHash: sha256(token),
          expiresAt: new Date(now.getTime() + STAFF_LINK_HOURS * 3_600_000),
        },
        now,
      );
      const firm = await firmName(ctx);
      const link = `${ctx.portalUrl}/auth/verify#t=${token}`;
      const email = to.includes('@');
      try {
        await ctx.notifier.send(
          email
            ? messageTo(
                to,
                `Sign in to ${firm}'s client portal`,
                `${firm} sent you this link to sign in to its client portal. It works once, for ` +
                  `${STAFF_LINK_HOURS} hours.\n\n${link}\n\n` +
                  `After that, sign in at ${ctx.portalUrl}/ with this email address.`,
              )
            : messageTo(
                to,
                '',
                `${firm}: sign in to its client portal with this link (works once, for ${STAFF_LINK_HOURS} hours): ${link}`,
              ),
        );
      } catch (err) {
        ctx.log.error({ err, channel: email ? 'email' : 'sms' }, 'sign-in link failed');
        throw new HttpError(502, 'send_failed');
      }
      await record(ctx.db, 'sign_in_link_sent', staffActor(req), {
        identityId: who.id,
        detail: { to },
      });
      res.json({ ok: true, to });
    }),
  );

  r.get(
    '/:identityId/history',
    h(async (req, res) => {
      const who = await identityOf(req);
      const q = HistoryQuery.parse(req.query);
      const events = await historyRows(
        ctx,
        or(
          eq(schema.events.identityId, who.id),
          and(eq(schema.events.actorKind, 'client'), eq(schema.events.actor, who.id)),
        ),
        q,
      );
      res.json({ events });
    }),
  );

  return r;
}
