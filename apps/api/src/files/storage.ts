// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Where stored files live (P51): the appliance's data volume or a Backblaze B2 bucket, chosen on
// Settings > Storage. Moving between them runs here, in the server, one move at a time:
//
//   1. New files go to the new place at once; a file not there yet is read from the old one.
//   2. Every file in the old place that is still in use is copied, then read back and compared.
//   3. Every file the portal knows of is checked to be in the new place.
//   4. Only then are the old copies deleted.
//
// A move that fails part-way leaves both places in use (nothing is lost, every file still
// opens); moving again picks up where it stopped. A restart during a move marks it interrupted.
// The appliance command (`storage-move`) asks the server to move; it does not move files itself.

import { createHash, randomUUID } from 'node:crypto';
import { pipeline as pipe, Readable, Transform } from 'node:stream';

import { sql } from 'drizzle-orm';
import { schema } from '@vibe-portal/db';

import type { Ctx } from '../context';
import { record } from '../lib/events';
import { B2Objects, type B2Settings } from './b2';
import type { ObjectStore } from './objects';

type FirmRow = typeof schema.firm.$inferSelect;
type StorageMove = schema.StorageMove;
export type Place = 'local' | 'b2';

const other = (p: Place): Place => (p === 'b2' ? 'local' : 'b2');

async function firmRow(ctx: Ctx): Promise<FirmRow> {
  const [f] = await ctx.db.select().from(schema.firm);
  if (!f) throw new Error('firm row missing');
  return f;
}

/** The saved B2 settings with the application key unwrapped, or null when not complete. */
export function b2Settings(ctx: Ctx, f: FirmRow): B2Settings | null {
  if (!f.b2Endpoint || !f.b2Bucket || !f.b2KeyId || !f.b2AppKeyEnc) return null;
  const appKey = Buffer.from(ctx.keyring.unwrap(new Uint8Array(f.b2AppKeyEnc))).toString('utf8');
  return { endpoint: f.b2Endpoint, bucket: f.b2Bucket, keyId: f.b2KeyId, appKey };
}

export function openB2(ctx: Ctx, s: B2Settings): ObjectStore {
  return ctx.openB2 ? ctx.openB2(s) : new B2Objects(s);
}

function storeFor(ctx: Ctx, f: FirmRow, place: Place): ObjectStore {
  if (place === 'local') return ctx.blobs.local;
  const s = b2Settings(ctx, f);
  if (!s) throw new Error('B2 is not set up');
  return openB2(ctx, s);
}

/** Points ctx.blobs at the places the database names. At startup and after each change. */
export async function applyStorage(ctx: Ctx): Promise<void> {
  const f = await firmRow(ctx);
  const place = f.storage;
  try {
    ctx.blobs.use(storeFor(ctx, f, place), f.storageOther ? storeFor(ctx, f, other(place)) : null);
  } catch (err) {
    // B2 named but not usable (its key removed by hand): files on B2 cannot be read until it is
    // set up again. New files must not silently go elsewhere, so this is loud, not a fallback.
    ctx.log.error({ err, place }, 'stored files: B2 is named but not set up');
    throw err;
  }
}

/** Writes, reads back and deletes a small file: the bucket and key work for all four. */
export async function probe(store: ObjectStore): Promise<void> {
  const key = randomUUID();
  const data = Buffer.from(`vibe portal check ${key}`);
  await store.put(key, Readable.from([data]));
  const back: Buffer[] = [];
  for await (const c of store.get(key)) back.push(c as Buffer);
  await store.remove(key);
  if (!Buffer.concat(back).equals(data)) throw new Error('the file read back was different');
  if (await store.exists(key)) throw new Error('a deleted file was still there');
}

/** Whether any file, upload or marked copy still uses this stored file. */
async function inUse(ctx: Ctx, key: string): Promise<boolean> {
  const rows = await ctx.db.execute<{ n: number }>(sql`
    SELECT 1 AS n FROM ${schema.files} WHERE ${schema.files.blobKey} = ${key}
    UNION ALL SELECT 1 FROM ${schema.uploads} WHERE ${schema.uploads.blobKey} = ${key}
    UNION ALL SELECT 1 FROM ${schema.fileShareMark} WHERE ${schema.fileShareMark.blobKey} = ${key}
    LIMIT 1`);
  return rowsOf<{ n: number }>(rows).length > 0;
}

async function allInUse(ctx: Ctx): Promise<string[]> {
  const rows = await ctx.db.execute<{ k: string }>(sql`
    SELECT ${schema.files.blobKey} AS k FROM ${schema.files} WHERE ${schema.files.blobKey} IS NOT NULL
    UNION SELECT ${schema.uploads.blobKey} FROM ${schema.uploads} WHERE ${schema.uploads.blobKey} IS NOT NULL
    UNION SELECT ${schema.fileShareMark.blobKey} FROM ${schema.fileShareMark}`);
  return rowsOf<{ k: string }>(rows).map((r) => r.k);
}

/** postgres-js returns the rows; pglite (tests) returns { rows }. */
function rowsOf<T>(r: unknown): T[] {
  return Array.isArray(r) ? (r as T[]) : ((r as { rows: T[] }).rows ?? []);
}

/** Copies one stored file as it is (still encrypted), then reads it back and compares. */
async function copyOne(from: ObjectStore, to: ObjectStore, key: string): Promise<void> {
  const sent = createHash('sha256');
  const hashing = new Transform({
    transform(chunk: Buffer, _enc, done) {
      sent.update(chunk);
      done(null, chunk);
    },
  });
  await to.put(
    key,
    pipe(from.get(key), hashing, () => undefined),
  );
  const back = createHash('sha256');
  for await (const c of to.get(key)) back.update(c as Buffer);
  if (sent.digest('hex') !== back.digest('hex')) {
    await to.remove(key);
    throw new Error(`a copied file did not read back the same (${key})`);
  }
}

let moving = false;

async function saveMove(ctx: Ctx, m: StorageMove): Promise<void> {
  await ctx.db.update(schema.firm).set({ storageMove: m });
}

/** Runs the move the database asks for, if any and none is running. */
export async function runMove(ctx: Ctx): Promise<void> {
  if (moving) return;
  const start = await firmRow(ctx);
  const asked = start.storageMove;
  if (asked?.state !== 'requested') return;
  moving = true;
  const to = asked.to;
  const from = other(to);
  const m: StorageMove = { ...asked, state: 'running', startedAt: ctx.now().toISOString() };
  try {
    const dst = storeFor(ctx, start, to);
    const src = storeFor(ctx, start, from);
    // The bucket must work before a single new file is sent to it (the appliance command asks
    // without checking; Settings checks too).
    await probe(dst.kind === 'b2' ? dst : src);
    // 1. New files go to the new place from now on; reads fall back to the old one.
    await ctx.db.update(schema.firm).set({ storage: to, storageOther: true, storageMove: m });
    ctx.blobs.use(dst, src);
    ctx.log.info({ to }, 'stored files: move started');

    // 2. Copy what is still in use.
    const keys: string[] = [];
    for await (const k of src.list()) keys.push(k);
    m.total = keys.length;
    m.copied = 0;
    await saveMove(ctx, m);
    for (const k of keys) {
      if ((await inUse(ctx, k)) && !(await dst.exists(k))) {
        await copyOne(src, dst, k);
        // Removed while it was copied: the copy must not outlive it (D9).
        if (!(await inUse(ctx, k))) await dst.remove(k);
      }
      m.copied += 1;
      if (m.copied % 25 === 0) await saveMove(ctx, m);
    }

    // 3. Every file the portal knows of is in the new place.
    let missing = 0;
    for (const k of await allInUse(ctx)) if (!(await dst.exists(k))) missing += 1;
    if (missing > 0) throw new Error(`${missing} stored files are not in the new place`);

    // 4. Only now are the old copies deleted.
    for await (const k of src.list()) await src.remove(k);
    m.state = 'done';
    m.finishedAt = ctx.now().toISOString();
    await ctx.db.update(schema.firm).set({ storageOther: false, storageMove: m });
    ctx.blobs.use(dst, null);
    ctx.log.info({ to, files: m.total }, 'stored files: move done');
    await record(
      ctx.db,
      'storage_moved',
      { kind: 'system', name: 'portal' },
      {
        detail: { to, files: m.total, ok: true },
      },
    );
  } catch (err) {
    ctx.log.error({ err, to }, 'stored files: move failed');
    m.state = 'failed';
    m.finishedAt = ctx.now().toISOString();
    m.error = err instanceof Error ? err.message : String(err);
    await saveMove(ctx, m);
    await record(
      ctx.db,
      'storage_moved',
      { kind: 'system', name: 'portal' },
      {
        detail: { to, ok: false, error: m.error },
      },
    ).catch(() => undefined);
  } finally {
    moving = false;
  }
}

/** At startup: a move the last run did not finish is marked interrupted (move again to finish). */
export async function noteInterrupted(ctx: Ctx): Promise<void> {
  const f = await firmRow(ctx);
  if (f.storageMove?.state === 'running') {
    await saveMove(ctx, { ...f.storageMove, state: 'interrupted' });
  }
}

export function isMoving(): boolean {
  return moving;
}

export async function storageState(ctx: Ctx) {
  const f = await firmRow(ctx);
  return {
    storage: f.storage,
    /** Files may still be in the other place (a move not finished). */
    bothInUse: f.storageOther,
    b2: {
      endpoint: f.b2Endpoint,
      bucket: f.b2Bucket,
      keyId: f.b2KeyId,
      hasKey: f.b2AppKeyEnc !== null,
    },
    move: f.storageMove,
  };
}
