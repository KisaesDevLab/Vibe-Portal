// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// The staff page's Settings (P36): the firm's name, colour and logo, the upload limit and how
// long fetched uploads are kept, the firm keys Vibe Files uses, and staff accounts. Every change
// is recorded with the staff member's name. All of it is for admins (P48).
//
//   GET    /api/staff/v1/settings
//   PUT    /api/staff/v1/settings                { firmName, accentColor, uploadLimitMb, uploadKeepDays }
//   PUT    /api/staff/v1/settings/logo           body: PNG or JPEG, at most 512 KB
//   DELETE /api/staff/v1/settings/logo
//   GET    /api/staff/v1/keys                    POST { label } -> { key } (shown once)
//   DELETE /api/staff/v1/keys/:id
//   GET    /api/staff/v1/staff                   POST { email, name, admin?, clientIds? }
//                                                -> { setupLink }
//   PATCH  /api/staff/v1/staff/:id               { active?, admin?, clientIds? }
//          clientIds: the only clients they see, or null for every client. An admin sees all.
//   POST   /api/staff/v1/staff/:id/reset         -> { setupLink } (new password and authenticator)
//
//   GET    /api/portal/branding                  (public) { firmName, accentColor, hasLogo }
//   GET    /api/portal/branding/logo             (public)

import express, { type Request, type Router } from 'express';
import { asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Database } from '@vibe-portal/db';

import { firmName, MAX_UPLOAD_BYTES, type Ctx } from '../context';
import { createFirmKey, revokeFirmKey } from '../firm/keys';
import { normalizeEmail } from '../lib/contact';
import { record, type Actor } from '../lib/events';
import { body, h, HttpError } from '../lib/http';
import { messageTo } from '../lib/notify';
import { cancelSetupLinks, createSetupLink, type StaffSession } from './auth';
import { requireAdmin } from './scope';
import { storageRouter } from './storage';

const MB = 1024 * 1024;
const LOGO_MAX = 512 * 1024;

const SettingsSchema = z.object({
  firmName: z.string().trim().min(1).max(120),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  uploadLimitMb: z
    .number()
    .int()
    .min(1)
    .max(MAX_UPLOAD_BYTES / MB),
  uploadKeepDays: z.number().int().min(0).max(3650),
  /** Clients may send secure links to files shared with them (P55). Left out: unchanged. */
  clientLinks: z.boolean().optional(),
  /** Downloads each new secure link allows, 0 for no limit (P58). Left out: unchanged. */
  shareDownloadLimit: z.number().int().min(0).max(1000).optional(),
});
const KeySchema = z.object({ label: z.string().trim().min(1).max(60) });
/** The only clients a staff member sees, or null for every client. */
const ClientIds = z.array(z.string().uuid()).max(20_000).nullable();
const StaffSchema = z.object({
  email: z.string().trim().max(254),
  name: z.string().trim().min(1).max(120),
  admin: z.boolean().default(false),
  clientIds: ClientIds.default(null),
});
const StaffChange = z
  .object({
    active: z.boolean().optional(),
    admin: z.boolean().optional(),
    clientIds: ClientIds.optional(),
    /** Clients sending files may ask that this person be told (P56). */
    notifyUploads: z.boolean().optional(),
    /** Emailed about new access requests (P59). */
    notifyAccessRequests: z.boolean().optional(),
  })
  .refine((c) => Object.values(c).some((v) => v !== undefined), 'nothing to change');

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Replaces the clients a staff member is limited to (none when they see every client). */
async function setClients(tx: Tx, staffId: string, clientIds: string[] | null): Promise<void> {
  await tx.delete(schema.staffClient).where(eq(schema.staffClient.staffId, staffId));
  const ids = [...new Set((clientIds ?? []).map((c) => c.toLowerCase()))];
  if (!ids.length) return;
  const known = await tx
    .select({ id: schema.clients.id })
    .from(schema.clients)
    .where(inArray(schema.clients.id, ids));
  if (known.length !== ids.length) throw new HttpError(400, 'client_not_found');
  await tx.insert(schema.staffClient).values(ids.map((clientId) => ({ staffId, clientId })));
}

function actor(req: Request): Actor {
  return { kind: 'staff', name: (req.staff as StaffSession).email };
}

function idParam(req: Request): string {
  const v = z.string().uuid().safeParse(req.params['id']);
  if (!v.success) throw new HttpError(404, 'not_found');
  // As the database writes it: the checks against the caller's own id compare text.
  return v.data.toLowerCase();
}

/** PNG or JPEG by its first bytes. */
function imageType(b: Buffer): string | null {
  if (b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (b.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'image/jpeg';
  return null;
}

export function staffSettingsRouter(ctx: Ctx): Router {
  const r = express.Router();
  // Not `r.use(requireAdmin)`: the rest of the staff API is mounted after this router.
  r.use(['/settings', '/keys', '/staff'], requireAdmin);
  // Where stored files live, and moving them (P51).
  r.use('/settings/storage', storageRouter(ctx));

  r.get(
    '/settings',
    h(async (_req, res) => {
      const [f] = await ctx.db.select().from(schema.firm);
      res.json({
        firmName: f?.name ?? '',
        accentColor: f?.accentColor ?? '#0f6cbd',
        uploadLimitMb: Math.round((f?.uploadLimitBytes ?? MAX_UPLOAD_BYTES) / MB),
        uploadKeepDays: f?.uploadKeepDays ?? 30,
        hasLogo: Boolean(f?.logo),
        portalUrl: ctx.portalUrl,
        clientLinks: Boolean(f?.clientLinks),
        shareDownloadLimit: f?.shareDownloadLimit ?? 5,
      });
    }),
  );

  r.put(
    '/settings',
    h(async (req, res) => {
      const s = body(SettingsSchema, req);
      await ctx.db.update(schema.firm).set({
        name: s.firmName,
        accentColor: s.accentColor,
        uploadLimitBytes: s.uploadLimitMb * MB,
        uploadKeepDays: s.uploadKeepDays,
        ...(s.clientLinks !== undefined ? { clientLinks: s.clientLinks } : {}),
        ...(s.shareDownloadLimit !== undefined ? { shareDownloadLimit: s.shareDownloadLimit } : {}),
        updatedAt: ctx.now(),
      });
      await record(ctx.db, 'settings_updated', actor(req), { detail: s });
      res.json({ ok: true });
    }),
  );

  r.put(
    '/settings/logo',
    express.raw({ type: ['image/png', 'image/jpeg', 'application/octet-stream'], limit: LOGO_MAX }),
    h(async (req, res) => {
      const b = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const type = imageType(b);
      if (!type) throw new HttpError(415, 'png_or_jpeg');
      await ctx.db.update(schema.firm).set({ logo: b, logoType: type, updatedAt: ctx.now() });
      await record(ctx.db, 'settings_updated', actor(req), {
        detail: { logo: type, size: b.length },
      });
      res.json({ ok: true });
    }),
  );

  r.delete(
    '/settings/logo',
    h(async (req, res) => {
      await ctx.db.update(schema.firm).set({ logo: null, logoType: null, updatedAt: ctx.now() });
      await record(ctx.db, 'settings_updated', actor(req), { detail: { logo: null } });
      res.json({ ok: true });
    }),
  );

  r.get(
    '/keys',
    h(async (_req, res) => {
      const rows = await ctx.db
        .select()
        .from(schema.firmKeys)
        .orderBy(asc(schema.firmKeys.createdAt));
      res.json({
        keys: rows.map((k) => ({
          id: k.id,
          label: k.label,
          createdAt: k.createdAt,
          lastUsedAt: k.lastUsedAt,
          revokedAt: k.revokedAt,
        })),
      });
    }),
  );

  r.post(
    '/keys',
    h(async (req, res) => {
      const { label } = body(KeySchema, req);
      const { id, key } = await createFirmKey(ctx.db, label, actor(req));
      res.status(201).json({ id, key });
    }),
  );

  r.delete(
    '/keys/:id',
    h(async (req, res) => {
      if (!(await revokeFirmKey(ctx.db, idParam(req), ctx.now(), actor(req)))) {
        throw new HttpError(404, 'not_found');
      }
      res.json({ ok: true });
    }),
  );

  r.get(
    '/staff',
    h(async (_req, res) => {
      const rows = await ctx.db
        .select()
        .from(schema.staffUsers)
        .orderBy(asc(schema.staffUsers.name));
      const limits = new Map<string, string[]>();
      for (const c of await ctx.db.select().from(schema.staffClient)) {
        const list = limits.get(c.staffId);
        if (list) list.push(c.clientId);
        else limits.set(c.staffId, [c.clientId]);
      }
      res.json({
        staff: rows.map((u) => ({
          id: u.id,
          email: u.email,
          name: u.name,
          active: u.active,
          ready: Boolean(u.totpConfirmedAt),
          lastSignInAt: u.lastSignInAt,
          admin: u.admin,
          // The only clients they see; null for every client.
          clientIds: u.admin || u.allClients ? null : (limits.get(u.id) ?? []),
          notifyUploads: u.notifyUploads,
          notifyAccessRequests: u.notifyAccessRequests,
        })),
      });
    }),
  );

  /** Sends the setup link to the person (email), and returns it for the screen too. */
  const sendSetup = async (email: string, link: string): Promise<void> => {
    const firm = await firmName(ctx);
    await ctx.notifier
      .send(
        messageTo(
          email,
          `Your staff account on ${firm}'s client portal`,
          `Finish your staff account (within 3 days): set a password and add the portal to your ` +
            `authenticator app.\n\n${link}`,
        ),
      )
      .catch((err: unknown) => ctx.log.error({ err }, 'staff setup email failed'));
  };

  r.post(
    '/staff',
    h(async (req, res) => {
      const input = body(StaffSchema, req);
      const email = normalizeEmail(input.email);
      if (!email) throw new HttpError(400, 'invalid_email');
      const [taken] = await ctx.db
        .select({ id: schema.staffUsers.id })
        .from(schema.staffUsers)
        .where(eq(schema.staffUsers.email, email));
      if (taken) throw new HttpError(409, 'email_taken');
      if (input.admin && input.clientIds) throw new HttpError(400, 'admin_sees_all');
      const u = await ctx.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(schema.staffUsers)
          .values({
            email,
            name: input.name,
            admin: input.admin,
            allClients: input.clientIds === null,
          })
          .returning({ id: schema.staffUsers.id });
        if (!row) throw new Error('staff insert returned nothing');
        await setClients(tx, row.id, input.clientIds);
        return row;
      });
      const a = actor(req);
      const link = await createSetupLink(ctx, u.id, a.name);
      await sendSetup(email, link);
      await record(ctx.db, 'staff_added', a, {
        detail: {
          staffId: u.id,
          email,
          admin: input.admin,
          clients: input.clientIds ? input.clientIds.length : 'all',
        },
      });
      res.status(201).json({ id: u.id, setupLink: link });
    }),
  );

  r.patch(
    '/staff/:id',
    h(async (req, res) => {
      const id = idParam(req);
      const change = body(StaffChange, req);
      const me = (req.staff as StaffSession).staffId;
      // Nobody takes their own access away, so an admin is always left: whoever made the change.
      if (id === me) {
        if (change.active === false) throw new HttpError(409, 'cannot_turn_off_yourself');
        if (change.admin === false || change.clientIds) {
          throw new HttpError(409, 'cannot_change_yourself');
        }
      }
      const after = await ctx.db.transaction(async (tx) => {
        // Both accounts are held until this is done (in one order, so two admins changing each
        // other at the same moment take turns): the one who goes second is no longer an admin.
        const held = await tx
          .select()
          .from(schema.staffUsers)
          .where(inArray(schema.staffUsers.id, [id, me]))
          .orderBy(asc(schema.staffUsers.id))
          .for('update');
        const self = held.find((u) => u.id === me);
        if (!self?.admin || !self.active) throw new HttpError(403, 'admins_only');
        const u = held.find((x) => x.id === id);
        if (!u) throw new HttpError(404, 'not_found');
        const admin = change.admin ?? u.admin;
        // Whether they are limited to some clients after this. Someone made an admin sees
        // every client; a list sent for an admin is refused.
        const limited =
          change.clientIds !== undefined ? change.clientIds !== null : !u.allClients && !admin;
        if (admin && limited) throw new HttpError(400, 'admin_sees_all');
        await tx
          .update(schema.staffUsers)
          .set({
            active: change.active ?? u.active,
            admin,
            allClients: !limited,
            notifyUploads: change.notifyUploads ?? u.notifyUploads,
            notifyAccessRequests: change.notifyAccessRequests ?? u.notifyAccessRequests,
          })
          .where(eq(schema.staffUsers.id, id));
        if (change.clientIds !== undefined) await setClients(tx, id, change.clientIds);
        else if (!limited) await setClients(tx, id, null);
        return { was: u, admin, limited };
      });
      const a = actor(req);
      if (change.active !== undefined && change.active !== after.was.active) {
        if (!change.active) {
          await ctx.db.delete(schema.sessions).where(eq(schema.sessions.subjectId, id));
          await cancelSetupLinks(ctx.db, id, ctx.now());
        }
        await record(ctx.db, change.active ? 'staff_on' : 'staff_off', a, {
          detail: { staffId: id },
        });
      }
      if (change.notifyUploads !== undefined && change.notifyUploads !== after.was.notifyUploads) {
        await record(ctx.db, 'staff_access', a, {
          detail: { staffId: id, notifyUploads: change.notifyUploads },
        });
      }
      if (
        change.notifyAccessRequests !== undefined &&
        change.notifyAccessRequests !== after.was.notifyAccessRequests
      ) {
        await record(ctx.db, 'staff_access', a, {
          detail: { staffId: id, notifyAccessRequests: change.notifyAccessRequests },
        });
      }
      if (change.admin !== undefined || change.clientIds !== undefined) {
        await record(ctx.db, 'staff_access', a, {
          detail: {
            staffId: id,
            admin: after.admin,
            clients: change.clientIds ? change.clientIds.length : after.limited ? 'same' : 'all',
          },
        });
      }
      res.json({ ok: true });
    }),
  );

  r.post(
    '/staff/:id/reset',
    h(async (req, res) => {
      const id = idParam(req);
      const me = (req.staff as StaffSession).staffId;
      // Resetting yourself would sign you out with the link only on a screen that is gone.
      if (id === me) throw new HttpError(409, 'cannot_reset_yourself');
      const a = actor(req);
      const u = await ctx.db.transaction(async (tx) => {
        // As the change above: both accounts are held, and the caller must still be a working
        // admin, so two admins resetting each other at the same moment do not both succeed
        // (the second has just been reset, or demoted).
        const held = await tx
          .select()
          .from(schema.staffUsers)
          .where(inArray(schema.staffUsers.id, [id, me]))
          .orderBy(asc(schema.staffUsers.id))
          .for('update');
        const self = held.find((x) => x.id === me);
        if (!self?.admin || !self.active || !self.totpConfirmedAt) {
          throw new HttpError(403, 'admins_only');
        }
        const who = held.find((x) => x.id === id);
        if (!who) throw new HttpError(404, 'not_found');
        if (!who.active) throw new HttpError(409, 'staff_off');
        // Their old password and authenticator stop working; sessions end.
        await tx
          .update(schema.staffUsers)
          .set({
            passwordHash: null,
            totpSecretEnc: null,
            totpConfirmedAt: null,
            failedLogins: 0,
            lockedUntil: null,
          })
          .where(eq(schema.staffUsers.id, id));
        await tx.delete(schema.sessions).where(eq(schema.sessions.subjectId, id));
        return who;
      });
      const link = await createSetupLink(ctx, id, a.name);
      await sendSetup(u.email, link);
      await record(ctx.db, 'staff_reset', a, { detail: { staffId: id } });
      res.json({ setupLink: link });
    }),
  );

  return r;
}

export function brandingRouter(ctx: Ctx): Router {
  const r = express.Router();
  r.get(
    '/',
    h(async (_req, res) => {
      const [f] = await ctx.db.select().from(schema.firm);
      res.json({
        firmName: f?.name || 'Your accounting firm',
        accentColor: f?.accentColor ?? '#0f6cbd',
        hasLogo: Boolean(f?.logo),
      });
    }),
  );
  r.get(
    '/logo',
    h(async (_req, res) => {
      const [f] = await ctx.db.select().from(schema.firm);
      if (!f?.logo || !f.logoType) throw new HttpError(404, 'not_found');
      res.setHeader('Content-Type', f.logoType);
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.setHeader('Content-Security-Policy', "default-src 'none'");
      // Raw bytes (the driver may hand back a Uint8Array, which send() would treat as text).
      res.end(Buffer.from(f.logo));
    }),
  );
  return r;
}
