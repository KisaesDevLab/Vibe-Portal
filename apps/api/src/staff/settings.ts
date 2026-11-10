// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// The staff page's Settings (P36): the firm's name, colour and logo, the upload limit and how
// long fetched uploads are kept, the firm keys Vibe Files uses, and staff accounts. Every change
// is recorded with the staff member's name.
//
//   GET    /api/staff/v1/settings
//   PUT    /api/staff/v1/settings                { firmName, accentColor, uploadLimitMb, uploadKeepDays }
//   PUT    /api/staff/v1/settings/logo           body: PNG or JPEG, at most 512 KB
//   DELETE /api/staff/v1/settings/logo
//   GET    /api/staff/v1/keys                    POST { label } -> { key } (shown once)
//   DELETE /api/staff/v1/keys/:id
//   GET    /api/staff/v1/staff                   POST { email, name } -> { setupLink }
//   PATCH  /api/staff/v1/staff/:id               { active }
//   POST   /api/staff/v1/staff/:id/reset         -> { setupLink } (new password and authenticator)
//
//   GET    /api/portal/branding                  (public) { firmName, accentColor, hasLogo }
//   GET    /api/portal/branding/logo             (public)

import express, { type Request, type Router } from 'express';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@vibe-portal/db';

import { firmName, type Ctx } from '../context';
import { createFirmKey, revokeFirmKey } from '../firm/keys';
import { normalizeEmail } from '../lib/contact';
import { record, type Actor } from '../lib/events';
import { body, h, HttpError } from '../lib/http';
import { messageTo } from '../lib/notify';
import { cancelSetupLinks, createSetupLink, type StaffSession } from './auth';

const MB = 1024 * 1024;
const LOGO_MAX = 512 * 1024;

const SettingsSchema = z.object({
  firmName: z.string().trim().min(1).max(120),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  uploadLimitMb: z.number().int().min(1).max(100),
  uploadKeepDays: z.number().int().min(0).max(3650),
});
const KeySchema = z.object({ label: z.string().trim().min(1).max(60) });
const StaffSchema = z.object({
  email: z.string().trim().max(254),
  name: z.string().trim().min(1).max(120),
});
const ActiveSchema = z.object({ active: z.boolean() });

function actor(req: Request): Actor {
  return { kind: 'staff', name: (req.staff as StaffSession).email };
}

function idParam(req: Request): string {
  const v = z.string().uuid().safeParse(req.params['id']);
  if (!v.success) throw new HttpError(404, 'not_found');
  return v.data;
}

/** PNG or JPEG by its first bytes. */
function imageType(b: Buffer): string | null {
  if (b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (b.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'image/jpeg';
  return null;
}

export function staffSettingsRouter(ctx: Ctx): Router {
  const r = express.Router();

  r.get(
    '/settings',
    h(async (_req, res) => {
      const [f] = await ctx.db.select().from(schema.firm);
      res.json({
        firmName: f?.name ?? '',
        accentColor: f?.accentColor ?? '#0f6cbd',
        uploadLimitMb: Math.round((f?.uploadLimitBytes ?? 100 * MB) / MB),
        uploadKeepDays: f?.uploadKeepDays ?? 30,
        hasLogo: Boolean(f?.logo),
        portalUrl: ctx.portalUrl,
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
      res.json({
        staff: rows.map((u) => ({
          id: u.id,
          email: u.email,
          name: u.name,
          active: u.active,
          ready: Boolean(u.totpConfirmedAt),
          lastSignInAt: u.lastSignInAt,
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
      const [u] = await ctx.db
        .insert(schema.staffUsers)
        .values({ email, name: input.name })
        .returning({ id: schema.staffUsers.id });
      if (!u) throw new Error('staff insert returned nothing');
      const a = actor(req);
      const link = await createSetupLink(ctx, u.id, a.name);
      await sendSetup(email, link);
      await record(ctx.db, 'staff_added', a, { detail: { staffId: u.id, email } });
      res.status(201).json({ id: u.id, setupLink: link });
    }),
  );

  r.patch(
    '/staff/:id',
    h(async (req, res) => {
      const id = idParam(req);
      const { active } = body(ActiveSchema, req);
      if (!active && id === (req.staff as StaffSession).staffId) {
        throw new HttpError(409, 'cannot_turn_off_yourself');
      }
      const rows = await ctx.db
        .update(schema.staffUsers)
        .set({ active })
        .where(eq(schema.staffUsers.id, id))
        .returning({ id: schema.staffUsers.id });
      if (!rows.length) throw new HttpError(404, 'not_found');
      if (!active) {
        await ctx.db.delete(schema.sessions).where(eq(schema.sessions.subjectId, id));
        await cancelSetupLinks(ctx.db, id, ctx.now());
      }
      await record(ctx.db, active ? 'staff_on' : 'staff_off', actor(req), {
        detail: { staffId: id },
      });
      res.json({ ok: true });
    }),
  );

  r.post(
    '/staff/:id/reset',
    h(async (req, res) => {
      const id = idParam(req);
      // Resetting yourself would sign you out with the link only on a screen that is gone.
      if (id === (req.staff as StaffSession).staffId) {
        throw new HttpError(409, 'cannot_reset_yourself');
      }
      const [u] = await ctx.db.select().from(schema.staffUsers).where(eq(schema.staffUsers.id, id));
      if (!u) throw new HttpError(404, 'not_found');
      if (!u.active) throw new HttpError(409, 'staff_off');
      const a = actor(req);
      // Their old password and authenticator stop working; sessions end.
      await ctx.db
        .update(schema.staffUsers)
        .set({
          passwordHash: null,
          totpSecretEnc: null,
          totpConfirmedAt: null,
          failedLogins: 0,
          lockedUntil: null,
        })
        .where(eq(schema.staffUsers.id, id));
      await ctx.db.delete(schema.sessions).where(eq(schema.sessions.subjectId, id));
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
