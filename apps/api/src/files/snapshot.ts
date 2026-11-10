// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Database snapshots in the B2 bucket (P51, owner 2026-11-10). With files in B2, each file's own
// key is in the database: the bucket alone opens nothing. So every hour (owner 2026-11-10; and after a move to B2)
// the portal sends an encrypted copy of its database to the bucket, under portal/snapshots/.
// The bucket and the seal file (.firm-key.seal) are then enough to recover everything.
//
// A snapshot is one object:
//
//   "VPS1" [header length, 4 bytes BE] [header, JSON] [body: gzip of JSON lines, sealed as a blob]
//
// The header is not secret: when it was taken, the migrations it needs, and the firm key
// envelope (the master key wrapped by the key in the seal file) with the body's own key wrapped by
// the master key. Restoring needs no database to open it: the seal file unwraps the master key
// from the header, the master key the body's key. Without the seal file it is unreadable.
//
// Left out: sign-in sessions, one-time codes and rate limits (short-lived; everyone signs in
// again after a restore).

import { gunzipSync, gzipSync } from 'node:zlib';

import { FirmKeyManager, generateKey, type FirmKeyEnvelopeRow } from '@vibe/crypto';
import { sql } from 'drizzle-orm';
import { schema, type Database } from '@vibe-portal/db';

import type { Ctx } from '../context';
import { record } from '../lib/events';
import { openBytes, sealBytes } from './blobs';
import type { Bucket } from './objects';

const MAGIC = Buffer.from('VPS1');
export const SNAPSHOTS = 'snapshots/';
/** How many snapshots the bucket keeps (the newest). */
const KEEP = 48;
/** Every hour; a little under, so the hourly timer does not skip one by a few seconds. */
const EVERY_MS = 55 * 60_000;
const FIRM_ID = 'firm';

/** Short-lived, or of no use after a restore. */
const LEAVE_OUT = new Set([
  'schema_migrations',
  'sessions',
  'sign_in_challenge',
  'rate_limit',
  'file_share_code',
  'file_share_grant',
]);

export interface SnapshotHeader {
  v: 1;
  takenAt: string;
  installId: string;
  migrations: string[];
  envelope: {
    firmId: string;
    wrappedMfk: string;
    kekMetadata: unknown;
    sentinelCiphertext: string;
    rotationVersion: number;
  };
  /** The body's key, wrapped by the master key. */
  dek: string;
}

/** postgres-js returns the rows; pglite (tests) returns { rows }. */
function rowsOf<T>(r: unknown): T[] {
  return Array.isArray(r) ? (r as T[]) : ((r as { rows: T[] }).rows ?? []);
}

async function query<T>(db: Pick<Database, 'execute'>, q: ReturnType<typeof sql>): Promise<T[]> {
  return rowsOf<T>(await db.execute(q));
}

async function publicTables(db: Pick<Database, 'execute'>): Promise<string[]> {
  const rows = await query<{ t: string }>(
    db,
    sql`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  );
  return rows.map((r) => r.t);
}

/** `names` ordered so a table comes after every table it refers to. */
async function parentsFirst(db: Pick<Database, 'execute'>, names: string[]): Promise<string[]> {
  const refs = await query<{ child: string; parent: string }>(
    db,
    sql`SELECT c.relname AS child, p.relname AS parent
        FROM pg_constraint k
        JOIN pg_class c ON c.oid = k.conrelid
        JOIN pg_class p ON p.oid = k.confrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE k.contype = 'f' AND n.nspname = 'public'`,
  );
  const want = new Set(names);
  const done: string[] = [];
  const seen = new Set<string>();
  const visit = (t: string, path: Set<string>): void => {
    if (seen.has(t)) return;
    if (path.has(t)) throw new Error(`tables refer to each other in a loop (${t})`);
    path.add(t);
    for (const r of refs) {
      if (r.child === t && r.parent !== t && want.has(r.parent)) visit(r.parent, path);
    }
    path.delete(t);
    seen.add(t);
    done.push(t);
  };
  for (const t of names) visit(t, new Set());
  return done;
}

async function applied(db: Pick<Database, 'execute'>): Promise<string[]> {
  const rows = await query<{ f: string }>(
    db,
    sql`SELECT filename AS f FROM schema_migrations ORDER BY filename`,
  );
  return rows.map((r) => r.f);
}

const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');
const unb64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));

function stamp(d: Date): string {
  const iso = d.toISOString(); // 2026-11-10T12:05:00.000Z
  const rand = Math.random().toString(36).slice(2, 6);
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}-${rand}`;
}

/** Takes a snapshot of the database now and sends it to `bucket`; returns its name. */
export async function takeSnapshot(ctx: Ctx, bucket: Bucket): Promise<string> {
  const [env] = await ctx.db.select().from(schema.firmKeyEnvelope);
  const [firm] = await ctx.db.select().from(schema.firm);
  if (!env || !firm) throw new Error('the portal has not been set up');
  const lines: string[] = [];
  let migrations: string[] = [];
  // One consistent picture of every table.
  await ctx.db.transaction(
    async (tx) => {
      migrations = await applied(tx);
      for (const t of await publicTables(tx)) {
        if (LEAVE_OUT.has(t)) continue;
        const rows = await query<{ j: string }>(
          tx,
          sql`SELECT row_to_json(x)::text AS j FROM ${sql.identifier(t)} x`,
        );
        for (const r of rows) lines.push(`${JSON.stringify(t)}\t${r.j}`);
      }
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
  const dek = generateKey();
  const body = await sealBytes(gzipSync(Buffer.from(lines.join('\n'), 'utf8')), dek);
  const header: SnapshotHeader = {
    v: 1,
    takenAt: ctx.now().toISOString(),
    installId: firm.installId,
    migrations,
    envelope: {
      firmId: env.firmId,
      wrappedMfk: b64(env.wrappedMfk),
      kekMetadata: env.kekMetadata,
      sentinelCiphertext: b64(env.sentinelCiphertext),
      rotationVersion: env.rotationVersion,
    },
    dek: b64(ctx.keyring.wrap(dek)),
  };
  const head = Buffer.from(JSON.stringify(header), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(head.length);
  const name = `${SNAPSHOTS}${stamp(ctx.now())}.vps`;
  await bucket.putNote(name, Buffer.concat([MAGIC, len, head, body]));
  // Keep the newest few; older ones go with every version.
  const all: string[] = [];
  for await (const n of bucket.notes(SNAPSHOTS)) all.push(n.name);
  all.sort();
  for (const old of all.slice(0, Math.max(0, all.length - KEEP))) await bucket.removeNote(old);
  return name;
}

/** Removes every snapshot and the portal's mark from a bucket it no longer uses. */
export async function forgetBucket(bucket: Bucket): Promise<void> {
  for (const s of await listSnapshots(bucket)) await bucket.removeNote(s.name);
  await bucket.removeNote('install-id');
}

/** The newest first. */
export async function listSnapshots(
  bucket: Bucket,
): Promise<{ name: string; size: number; modified: Date }[]> {
  const all: { name: string; size: number; modified: Date }[] = [];
  for await (const n of bucket.notes(SNAPSHOTS)) all.push(n);
  return all.sort((a, b) => (a.name < b.name ? 1 : -1));
}

export interface OpenedSnapshot {
  header: SnapshotHeader;
  /** Rows by table, as JSON text. */
  rows: Map<string, string[]>;
}

/** Opens a snapshot with the seal file (no database needed). Fails on a wrong seal file. */
export async function openSnapshot(data: Buffer, sealPath: string): Promise<OpenedSnapshot> {
  if (data.length < 8 || !data.subarray(0, 4).equals(MAGIC)) {
    throw new Error('not a portal snapshot');
  }
  const len = data.readUInt32BE(4);
  const header = JSON.parse(data.subarray(8, 8 + len).toString('utf8')) as SnapshotHeader;
  if (header.v !== 1) throw new Error(`snapshot version ${String(header.v)} is not known`);
  const meta = header.envelope.kekMetadata as FirmKeyEnvelopeRow['kekMetadata'];
  if (meta.mode !== 'sealed-on-disk') throw new Error('only a sealed-on-disk firm key is known');
  const row: FirmKeyEnvelopeRow = {
    firmId: header.envelope.firmId,
    wrappedMfk: unb64(header.envelope.wrappedMfk),
    // The key manager reads the seal file from the path the envelope names (the old
    // appliance's), not the one it is given: point it at the file given here.
    kekMetadata: { ...meta, path: sealPath },
    sentinelCiphertext: unb64(header.envelope.sentinelCiphertext),
    rotationVersion: header.envelope.rotationVersion,
  };
  const manager = new FirmKeyManager({
    store: {
      get: async (id) => (id === row.firmId ? row : null),
      insert: async () => {
        throw new Error('read only');
      },
      update: async () => {
        throw new Error('read only');
      },
    },
    sealedKeyPath: sealPath,
  });
  try {
    await manager.unseal({ firmId: FIRM_ID });
  } catch (err) {
    throw new Error(
      `The seal file ${sealPath} does not open this snapshot (${String(err)}). Use the ` +
        '.firm-key.seal from the appliance this snapshot came from.',
    );
  }
  const dek = manager.unwrapTDek(FIRM_ID, unb64(header.dek));
  const text = gunzipSync(await openBytes(data.subarray(8 + len), dek)).toString('utf8');
  const rows = new Map<string, string[]>();
  for (const line of text ? text.split('\n') : []) {
    const tab = line.indexOf('\t');
    const t = JSON.parse(line.slice(0, tab)) as string;
    const list = rows.get(t) ?? [];
    list.push(line.slice(tab + 1));
    rows.set(t, list);
  }
  return { header, rows };
}

/**
 * Replaces the database's contents with the snapshot's, in one transaction. The database must
 * have every migration the snapshot had (start the same or a newer portal on it once first). A
 * database with clients or files in it is refused unless `replace` is set.
 */
export async function restoreSnapshot(
  db: Database,
  snap: OpenedSnapshot,
  replace = false,
): Promise<Record<string, number>> {
  const have = new Set(await applied(db));
  const lacking = snap.header.migrations.filter((m) => !have.has(m));
  if (lacking.length) {
    throw new Error(`This database is older than the snapshot (missing ${lacking.join(', ')}).`);
  }
  if (!replace) {
    const [n] = await query<{ n: number }>(
      db,
      sql`SELECT (SELECT count(*) FROM clients) + (SELECT count(*) FROM files) AS n`,
    );
    if (Number(n?.n ?? 0) > 0) {
      throw new Error('This database already has clients or files. Add --replace to overwrite it.');
    }
  }
  const counts: Record<string, number> = {};
  await db.transaction(async (tx) => {
    const all = (await publicTables(tx)).filter((t) => t !== 'schema_migrations');
    await tx.execute(
      sql.raw(`TRUNCATE ${all.map((t) => `"${t.replace(/"/g, '""')}"`).join(', ')} CASCADE`),
    );
    for (const t of await parentsFirst(tx, all)) {
      const lines = snap.rows.get(t);
      if (!lines?.length) continue;
      const cols = new Set(
        (
          await query<{ c: string }>(
            tx,
            sql`SELECT column_name AS c FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = ${t}`,
          )
        ).map((r) => r.c),
      );
      const first = JSON.parse(lines[0] as string) as Record<string, unknown>;
      const use = Object.keys(first).filter((c) => cols.has(c));
      const list = sql.join(
        use.map((c) => sql.identifier(c)),
        sql`, `,
      );
      for (let i = 0; i < lines.length; i += 500) {
        const batch = `[${lines.slice(i, i + 500).join(',')}]`;
        await tx.execute(
          sql`INSERT INTO ${sql.identifier(t)} (${list}) OVERRIDING SYSTEM VALUE
              SELECT ${list} FROM json_populate_recordset(null::${sql.identifier(t)}, ${batch}::json)`,
        );
      }
      counts[t] = lines.length;
    }
    // The database is older than the files written since this snapshot: the sweep for leftover
    // files holds off for a week (storage.ts).
    const hold = new Date(Date.now() + 7 * 24 * 3_600_000).toISOString();
    await tx.execute(
      sql`UPDATE firm SET storage_note = coalesce(storage_note, '{}'::jsonb) || ${JSON.stringify({ sweepHoldUntil: hold })}::jsonb`,
    );
    // Identity columns carry on after the restored rows.
    const ids = await query<{ t: string; c: string }>(
      tx,
      sql`SELECT table_name AS t, column_name AS c FROM information_schema.columns
          WHERE table_schema = 'public' AND is_identity = 'YES'`,
    );
    for (const { t, c } of ids) {
      if (!counts[t]) continue;
      await tx.execute(
        sql`SELECT setval(pg_get_serial_sequence(${`"${t}"`}, ${c}), max(${sql.identifier(c)}))
            FROM ${sql.identifier(t)}`,
      );
    }
  });
  return counts;
}

async function noteSnapshot(ctx: Ctx, n: Record<string, unknown>): Promise<void> {
  await ctx.db.execute(
    sql`UPDATE firm SET storage_note = coalesce(storage_note, '{}'::jsonb) || ${JSON.stringify(n)}::jsonb`,
  );
}

let taking = false;

/**
 * Sends a snapshot when files are in B2 and the last one is a day old (or `now`). A failure is
 * kept for Settings and written to History; the next hour tries again.
 */
export async function snapshotIfDue(ctx: Ctx, now = false): Promise<string | null> {
  if (taking) return null;
  taking = true;
  try {
    const [f] = await ctx.db.select().from(schema.firm);
    const store = ctx.blobs.where.primary;
    if (!f || f.storage !== 'b2' || store.kind !== 'b2') return null;
    const last = f.storageNote?.snapshotAt;
    if (!now && last && ctx.now().getTime() - Date.parse(last) < EVERY_MS) return null;
    try {
      const name = await takeSnapshot(ctx, store as Bucket);
      await noteSnapshot(ctx, {
        snapshotAt: ctx.now().toISOString(),
        snapshotName: name,
        snapshotError: null,
      });
      ctx.log.info({ name }, 'database snapshot sent to the bucket');
      return name;
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      const newly = !f.storageNote?.snapshotError;
      await noteSnapshot(ctx, { snapshotError: msg, snapshotFailedAt: ctx.now().toISOString() });
      ctx.log.error({ err }, 'database snapshot failed');
      // History hears of it once, not every hour it goes on failing.
      if (newly)
        await record(
          ctx.db,
          'storage_snapshot_failed',
          { kind: 'system', name: 'portal' },
          { detail: { error: msg } },
        ).catch(() => undefined);
      throw err;
    }
  } finally {
    taking = false;
  }
}
