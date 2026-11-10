// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// A client sending files the firm shared with them to someone outside (P55).

import { createHash, randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { schema } from '@vibe-portal/db';
import { PDFDocument } from 'pdf-lib';
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
      expect.objectContaining({ email: LENDER, files: ['2025 Form 1040.pdf'], status: 'sent' }),
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
});
