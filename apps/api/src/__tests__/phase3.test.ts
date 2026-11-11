// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Phase 3 gate (BUILD_PLAN.md §7): a file shown to user A only is listed for A and is a 404 for
// B; a removed file is gone from disk and from the list; a tampered stored file fails to
// decrypt. Plus P18-P24.

import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { and, eq } from 'drizzle-orm';
import { schema } from '@vibe-portal/db';
import type request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BadBlob } from '../files/blobs';
import { flush } from '../files/notify-queue';
import { CLIENT, OTHER, world, type World } from './harness';

let w: World;

beforeEach(async () => {
  w = await world();
});
afterEach(async () => {
  await w.close();
});

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

function add(
  body: Buffer,
  name = 'Smith 2025 Form 1040.pdf',
  extra: Record<string, string> = {},
  clientId = CLIENT,
) {
  const q = new URLSearchParams({
    clientId,
    vfDocumentId: extra['vfDocumentId'] ?? `doc-${name}`,
    name,
    sha256: extra['sha256'] ?? sha(body),
    ...(extra['taxYear'] ? { taxYear: extra['taxYear'] } : {}),
  });
  return w
    .firm('post', `/files?${q.toString()}`)
    .set('Content-Type', 'application/octet-stream')
    .send(body);
}

async function show(fileId: string, users: Record<string, boolean>) {
  return w.firm('put', `/files/${fileId}/visibility`).send({ users }).expect(200);
}

async function blobFiles(): Promise<string[]> {
  try {
    return await readdir(join(w.dir, 'blobs'));
  } catch {
    return [];
  }
}

/** Raw response body as a Buffer. */
function raw(res: { body: unknown; text?: string }): Buffer {
  return Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.text ?? '');
}

/** Collects a response body as bytes, whatever its type. */
function bytes(res: request.Response, done: (err: Error | null, body: unknown) => void): void {
  const stream = res as unknown as NodeJS.ReadableStream;
  const parts: Buffer[] = [];
  stream.on('data', (c: Buffer) => parts.push(c));
  stream.on('end', () => done(null, Buffer.concat(parts)));
}

describe('Phase 3 gate', () => {
  it('a file shown to A only is listed for A and is a 404 for B', async () => {
    const a = await w.member('a@example.test');
    const b = await w.member('b@example.test');
    const pdf = Buffer.from('%PDF-1.7 return for A');
    const added = await add(pdf).expect(201);
    const fileId = added.body.fileId as string;
    await show(fileId, { [a.id]: true, [b.id]: false });

    const listA = await a.agent.get('/api/portal/files').expect(200);
    expect(listA.body.files).toEqual([
      expect.objectContaining({ id: fileId, name: 'Smith 2025 Form 1040.pdf', isNew: true }),
    ]);
    expect((await b.agent.get('/api/portal/files').expect(200)).body.files).toEqual([]);

    const got = await a.agent
      .get(`/api/portal/files/${fileId}/content`)
      .buffer(true)
      .parse(bytes)
      .expect(200);
    expect(raw(got).equals(pdf)).toBe(true);
    await b.agent.get(`/api/portal/files/${fileId}/content`).expect(404);
  });

  it('a removed file is gone from disk and from the list', async () => {
    const a = await w.member('a@example.test');
    const fileId = (await add(Buffer.from('%PDF gone')).expect(201)).body.fileId as string;
    await show(fileId, { [a.id]: true });
    expect(await blobFiles()).toHaveLength(1);

    await w.firm('delete', `/files/${fileId}`).expect(200);
    expect(await blobFiles()).toHaveLength(0);
    expect((await a.agent.get('/api/portal/files').expect(200)).body.files).toEqual([]);
    await a.agent.get(`/api/portal/files/${fileId}/content`).expect(404);
    await w.firm('delete', `/files/${fileId}`).expect(404);
    // The same document can be shared again later.
    await add(Buffer.from('%PDF gone')).expect(201);
  });

  it('a tampered or cut-off stored file fails to decrypt', async () => {
    const a = await w.member('a@example.test');
    const body = randomBytes(2.5 * 1024 * 1024);
    const fileId = (await add(body, 'big.pdf').expect(201)).body.fileId as string;
    await show(fileId, { [a.id]: true });
    const [blobName] = await blobFiles();
    const path = join(w.dir, 'blobs', blobName ?? '');
    const [row] = await w.t.db.select().from(schema.files).where(eq(schema.files.id, fileId));
    const dek = w.ctx.keyring.unwrap(new Uint8Array(row?.dekWrapped ?? []));
    expect((await w.ctx.blobs.read(blobName ?? '', dek)).equals(body)).toBe(true);

    // One byte changed in the first chunk: refused before anything is sent.
    const stored = await readFile(path);
    const flipped = Buffer.from(stored);
    flipped[100] = (flipped[100] ?? 0) ^ 0xff;
    await writeFile(path, flipped);
    await expect(w.ctx.blobs.read(blobName ?? '', dek)).rejects.toBeInstanceOf(BadBlob);
    const res = await a.agent.get(`/api/portal/files/${fileId}/content`);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'file_unreadable' });

    // Cut off: the last chunk is missing.
    await writeFile(path, stored);
    await truncate(path, stored.length - 1000);
    await expect(w.ctx.blobs.read(blobName ?? '', dek)).rejects.toBeInstanceOf(BadBlob);

    // The wrong key.
    await writeFile(path, stored);
    await expect(w.ctx.blobs.read(blobName ?? '', randomBytes(32))).rejects.toBeInstanceOf(BadBlob);
  });
});

describe('a stored file missing from disk', () => {
  it('is an error for the client, not a crash', async () => {
    const a = await w.member('a@example.test');
    const fileId = (await add(Buffer.from('%PDF')).expect(201)).body.fileId as string;
    await show(fileId, { [a.id]: true });
    const [blobName] = await blobFiles();
    await rm(join(w.dir, 'blobs', blobName ?? ''));
    const res = await a.agent.get(`/api/portal/files/${fileId}/content`);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'file_unreadable' });
  });
});

describe('adding and replacing files', () => {
  it('stores a multi-chunk file encrypted and gives it back exactly', async () => {
    const a = await w.member('a@example.test');
    const body = randomBytes(3 * 1024 * 1024 + 123);
    const fileId = (await add(body, 'scan.pdf').expect(201)).body.fileId as string;
    await show(fileId, { [a.id]: true });
    const [blobName] = await blobFiles();
    const onDisk = await readFile(join(w.dir, 'blobs', blobName ?? ''));
    expect(onDisk.includes(body.subarray(0, 64))).toBe(false);
    const got = await a.agent
      .get(`/api/portal/files/${fileId}/content`)
      .buffer(true)
      .parse(bytes)
      .expect(200);
    expect(sha(raw(got))).toBe(sha(body));
    expect(got.headers['content-length']).toBe(String(body.length));
  });

  it('refuses a file over the firm limit and keeps nothing (P23)', async () => {
    await w.t.db.update(schema.firm).set({ uploadLimitBytes: 1000 });
    const res = await add(randomBytes(2000));
    expect(res.status).toBe(413);
    expect(await blobFiles()).toEqual([]);
    expect(await w.t.db.select().from(schema.files)).toEqual([]);
  });

  it('refuses a file whose content does not match its sha256', async () => {
    const res = await add(Buffer.from('abc'), 'a.pdf', { sha256: sha(Buffer.from('xyz')) });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'sha256_mismatch' });
    expect(await blobFiles()).toEqual([]);
  });

  it('needs application/octet-stream', async () => {
    const q = new URLSearchParams({
      clientId: CLIENT,
      vfDocumentId: 'd',
      name: 'a.pdf',
      sha256: sha(Buffer.from('{}')),
    });
    await w.firm('post', `/files?${q.toString()}`).send({}).expect(415);
  });

  it('the same document again: same content is the same file; changed content must be replaced', async () => {
    const body = Buffer.from('%PDF v1');
    const first = await add(body, 'a.pdf', { vfDocumentId: 'doc-1' }).expect(201);
    const again = await add(body, 'a.pdf', { vfDocumentId: 'doc-1' }).expect(200);
    expect(again.body).toEqual({ fileId: first.body.fileId, existing: true });
    const changed = await add(Buffer.from('%PDF v2'), 'a.pdf', { vfDocumentId: 'doc-1' });
    expect(changed.status).toBe(409);
    expect(changed.body).toEqual({ error: 'changed_use_replace', fileId: first.body.fileId });
  });

  it('refuses files for a switched-off client', async () => {
    await w
      .firm('put', `/clients/${OTHER}`)
      .send({ displayName: 'Smith Farms LLC', active: false })
      .expect(200);
    const res = await add(Buffer.from('x'), 'a.pdf', {}, OTHER);
    expect(res.status).toBe(409);
  });

  it('Update on portal replaces the content in place, marked Updated and new again (P20)', async () => {
    const a = await w.member('a@example.test');
    const fileId = (await add(Buffer.from('%PDF v1'), 'a.pdf').expect(201)).body.fileId as string;
    await show(fileId, { [a.id]: true });
    await a.agent.get(`/api/portal/files/${fileId}/content`).expect(200);
    expect((await a.agent.get('/api/portal/files')).body.files[0].isNew).toBe(false);
    const [oldBlob] = await blobFiles();

    w.later(20);
    const v2 = Buffer.from('%PDF v2, corrected');
    await w
      .firm('put', `/files/${fileId}/content?sha256=${sha(v2)}`)
      .set('Content-Type', 'application/octet-stream')
      .send(v2)
      .expect(200);
    const files = (await a.agent.get('/api/portal/files')).body.files;
    expect(files).toEqual([
      expect.objectContaining({ id: fileId, isNew: true, updatedAt: '2026-11-09T15:20:00.000Z' }),
    ]);
    const got = await a.agent
      .get(`/api/portal/files/${fileId}/content`)
      .buffer(true)
      .parse(bytes)
      .expect(200);
    expect(raw(got).equals(v2)).toBe(true);
    expect(await blobFiles()).not.toContain(oldBlob);
    expect(await blobFiles()).toHaveLength(1);

    // Same content again: nothing to do.
    const same = await w
      .firm('put', `/files/${fileId}/content?sha256=${sha(v2)}`)
      .set('Content-Type', 'application/octet-stream')
      .send(v2)
      .expect(200);
    expect(same.body.unchanged).toBe(true);
  });
});

describe('who sees what', () => {
  it("only people with access to the file's client can be shown it", async () => {
    const stranger = await w.member('s@example.test', OTHER);
    const fileId = (await add(Buffer.from('x'), 'a.pdf').expect(201)).body.fileId as string;
    const res = await w
      .firm('put', `/files/${fileId}/visibility`)
      .send({ users: { [stranger.id]: true } });
    expect(res.status).toBe(400);
  });

  it('a user turned off for the client cannot open a file shown to them', async () => {
    const a = await w.member('a@example.test');
    const fileId = (await add(Buffer.from('x'), 'a.pdf').expect(201)).body.fileId as string;
    await show(fileId, { [a.id]: true });
    await w.firm('patch', `/clients/${CLIENT}/users/${a.id}`).send({ active: false }).expect(200);
    // Signed out at once; the file is not reachable even with an old session.
    await a.agent.get(`/api/portal/files/${fileId}/content`).expect(401);
  });

  it('someone of one client reaches nothing of another client, whatever they ask for', async () => {
    // Owner 2026-11-11: confirm a person cannot reach a client they were not given.
    const a = await w.member('a@example.test'); // CLIENT only
    const b = await w.member('b@example.test', OTHER); // OTHER only
    const theirs = (await add(Buffer.from('%PDF other'), 'other.pdf', {}, OTHER).expect(201)).body
      .fileId as string;
    await show(theirs, { [b.id]: true });
    // The firm cannot show OTHER's file to A, who has no access to OTHER.
    const wrong = await w
      .firm('put', `/files/${theirs}/visibility`)
      .send({ users: { [a.id]: true } });
    expect([wrong.status, wrong.body]).toEqual([400, { error: 'not_a_user_of_this_client' }]);
    // A: not listed, not opened by its id (view or download), not switched to, no uploads into
    // it, no link to it for someone outside.
    expect((await a.agent.get('/api/portal/files').expect(200)).body.files).toEqual([]);
    await a.agent.get(`/api/portal/files/${theirs}/content?mode=view`).expect(404);
    await a.agent.get(`/api/portal/files/${theirs}/content`).expect(404);
    await a.agent.post('/api/portal/auth/switch-client').send({ clientId: OTHER }).expect(404);
    const me = await a.agent.get('/api/portal/auth/me').expect(200);
    expect(me.body.clients.map((c: { id: string }) => c.id)).toEqual([CLIENT]);
    await a.agent
      .post(`/api/portal/uploads?clientId=${OTHER}&batchId=${crypto.randomUUID()}&name=x.pdf`)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('%PDF-1.7\n%%EOF\n'))
      .expect(404);
    await w.t.db.update(schema.firm).set({ clientLinks: true });
    await a.agent
      .post('/api/portal/outside-shares')
      .send({ clientId: OTHER, fileIds: [theirs], email: 'x@example.test' })
      .expect(404);
    await a.agent
      .post('/api/portal/outside-shares')
      .send({ clientId: CLIENT, fileIds: [theirs], email: 'x@example.test' })
      .expect(400);
    // B, who was given OTHER, still opens it.
    await b.agent.get(`/api/portal/files/${theirs}/content`).expect(200);
  });

  it('files of one client are not listed under another of the same person', async () => {
    const a = await w.member('a@example.test');
    await w.firm('post', `/clients/${OTHER}/invites`).send({ email: 'a@example.test' }).expect(201);
    await a.agent
      .post('/api/portal/invitations/accept')
      .send({ token: w.linkToken('a@example.test') })
      .expect(200);
    const f1 = (await add(Buffer.from('1'), 'one.pdf').expect(201)).body.fileId as string;
    const f2 = (await add(Buffer.from('2'), 'two.pdf', {}, OTHER).expect(201)).body
      .fileId as string;
    await show(f1, { [a.id]: true });
    await show(f2, { [a.id]: true });
    await a.agent.post('/api/portal/auth/switch-client').send({ clientId: CLIENT }).expect(200);
    expect(
      (await a.agent.get('/api/portal/files')).body.files.map((f: { id: string }) => f.id),
    ).toEqual([f1]);
    await a.agent.post('/api/portal/auth/switch-client').send({ clientId: OTHER }).expect(200);
    expect(
      (await a.agent.get('/api/portal/files')).body.files.map((f: { id: string }) => f.id),
    ).toEqual([f2]);
  });

  it('staff see who opened the current content (P21); events record each step', async () => {
    const a = await w.member('a@example.test');
    const b = await w.member('b@example.test');
    const fileId = (await add(Buffer.from('%PDF'), 'a.pdf').expect(201)).body.fileId as string;
    await show(fileId, { [a.id]: true, [b.id]: true });
    w.later(10);
    await a.agent.get(`/api/portal/files/${fileId}/content?mode=view`).expect(200);
    const list = await w.firm('get', `/files?clientId=${CLIENT}`).expect(200);
    const users = list.body.files[0].users as { identityId: string; viewedAt: string | null }[];
    expect(users.find((u) => u.identityId === a.id)?.viewedAt).toBe('2026-11-09T15:10:00.000Z');
    expect(users.find((u) => u.identityId === b.id)?.viewedAt).toBeNull();

    const kinds = (
      await w.t.db.select().from(schema.events).where(eq(schema.events.fileId, fileId))
    )
      .map((e) => e.kind)
      .sort();
    expect(kinds).toEqual(['file_added', 'share', 'share', 'view']);
  });
});

describe('the client list (P19) and opening files (P22)', () => {
  it('newest first, with a year filter and a search', async () => {
    const a = await w.member('a@example.test');
    const ids: string[] = [];
    for (const [name, year] of [
      ['2024 Form 1040.pdf', '2024'],
      ['2025 Form 1040.pdf', '2025'],
      ['2025 Engagement letter.pdf', '2025'],
    ] as const) {
      w.later(1);
      const id = (await add(Buffer.from(name), name, { taxYear: year }).expect(201)).body
        .fileId as string;
      ids.push(id);
      await show(id, { [a.id]: true });
    }
    const all = await a.agent.get('/api/portal/files').expect(200);
    expect(all.body.files.map((f: { name: string }) => f.name)).toEqual([
      '2025 Engagement letter.pdf',
      '2025 Form 1040.pdf',
      '2024 Form 1040.pdf',
    ]);
    expect(all.body.years).toEqual([2025, 2024]);
    const y = await a.agent.get('/api/portal/files?year=2024').expect(200);
    expect(y.body.files.map((f: { name: string }) => f.name)).toEqual(['2024 Form 1040.pdf']);
    const q = await a.agent.get('/api/portal/files?q=engage').expect(200);
    expect(q.body.files.map((f: { name: string }) => f.name)).toEqual([
      '2025 Engagement letter.pdf',
    ]);
    const wild = await a.agent.get('/api/portal/files?q=%25').expect(200);
    expect(wild.body.files).toEqual([]);
  });

  it('PDFs and pictures open in the browser; anything else downloads', async () => {
    const a = await w.member('a@example.test');
    const pdf = (await add(Buffer.from('%PDF'), 'r.pdf').expect(201)).body.fileId as string;
    const doc = (await add(Buffer.from('PK'), 'notes.docx').expect(201)).body.fileId as string;
    await show(pdf, { [a.id]: true });
    await show(doc, { [a.id]: true });

    const v = await a.agent.get(`/api/portal/files/${pdf}/content?mode=view`).expect(200);
    expect(v.headers['content-type']).toBe('application/pdf');
    expect(v.headers['content-disposition']).toMatch(/^inline; filename="r.pdf"/);
    expect(v.headers['content-security-policy']).toContain('sandbox');

    const d = await a.agent.get(`/api/portal/files/${doc}/content?mode=view`).expect(200);
    expect(d.headers['content-type']).toBe('application/octet-stream');
    expect(d.headers['content-disposition']).toMatch(/^attachment; filename="notes.docx"/);

    const listed = (await a.agent.get('/api/portal/files')).body.files;
    expect(
      Object.fromEntries(listed.map((f: { name: string; preview: string }) => [f.name, f.preview])),
    ).toEqual({ 'r.pdf': 'pdf', 'notes.docx': null });
  });

  it('keeps a non-ASCII file name for the download', async () => {
    const a = await w.member('a@example.test');
    const id = (await add(Buffer.from('x'), 'Résumé 2025.pdf').expect(201)).body.fileId as string;
    await show(id, { [a.id]: true });
    const d = await a.agent.get(`/api/portal/files/${id}/content`).expect(200);
    expect(d.headers['content-disposition']).toContain(
      "filename*=UTF-8''R%C3%A9sum%C3%A9%202025.pdf",
    );
  });
});

describe('gathered notifications (P18)', () => {
  it('several files to one person within 5 minutes: one message, no file names', async () => {
    const a = await w.member('a@example.test');
    for (const n of ['1.pdf', '2.pdf', '3.pdf']) {
      const id = (await add(Buffer.from(n), n).expect(201)).body.fileId as string;
      await show(id, { [a.id]: true });
      w.later(1);
    }
    const before = w.notes.sent.length;
    expect(await flush(w.ctx)).toBe(0);
    w.later(3);
    expect(await flush(w.ctx)).toBe(1);
    const msgs = w.notes.sent.slice(before);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.to).toBe('a@example.test');
    expect(msgs[0]?.subject).toBe('Example CPA has 3 new files for you');
    expect(msgs[0]?.body).not.toContain('.pdf');
    w.later(10);
    expect(await flush(w.ctx)).toBe(0);
  });

  it('a file hidden or removed before sending is not counted; "none" sends nothing', async () => {
    const a = await w.member('a@example.test');
    const b = await w.member('b@example.test');
    await w.t.db
      .update(schema.portalIdentity)
      .set({ notify: 'none' })
      .where(eq(schema.portalIdentity.id, b.id));
    const f1 = (await add(Buffer.from('1'), '1.pdf').expect(201)).body.fileId as string;
    const f2 = (await add(Buffer.from('2'), '2.pdf').expect(201)).body.fileId as string;
    await show(f1, { [a.id]: true, [b.id]: true });
    await show(f2, { [a.id]: true });
    await show(f1, { [a.id]: false });
    const before = w.notes.sent.length;
    w.later(6);
    await flush(w.ctx);
    const msgs = w.notes.sent.slice(before);
    expect(msgs).toEqual([expect.objectContaining({ to: 'a@example.test' })]);
    expect(msgs[0]?.subject).toBe('Example CPA has a new file for you');
    const pending = await w.t.db
      .select()
      .from(schema.notifyQueue)
      .where(and(eq(schema.notifyQueue.fileId, f1), eq(schema.notifyQueue.identityId, a.id)));
    expect(pending[0]?.droppedAt).not.toBeNull();
  });
});

describe('the key file (P28)', () => {
  it('a missing key file stops the portal with a clear message, never a new key', async () => {
    const { openKeyring } = await import('../files/keyring');
    await rm(join(w.dir, '.firm-key.seal'));
    await expect(openKeyring(w.t.db, w.dir)).rejects.toThrow(/key file .* is missing/);
    expect(await w.t.db.select().from(schema.firmKeyEnvelope)).toHaveLength(1);
  });
});

describe('a failed notice is retried (QA 2026-11-09)', () => {
  it('puts the notices back when sending fails, and sends them next time', async () => {
    const a = await w.member('a@example.test');
    const id = (await add(Buffer.from('1'), '1.pdf').expect(201)).body.fileId as string;
    await show(id, { [a.id]: true });
    w.later(6);
    const real = w.ctx.notifier;
    w.ctx.notifier = {
      send: async () => {
        throw new Error('smtp down');
      },
    };
    expect(await flush(w.ctx)).toBe(0);
    w.ctx.notifier = real;
    const before = w.notes.sent.length;
    w.later(1);
    expect(await flush(w.ctx)).toBe(1);
    expect(w.notes.sent.slice(before)).toEqual([expect.objectContaining({ to: 'a@example.test' })]);
  });
});

describe('for Vibe Files (Phase 6)', () => {
  it('lists every live file with all=1, and needs some filter', async () => {
    const a = await w.member('a@example.test');
    const f1 = (await add(Buffer.from('1'), '1.pdf').expect(201)).body.fileId as string;
    const f2 = (await add(Buffer.from('2'), '2.pdf', {}, OTHER).expect(201)).body.fileId as string;
    await show(f1, { [a.id]: true });
    await w.firm('delete', `/files/${f2}`).expect(200);
    const all = await w.firm('get', '/files?all=1').expect(200);
    expect(all.body.files.map((f: { fileId: string }) => f.fileId)).toEqual([f1]);
    await w.firm('get', '/files').expect(400);
  });

  it('gives the history after an id, with the cabinet document of each file event', async () => {
    const a = await w.member('a@example.test');
    const f = (await add(Buffer.from('%PDF'), 'r.pdf', { vfDocumentId: 'doc-77' }).expect(201)).body
      .fileId as string;
    await show(f, { [a.id]: true });
    await a.agent.get(`/api/portal/files/${f}/content?mode=view`).expect(200);
    const all = await w.firm('get', '/events?since=0').expect(200);
    const view = all.body.events.find((e: { kind: string }) => e.kind === 'view');
    expect(view).toMatchObject({
      fileId: f,
      vfDocumentId: 'doc-77',
      identityId: a.id,
      actorKind: 'client',
    });
    const later = await w.firm('get', `/events?since=${view.id}`).expect(200);
    expect(later.body.events.every((e: { id: number }) => e.id > view.id)).toBe(true);
    const page = await w.firm('get', '/events?since=0&limit=2').expect(200);
    expect(page.body.events).toHaveLength(2);
    expect(page.body.events[0].id).toBeLessThan(page.body.events[1].id);
  });
});
