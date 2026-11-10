// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// A database snapshot round trip on real Postgres through postgres-js, as on the appliance (the
// other tests use pglite). Runs only with PG_TEST_URL set to a server where the user may create
// databases, for example the dev one:
//
//   PG_TEST_URL=postgres://vibe:vibe@localhost:5433/vibe_portal pnpm --filter @vibe-portal/api test snapshot-postgres

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { generateKey } from '@vibe/crypto';
import { createDb, migrate, schema } from '@vibe-portal/db';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';

import type { Ctx } from '../context';
import { BlobStore } from '../files/blobs';
import { openKeyring } from '../files/keyring';
import { MemoryObjects } from '../files/objects';
import { listSnapshots, openSnapshot, restoreSnapshot, takeSnapshot } from '../files/snapshot';

const URL_ = process.env.PG_TEST_URL;

function urlFor(name: string): string {
  const u = new URL(URL_ as string);
  u.pathname = `/${name}`;
  return u.toString();
}

async function migrated(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await migrate({
      exec: async (q) => {
        await sql.unsafe(q);
      },
      applied: async () =>
        new Set(
          (await sql<{ filename: string }[]>`SELECT filename FROM schema_migrations`).map(
            (r) => r.filename,
          ),
        ),
      applyOne: async (name, body) => {
        await sql.begin(async (tx) => {
          await tx.unsafe(body);
          await tx`INSERT INTO schema_migrations (filename) VALUES (${name})`;
        });
      },
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

describe.skipIf(!URL_)('database snapshots on real Postgres (P51)', () => {
  it('snapshot, restore into an empty database, and a file opens from the bucket', async () => {
    const admin = postgres(URL_ as string, { max: 1, onnotice: () => undefined });
    const names = [`snap_a_${Date.now()}`, `snap_b_${Date.now()}`];
    const dirs = [
      await mkdtemp(join(tmpdir(), 'vp-snap-a-')),
      await mkdtemp(join(tmpdir(), 'vp-snap-b-')),
    ];
    for (const n of names) await admin.unsafe(`CREATE DATABASE ${n}`);
    const a = createDb({ connectionString: urlFor(names[0] as string), max: 2 });
    const b = createDb({ connectionString: urlFor(names[1] as string), max: 2 });
    try {
      for (const n of names) await migrated(urlFor(n));
      const bucket = new MemoryObjects();

      // The old appliance: a client, a file in the bucket, some history, files in B2.
      const keyring = await openKeyring(a.db, dirs[0] as string);
      const blobs = new BlobStore(join(dirs[0] as string, 'blobs'));
      blobs.use(bucket, null);
      const ctx = {
        db: a.db,
        keyring,
        blobs,
        now: () => new Date(),
        log: pino({ level: 'silent' }),
      } as unknown as Ctx;
      const client = randomUUID();
      await a.db.insert(schema.clients).values({ id: client, displayName: 'Pat Doe' });
      const dek = generateKey();
      const stored = await blobs.put(Readable.from([Buffer.from('%PDF real')]), dek, 1_000_000);
      const [file] = await a.db
        .insert(schema.files)
        .values({
          clientId: client,
          vfDocumentId: 'doc-1',
          name: 'W-2.pdf',
          size: stored.size,
          sha256: stored.sha256,
          blobKey: stored.blobKey,
          dekWrapped: Buffer.from(keyring.wrap(dek)),
        })
        .returning();
      for (let i = 0; i < 3; i++) {
        await a.db
          .insert(schema.events)
          .values({ kind: 'settings_updated', actorKind: 'system', actor: 'test', detail: { i } });
      }
      await a.db.update(schema.firm).set({ storage: 'b2', name: 'Example CPA' });
      await takeSnapshot(ctx, bucket);
      const [snap] = await listSnapshots(bucket);
      const data = await bucket.getNote(snap?.name as string);

      // The new appliance: an empty database, its own seal file.
      await openKeyring(b.db, dirs[1] as string);
      const opened = await openSnapshot(data as Buffer, join(dirs[0] as string, '.firm-key.seal'));
      const counts = await restoreSnapshot(b.db, opened);
      expect(counts).toEqual(expect.objectContaining({ clients: 1, files: 1, events: 3 }));
      const back = await openKeyring(b.db, dirs[0] as string);
      const [f] = await b.db
        .select()
        .from(schema.files)
        .where(eq(schema.files.id, file?.id ?? ''));
      const read = new BlobStore(join(dirs[1] as string, 'blobs'));
      read.use(bucket, null);
      const plain = await read.read(
        f?.blobKey as string,
        back.unwrap(new Uint8Array(f?.dekWrapped as Buffer)),
      );
      expect(plain.toString()).toBe('%PDF real');
      const [firm] = await b.db.select().from(schema.firm);
      expect([firm?.name, firm?.storage]).toEqual(['Example CPA', 'b2']);
      // History carries on after the restored rows (the identity column was moved on).
      const [ev] = await b.db
        .insert(schema.events)
        .values({ kind: 'settings_updated', actorKind: 'system', actor: 'test', detail: {} })
        .returning();
      expect(Number(ev?.id)).toBeGreaterThan(3);
    } finally {
      await a.close();
      await b.close();
      for (const n of names) await admin.unsafe(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`);
      await admin.end({ timeout: 5 });
      for (const d of dirs) await rm(d, { recursive: true, force: true });
    }
  });
});
