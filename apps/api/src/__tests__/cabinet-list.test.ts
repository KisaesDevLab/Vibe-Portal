// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// The list of documents Vibe Files sent to its B2 bucket (P90): sent by Vibe Files alone, kept
// by client, shown to staff; a list made from an older state of the bucket is not taken.

import { createHash, randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { schema } from '@vibe-portal/db';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CABINET_FILES_MAX, CABINET_PATH_MAX } from '../firm/cabinet';
import { createSetupLink } from '../staff/auth';
import { totpCode } from '../staff/credentials';
import { CLIENT, OTHER, world, type World } from './harness';

let w: World;
beforeEach(async () => {
  w = await world();
});
afterEach(async () => {
  await w.close();
});

const NEW = '33333333-3333-4333-8333-333333333333';
const PASSWORD = 'a long staff password';
type Agent = ReturnType<typeof request.agent>;

async function finish(link: string, email?: string): Promise<Agent> {
  const token = /#t=([\w-]+)/.exec(link)?.[1] ?? '';
  const agent = request.agent(w.app);
  const set = await agent
    .post('/api/staff/auth/setup')
    .send({ token, ...(email ? { email, name: 'Kurt' } : {}), password: PASSWORD })
    .expect(200);
  await agent
    .post('/api/staff/auth/setup/confirm')
    .send({ token, code: totpCode(set.body.secret as string, w.ctx.now()) })
    .expect(200);
  return agent;
}

const admin = async (): Promise<Agent> =>
  finish(await createSetupLink(w.ctx, null, 'appliance'), 'kurt@example-cpa.test');

const file = (docId: string, path: string, taxYear: number | null = 2025, size = 100) => ({
  docId,
  path,
  size,
  taxYear,
});

function list(
  files: ReturnType<typeof file>[],
  more: { rev?: number; headRev?: number; hash?: string; displayName?: string } = {},
) {
  return {
    clientCode: '3003',
    displayName: more.displayName ?? 'Garcia, Ana',
    rev: more.rev ?? 1,
    headRev: more.headRev ?? 1,
    hash: more.hash ?? createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    files,
  };
}

const kinds = async (): Promise<string[]> =>
  (await w.t.db.select().from(schema.events)).map((e) => e.kind);

describe('the list of documents in Vibe Files’ B2 bucket (P90)', () => {
  it('makes a client by its first list and shows the list to staff', async () => {
    const files = [
      file('d2', 'Income Tax/2025/W-2.pdf'),
      file('d1', 'Income Tax/2025/1040.pdf'),
      file('d3', 'Permanent/Setup/EIN letter.pdf', null, 5),
    ];
    const put = await w.firm('put', `/cabinet/${NEW}`).send(list(files));
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body).toEqual({ ok: true });

    const a = await admin();
    const clients = await a.get('/api/staff/v1/clients').expect(200);
    const row = (clients.body.clients as { id: string }[]).find((c) => c.id === NEW);
    expect(row).toEqual(
      expect.objectContaining({
        displayName: 'Garcia, Ana',
        clientCode: '3003',
        active: true,
        cabinetFiles: 3,
        cabinetListed: true,
        files: 0,
        users: 0,
      }),
    );
    const got = await a.get(`/api/staff/v1/clients/${NEW}/cabinet-files`).expect(200);
    expect(got.body.listedAt).toBeTruthy();
    // By place in the folder; nothing is on the portal yet.
    expect(got.body.files).toEqual([
      { docId: 'd1', path: 'Income Tax/2025/1040.pdf', size: 100, taxYear: 2025, fileId: null },
      { docId: 'd2', path: 'Income Tax/2025/W-2.pdf', size: 100, taxYear: 2025, fileId: null },
      { docId: 'd3', path: 'Permanent/Setup/EIN letter.pdf', size: 5, taxYear: null, fileId: null },
    ]);
    // History has the client's making, and no file name anywhere.
    const events = await w.t.db.select().from(schema.events);
    const made = events.filter((e) => e.kind === 'client_updated' && e.clientId === NEW);
    expect(made).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('W-2');
  });

  it('marks a listed document that is shared on the portal', async () => {
    const doc = randomUUID();
    await w
      .firm('put', `/cabinet/${CLIENT}`)
      .send({ ...list([file(doc, 'Income Tax/2025/1040.pdf')]), displayName: 'Smith, John' })
      .expect(200);
    const bytes = Buffer.from('%PDF return');
    const sha = createHash('sha256').update(bytes).digest('hex');
    const shared = await w
      .firm('post', `/files?clientId=${CLIENT}&vfDocumentId=${doc}&name=1040.pdf&sha256=${sha}`)
      .set('Content-Type', 'application/octet-stream')
      .send(bytes)
      .expect(201);
    const got = await w.firm('get', `/clients/${CLIENT}/cabinet-files`).expect(200);
    expect(got.body.files[0].fileId).toBe(shared.body.fileId);
    // Removed from the portal: listed still, shared no longer.
    await w.firm('delete', `/files/${shared.body.fileId as string}`).expect(200);
    const after = await w.firm('get', `/clients/${CLIENT}/cabinet-files`).expect(200);
    expect(after.body.files[0].fileId).toBeNull();
  });

  it('replaces a list when it changed, and writes nothing when it did not', async () => {
    const one = list([file('d1', 'A/a.pdf')], { rev: 1 });
    await w.firm('put', `/cabinet/${NEW}`).send(one).expect(200);
    const [first] = await w.t.db.select().from(schema.clients).where(eq(schema.clients.id, NEW));
    w.later(10);
    // The same list again: nothing changes, and History gains nothing.
    const before = (await kinds()).length;
    await w.firm('put', `/cabinet/${NEW}`).send(one).expect(200);
    const [same] = await w.t.db.select().from(schema.clients).where(eq(schema.clients.id, NEW));
    expect(same?.cabinetListedAt).toEqual(first?.cabinetListedAt);
    expect((await kinds()).length).toBe(before);
    // A newer list replaces it whole.
    await w
      .firm('put', `/cabinet/${NEW}`)
      .send(list([file('d2', 'B/b.pdf'), file('d3', 'B/c.pdf')], { rev: 2, headRev: 2 }))
      .expect(200);
    const got = await w.firm('get', `/clients/${NEW}/cabinet-files`).expect(200);
    expect((got.body.files as { docId: string }[]).map((f) => f.docId)).toEqual(['d2', 'd3']);
    const state = await w.firm('get', '/cabinet').expect(200);
    expect(state.body.max).toBe(CABINET_FILES_MAX);
    expect(state.body.clients).toEqual([expect.objectContaining({ id: NEW, rev: 2, headRev: 2 })]);
  });

  it('does not take a list made from an older state of the bucket', async () => {
    await w
      .firm('put', `/cabinet/${NEW}`)
      .send(list([file('d1', 'A/new.pdf')], { rev: 5, headRev: 9 }))
      .expect(200);
    const old = await w
      .firm('put', `/cabinet/${NEW}`)
      .send(list([file('d0', 'A/old.pdf')], { rev: 4, headRev: 4, displayName: 'Old name' }))
      .expect(200);
    expect(old.body).toEqual({ ok: true, kept: true });
    const got = await w.firm('get', `/clients/${NEW}/cabinet-files`).expect(200);
    expect((got.body.files as { docId: string }[]).map((f) => f.docId)).toEqual(['d1']);
    const [c] = await w.t.db.select().from(schema.clients).where(eq(schema.clients.id, NEW));
    expect(c?.displayName).toBe('Garcia, Ana');
    // Nor does a PC that has seen less clear the list of a client it does not know.
    const gone = await w.firm('delete', `/cabinet/${NEW}?headRev=8`).expect(200);
    expect(gone.body).toEqual({ ok: true, kept: true });
    // One that has seen as much does; the client stays.
    await w.firm('delete', `/cabinet/${NEW}?headRev=9`).expect(200);
    const after = await w.firm('get', `/clients/${NEW}/cabinet-files`).expect(200);
    expect(after.body).toEqual({ listedAt: null, files: [] });
    // The portal remembers the clearing and how much its sender had seen: a PC that has
    // seen less cannot bring the list back; one that has seen as much can.
    expect((await w.firm('get', '/cabinet').expect(200)).body.clients).toEqual([
      { id: NEW, rev: null, headRev: 9, hash: null, by: null },
    ]);
    const back = await w
      .firm('put', `/cabinet/${NEW}`)
      .send(list([file('d0', 'A/old.pdf')], { rev: 5, headRev: 8 }))
      .expect(200);
    expect(back.body).toEqual({ ok: true, kept: true });
    expect((await w.firm('get', `/clients/${NEW}/cabinet-files`).expect(200)).body.files).toEqual(
      [],
    );
    await w
      .firm('put', `/cabinet/${NEW}`)
      .send(list([file('d7', 'A/again.pdf')], { rev: 1, headRev: 9 }))
      .expect(200);
    const again = await w.firm('get', `/clients/${NEW}/cabinet-files`).expect(200);
    expect((again.body.files as { docId: string }[]).map((f) => f.docId)).toEqual(['d7']);
  });

  it('renames a client it already has, and leaves one switched off as it is', async () => {
    await w
      .firm('put', `/clients/${CLIENT}`)
      .send({ clientCode: '1001', displayName: 'Smith, John', active: false })
      .expect(200);
    await w
      .firm('put', `/cabinet/${CLIENT}`)
      .send({ ...list([file('d1', 'A/a.pdf')]), clientCode: '1001', displayName: 'Smith, Jon' })
      .expect(200);
    const [c] = await w.t.db.select().from(schema.clients).where(eq(schema.clients.id, CLIENT));
    expect(c).toEqual(expect.objectContaining({ displayName: 'Smith, Jon', active: false }));
    // Renamed since on the portal (a share from Vibe Files does that). A PC whose catalog still
    // has the old name sends its list of the same segment: the name stays, History gains nothing.
    await w
      .firm('put', `/clients/${CLIENT}`)
      .send({ clientCode: '1001', displayName: 'Smith, Jonathan' })
      .expect(200);
    const before = (await kinds()).length;
    await w
      .firm('put', `/cabinet/${CLIENT}`)
      .send({
        ...list([file('d1', 'A/a.pdf'), file('d2', 'A/b.pdf')]),
        clientCode: '1001',
        displayName: 'Smith, Jon',
      })
      .expect(200);
    const [same] = await w.t.db.select().from(schema.clients).where(eq(schema.clients.id, CLIENT));
    expect(same).toEqual(
      expect.objectContaining({ displayName: 'Smith, Jonathan', cabinetCount: 2 }),
    );
    expect((await kinds()).length).toBe(before);
    // A list made from a newer segment carries the cabinet's name.
    await w
      .firm('put', `/cabinet/${CLIENT}`)
      .send({
        ...list([file('d1', 'A/a.pdf')], { rev: 2, headRev: 2 }),
        clientCode: '1001',
        displayName: 'Smith, J.',
      })
      .expect(200);
    const [newer] = await w.t.db.select().from(schema.clients).where(eq(schema.clients.id, CLIENT));
    expect(newer?.displayName).toBe('Smith, J.');
    // A list always says the client's ID: one that leaves it out is refused, not taken as none.
    const { clientCode: _none, ...without } = list([file('d1', 'A/a.pdf')], { rev: 3 });
    await w.firm('put', `/cabinet/${CLIENT}`).send(without).expect(400);
  });

  it('keeps one list when two PCs at the same segment send different ones', async () => {
    const from = (pc: string, hash: string, doc: string) =>
      w
        .firm('put', `/cabinet/${NEW}`)
        .set('X-Vibe-PC', pc)
        .set('X-Vibe-User', 'kurt')
        .send(list([file(doc, `A/${doc}.pdf`)], { rev: 5, headRev: 5, hash }));
    const docs = async (): Promise<string[]> =>
      (
        (await w.firm('get', `/clients/${NEW}/cabinet-files`).expect(200)).body.files as {
          docId: string;
        }[]
      ).map((f) => f.docId);
    expect((await from('PC-A', 'mmm', 'a1').expect(200)).body).toEqual({ ok: true });
    // Another PC, the same segment, a list whose mark sorts before the kept one: not taken.
    expect((await from('PC-B', 'ccc', 'b1').expect(200)).body).toEqual({ ok: true, kept: true });
    expect(await docs()).toEqual(['a1']);
    // One whose mark sorts after is taken, and then the first PC's is not: no back and forth.
    expect((await from('PC-B', 'zzz', 'b2').expect(200)).body).toEqual({ ok: true });
    expect((await from('PC-A', 'mmm', 'a1').expect(200)).body).toEqual({ ok: true, kept: true });
    expect(await docs()).toEqual(['b2']);
    // The PC whose list is kept may change it, whatever the mark (a detail it changed).
    expect((await from('PC-B', 'bbb', 'b3').expect(200)).body).toEqual({ ok: true });
    expect(await docs()).toEqual(['b3']);
    expect((await w.firm('get', '/cabinet').expect(200)).body.clients).toEqual([
      { id: NEW, rev: 5, headRev: 5, hash: 'bbb', by: 'PC-B\\kurt' },
    ]);
    // A newer segment from any PC replaces it.
    await w
      .firm('put', `/cabinet/${NEW}`)
      .set('X-Vibe-PC', 'PC-A')
      .set('X-Vibe-User', 'kurt')
      .send(list([file('a9', 'A/a9.pdf')], { rev: 6, headRev: 6, hash: 'aaa' }))
      .expect(200);
    expect(await docs()).toEqual(['a9']);
  });

  it('remembers a clearing even with no list to clear, and takes only a plain number for it', async () => {
    for (const bad of ['', '1e30', '-1', '1.5', '99999999999999999', 'x']) {
      await w.firm('delete', `/cabinet/${CLIENT}?headRev=${bad}`).expect(400);
    }
    await w.firm('delete', `/cabinet/${CLIENT}`).expect(400);
    // The harness's client has no list: the clearing is remembered all the same.
    expect((await w.firm('delete', `/cabinet/${CLIENT}?headRev=7`).expect(200)).body).toEqual({
      ok: true,
    });
    const late = await w
      .firm('put', `/cabinet/${CLIENT}`)
      .send({
        ...list([file('d1', 'A/a.pdf')], { rev: 3, headRev: 6 }),
        displayName: 'Smith, John',
      })
      .expect(200);
    expect(late.body).toEqual({ ok: true, kept: true });
    // A client the portal does not have: nothing to do, nothing made.
    await w.firm('delete', `/cabinet/${NEW}?headRev=7`).expect(200);
    expect(await w.t.db.select().from(schema.clients).where(eq(schema.clients.id, NEW))).toEqual(
      [],
    );
    // Unticked and ticked again: what clearings remembered is gone, every PC starts afresh.
    expect((await w.firm('delete', '/cabinet').expect(200)).body).toEqual({ ok: true, clients: 0 });
    expect((await w.firm('get', '/cabinet').expect(200)).body.clients).toEqual([]);
    const fresh = await w
      .firm('put', `/cabinet/${CLIENT}`)
      .send({
        ...list([file('d1', 'A/a.pdf')], { rev: 3, headRev: 6 }),
        displayName: 'Smith, John',
      })
      .expect(200);
    expect(fresh.body).toEqual({ ok: true });
  });

  it('reads a large list only for a caller with the firm key', async () => {
    const big = list(
      Array.from({ length: 3000 }, (_, i) =>
        file(`d${i}`, `Income Tax/2025/${'x'.repeat(60)}${i}`),
      ),
      { hash: 'h' },
    );
    expect(JSON.stringify(big).length).toBeGreaterThan(200_000);
    // No key: refused for the key, the body never read (it is over what any other route takes).
    const none = await request(w.app).put(`/api/firm/v1/cabinet/${NEW}`).send(big);
    expect(none.status).toBe(401);
    const upper = await request(w.app).put(`/API/Firm/V1/Cabinet/${NEW}`).send(big);
    expect(upper.status).toBe(401);
    // The staff page's copy of the route takes no list at all.
    const a = await admin();
    expect((await a.put(`/api/staff/v1/cabinet/${NEW}`).send(big)).status).toBe(413);
    // With the key it is taken; other firm routes keep their small limit.
    await w.firm('put', `/cabinet/${NEW}`).send(big).expect(200);
    expect((await w.firm('put', `/clients/${NEW}`).send(big)).status).toBe(413);
    // A place longer than the portal lists is refused by field.
    const long = await w
      .firm('put', `/cabinet/${NEW}`)
      .send(list([file('d1', 'x'.repeat(CABINET_PATH_MAX + 1))], { rev: 2 }));
    expect(long.status).toBe(400);
    await w
      .firm('put', `/cabinet/${NEW}`)
      .send(list([file('d1', 'x'.repeat(CABINET_PATH_MAX))], { rev: 2 }))
      .expect(200);
  });

  it('refuses a list that is too long, or names a document twice', async () => {
    const many = Array.from({ length: CABINET_FILES_MAX + 1 }, (_, i) => file(`d${i}`, `f${i}`));
    const long = await w.firm('put', `/cabinet/${NEW}`).send(list(many, { hash: 'h' }));
    expect(long.status).toBe(400);
    const twice = await w
      .firm('put', `/cabinet/${NEW}`)
      .send(list([file('d1', 'a.pdf'), file('d1', 'b.pdf')]));
    expect(twice.status).toBe(400);
    expect(twice.body.error).toBe('document_twice');
    // Text the database would refuse (its error could put the names in the log) is refused
    // first, naming the field and not the value.
    for (const bad of [
      list([file('d1', 'a\u0000.pdf')]),
      list([file('d\u0007', 'a.pdf')]),
      { ...list([file('d1', 'a.pdf')]), displayName: 'Garcia\u0000' },
      { ...list([file('d1', 'a.pdf')]), hash: 'h\n' },
    ]) {
      const res = await w.firm('put', `/cabinet/${NEW}`).send(bad);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid');
      expect(JSON.stringify(res.body)).not.toContain('.pdf');
    }
    // Nothing was made of any of them.
    const rows = await w.t.db.select().from(schema.clients).where(eq(schema.clients.id, NEW));
    expect(rows).toHaveLength(0);
    // A full list is taken.
    await w
      .firm('put', `/cabinet/${NEW}`)
      .send(list(many.slice(0, CABINET_FILES_MAX), { hash: 'h' }))
      .expect(200);
    const got = await w.firm('get', `/clients/${NEW}/cabinet-files`).expect(200);
    expect(got.body.files).toHaveLength(CABINET_FILES_MAX);
  });

  it('is written by Vibe Files only, and a limited staff member sees only their clients', async () => {
    await w
      .firm('put', `/cabinet/${CLIENT}`)
      .send({ ...list([file('d1', 'A/a.pdf')]), displayName: 'Smith, John' })
      .expect(200);
    await w
      .firm('put', `/cabinet/${OTHER}`)
      .send({ ...list([file('d2', 'A/b.pdf')]), displayName: 'Jones LLC' })
      .expect(200);
    const a = await admin();
    await a.get('/api/staff/v1/cabinet').expect(403);
    await a.put(`/api/staff/v1/cabinet/${CLIENT}`).send(list([])).expect(403);
    await a.delete(`/api/staff/v1/cabinet/${CLIENT}?headRev=99`).expect(403);
    await a.delete('/api/staff/v1/cabinet').expect(403);
    // Without the firm key, nothing.
    await request(w.app).get('/api/firm/v1/cabinet').expect(401);

    const made = await a
      .post('/api/staff/v1/staff')
      .send({ email: 'lee@example-cpa.test', name: 'Lee', clientIds: [CLIENT] })
      .expect(201);
    const lee = await finish(made.body.setupLink as string);
    const mine = await lee.get(`/api/staff/v1/clients/${CLIENT}/cabinet-files`).expect(200);
    expect(mine.body.files).toHaveLength(1);
    await lee.get(`/api/staff/v1/clients/${OTHER}/cabinet-files`).expect(404);
  });

  it('clears every list when Vibe Files stops sending them, and says so once in History', async () => {
    await w
      .firm('put', `/cabinet/${NEW}`)
      .send(list([file('d1', 'A/a.pdf')]))
      .expect(200);
    await w
      .firm('put', `/cabinet/${CLIENT}`)
      .send({ ...list([file('d2', 'A/b.pdf')]), displayName: 'Smith, John' })
      .expect(200);
    const cleared = await w.firm('delete', '/cabinet').expect(200);
    expect(cleared.body).toEqual({ ok: true, clients: 2 });
    expect(await w.t.db.select().from(schema.cabinetFile)).toHaveLength(0);
    const listed = (await w.firm('get', '/clients').expect(200)).body.clients as {
      cabinetFiles: number;
      cabinetListed: boolean;
    }[];
    expect(listed.every((c) => c.cabinetFiles === 0 && !c.cabinetListed)).toBe(true);
    // The clients stay; a second clearing finds nothing and records nothing.
    const rows = await w.t.db.select().from(schema.clients).where(eq(schema.clients.id, NEW));
    expect(rows).toHaveLength(1);
    await w.firm('delete', '/cabinet').expect(200);
    expect((await kinds()).filter((k) => k === 'cabinet_lists_cleared')).toHaveLength(1);
  });
});
