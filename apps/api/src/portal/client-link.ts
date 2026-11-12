// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P76: the active client's link from another service, for the top of the signed-in home page.
//
//   GET /api/portal/client-link   -> { link: { url, message, button } | null }

import express, { type Router } from 'express';
import { eq } from 'drizzle-orm';
import { schema } from '@vibe-portal/db';

import { activeClientsOf } from '../auth/grant';
import { requireClient } from '../auth/client-auth';
import type { ClientSession } from '../auth/sessions';
import type { Ctx } from '../context';
import { h, HttpError } from '../lib/http';

export function clientLinkRouter(ctx: Ctx): Router {
  const r = express.Router();
  r.get(
    '/',
    requireClient(ctx),
    h(async (req, res) => {
      const s = req.clientSession as ClientSession;
      const clients = await activeClientsOf(ctx.db, s.identityId);
      const clientId = clients.find((c) => c.id === s.activeClientId)?.id ?? clients[0]?.id;
      if (!clientId) throw new HttpError(401, 'signed_out');
      const [link] = await ctx.db
        .select({
          url: schema.clientLink.url,
          message: schema.clientLink.message,
          button: schema.clientLink.button,
        })
        .from(schema.clientLink)
        .where(eq(schema.clientLink.clientId, clientId));
      res.json({ link: link ?? null });
    }),
  );
  return r;
}
