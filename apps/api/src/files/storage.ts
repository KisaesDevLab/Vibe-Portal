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
// opens); moving again picks up where it stopped. A restart during a move starts it again by
// itself, up to three times. The appliance command (`storage-move`) asks the server to move; it
// does not move files itself.
//
// The bucket carries this installation's mark (portal/install-id): a bucket marked by another
// is refused, and the daily sweep for leftover stored files (a file whose row went but whose
// delete failed, D9) runs only where the mark is this portal's own. A new portal with an empty
// database pointed at a full bucket must never take every file in it for a leftover.

import { createHash, randomUUID } from 'node:crypto';
import { pipeline as pipe, Readable, Transform } from 'node:stream';

import { sql } from 'drizzle-orm';
import { schema } from '@vibe-portal/db';

import type { Ctx } from '../context';
import { record } from '../lib/events';
import { B2Objects, type B2Settings } from './b2';
import { NotFound, type Bucket, type ObjectStore } from './objects';
import { snapshotIfDue } from './snapshot';

type FirmRow = typeof schema.firm.$inferSelect;
type StorageMove = schema.StorageMove;
type StorageNote = schema.StorageNote;
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

export function openB2(ctx: Ctx, s: B2Settings): Bucket {
  return ctx.openB2 ? ctx.openB2(s) : new B2Objects(s);
}

/** The bucket names the installation that uses it. */
const MARK = 'install-id';

/** Refused before any file is pointed at it; the message is shown on Settings as B2's answer. */
export class BucketRefused extends Error {}

/** The data volume has too little room for the files a move back would bring. */
export class NoRoom extends Error {}

/** Probe, Object Lock, and this installation's mark (written when the bucket has none). */
export async function checkBucket(bucket: Bucket, installId: string): Promise<void> {
  await probe(bucket);
  if ((await bucket.objectLock()) === true) {
    throw new BucketRefused(
      'Object Lock is on for this bucket, so files removed from the portal could not be ' +
        'deleted from it. Use a bucket without Object Lock.',
    );
  }
  const mark = (await bucket.getNote(MARK))?.toString('utf8').trim();
  if (mark && mark !== installId) {
    throw new BucketRefused(
      "This bucket holds another portal's files. Use a new, empty bucket for this portal.",
    );
  }
  if (!mark) await bucket.putNote(MARK, Buffer.from(installId, 'utf8'));
}

const GB = 1024 ** 3;
const gb = (n: number): string => `${(n / GB).toFixed(1)} GB`;

/** Room on the data volume for every file in `src` not already there, with a margin. */
async function checkRoom(ctx: Ctx, src: ObjectStore): Promise<void> {
  let need = 0;
  for await (const o of src.list()) {
    if (!(await ctx.blobs.local.exists(o.key))) need += o.size;
  }
  const free = await ctx.blobs.local.freeBytes();
  const want = need * 1.1 + 0.5 * GB;
  if (free < want) {
    throw new NoRoom(
      `The appliance has ${gb(free)} free; the files need about ${gb(want)}. Free some space first.`,
    );
  }
}

/** Checks a move can start: the bucket, and room on the appliance for a move back. */
export async function checkMove(ctx: Ctx, f: FirmRow, to: Place): Promise<void> {
  const s = b2Settings(ctx, f);
  if (!s) throw new Error('B2 is not set up');
  const bucket = openB2(ctx, s);
  await checkBucket(bucket, f.installId);
  if (to === 'local') await checkRoom(ctx, bucket);
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
  try {
    await store.remove(key);
  } catch (err) {
    throw new BucketRefused(
      `The test file could not be deleted (${err instanceof Error ? err.message : String(err)}). ` +
        'The key must be allowed to delete files, and the bucket must have no Object Lock or ' +
        'retention rule.',
    );
  }
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

/** A move or a sweep is running: one at a time. */
let moving = false;

async function saveMove(ctx: Ctx, m: StorageMove): Promise<void> {
  await ctx.db.update(schema.firm).set({ storageMove: m });
}

/** Runs the move the database asks for, if any and none is running. */
export async function runMove(ctx: Ctx): Promise<void> {
  if (moving) return;
  // Set before the first wait, so the timer and a Settings click cannot both start one.
  moving = true;
  try {
    const start = await firmRow(ctx);
    const asked = start.storageMove;
    if (asked?.state === 'requested') await move(ctx, start, asked);
  } finally {
    moving = false;
  }
}

async function move(ctx: Ctx, start: FirmRow, asked: StorageMove): Promise<void> {
  const to = asked.to;
  const from = other(to);
  const m: StorageMove = { ...asked, state: 'running', startedAt: ctx.now().toISOString() };
  try {
    const dst = storeFor(ctx, start, to);
    const src = storeFor(ctx, start, from);
    // The bucket must work before a single new file is sent to it, and a move back needs room
    // (the appliance command and a restart ask without checking; Settings checks too).
    await checkMove(ctx, start, to);
    // 1. New files go to the new place from now on; reads fall back to the old one.
    await ctx.db.update(schema.firm).set({ storage: to, storageOther: true, storageMove: m });
    ctx.blobs.use(dst, src);
    ctx.log.info({ to }, 'stored files: move started');
    // A file that began to be written before the switch is still going to the old place: wait
    // for it, so the list below has it.
    await ctx.blobs.settled();

    // 2. Copy what is still in use.
    const keys: string[] = [];
    for await (const o of src.list()) keys.push(o.key);
    m.total = keys.length;
    m.copied = 0;
    await saveMove(ctx, m);
    // In use: named in the database, or written moments ago (the database is told just after).
    const needed = async (k: string): Promise<boolean> =>
      ctx.blobs.isRecent(k) || (await inUse(ctx, k));
    for (const k of keys) {
      if ((await needed(k)) && !(await dst.exists(k))) {
        try {
          await copyOne(src, dst, k);
        } catch (err) {
          // Removed from both places while waiting its turn: nothing to copy.
          if (!(err instanceof NotFound) || (await needed(k))) throw err;
        }
        // Removed while it was copied: the copy must not outlive it (D9).
        if (!(await needed(k))) await dst.remove(k);
      }
      m.copied += 1;
      if (m.copied % 25 === 0) await saveMove(ctx, m);
    }

    // 3. Every file the portal knows of is in the new place.
    let missing = 0;
    for (const k of await allInUse(ctx)) if (!(await dst.exists(k))) missing += 1;
    if (missing > 0) throw new Error(`${missing} stored files are not in the new place`);

    // 4. Only now are the old copies deleted: those that are in the new place, and those no
    // longer in use. One in use and not in the new place stops the move (both stay in use).
    let left = 0;
    for await (const { key: k } of src.list()) {
      if ((await dst.exists(k)) || !(await needed(k))) await src.remove(k);
      else left += 1;
    }
    if (left > 0) throw new Error(`${left} stored files are only in the old place; move again`);
    m.state = 'done';
    m.finishedAt = ctx.now().toISOString();
    await ctx.db.update(schema.firm).set({ storageOther: false, storageMove: m });
    ctx.blobs.use(dst, null);
    ctx.log.info({ to, files: m.total }, 'stored files: move done');
    // The bucket now holds the files: send it what opens them at once, not tomorrow.
    if (to === 'b2') {
      void snapshotIfDue(ctx, true).catch(() => undefined);
    }
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
  }
}

/** How many times a move cut off by a restart starts again by itself. */
const RESUMES = 3;

/** At startup: a move the last run did not finish starts again by itself (owner 2026-11-10), up
 *  to three times; one that keeps being cut off (the move itself may be what stops the portal)
 *  is marked interrupted and waits for someone to move again. */
export async function resumeInterrupted(ctx: Ctx): Promise<void> {
  const f = await firmRow(ctx);
  const m = f.storageMove;
  if (m?.state !== 'running') return;
  const attempts = (m.attempts ?? 0) + 1;
  const again = attempts <= RESUMES;
  await saveMove(ctx, { ...m, state: again ? 'requested' : 'interrupted', attempts });
  ctx.log.warn({ to: m.to, attempts, again }, 'stored files: a move was cut off by a restart');
}

/** Stored files older than this, named nowhere, are leftovers. A day, not minutes: the clock
 *  of B2 and of the appliance differ, and what the server remembers is gone after a restart. */
const LEFTOVER_AGE_MS = 24 * 3_600_000;
const SWEEP_EVERY_MS = 23 * 3_600_000;

/** Merged into what is there: the snapshot keeps its own fields in the same note. */
async function saveNote(ctx: Ctx, n: StorageNote): Promise<void> {
  await ctx.db.execute(
    sql`UPDATE firm SET storage_note = coalesce(storage_note, '{}'::jsonb) || ${JSON.stringify(n)}::jsonb`,
  );
}

/**
 * Once a day: removes stored files that no file, upload or marked copy names any more (their
 * row went but the delete failed: B2 down at that moment). Not while a move is under way; in a
 * bucket only when it carries this installation's mark; and never more than a tenth of the
 * files at once: more than that is not leftovers but a database that does not match (an old
 * backup restored), so nothing is removed and Settings says so.
 */
export async function sweep(ctx: Ctx, force = false): Promise<void> {
  if (moving) return;
  moving = true;
  try {
    const f = await firmRow(ctx);
    const state = f.storageMove?.state;
    if (f.storageOther || state === 'requested' || state === 'running') return;
    const now = ctx.now();
    const note: StorageNote = { ...(f.storageNote ?? {}) };
    if (!force && note.sweptAt && now.getTime() - Date.parse(note.sweptAt) < SWEEP_EVERY_MS) {
      return;
    }
    note.sweptAt = now.toISOString();
    const store = ctx.blobs.where.primary;
    if (store.kind === 'b2') {
      const mark = (await (store as Bucket).getNote(MARK))?.toString('utf8').trim();
      if (mark !== f.installId) {
        note.otherBucket = true;
        await saveNote(ctx, note);
        ctx.log.warn('stored files: the bucket does not carry this portal mark; no sweep');
        return;
      }
    }
    note.otherBucket = false;
    const cutoff = now.getTime() - LEFTOVER_AGE_MS;
    let total = 0;
    const leftovers: string[] = [];
    for await (const o of store.list()) {
      total += 1;
      if (o.modified.getTime() >= cutoff || ctx.blobs.isRecent(o.key)) continue;
      if (!(await inUse(ctx, o.key))) leftovers.push(o.key);
    }
    if (leftovers.length > Math.max(20, Math.floor(total / 10))) {
      note.refused = { at: note.sweptAt, count: leftovers.length, total };
      await saveNote(ctx, note);
      ctx.log.error(
        { count: leftovers.length, total },
        'stored files: too many named nowhere to be leftovers; none removed',
      );
      await record(
        ctx.db,
        'storage_sweep_refused',
        { kind: 'system', name: 'portal' },
        { detail: { count: leftovers.length, total } },
      );
      return;
    }
    let removed = 0;
    for (const k of leftovers) {
      // Asked again just before: named since the list was made, it stays.
      if (await inUse(ctx, k)) continue;
      await store.remove(k);
      removed += 1;
    }
    note.removed = removed;
    note.refused = null;
    await saveNote(ctx, note);
    if (removed > 0) {
      ctx.log.info({ removed }, 'stored files: leftovers removed');
      await record(
        ctx.db,
        'storage_swept',
        { kind: 'system', name: 'portal' },
        { detail: { removed, place: store.kind } },
      );
    }
  } finally {
    moving = false;
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
    note: f.storageNote,
  };
}

/** For Vibe Files' Admin > Portal > Test (GET /api/firm/v1/status). */
export async function storageSummary(
  ctx: Ctx,
): Promise<{ storage: Place; storageMoving: boolean }> {
  const f = await firmRow(ctx);
  const state = f.storageMove?.state;
  return {
    storage: f.storage,
    storageMoving: f.storageOther || state === 'requested' || state === 'running',
  };
}
