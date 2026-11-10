// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Phase 4 gate (BUILD_PLAN.md §7): two fetchers at once -> one 200, one 409; over-size and
// wrong-type uploads refused. Plus P8, P29-P34.

import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { eq } from 'drizzle-orm';
import { schema } from '@vibe-portal/db';
import supertest, { type default as request } from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { purgeUploads } from '../firm/uploads';
import { CLIENT, OTHER, world, type World } from './harness';

const here = dirname(fileURLToPath(import.meta.url));
let w: World;

beforeEach(async () => {
  w = await world();
});
afterEach(async () => {
  await w.close();
});

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n');
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

function send(
  agent: ReturnType<typeof request.agent>,
  body: Buffer,
  name: string,
  opts: { batchId?: string; note?: string; clientId?: string } = {},
) {
  const q = new URLSearchParams({
    clientId: opts.clientId ?? CLIENT,
    batchId: opts.batchId ?? randomUUID(),
    name,
    ...(opts.note ? { note: opts.note } : {}),
  });
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

async function blobCount(): Promise<number> {
  try {
    return (await readdir(join(w.dir, 'blobs'))).length;
  } catch {
    return 0;
  }
}

describe('Phase 4 gate', () => {
  it('two Vibe Files PCs fetching at once: one 200, one 409', async () => {
    const a = await w.member('a@example.test');
    const up = await send(a.agent, PDF, 'W-2.pdf').expect(201);
    const id = up.body.uploadId as string;
    const [r1, r2] = await Promise.all([
      w.firm('post', `/uploads/${id}/fetched`),
      w.firm('post', `/uploads/${id}/fetched`),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect([r1.body.error, r2.body.error]).toContain('already_fetched');
  });

  it('refuses a file over the firm limit and keeps nothing', async () => {
    const a = await w.member('a@example.test');
    await w.t.db.update(schema.firm).set({ uploadLimitBytes: 1000 });
    const big = Buffer.concat([PDF, Buffer.alloc(5000, 32)]);
    expect((await send(a.agent, big, 'big.pdf')).status).toBe(413);
    expect(await blobCount()).toBe(0);
    expect(await w.t.db.select().from(schema.uploads)).toEqual([]);
  });

  it('refuses types that are not allowed, by content and by name (P29)', async () => {
    const a = await w.member('a@example.test');
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 0)]);
    for (const [body, name] of [
      [exe, 'setup.exe'],
      [exe, 'return.pdf'], // a program pretending to be a PDF
      [PDF, 'return.exe'], // a PDF with the wrong name
      [Buffer.from('PK\u0003\u0004 zip'), 'folder.zip'],
      [Buffer.from('<script>alert(1)</script>'), 'page.html'],
    ] as const) {
      const res = await send(a.agent, body, name);
      expect(res.status, name).toBe(415);
      expect(res.body.error).toBe('type_not_allowed');
    }
    expect(await blobCount()).toBe(0);
  });
});

describe('uploading', () => {
  it('accepts the allowed types', async () => {
    const a = await w.member('a@example.test');
    const ok: [Buffer, string][] = [
      [PDF, 'a.pdf'],
      [Buffer.from('ffd8ffe000104a464946', 'hex'), 'b.jpg'],
      [Buffer.from('89504e470d0a1a0a0000', 'hex'), 'c.png'],
      [Buffer.from('49492a0008000000', 'hex'), 'd.tif'],
      [Buffer.from('504b030414000600', 'hex'), 'e.xlsx'],
      [Buffer.from('d0cf11e0a1b11ae10000', 'hex'), 'f.doc'],
      [Buffer.from('Date,Amount\n2025-01-02,10.00\n'), 'g.csv'],
      [Buffer.from('Notes for the preparer — café'), 'h.txt'],
    ];
    for (const [body, name] of ok) {
      const res = await send(a.agent, body, name);
      expect(res.status, name).toBe(201);
    }
  });

  it('client uploads -> firm lists, fetches and marks it; the client sees "received"', async () => {
    const a = await w.member('mary@example.test');
    const up = await send(a.agent, PDF, '2025 W-2.pdf', { note: 'From my second job' }).expect(201);
    const id = up.body.uploadId as string;

    const mine = await a.agent.get('/api/portal/uploads').expect(200);
    expect(mine.body.uploads).toEqual([
      expect.objectContaining({
        id,
        name: '2025 W-2.pdf',
        note: 'From my second job',
        received: false,
      }),
    ]);

    const waiting = await w.firm('get', '/uploads').expect(200);
    expect(waiting.body.uploads).toEqual([
      expect.objectContaining({
        uploadId: id,
        clientId: CLIENT,
        clientCode: '1001',
        clientName: 'Smith, John',
        name: '2025 W-2.pdf',
        note: 'From my second job',
        sha256: sha(PDF),
        from: expect.objectContaining({ email: 'mary@example.test' }),
      }),
    ]);
    const got = await w.firm('get', `/uploads/${id}/content`).buffer(true).parse(bytes).expect(200);
    expect((got.body as Buffer).equals(PDF)).toBe(true);
    expect(got.headers['x-content-sha256']).toBe(sha(PDF));
    expect(got.headers['content-disposition']).toMatch(/^attachment/);

    await w.firm('post', `/uploads/${id}/fetched`).expect(200);
    expect((await w.firm('get', '/uploads')).body.uploads).toEqual([]);
    expect((await a.agent.get('/api/portal/uploads')).body.uploads[0].received).toBe(true);
    // Too late to remove (P32).
    const del = await a.agent.delete(`/api/portal/uploads/${id}`);
    expect(del.status).toBe(409);
    expect(del.body.error).toBe('already_received');

    const [ev] = await w.t.db.select().from(schema.events).where(eq(schema.events.kind, 'fetch'));
    expect(ev).toMatchObject({ actor: 'THGR18C-XA003\\kurt', uploadId: id });
  });

  it('a client can remove an upload before it is fetched (P32)', async () => {
    const a = await w.member('a@example.test');
    const id = (await send(a.agent, PDF, 'oops.pdf').expect(201)).body.uploadId as string;
    expect(await blobCount()).toBe(1);
    await a.agent.delete(`/api/portal/uploads/${id}`).expect(200);
    expect(await blobCount()).toBe(0);
    expect((await a.agent.get('/api/portal/uploads')).body.uploads).toEqual([]);
    expect((await w.firm('get', '/uploads')).body.uploads).toEqual([]);
    const f = await w.firm('post', `/uploads/${id}/fetched`);
    expect(f.status).toBe(409);
    expect(f.body.error).toBe('removed_by_client');
    await w.firm('get', `/uploads/${id}/content`).expect(404);
  });

  it("one person cannot see or remove another's uploads", async () => {
    const a = await w.member('a@example.test');
    const b = await w.member('b@example.test');
    const id = (await send(a.agent, PDF, 'a.pdf').expect(201)).body.uploadId as string;
    expect((await b.agent.get('/api/portal/uploads')).body.uploads).toEqual([]);
    await b.agent.delete(`/api/portal/uploads/${id}`).expect(404);
  });

  it('only to a client the person has access to', async () => {
    const a = await w.member('a@example.test');
    const res = await send(a.agent, PDF, 'a.pdf', { clientId: OTHER });
    expect(res.status).toBe(404);
  });

  it('at most 20 files in one batch (P34)', async () => {
    const a = await w.member('a@example.test');
    const batchId = randomUUID();
    for (let i = 0; i < 20; i++) {
      await send(a.agent, Buffer.from(`line ${i}\n`), `n${i}.txt`, { batchId }).expect(201);
    }
    const res = await send(a.agent, Buffer.from('x\n'), 'n20.txt', { batchId });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('batch_full');
  });

  it('needs to be signed in, and a real upload content type', async () => {
    const q = new URLSearchParams({ clientId: CLIENT, batchId: randomUUID(), name: 'a.pdf' });
    const anon = await supertest(w.app)
      .post(`/api/portal/uploads?${q.toString()}`)
      .set('Content-Type', 'application/octet-stream')
      .send(PDF);
    expect(anon.status).toBe(401);
    const a = await w.member('a@example.test');
    const form = await a.agent.post(`/api/portal/uploads?${q.toString()}`).type('form').send('a=1');
    expect(form.status).toBe(415);
  });
});

describe('phone photos (P33)', () => {
  it('a HEIC photo is stored as a JPG', async () => {
    const a = await w.member('a@example.test');
    const heic = await readFile(join(here, 'fixtures', 'sample.heic'));
    const up = await send(a.agent, heic, 'IMG_1234.HEIC').expect(201);
    expect(up.body.name).toBe('IMG_1234.jpg');
    const waiting = (await w.firm('get', '/uploads')).body.uploads[0];
    expect(waiting).toMatchObject({ name: 'IMG_1234.jpg', originalName: 'IMG_1234.HEIC' });
    const got = await w
      .firm('get', `/uploads/${waiting.uploadId}/content`)
      .buffer(true)
      .parse(bytes)
      .expect(200);
    expect((got.body as Buffer).subarray(0, 3).toString('hex')).toBe('ffd8ff');
  }, 60_000);

  it('a damaged HEIC photo is refused with a clear reason', async () => {
    const a = await w.member('a@example.test');
    const broken = Buffer.concat([
      Buffer.from('000000186674797068656963', 'hex'),
      Buffer.alloc(500, 7),
    ]);
    const res = await send(a.agent, broken, 'IMG_9.heic');
    expect(res.status).toBe(415);
    expect(res.body.error).toBe('photo_unreadable');
    expect(await blobCount()).toBe(0);
  }, 60_000);
});

describe('keeping fetched uploads (P8)', () => {
  it('deletes the stored copy 30 days after fetch; the client still sees "received"', async () => {
    const a = await w.member('a@example.test');
    const id = (await send(a.agent, PDF, 'a.pdf').expect(201)).body.uploadId as string;
    await w.firm('post', `/uploads/${id}/fetched`).expect(200);
    w.later(29 * 24 * 60);
    expect(await purgeUploads(w.ctx)).toBe(0);
    expect(await blobCount()).toBe(1);
    w.later(2 * 24 * 60);
    expect(await purgeUploads(w.ctx)).toBe(1);
    expect(await blobCount()).toBe(0);
    await w.firm('get', `/uploads/${id}/content`).expect(404);
    const [row] = await w.t.db.select().from(schema.uploads).where(eq(schema.uploads.id, id));
    expect(row?.fetchedAt).not.toBeNull();
    expect(row?.purgedAt).not.toBeNull();
  });
});
