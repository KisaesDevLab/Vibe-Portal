// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P91: staff put a document that is in Vibe Files' part of the B2 bucket on the portal. The
// bucket here was written by Vibe Files itself (fixtures/vf-bucket: its test
// `writes_a_bucket_for_the_portals_tests` in crates/vf-sync/tests/sync.rs, run with
// VF_PORTAL_FIXTURE set to that folder), so the portal's reader is checked against the real
// format, not against its own idea of it.

import { createHash, hkdfSync, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { schema } from '@vibe-portal/db';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MemoryObjects } from '../files/objects';
import { followB2, forgetCompared } from '../files/vf-follow';
import { content, find, open, unlock, VfError, type VfAccess } from '../files/vf-bucket';
import { createSetupLink } from '../staff/auth';
import { totpCode } from '../staff/credentials';
import { world, type World } from './harness';

const FIXTURE = join(__dirname, 'fixtures', 'vf-bucket');
interface Expect {
  passphrase: string;
  cabinetId: string;
  deletedDocId: string;
  clients: {
    id: string;
    code: string;
    name: string;
    docs: { docId: string; path: string; size: number; taxYear: number | null; content: string }[];
  }[];
}
const EXPECT = JSON.parse(readFileSync(join(FIXTURE, 'expect.json'), 'utf8')) as Expect;
const ANDERSON = EXPECT.clients.find((c) => c.code === '1042')!;
const W2 = ANDERSON.docs[0]!;

/** The fixture's bucket, as the portal's B2 bucket with Vibe Files' objects under "vf/". */
function vfBucket(): MemoryObjects {
  const b = new MemoryObjects();
  const root = join(FIXTURE, 'bucket', 'vf');
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else b.vfItems.set(relative(root, p).replace(/\\/g, '/'), readFileSync(p));
    }
  };
  walk(root);
  return b;
}

describe('reading Vibe Files’ part of the bucket (P91)', () => {
  it('opens what Vibe Files wrote, with the sync passphrase', async () => {
    const bucket = vfBucket();
    const access = await unlock(bucket, EXPECT.passphrase);
    expect(access.cabinetId).toBe(EXPECT.cabinetId);
    expect(Object.keys(access.keys)).toHaveLength(1);
    for (const c of EXPECT.clients) {
      for (const d of c.docs) {
        const doc = await find(bucket, access, c.id.toUpperCase(), d.docId);
        expect(doc).toEqual(
          expect.objectContaining({
            name: d.path.slice(d.path.lastIndexOf('/') + 1),
            size: d.size,
            taxYear: d.taxYear,
            sha256: createHash('sha256').update(d.content).digest('hex'),
          }),
        );
        expect((await content(bucket, access, doc)).toString('utf8')).toBe(d.content);
      }
    }
  });

  it('refuses a wrong passphrase, a deleted document and a changed object', async () => {
    const bucket = vfBucket();
    await expect(unlock(bucket, 'not the passphrase')).rejects.toMatchObject({
      code: 'vf_wrong_passphrase',
    });
    await expect(unlock(new MemoryObjects(), EXPECT.passphrase)).rejects.toMatchObject({
      code: 'vf_no_cabinet',
    });
    // Another cabinet in the bucket whose key asks for a cost the portal does not run (a
    // trial's leftover, or planted), listed first: passed over, and the real one still opens.
    const real = JSON.parse(
      bucket.vfItems.get(`${EXPECT.cabinetId}/cabinet.json`)!.toString('utf8'),
    ) as { cabinet_id: string; wrapped: Record<string, { params: { m_kib: number; t: number } }> };
    const stray = structuredClone(real);
    stray.cabinet_id = '00000000-0000-4000-8000-000000000000';
    stray.wrapped['k-01']!.params = { ...stray.wrapped['k-01']!.params, m_kib: 1024 * 1024, t: 1 };
    const both = new MemoryObjects();
    both.vfItems.set(`${stray.cabinet_id}/cabinet.json`, Buffer.from(JSON.stringify(stray)));
    for (const [k, v] of bucket.vfItems) both.vfItems.set(k, v);
    expect((await unlock(both, EXPECT.passphrase)).cabinetId).toBe(EXPECT.cabinetId);
    // Only that one: the portal says it cannot read it, not that the passphrase is wrong.
    const only = new MemoryObjects();
    only.vfItems.set(`${stray.cabinet_id}/cabinet.json`, Buffer.from(JSON.stringify(stray)));
    await expect(unlock(only, EXPECT.passphrase)).rejects.toMatchObject({ code: 'vf_format' });
    const access = await unlock(bucket, EXPECT.passphrase);
    // Deleted in the cabinet since it was pushed: the manifest has its tombstone.
    await expect(find(bucket, access, ANDERSON.id, EXPECT.deletedDocId)).rejects.toMatchObject({
      code: 'vf_gone',
    });
    await expect(find(bucket, access, ANDERSON.id, 'no-such-document')).rejects.toBeInstanceOf(
      VfError,
    );
    const doc = await find(bucket, access, ANDERSON.id, W2.docId);
    const key = `${EXPECT.cabinetId}/${doc.objectKey}`;
    const body = Buffer.from(bucket.vfItems.get(key)!);
    body[body.length - 1]! ^= 1;
    bucket.vfItems.set(key, body);
    await expect(content(bucket, access, doc)).rejects.toMatchObject({ code: 'vf_damaged' });
    // A key the portal was not given (made since the passphrase was entered).
    await expect(content(bucket, { ...access, keys: {} }, doc)).rejects.toMatchObject({
      code: 'vf_key',
    });
    // The cabinet's sync key made anew since (Vibe Files names every key "k-01"): the
    // manifest's head no longer opens, and the passphrase is to be entered again.
    const other = { ...access, keys: { 'k-01': 'ab'.repeat(32) } };
    await expect(find(bucket, other, ANDERSON.id, W2.docId)).rejects.toMatchObject({
      code: 'vf_key',
    });
    // An object far larger than the manifest says its document is, is not read into memory.
    bucket.vfItems.set(key, Buffer.alloc(doc.size + 5000));
    await expect(content(bucket, access, doc)).rejects.toMatchObject({ code: 'vf_damaged' });
    bucket.vfItems.delete(key);
    await expect(content(bucket, access, doc)).rejects.toMatchObject({ code: 'vf_missing' });
  });
});

/** Seals as Vibe Files does (the reader above is checked against Vibe Files' own sealing):
 *  for what Vibe Files would push next, which the fixture does not hold. */
function seal(access: VfAccess, plain: Buffer, key: string): Buffer {
  const [keyId, firm] = Object.entries(access.keys)[0]!;
  const k = Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(firm, 'hex'),
      Buffer.from('vibe-files sync v1'),
      Buffer.from('content'),
      32,
    ),
  );
  const nonce = randomBytes(24);
  const id = Buffer.from(keyId, 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16LE(id.length);
  return Buffer.concat([
    Buffer.from('VF1\0', 'latin1'),
    len,
    id,
    nonce,
    xchacha20poly1305(k, nonce, Buffer.from(key, 'utf8')).encrypt(plain),
  ]);
}

/** Vibe Files pushes a changed version of one document: a new object, a new segment for the
 *  client, a new head. */
function pushChange(
  bucket: MemoryObjects,
  access: VfAccess,
  clientId: string,
  docId: string,
  body: string,
  rename?: string,
): void {
  const at = (k: string): string => `${access.cabinetId}/${k}`;
  const head = JSON.parse(
    open(access, bucket.vfItems.get(at('manifest/HEAD'))!, 'manifest/HEAD').toString(),
  ) as {
    rev: number;
    segments: Record<string, number>;
    segment_writers: Record<string, string>;
  };
  const old = `manifest/clients/${clientId}/${head.segments[clientId]}-${head.segment_writers[clientId]}`;
  const seg = JSON.parse(open(access, bucket.vfItems.get(at(old))!, old).toString()) as {
    segment_rev: number;
    documents: { doc_id: string; rel_path: string; hash: string; object: string; size: number }[];
  };
  const plain = Buffer.from(body);
  const d = seg.documents.find((x) => x.doc_id === docId)!;
  d.hash = createHash('sha256').update(plain).digest('hex');
  d.object = createHash('sha256').update(`name ${d.hash}`).digest('hex');
  d.size = plain.length;
  if (rename) d.rel_path = d.rel_path.replace(/[^/]+$/, rename);
  const object = `objects/${d.object.slice(0, 2)}/${d.object}`;
  bucket.vfItems.set(at(object), seal(access, plain, object));
  head.rev += 1;
  head.segments[clientId] = head.rev;
  seg.segment_rev = head.rev;
  const next = `manifest/clients/${clientId}/${head.rev}-${head.segment_writers[clientId]}`;
  bucket.vfItems.set(at(next), seal(access, Buffer.from(JSON.stringify(seg)), next));
  bucket.vfItems.set(
    at('manifest/HEAD'),
    seal(access, Buffer.from(JSON.stringify(head)), 'manifest/HEAD'),
  );
}

const B2 = {
  endpoint: 'https://s3.us-west-004.backblazeb2.com',
  bucket: 'example-cpa-portal',
  keyId: '004a1b2c3d4e5f60000000001',
  appKey: 'K004SuperSecretApplicationKeyValue',
};
type Agent = ReturnType<typeof request.agent>;

describe('a document in B2 put on the portal from the staff page (P91)', () => {
  let w: World;
  let bucket: MemoryObjects;
  beforeEach(async () => {
    w = await world();
    bucket = vfBucket();
    w.ctx.openB2 = () => bucket;
  });
  afterEach(async () => {
    await w.close();
  });

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

  /** Vibe Files lists the client's documents in B2, as it does every ten minutes. */
  async function listed(): Promise<void> {
    const files = [
      ...ANDERSON.docs.map(({ docId, path, size, taxYear }) => ({ docId, path, size, taxYear })),
      // Still on the list of a PC that has not heard it was deleted.
      {
        docId: EXPECT.deletedDocId,
        path: 'Permanent/Setup/EIN letter.pdf',
        size: 12,
        taxYear: null,
      },
    ];
    await w
      .firm('put', `/cabinet/${ANDERSON.id}`)
      .send({
        clientCode: ANDERSON.code,
        displayName: ANDERSON.name,
        rev: 2,
        headRev: 2,
        hash: 'h',
        files,
      })
      .expect(200);
  }

  const add = (a: Agent, docId: string) =>
    a.post(`/api/staff/v1/clients/${ANDERSON.id}/cabinet-files/${docId}`);

  it('needs the bucket and the passphrase, then adds the document, shown to nobody', async () => {
    const boss = await admin();
    await listed();
    let list = await boss.get(`/api/staff/v1/clients/${ANDERSON.id}/cabinet-files`).expect(200);
    expect(list.body.canAdd).toBe(false);
    expect((await add(boss, W2.docId)).body).toEqual({ error: 'vf_not_set_up' });

    // The passphrase needs the bucket first, and is checked against it.
    const early = await boss
      .put('/api/staff/v1/settings/storage/vibe-files')
      .send({ passphrase: EXPECT.passphrase });
    expect([early.status, early.body]).toEqual([400, { error: 'b2_not_set_up' }]);
    await boss.put('/api/staff/v1/settings/storage/b2').send(B2).expect(200);
    const wrong = await boss
      .put('/api/staff/v1/settings/storage/vibe-files')
      .send({ passphrase: 'not the passphrase' });
    expect([wrong.status, wrong.body]).toEqual([400, { error: 'vf_wrong_passphrase' }]);
    const saved = await boss
      .put('/api/staff/v1/settings/storage/vibe-files')
      .send({ passphrase: EXPECT.passphrase })
      .expect(200);
    expect(saved.body.vibeFiles).toEqual({
      cabinetId: EXPECT.cabinetId,
      own: false,
      endpoint: 's3.us-west-004.backblazeb2.com',
      bucket: B2.bucket,
      keyId: B2.keyId,
    });
    // Neither the passphrase nor the key goes back to the page or into History.
    expect(JSON.stringify(saved.body)).not.toContain(EXPECT.passphrase);
    const events = await w.t.db.select().from(schema.events);
    expect(JSON.stringify(events)).not.toContain(EXPECT.passphrase);
    expect(events.map((e) => e.kind)).toContain('storage_vf_saved');

    list = await boss.get(`/api/staff/v1/clients/${ANDERSON.id}/cabinet-files`).expect(200);
    expect(list.body.canAdd).toBe(true);

    const made = await add(boss, W2.docId);
    expect([made.status, Object.keys(made.body)]).toEqual([201, ['fileId']]);
    const files = await boss.get(`/api/staff/v1/files?clientId=${ANDERSON.id}`).expect(200);
    expect(files.body.files).toEqual([
      expect.objectContaining({
        fileId: made.body.fileId,
        vfDocumentId: W2.docId,
        name: 'W-2 Northwind.pdf',
        size: W2.size,
        taxYear: 2025,
        sha256: createHash('sha256').update(W2.content).digest('hex'),
        sharedBy: 'kurt@example-cpa.test',
        users: [],
      }),
    ]);
    // The portal's own copy opens: what the client's people would get.
    const [row] = await w.t.db.select().from(schema.files);
    const parts: Buffer[] = [];
    const dek = w.ctx.keyring.unwrap(new Uint8Array(row!.dekWrapped!));
    for await (const c of w.ctx.blobs.get(row!.blobKey!, dek)) parts.push(c as Buffer);
    expect(Buffer.concat(parts).toString('utf8')).toBe(W2.content);
    // The list says it is on the portal; Vibe Files finds it by the document's id.
    list = await boss.get(`/api/staff/v1/clients/${ANDERSON.id}/cabinet-files`).expect(200);
    expect(
      (list.body.files as { docId: string; fileId: string | null }[]).find(
        (f) => f.docId === W2.docId,
      )?.fileId,
    ).toBe(made.body.fileId);
    const byDoc = await w.firm('get', `/files?vfDocumentId=${W2.docId}`).expect(200);
    expect(byDoc.body.files).toHaveLength(1);

    // Again: the same file, nothing new.
    const again = await add(boss, W2.docId);
    expect([again.status, again.body]).toEqual([200, { fileId: made.body.fileId, existing: true }]);
    const added = (await w.t.db.select().from(schema.events)).filter(
      (e) => e.kind === 'file_added',
    );
    expect(added).toHaveLength(1);
    expect(added[0]!.actor).toBe('kurt@example-cpa.test');

    // Deleted in the cabinet since the list was sent; not on the list at all; only Vibe Files'
    // own key cannot do this.
    const gone = await add(boss, EXPECT.deletedDocId);
    expect([gone.status, gone.body]).toEqual([409, { error: 'vf_gone' }]);
    expect((await add(boss, 'never-listed')).body).toEqual({ error: 'vf_unlisted' });
    await w.firm('post', `/clients/${ANDERSON.id}/cabinet-files/${W2.docId}`).expect(404);

    // A staff member who is not an admin adds documents, and does not touch the passphrase.
    // (Kept to their clients by the same guard as the rest of a client's page, P48.)
    const users = await boss.get(`/api/staff/v1/clients/${ANDERSON.id}/users`).expect(200);
    expect(users.body.users).toEqual([]);

    // Another bucket: the key was checked against the old one, so it is forgotten, and said.
    await boss
      .put('/api/staff/v1/settings/storage/b2')
      .send({ ...B2, bucket: 'example-cpa-other' })
      .expect(200);
    const moved = await boss.get('/api/staff/v1/settings/storage').expect(200);
    expect(moved.body.vibeFiles).toBeNull();
    const kinds = (await w.t.db.select().from(schema.events)).map((e) => e.kind);
    expect(kinds).toContain('storage_vf_removed');
    await boss
      .put('/api/staff/v1/settings/storage/vibe-files')
      .send({ passphrase: EXPECT.passphrase })
      .expect(200);

    // The passphrase removed: nothing more is read.
    const off = await boss.delete('/api/staff/v1/settings/storage/vibe-files').expect(200);
    expect(off.body.vibeFiles).toBeNull();
    expect((await add(boss, EXPECT.deletedDocId)).body).toEqual({ error: 'vf_not_set_up' });
  });

  it('reads a bucket of Vibe Files’ own (one with Object Lock), with no bucket for the portal (P94)', async () => {
    const boss = await admin();
    await listed();
    // Object Lock: the portal would refuse it for its own files; it is only read here.
    bucket.locked = true;
    const own = { ...B2, bucket: 'example-cpa-vibe-files' };
    const bad = await boss
      .put('/api/staff/v1/settings/storage/vibe-files')
      .send({
        passphrase: EXPECT.passphrase,
        bucket: { ...own, endpoint: 'https://s3.amazonaws.com' },
      });
    expect(bad.body).toEqual({ error: 'b2_endpoint' });
    // A space pasted after the passphrase: taken as typed first, then without it.
    const saved = await boss
      .put('/api/staff/v1/settings/storage/vibe-files')
      .send({ passphrase: `${EXPECT.passphrase} `, bucket: own })
      .expect(200);
    expect(saved.body.vibeFiles).toEqual({
      cabinetId: EXPECT.cabinetId,
      own: true,
      endpoint: 's3.us-west-004.backblazeb2.com',
      bucket: own.bucket,
      keyId: own.keyId,
    });
    expect(JSON.stringify(saved.body)).not.toContain(own.appKey);
    // Nothing was written to Vibe Files' bucket: no test file, no mark of the portal's.
    expect(bucket.items.size).toBe(0);
    expect(bucket.noteItems.size).toBe(0);
    expect(saved.body.b2.hasKey).toBe(false);
    await add(boss, W2.docId).expect(201);

    // The portal's own bucket set up, changed and removed since: Vibe Files' stays.
    bucket.locked = false;
    await boss.put('/api/staff/v1/settings/storage/b2').send(B2).expect(200);
    await boss
      .put('/api/staff/v1/settings/storage/b2')
      .send({ ...B2, bucket: 'example-cpa-other' })
      .expect(200);
    await boss.delete('/api/staff/v1/settings/storage/b2').expect(200);
    const after = await boss.get('/api/staff/v1/settings/storage').expect(200);
    expect(after.body.vibeFiles.bucket).toBe(own.bucket);
    const kinds = (await w.t.db.select().from(schema.events)).map((e) => e.kind);
    expect(kinds).not.toContain('storage_vf_removed');
  });

  it('a file added from B2 is replaced by itself when the bucket has a changed version (P94)', async () => {
    forgetCompared();
    const boss = await admin();
    await listed();
    await boss.put('/api/staff/v1/settings/storage/b2').send(B2).expect(200);
    await boss
      .put('/api/staff/v1/settings/storage/vibe-files')
      .send({ passphrase: EXPECT.passphrase })
      .expect(200);
    const mary = await w.member('mary@example.test', ANDERSON.id);
    const fileId = (await add(boss, W2.docId).expect(201)).body.fileId as string;
    await boss
      .put(`/api/staff/v1/files/${fileId}/visibility`)
      .send({ users: { [mary.id]: true } })
      .expect(200);
    // Mary opens it: no longer new for her.
    await mary.agent.get(`/api/portal/files/${fileId}/content`).expect(200);
    const hers = async (): Promise<{ name: string; isNew: boolean; size: number }> =>
      (await mary.agent.get('/api/portal/files').expect(200)).body.files[0];
    expect((await hers()).isNew).toBe(false);

    // Nothing changed in the bucket: nothing is replaced, and a second look reads nothing more.
    expect(await followB2(w.ctx)).toEqual({ updated: 0, failed: 0 });

    // Vibe Files pushes a corrected W-2 under a new name.
    const access = await unlock(bucket, EXPECT.passphrase);
    pushChange(
      bucket,
      access,
      ANDERSON.id,
      W2.docId,
      'w2 2025 corrected',
      'W-2 Northwind corrected.pdf',
    );
    expect(await followB2(w.ctx)).toEqual({ updated: 1, failed: 0 });
    expect(await hers()).toEqual(
      expect.objectContaining({ name: 'W-2 Northwind corrected.pdf', isNew: true, size: 17 }),
    );
    const got = await mary.agent.get(`/api/portal/files/${fileId}/content`).expect(200);
    expect(Buffer.from(got.body as Buffer).toString('utf8') || got.text).toContain(
      'w2 2025 corrected',
    );
    const replaced = (await w.t.db.select().from(schema.events)).filter(
      (e) => e.kind === 'replace',
    );
    expect(replaced).toHaveLength(1);
    expect(replaced[0]).toEqual(
      expect.objectContaining({ actorKind: 'system', actor: 'Vibe Files’ B2', fileId }),
    );
    // The old stored copy is gone: one blob for one file.
    expect((await w.t.db.select().from(schema.files)).filter((f) => f.blobKey)).toHaveLength(1);
    // Looked at again with nothing new: nothing happens.
    expect(await followB2(w.ctx)).toEqual({ updated: 0, failed: 0 });
    expect(
      (await w.t.db.select().from(schema.events)).filter((e) => e.kind === 'replace'),
    ).toHaveLength(1);

    // A file shared from Vibe Files itself does not follow the bucket: Vibe Files replaces it.
    const [row] = await w.t.db.select().from(schema.files);
    await w.t.db.update(schema.files).set({ fromB2: false });
    pushChange(bucket, access, ANDERSON.id, W2.docId, 'w2 2025 corrected again');
    expect(await followB2(w.ctx)).toEqual({ updated: 0, failed: 0 });
    await w.t.db.update(schema.files).set({ fromB2: true });

    // The changed object damaged in the bucket: not taken, said in the log, tried again.
    forgetCompared();
    const doc = await find(bucket, access, ANDERSON.id, W2.docId);
    const key = `${EXPECT.cabinetId}/${doc.objectKey}`;
    const good = bucket.vfItems.get(key)!;
    const broken = Buffer.from(good);
    broken[broken.length - 1]! ^= 1;
    bucket.vfItems.set(key, broken);
    expect(await followB2(w.ctx)).toEqual({ updated: 0, failed: 1 });
    expect((await w.t.db.select().from(schema.files))[0]!.sha256).toBe(row!.sha256);
    bucket.vfItems.set(key, good);
    expect(await followB2(w.ctx)).toEqual({ updated: 1, failed: 0 });

    // Removed from the portal: it follows nothing any more.
    await boss.delete(`/api/staff/v1/files/${fileId}`).expect(200);
    pushChange(bucket, access, ANDERSON.id, W2.docId, 'w2 2025 once more');
    expect(await followB2(w.ctx)).toEqual({ updated: 0, failed: 0 });
  });

  it('refuses a document larger than the portal takes, before fetching it', async () => {
    const boss = await admin();
    await listed();
    await boss.put('/api/staff/v1/settings/storage/b2').send(B2).expect(200);
    await boss
      .put('/api/staff/v1/settings/storage/vibe-files')
      .send({ passphrase: EXPECT.passphrase })
      .expect(200);
    await w.t.db.update(schema.firm).set({ uploadLimitBytes: 4 });
    const res = await add(boss, W2.docId);
    expect([res.status, res.body]).toEqual([413, { error: 'vf_too_large' }]);
    expect(await w.t.db.select().from(schema.files)).toHaveLength(0);
  });
});
