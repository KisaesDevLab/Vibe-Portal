// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P68: Vibe Files sends a secure link to someone outside the client with the firm key (its
// Send secure link… button). The document goes to the portal shown to nobody when the client
// was not given it: the client's people never see it, the recipient opens it by the link.

import { createHash, randomUUID } from 'node:crypto';

import { schema } from '@vibe-portal/db';
import { PDFDocument } from 'pdf-lib';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CLIENT, OTHER, world, type World } from './harness';

let w: World;
beforeEach(async () => {
  w = await world();
});
afterEach(async () => {
  await w.close();
});

const LENDER = 'pat@first-bank.test';

async function pdf(): Promise<Buffer> {
  const d = await PDFDocument.create();
  d.addPage([612, 792]);
  return Buffer.from(await d.save());
}

/** What Vibe Files does when the document is not on the portal: sends it, shown to nobody. */
async function hiddenOnPortal(clientId: string, bytes: Buffer): Promise<string> {
  const sha = createHash('sha256').update(bytes).digest('hex');
  const res = await w
    .firm('post', `/files?clientId=${clientId}&vfDocumentId=${randomUUID()}&sha256=${sha}`)
    .set('X-Vibe-Name', 'Return-2025.pdf')
    .set('Content-Type', 'application/octet-stream')
    .send(bytes);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.fileId as string;
}

describe('Vibe Files sends a secure link (P68)', () => {
  it('to a file the client does not see: the client never sees it, the recipient opens it', async () => {
    const jo = await w.member('jo@example.test');
    const original = await pdf();
    const fileId = await hiddenOnPortal(CLIENT, original);

    const made = await w.firm('post', '/shares').send({
      clientId: CLIENT,
      fileIds: [fileId],
      email: LENDER,
      name: 'Pat Roe',
      organization: 'First Bank',
      canDownload: true,
      watermark: true,
      days: 7,
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.expiresAt).toBe('2026-11-16T15:00:00.000Z');
    expect(w.notes.last(LENDER).subject).toBe('Example CPA shared a secure document with you');

    // The client's person still does not see it.
    const theirs = await jo.agent.get('/api/portal/files').expect(200);
    expect(theirs.body.files).toEqual([]);

    // The recipient proves the mailbox and downloads it (watermarked: a different PDF).
    const token = /\/shared#t=([\w.-]+)/.exec(w.notes.last(LENDER).body)?.[1] ?? '';
    const id = token.slice(0, 36);
    const key = token.slice(37);
    const path = `/api/portal/shared/${id}`;
    const pat = request.agent(w.app);
    await pat.post(`${path}/code`).send({ key }).expect(200);
    await pat
      .post(`${path}/verify`)
      .send({ key, code: w.code(LENDER) })
      .expect(200);
    const down = await pat.get(`${path}/files/${fileId}/content?mode=download`).buffer(true);
    expect(down.status).toBe(200);

    // The history names who sent it from Vibe Files.
    const ev = (await w.t.db.select().from(schema.events)).find((e) => e.kind === 'outside_share');
    expect(ev?.actorKind).toBe('firm_key');
    expect(ev?.actor).toBe('THGR18C-XA003\\kurt');
    const [share] = await w.t.db.select().from(schema.fileShare);
    expect(share?.createdBy).toBe('THGR18C-XA003\\kurt');
  });

  it('refuses a file of another client, and a bad email', async () => {
    const theirs = await hiddenOnPortal(OTHER, await pdf());
    const wrong = await w
      .firm('post', '/shares')
      .send({ clientId: CLIENT, fileIds: [theirs], email: LENDER });
    expect([wrong.status, wrong.body]).toEqual([400, { error: 'file_not_found' }]);
    const mine = await hiddenOnPortal(CLIENT, await pdf());
    const bad = await w
      .firm('post', '/shares')
      .send({ clientId: CLIENT, fileIds: [mine], email: 'not an email' });
    expect([bad.status, bad.body]).toEqual([400, { error: 'invalid_email' }]);
    expect(await w.t.db.select().from(schema.fileShare)).toEqual([]);
  });

  it('each Windows user has the daily count of a staff member', async () => {
    const mine = await hiddenOnPortal(CLIENT, await pdf());
    const quotas = async (): Promise<string[]> =>
      (await w.t.db.select().from(schema.rateLimit)).map((r) => r.bucket);
    await w
      .firm('post', '/shares')
      .send({ clientId: CLIENT, fileIds: [mine], email: LENDER })
      .expect(201);
    expect(await quotas()).toContain('outside-share:vibe-files:THGR18C-XA003\\kurt');
  });
});
