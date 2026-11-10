// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Stored files in a B2 bucket (P51): Settings > Storage, moving files there and back while the
// portal keeps working, and what happens when a move fails part-way. The bucket here is kept in
// memory (files/objects.ts, MemoryObjects); the real B2 adapter (files/b2.ts) is not exercised.

import { createHash, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { get as httpGet } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';

import { generateKey } from '@vibe/crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@vibe-portal/db';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MemoryObjects, NotFound } from '../files/objects';
import { noteInterrupted, runMove } from '../files/storage';
import { createFirmKey } from '../firm/keys';
import { createSetupLink } from '../staff/auth';
import { totpCode } from '../staff/credentials';
import { CLIENT, world, type World } from './harness';

let w: World;
let bucket: MemoryObjects;
beforeEach(async () => {
  w = await world();
  bucket = new MemoryObjects();
  w.ctx.openB2 = () => bucket;
});
afterEach(async () => {
  await w.close();
});

const B2 = {
  endpoint: 'https://s3.us-west-004.backblazeb2.com',
  bucket: 'example-cpa-portal',
  keyId: '004a1b2c3d4e5f60000000001',
  appKey: 'K004SuperSecretApplicationKeyValue',
};
type Agent = ReturnType<typeof request.agent>;

async function admin(): Promise<Agent> {
  const link = await createSetupLink(w.ctx, null, 'appliance');
  const token = /#t=([\w-]+)/.exec(link)?.[1] ?? '';
  const agent = request.agent(w.app);
  const set = await agent
    .post('/api/staff/auth/setup')
    .send({
      token,
      email: 'kurt@example-cpa.test',
      name: 'Kurt',
      password: 'a long staff password',
    })
    .expect(200);
  await agent
    .post('/api/staff/auth/setup/confirm')
    .send({ token, code: totpCode(set.body.secret as string, w.ctx.now()) })
    .expect(200);
  return agent;
}

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

async function shared(name: string, bytes: Buffer): Promise<string> {
  const res = await w
    .firm(
      'post',
      `/files?clientId=${CLIENT}&vfDocumentId=${randomUUID()}&name=${name}&sha256=${sha(bytes)}`,
    )
    .set('Content-Type', 'application/octet-stream')
    .send(bytes);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.fileId as string;
}

/** What a stored file reads as now, through the same store the routes use. */
async function readFile(fileId: string): Promise<string> {
  const [f] = await w.t.db.select().from(schema.files).where(eq(schema.files.id, fileId));
  const dek = w.ctx.keyring.unwrap(new Uint8Array(f?.dekWrapped as Buffer));
  return (await w.ctx.blobs.read(f?.blobKey as string, dek)).toString();
}

async function onDisk(): Promise<string[]> {
  try {
    return (await readdir(join(w.dir, 'blobs'))).filter((n) => !n.endsWith('.part'));
  } catch {
    return [];
  }
}

function upload(agent: Agent, body: Buffer, name: string) {
  const q = new URLSearchParams({ clientId: CLIENT, batchId: randomUUID(), name });
  return agent
    .post(`/api/portal/uploads?${q.toString()}`)
    .set('Content-Type', 'application/octet-stream')
    .send(body);
}

function bytes(res: request.Response, done: (err: Error | null, body: unknown) => void): void {
  const stream = res as unknown as NodeJS.ReadableStream;
  const parts: Buffer[] = [];
  stream.on('data', (c: Buffer) => parts.push(c));
  stream.on('end', () => done(null, Buffer.concat(parts)));
}

/** Starts a move on Settings and waits for the server to finish it. */
async function move(boss: Agent, to: 'b2' | 'local') {
  await boss.post('/api/staff/v1/settings/storage/move').send({ to }).expect(202);
  await runMove(w.ctx); // returns at once if the one the route started is still running
  for (let i = 0; i < 200; i++) {
    const s = await boss.get('/api/staff/v1/settings/storage').expect(200);
    if (['done', 'failed'].includes(s.body.move?.state as string)) return s.body;
    await new Promise((ok) => setTimeout(ok, 10));
  }
  throw new Error('move did not finish');
}

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n');

describe('Settings > Storage (P51)', () => {
  it('saves a bucket only once it works, and never shows or records the key', async () => {
    const boss = await admin();
    const bad = await boss
      .put('/api/staff/v1/settings/storage/b2')
      .send({ ...B2, endpoint: 'https://s3.amazonaws.com' });
    expect([bad.status, bad.body]).toEqual([400, { error: 'b2_endpoint' }]);
    const shortName = await boss
      .put('/api/staff/v1/settings/storage/b2')
      .send({ ...B2, bucket: 'ab' });
    expect(shortName.body).toEqual({ error: 'b2_bucket' });

    bucket.down = true;
    const refused = await boss.put('/api/staff/v1/settings/storage/b2').send(B2);
    expect(refused.status).toBe(400);
    expect(refused.body).toEqual({ error: 'b2_check_failed', detail: 'network down' });
    bucket.down = false;
    let s = await boss.get('/api/staff/v1/settings/storage').expect(200);
    expect(s.body.b2.hasKey).toBe(false);

    await boss.put('/api/staff/v1/settings/storage/b2').send(B2).expect(200);
    s = await boss.get('/api/staff/v1/settings/storage').expect(200);
    expect(s.body).toEqual({
      storage: 'local',
      bothInUse: false,
      b2: {
        endpoint: 's3.us-west-004.backblazeb2.com',
        bucket: B2.bucket,
        keyId: B2.keyId,
        hasKey: true,
      },
      move: null,
    });
    // The check left nothing behind in the bucket.
    expect(bucket.items.size).toBe(0);
    await boss.post('/api/staff/v1/settings/storage/test').expect(200);

    // The key: wrapped in the database, nowhere in a reply or the history.
    const [f] = await w.t.db.select().from(schema.firm);
    expect(f?.b2AppKeyEnc?.toString('utf8') ?? '').not.toContain(B2.appKey);
    const events = await w.t.db.select().from(schema.events);
    expect(JSON.stringify(events)).not.toContain(B2.appKey);
    expect(events.map((e) => e.kind)).toContain('storage_b2_saved');
    expect(JSON.stringify(s.body)).not.toContain(B2.appKey);
  });

  it('is for admins only', async () => {
    const boss = await admin();
    const add = await boss
      .post('/api/staff/v1/staff')
      .send({ email: 'mary@example-cpa.test', name: 'Mary' })
      .expect(201);
    const token = /#t=([\w-]+)/.exec(add.body.setupLink as string)?.[1] ?? '';
    const mary = request.agent(w.app);
    const set = await mary
      .post('/api/staff/auth/setup')
      .send({ token, password: 'a long staff password' })
      .expect(200);
    await mary
      .post('/api/staff/auth/setup/confirm')
      .send({ token, code: totpCode(set.body.secret as string, w.ctx.now()) })
      .expect(200);
    await mary.get('/api/staff/v1/settings/storage').expect(403);
    await mary.put('/api/staff/v1/settings/storage/b2').send(B2).expect(403);
    await mary.post('/api/staff/v1/settings/storage/move').send({ to: 'b2' }).expect(403);
  });
});

describe('moving stored files (P51)', () => {
  it('to B2 and back: every file still opens, and the old place is emptied', async () => {
    const boss = await admin();
    await boss.put('/api/staff/v1/settings/storage/b2').send(B2).expect(200);
    const a = await shared('a.pdf', Buffer.from('%PDF shared a'));
    const pat = await w.member('pat@example.test');
    const up = await upload(pat.agent, PDF, 'W-2.pdf').expect(201);
    const uploadId = up.body.uploadId as string;
    expect(await onDisk()).toHaveLength(2);

    const done = await move(boss, 'b2');
    expect(done.move).toEqual(
      expect.objectContaining({ to: 'b2', state: 'done', by: 'kurt@example-cpa.test', total: 2 }),
    );
    expect([done.storage, done.bothInUse]).toEqual(['b2', false]);
    expect(await onDisk()).toEqual([]);
    expect(bucket.items.size).toBe(2);
    // Stored encrypted: the bucket never holds the readable file.
    for (const b of bucket.items.values()) expect(b.includes(Buffer.from('%PDF'))).toBe(false);
    expect(await readFile(a)).toBe('%PDF shared a');
    const got = await w
      .firm('get', `/uploads/${uploadId}/content`)
      .buffer(true)
      .parse(bytes)
      .expect(200);
    expect(Buffer.compare(got.body as Buffer, PDF)).toBe(0);

    // New files go to the bucket; one removed is removed from it.
    const b = await shared('b.pdf', Buffer.from('%PDF shared b'));
    expect(bucket.items.size).toBe(3);
    expect(await onDisk()).toEqual([]);
    await w.firm('delete', `/files/${b}`).expect(200);
    expect(bucket.items.size).toBe(2);

    // While files are in it, the bucket cannot be changed or forgotten; a new key is fine.
    const other = await boss
      .put('/api/staff/v1/settings/storage/b2')
      .send({ ...B2, bucket: 'another-bucket' });
    expect([other.status, other.body]).toEqual([409, { error: 'b2_in_use' }]);
    await boss.delete('/api/staff/v1/settings/storage/b2').expect(409);
    await boss
      .put('/api/staff/v1/settings/storage/b2')
      .send({ ...B2, keyId: '004a1b2c3d4e5f60000000002', appKey: 'K004NewKey' })
      .expect(200);
    const again = await boss.post('/api/staff/v1/settings/storage/move').send({ to: 'b2' });
    expect([again.status, again.body]).toEqual([409, { error: 'already_there' }]);

    const back = await move(boss, 'local');
    expect([back.storage, back.bothInUse, back.move.state]).toEqual(['local', false, 'done']);
    expect(bucket.items.size).toBe(0);
    expect(await onDisk()).toHaveLength(2);
    expect(await readFile(a)).toBe('%PDF shared a');
    // Now the bucket may be forgotten.
    await boss.delete('/api/staff/v1/settings/storage/b2').expect(200);
    const kinds = (await w.t.db.select().from(schema.events)).map((e) => e.kind);
    expect(kinds.filter((k) => k === 'storage_moved')).toHaveLength(2);
  });

  it('a move cut off part-way loses nothing, and moving again finishes it', async () => {
    const boss = await admin();
    await boss.put('/api/staff/v1/settings/storage/b2').send(B2).expect(200);
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(await shared(`f${i}.pdf`, Buffer.from(`%PDF ${i}`)));
    // The connection goes after the two checks (Settings, then the move) and two files.
    bucket.putsLeft = 4;
    const failed = await move(boss, 'b2');
    expect(failed.move).toEqual(
      expect.objectContaining({ state: 'failed', error: 'connection lost' }),
    );
    // Both places in use: every file still opens, wherever it is.
    expect([failed.storage, failed.bothInUse]).toEqual(['b2', true]);
    expect(bucket.items.size).toBe(2);
    // Nothing is deleted from the appliance until every file is in the bucket.
    expect(await onDisk()).toHaveLength(4);
    for (let i = 0; i < 4; i++) expect(await readFile(ids[i] as string)).toBe(`%PDF ${i}`);
    // A file removed now goes from both places.
    await w.firm('delete', `/files/${ids[0] ?? ''}`).expect(200);

    bucket.putsLeft = Infinity;
    const done = await move(boss, 'b2');
    expect([done.move.state, done.bothInUse]).toEqual(['done', false]);
    expect(await onDisk()).toEqual([]);
    expect(bucket.items.size).toBe(3);
    for (let i = 1; i < 4; i++) expect(await readFile(ids[i] as string)).toBe(`%PDF ${i}`);
  });

  it('while both places are in use, a file the bucket cannot give is read from the appliance', async () => {
    const boss = await admin();
    await boss.put('/api/staff/v1/settings/storage/b2').send(B2).expect(200);
    const a = await shared('a.pdf', Buffer.from('%PDF a'));
    // As during a move: new files to the bucket, the rest still on the appliance.
    w.ctx.blobs.use(bucket, w.ctx.blobs.local);
    expect(await readFile(a)).toBe('%PDF a');
    // The bucket is down: the appliance still has it.
    bucket.down = true;
    expect(await readFile(a)).toBe('%PDF a');
    // Once the move is over, only the bucket is asked: down is an error, not a fallback.
    w.ctx.blobs.use(bucket, null);
    await expect(readFile(a)).rejects.toThrow('network down');
    bucket.down = false;
    await expect(readFile(a)).rejects.toBeInstanceOf(NotFound);
    // In neither place while the bucket is down: the bucket's error is the answer.
    const [row] = await w.t.db.select().from(schema.files);
    await w.ctx.blobs.local.remove(row?.blobKey as string);
    w.ctx.blobs.use(bucket, w.ctx.blobs.local);
    bucket.down = true;
    await expect(readFile(a)).rejects.toThrow('network down');
  });

  it('a file still being written when the move starts is waited for and moved', async () => {
    const boss = await admin();
    await boss.put('/api/staff/v1/settings/storage/b2').send(B2).expect(200);
    const source = new PassThrough();
    const dek = generateKey();
    const writing = w.ctx.blobs.put(source, dek, 10_000_000);
    source.write(Buffer.alloc(3_000_000, 7));
    await w.t.db.update(schema.firm).set({
      storageMove: { to: 'b2', state: 'requested', by: 'kurt', requestedAt: 'x' },
    });
    const moving = runMove(w.ctx);
    await new Promise((ok) => setTimeout(ok, 50));
    source.end(Buffer.alloc(1_000, 8));
    const stored = await writing;
    await moving;
    // The database is told only now, after the move has finished with it.
    const s = await boss.get('/api/staff/v1/settings/storage').expect(200);
    expect([s.body.move.state, s.body.bothInUse]).toEqual(['done', false]);
    expect(await onDisk()).toEqual([]);
    expect(bucket.items.has(stored.blobKey)).toBe(true);
    const back = await w.ctx.blobs.read(stored.blobKey, dek);
    expect(back.length).toBe(3_001_000);
  });

  it('a download given up part-way closes the stored file it was reading', async () => {
    let closed = false;
    const big = Buffer.alloc(8 * 1024 * 1024, 1);
    const pat = await w.member('pat@example.test');
    const up = await upload(pat.agent, PDF, 'W-2.pdf').expect(201);
    await w.t.db.update(schema.uploads).set({ size: 64 * 128 * 1024 });
    // The stored file stands in for a long one, read slowly.
    w.ctx.blobs.get = () => {
      async function* slow(): AsyncGenerator<Buffer> {
        try {
          for (let i = 0; i < 64; i++) {
            yield big.subarray(0, 128 * 1024);
            await new Promise((ok) => setTimeout(ok, 5));
          }
        } finally {
          closed = true;
        }
      }
      return Readable.from(slow(), { objectMode: false });
    };
    const server = w.app.listen(0);
    try {
      const port = (server.address() as AddressInfo).port;
      const key = (await createFirmKey(w.t.db, 'Test')).key;
      await new Promise<void>((ok, fail) => {
        const req = httpGet(
          {
            port,
            path: `/api/firm/v1/uploads/${up.body.uploadId as string}/content`,
            headers: { Authorization: `Bearer ${key}`, 'X-Vibe-PC': 'PC1', 'X-Vibe-User': 'kurt' },
          },
          (res) => {
            res.once('data', () => {
              req.destroy();
              ok();
            });
          },
        );
        req.on('error', () => undefined);
        setTimeout(() => fail(new Error('no data')), 5000);
      });
      for (let i = 0; i < 200 && !closed; i++) await new Promise((ok) => setTimeout(ok, 10));
      expect(closed).toBe(true);
    } finally {
      server.close();
    }
  });

  it('the appliance command asks; the server moves; a restart mid-move says so', async () => {
    const boss = await admin();
    await boss.put('/api/staff/v1/settings/storage/b2').send(B2).expect(200);
    await shared('a.pdf', Buffer.from('%PDF a'));
    await w.t.db.update(schema.firm).set({
      storageMove: { to: 'b2', state: 'requested', by: 'appliance', requestedAt: 'x' },
    });
    await runMove(w.ctx);
    const s = await boss.get('/api/staff/v1/settings/storage').expect(200);
    expect([s.body.storage, s.body.move.state, s.body.move.by]).toEqual([
      'b2',
      'done',
      'appliance',
    ]);

    await w.t.db.update(schema.firm).set({
      storageMove: { to: 'local', state: 'running', by: 'kurt', requestedAt: 'x' },
    });
    await noteInterrupted(w.ctx);
    const after = await boss.get('/api/staff/v1/settings/storage').expect(200);
    expect(after.body.move.state).toBe('interrupted');
  });

  it('a bucket that stops working is found out before any file is pointed at it', async () => {
    const boss = await admin();
    await boss.put('/api/staff/v1/settings/storage/b2').send(B2).expect(200);
    await shared('a.pdf', Buffer.from('%PDF a'));
    bucket.down = true;
    const res = await boss.post('/api/staff/v1/settings/storage/move').send({ to: 'b2' });
    expect(res.body).toEqual({ error: 'b2_check_failed', detail: 'network down' });
    const s = await boss.get('/api/staff/v1/settings/storage').expect(200);
    expect([s.body.storage, s.body.bothInUse, s.body.move]).toEqual(['local', false, null]);
  });
});
