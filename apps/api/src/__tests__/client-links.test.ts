// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// A client sending files the firm shared with them to someone outside (P55).

import { createHash, randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { schema } from '@vibe-portal/db';
import { PDFDocument } from 'pdf-lib';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CLIENT, world, type World } from './harness';

let w: World;
beforeEach(async () => {
  w = await world();
});
afterEach(async () => {
  await w.close();
});

const LENDER = 'loans@first-bank.test';

async function pdf(): Promise<Buffer> {
  const d = await PDFDocument.create();
  d.addPage([612, 792]);
  return Buffer.from(await d.save());
}

async function shared(name: string, to: string[]): Promise<string> {
  const bytes = await pdf();
  const sha = createHash('sha256').update(bytes).digest('hex');
  const res = await w
    .firm(
      'post',
      `/files?clientId=${CLIENT}&vfDocumentId=${randomUUID()}&name=${name}&sha256=${sha}`,
    )
    .set('Content-Type', 'application/octet-stream')
    .send(bytes);
  expect(res.status).toBe(201);
  const id = res.body.fileId as string;
  if (to.length) {
    await w
      .firm('put', `/files/${id}/visibility`)
      .send({ users: Object.fromEntries(to.map((i) => [i, true])) })
      .expect(200);
  }
  return id;
}

const on = () => w.t.db.update(schema.firm).set({ clientLinks: true });

describe('client secure links (P55)', () => {
  it('are off until an admin turns them on', async () => {
    const pat = await w.member('pat@example.test');
    const f = await shared('W-2.pdf', [pat.id]);
    const list = await pat.agent.get('/api/portal/outside-shares').expect(200);
    expect(list.body).toEqual(expect.objectContaining({ enabled: false, shares: [] }));
    await pat.agent
      .post('/api/portal/outside-shares')
      .send({ clientId: CLIENT, fileIds: [f], email: LENDER })
      .expect(403);
    expect(w.notes.sent.filter((m) => m.to === LENDER)).toHaveLength(0);
  });

  it('send a watermarked link to a file shared with them, which the firm sees and can end', async () => {
    await on();
    const pat = await w.member('pat@example.test');
    const f = await shared('2025 Form 1040.pdf', [pat.id]);
    const made = await pat.agent
      .post('/api/portal/outside-shares')
      .send({
        clientId: CLIENT,
        fileIds: [f],
        email: LENDER,
        name: 'Lee Loans',
        organization: 'First Bank',
        canDownload: true,
      })
      .expect(201);
    const mail = w.notes.last(LENDER);
    expect(mail.body).toContain('a client of');
    expect(mail.body).toMatch(/\/shared#t=/);

    const [row] = await w.t.db
      .select()
      .from(schema.fileShare)
      .where(eq(schema.fileShare.id, made.body.shareId as string));
    // Always watermarked, at most 30 days, sent by the client.
    expect(row?.watermark).toBe(true);
    expect(row?.sentByIdentityId).toBe(pat.id);
    const days = ((row?.expiresAt.getTime() ?? 0) - (row?.createdAt.getTime() ?? 0)) / 86_400_000;
    expect(Math.round(days)).toBe(30);

    // The client sees it; staff see it on the client's page, marked as the client's.
    const mine = await pat.agent.get('/api/portal/outside-shares').expect(200);
    expect(mine.body.shares).toEqual([
      expect.objectContaining({
        email: LENDER,
        files: [{ name: '2025 Form 1040.pdf', downloads: 0 }],
        status: 'sent',
      }),
    ]);
    const firm = await w.firm('get', `/shares?clientId=${CLIENT}`);
    if (firm.status === 200) {
      expect(firm.body.shares[0]).toEqual(expect.objectContaining({ byClient: true }));
    }
    const kinds = (await w.t.db.select().from(schema.events)).map((e) => e.kind);
    expect(kinds).toContain('outside_share');

    // The client ends it.
    await pat.agent.delete(`/api/portal/outside-shares/${made.body.shareId as string}`).expect(200);
    const after = await pat.agent.get('/api/portal/outside-shares').expect(200);
    expect(after.body.shares[0].status).toBe('revoked');
  });

  it('refuses files not shared with them, more than 30 days, and links of someone else', async () => {
    await on();
    const pat = await w.member('pat@example.test');
    const sam = await w.member('sam@example.test');
    const hidden = await shared('Not for Pat.pdf', [sam.id]);
    const mine = await shared('Pat.pdf', [pat.id]);
    await pat.agent
      .post('/api/portal/outside-shares')
      .send({ clientId: CLIENT, fileIds: [hidden], email: LENDER })
      .expect(400);
    await pat.agent
      .post('/api/portal/outside-shares')
      .send({ clientId: CLIENT, fileIds: [mine], email: LENDER, days: 90 })
      .expect(400);
    const made = await pat.agent
      .post('/api/portal/outside-shares')
      .send({ clientId: CLIENT, fileIds: [mine], email: LENDER, days: 7 })
      .expect(201);
    // Sam cannot end Pat's link, nor sees it.
    await sam.agent.delete(`/api/portal/outside-shares/${made.body.shareId as string}`).expect(404);
    const samList = await sam.agent.get('/api/portal/outside-shares').expect(200);
    expect(samList.body.shares).toEqual([]);
  });

  it('stop working when the sender loses the file or the client, or the firm turns them off', async () => {
    await on();
    const pat = await w.member('pat@example.test');
    const f = await shared('W-2.pdf', [pat.id]);
    const g = await shared('1099.pdf', [pat.id]);
    const made = await pat.agent
      .post('/api/portal/outside-shares')
      .send({ clientId: CLIENT, fileIds: [f, g], email: LENDER, canDownload: true })
      .expect(201);
    const link = /\/shared#t=([\w.-]+)/.exec(w.notes.last(LENDER).body)?.[1] ?? '';
    const path = `/api/portal/shared/${link.slice(0, 36)}`;
    const key = link.slice(37);
    const lender = request.agent(w.app);
    await lender.post(`${path}/code`).send({ key }).expect(200);
    await lender
      .post(`${path}/verify`)
      .send({ key, code: w.code(LENDER) })
      .expect(200);
    const dl = (id: string) => lender.get(`${path}/files/${id}/content?mode=download`);
    expect((await dl(f)).status).toBe(200);

    // The firm hides W-2 from Pat: the lender no longer gets it; 1099 still opens.
    await w
      .firm('put', `/files/${f}/visibility`)
      .send({ users: { [pat.id]: false } })
      .expect(200);
    expect((await dl(f)).status).toBe(404);
    expect((await dl(g)).status).toBe(200);

    // The firm turns client links off: the link stops, and Pat still sees it listed.
    await w.t.db.update(schema.firm).set({ clientLinks: false });
    expect((await dl(g)).status).toBe(410);
    const listed = await pat.agent.get('/api/portal/outside-shares').expect(200);
    expect(listed.body.enabled).toBe(false);
    expect(listed.body.shares.map((x: { id: string }) => x.id)).toEqual([made.body.shareId]);

    // On again, but Pat's access to the client is turned off: it stops.
    await on();
    expect((await dl(g)).status).toBe(200);
    await w.t.db
      .update(schema.clientAccess)
      .set({ active: false })
      .where(eq(schema.clientAccess.identityId, pat.id));
    expect((await dl(g)).status).toBe(410);
  });

  it('a link a client ends reads as ended, whatever their name (not as locked)', async () => {
    await on();
    const pat = await w.member('pat@example.test');
    await w.t.db
      .update(schema.portalIdentity)
      .set({ name: 'lockout' })
      .where(eq(schema.portalIdentity.id, pat.id));
    const f = await shared('W-2.pdf', [pat.id]);
    const made = await pat.agent
      .post('/api/portal/outside-shares')
      .send({ clientId: CLIENT, fileIds: [f], email: LENDER })
      .expect(201);
    await pat.agent.delete(`/api/portal/outside-shares/${made.body.shareId as string}`).expect(200);
    const listed = await pat.agent.get('/api/portal/outside-shares').expect(200);
    expect(listed.body.shares[0].status).toBe('revoked');
  });
});
