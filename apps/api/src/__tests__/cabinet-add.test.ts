// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P91: staff put a document that is in Vibe Files' part of the B2 bucket on the portal. The
// bucket here was written by Vibe Files itself (fixtures/vf-bucket: its test
// `writes_a_bucket_for_the_portals_tests` in crates/vf-sync/tests/sync.rs, run with
// VF_PORTAL_FIXTURE set to that folder), so the portal's reader is checked against the real
// format, not against its own idea of it.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { schema } from '@vibe-portal/db';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MemoryObjects } from '../files/objects';
import { content, find, unlock, VfError } from '../files/vf-bucket';
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
    bucket.vfItems.delete(key);
    await expect(content(bucket, access, doc)).rejects.toMatchObject({ code: 'vf_missing' });
  });
});

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
    expect(saved.body.vibeFiles).toEqual({ cabinetId: EXPECT.cabinetId });
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
