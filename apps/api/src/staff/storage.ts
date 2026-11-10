// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Settings > Storage (P51): where stored files live, the B2 bucket and its application key, and
// moving the files there or back. Admins only. The application key is stored wrapped by the firm
// key and never sent back, logged or written to History.
//
//   GET    /api/staff/v1/settings/storage
//   PUT    /api/staff/v1/settings/storage/b2     { endpoint, bucket, keyId, appKey? }  checked first
//   DELETE /api/staff/v1/settings/storage/b2     only while no file is on B2
//   POST   /api/staff/v1/settings/storage/test   checks the saved bucket and key
//   POST   /api/staff/v1/settings/storage/move   { to: 'b2' | 'local' }  runs in the background

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { schema } from '@vibe-portal/db';

import type { Ctx } from '../context';
import { parseEndpoint, validBucket, type B2Settings } from '../files/b2';
import {
  applyStorage,
  b2Settings,
  BucketRefused,
  checkBucket,
  checkMove,
  isMoving,
  NoRoom,
  openB2,
  runMove,
  storageState,
} from '../files/storage';
import { record, type Actor } from '../lib/events';
import { body, h, HttpError } from '../lib/http';
import type { StaffSession } from './auth';
import { requireAdmin } from './scope';

const B2Schema = z.object({
  endpoint: z.string().trim().max(200),
  bucket: z.string().trim().max(63),
  keyId: z.string().trim().min(1).max(100),
  /** Left out to keep the saved key (changing only the key id is refused by the check). */
  appKey: z.string().trim().min(1).max(200).optional(),
});
const MoveSchema = z.object({ to: z.enum(['b2', 'local']) });

const actor = (req: Request): Actor => ({
  kind: 'staff',
  name: (req.staff as StaffSession).email,
});

/** Why B2 refused, in words for the page: the SDK's message names the problem, never the key. */
function why(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.slice(0, 300);
}

/** A bucket or move that cannot be used: the portal's own reason, or B2's answer. */
function refuse(res: Response, err: unknown): void {
  if (err instanceof NoRoom) res.status(409).json({ error: 'no_room', detail: why(err) });
  else if (err instanceof BucketRefused) {
    res.status(400).json({ error: 'b2_refused', detail: why(err) });
  } else res.status(400).json({ error: 'b2_check_failed', detail: why(err) });
}

export function storageRouter(ctx: Ctx): Router {
  const r = express.Router();
  r.use(requireAdmin);

  r.get(
    '/',
    h(async (_req, res) => {
      res.json(await storageState(ctx));
    }),
  );

  r.put(
    '/b2',
    h(async (req, res) => {
      const input = body(B2Schema, req);
      const at = parseEndpoint(input.endpoint);
      if (!at) throw new HttpError(400, 'b2_endpoint');
      if (!validBucket(input.bucket)) throw new HttpError(400, 'b2_bucket');
      const [f] = await ctx.db.select().from(schema.firm);
      if (!f) throw new Error('firm row missing');
      const endpoint = at.host;
      // Files are in this bucket (or being moved there or out): it cannot change under them.
      const inUse = f.storage === 'b2' || f.storageOther;
      if (inUse && (endpoint !== f.b2Endpoint || input.bucket !== f.b2Bucket)) {
        throw new HttpError(409, 'b2_in_use');
      }
      const saved = b2Settings(ctx, f);
      const appKey = input.appKey ?? saved?.appKey;
      if (!appKey) throw new HttpError(400, 'b2_app_key');
      const next: B2Settings = { endpoint, bucket: input.bucket, keyId: input.keyId, appKey };
      try {
        await checkBucket(openB2(ctx, next), f.installId);
      } catch (err) {
        refuse(res, err);
        return;
      }
      await ctx.db.update(schema.firm).set({
        b2Endpoint: endpoint,
        b2Bucket: input.bucket,
        b2KeyId: input.keyId,
        b2AppKeyEnc: Buffer.from(ctx.keyring.wrap(Buffer.from(appKey, 'utf8'))),
        updatedAt: ctx.now(),
      });
      // A new key for the bucket in use takes over at once.
      if (inUse) await applyStorage(ctx);
      await record(ctx.db, 'storage_b2_saved', actor(req), {
        detail: {
          endpoint,
          bucket: input.bucket,
          keyId: input.keyId,
          newKey: Boolean(input.appKey),
        },
      });
      res.json(await storageState(ctx));
    }),
  );

  r.delete(
    '/b2',
    h(async (req, res) => {
      const [f] = await ctx.db.select().from(schema.firm);
      if (!f) throw new Error('firm row missing');
      if (f.storage === 'b2' || f.storageOther || isMoving()) {
        throw new HttpError(409, 'b2_in_use');
      }
      await ctx.db.update(schema.firm).set({
        b2Endpoint: '',
        b2Bucket: '',
        b2KeyId: '',
        b2AppKeyEnc: null,
        updatedAt: ctx.now(),
      });
      await record(ctx.db, 'storage_b2_removed', actor(req));
      res.json(await storageState(ctx));
    }),
  );

  r.post(
    '/test',
    h(async (_req, res) => {
      const [f] = await ctx.db.select().from(schema.firm);
      const s = f ? b2Settings(ctx, f) : null;
      if (!f || !s) throw new HttpError(400, 'b2_not_set_up');
      try {
        await checkBucket(openB2(ctx, s), f.installId);
      } catch (err) {
        refuse(res, err);
        return;
      }
      res.json({ ok: true });
    }),
  );

  r.post(
    '/move',
    h(async (req, res) => {
      const { to } = body(MoveSchema, req);
      const [f] = await ctx.db.select().from(schema.firm);
      if (!f) throw new Error('firm row missing');
      if (
        isMoving() ||
        f.storageMove?.state === 'requested' ||
        f.storageMove?.state === 'running'
      ) {
        throw new HttpError(409, 'move_running');
      }
      // Already there, and nothing left in the other place.
      if (f.storage === to && !f.storageOther) throw new HttpError(409, 'already_there');
      if (!b2Settings(ctx, f)) throw new HttpError(400, 'b2_not_set_up');
      // The bucket must work before a single file is pointed at it (or read back from it), and
      // the appliance must have room for the files a move back brings.
      try {
        await checkMove(ctx, f, to);
      } catch (err) {
        refuse(res, err);
        return;
      }
      const who = actor(req);
      await ctx.db.update(schema.firm).set({
        storageMove: { to, state: 'requested', by: who.name, requestedAt: ctx.now().toISOString() },
      });
      await record(ctx.db, 'storage_move', who, { detail: { to } });
      void runMove(ctx);
      res.status(202).json(await storageState(ctx));
    }),
  );

  return r;
}
