// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// The portal's history for Vibe Files' audit trail (BUILD_PLAN.md §3, §5): events after an id,
// oldest first. Each carries the cabinet document id when it is about a shared file, so Vibe
// Files can record "client opened" against the document.
//
//   GET /api/firm/v1/events?since=<id>&limit=<n>[&latest=1]

import express, { type Router } from 'express';
import { and, asc, desc, eq, gt, lt, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@vibe-portal/db';
import type { EventKind } from '@vibe-portal/types';

import type { Ctx } from '../context';
import { h } from '../lib/http';
import { inScope } from '../staff/scope';

const Query = z.object({
  since: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
  /** The newest `limit` events, newest first (the staff History page). */
  latest: z.literal('1').optional(),
  /** With latest: only events older than this id (the next page of History, P57). */
  before: z.coerce.number().int().min(1).optional(),
});

/** What admins do in Settings, and who signs in: the staff list and the portal keys could be
 *  read back from these, so staff who are not admins do not get them (QA 2026-11-10). */
const ADMIN_KINDS: EventKind[] = [
  'staff_sign_in',
  'staff_sso',
  'settings_updated',
  'staff_added',
  'staff_on',
  'staff_off',
  'staff_reset',
  'staff_access',
  'firm_key_created',
  'firm_key_revoked',
  'storage_b2_saved',
  'storage_b2_removed',
  'storage_move',
  'storage_moved',
  'storage_swept',
  'storage_sweep_refused',
  'storage_snapshot_failed',
];

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
        // P48: limited staff see their clients' events only (none of the firm-wide ones).
        .where(
          and(
            gt(schema.events.id, q.since),
            q.before ? lt(schema.events.id, q.before) : undefined,
            inScope(req, schema.events.clientId),
            req.staff && !req.staff.admin ? notInArray(schema.events.kind, ADMIN_KINDS) : undefined,
          ),
        )
        .orderBy(q.latest ? desc(schema.events.id) : asc(schema.events.id))
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
