// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// The portal's history for Vibe Files' audit trail (BUILD_PLAN.md §3, §5): events after an id,
// oldest first. Each carries the cabinet document id when it is about a shared file, so Vibe
// Files can record "client opened" against the document.
//
//   GET /api/firm/v1/events?since=<id>&limit=<n>

import express, { type Router } from 'express';
import { asc, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@vibe-portal/db';

import type { Ctx } from '../context';
import { h } from '../lib/http';

const Query = z.object({
  since: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

export function firmEventsRouter(ctx: Ctx): Router {
  const r = express.Router();
  r.get(
    '/',
    h(async (req, res) => {
      const q = Query.parse(req.query);
      const rows = await ctx.db
        .select({ e: schema.events, vfDocumentId: schema.files.vfDocumentId })
        .from(schema.events)
        .leftJoin(schema.files, eq(schema.files.id, schema.events.fileId))
        .where(gt(schema.events.id, q.since))
        .orderBy(asc(schema.events.id))
        .limit(q.limit);
      res.json({
        events: rows.map(({ e, vfDocumentId }) => ({
          id: e.id,
          at: e.at,
          kind: e.kind,
          actorKind: e.actorKind,
          actor: e.actor,
          clientId: e.clientId,
          fileId: e.fileId,
          uploadId: e.uploadId,
          identityId: e.identityId,
          vfDocumentId,
          detail: e.detail,
        })),
      });
    }),
  );
  return r;
}
