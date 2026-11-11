// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P67: a photo ID with every access request; on approval a PDF of the request and the ID goes
// to Vibe Files' Portal inbox with the first client; the ID is deleted 7 days after Vibe Files
// fetched the PDF (30 days after a denial).

import { PDFDocument } from 'pdf-lib';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { purgeIdPhotos } from '../portal/access-id';
import { CLIENT, ID_PNG, OTHER, sendId, world, type World } from './harness';

let w: World;
beforeEach(async () => {
  w = await world();
});
afterEach(async () => {
  await w.close();
});

const MARY = 'mary@example.test';
const DAY = 24 * 60;

async function ask(): Promise<string> {
  const made = await request(w.app)
    .post('/api/portal/access-requests')
    .send({ name: 'Mary Smith', email: MARY, clientAs: 'Smith, John', note: 'Spouse' })
    .expect(201);
  return made.body.requestId as string;
}

async function confirm(id: string): Promise<void> {
  await request(w.app)
    .post(`/api/portal/access-requests/${id}/confirm`)
    .send({ code: w.code(MARY) })
    .expect(200);
}

describe('photo ID on access requests (P67)', () => {
  it('is required before the code, must be a picture or PDF, and staff see it', async () => {
    const id = await ask();
    const none = await request(w.app)
      .post(`/api/portal/access-requests/${id}/confirm`)
      .send({ code: w.code(MARY) });
    expect([none.status, none.body.error]).toEqual([400, 'id_required']);
    // Not used up: the same code works once the ID is in.
    const text = await request(w.app)
      .post(`/api/portal/access-requests/${id}/id-photo?name=id.txt`)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('hello there'));
    expect([text.status, text.body.error]).toEqual([415, 'id_type']);
    await sendId(w, id);
    await confirm(id);
    // Too late to change once confirmed.
    const late = await request(w.app)
      .post(`/api/portal/access-requests/${id}/id-photo?name=id.png`)
      .set('Content-Type', 'application/octet-stream')
      .send(ID_PNG);
    expect(late.status).toBe(404);

    const list = await w.firm('get', '/access-requests').expect(200);
    expect(list.body.requests[0].idPhoto).toEqual({
      contentType: 'image/png',
      size: ID_PNG.length,
    });
    const photo = await w
      .firm('get', `/access-requests/${id}/id-photo`)
      .buffer(true)
      .parse((res, cb) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => cb(null, Buffer.concat(parts)));
      })
      .expect(200);
    expect(photo.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(photo.body as Buffer, ID_PNG)).toBe(0);
  });

  it('approved: a PDF goes to the Portal inbox for the first client, not to the person', async () => {
    const id = await ask();
    await sendId(w, id);
    await confirm(id);
    const ok = await w
      .firm('post', `/access-requests/${id}/approve`)
      .send({ clientIds: [CLIENT, OTHER], roleLabel: 'Spouse' })
      .expect(200);
    const ups = await w.firm('get', '/uploads').expect(200);
    expect(ups.body.uploads).toHaveLength(1);
    const rec = ups.body.uploads[0];
    expect(rec).toEqual(
      expect.objectContaining({
        clientId: CLIENT,
        clientCode: '1001',
        clientName: 'Smith, John',
        name: 'Access request - Mary Smith.pdf',
      }),
    );
    const pdf = await w
      .firm('get', `/uploads/${rec.uploadId}/content`)
      .buffer(true)
      .parse((res, cb) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => cb(null, Buffer.concat(parts)));
      })
      .expect(200);
    const doc = await PDFDocument.load(pdf.body as Buffer);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(doc.getTitle()).toBe('Portal access request - Mary Smith');
    // The photo ID is in it.
    expect((pdf.body as Buffer).toString('latin1')).toMatch(/\/Subtype\s*\/Image/);

    // The person does not see it among their uploads.
    const a = request.agent(w.app);
    await request(w.app).post('/api/portal/auth/login').send({ contact: MARY }).expect(200);
    await a
      .post('/api/portal/auth/verify-link')
      .send({ token: w.linkToken(MARY) })
      .expect(200);
    const mine = await a.get('/api/portal/uploads').expect(200);
    expect(mine.body.uploads).toEqual([]);
    await a.delete(`/api/portal/uploads/${rec.uploadId}`).expect(404);
    expect(ok.body.identityId).toBeTruthy();
  });

  it('the ID and the portal copy of the PDF go 7 days after Vibe Files fetched it', async () => {
    const id = await ask();
    await sendId(w, id);
    await confirm(id);
    await w.firm('post', `/access-requests/${id}/approve`).send({ clientId: CLIENT }).expect(200);
    const rec = (await w.firm('get', '/uploads').expect(200)).body.uploads[0];
    // Not fetched: kept however long.
    w.later(60 * DAY);
    await purgeIdPhotos(w.ctx);
    await w.firm('get', `/access-requests/${id}/id-photo`).expect(200);
    await w.firm('post', `/uploads/${rec.uploadId}/fetched`).expect(200);
    w.later(6 * DAY);
    await purgeIdPhotos(w.ctx);
    await w.firm('get', `/access-requests/${id}/id-photo`).expect(200);
    await w.firm('get', `/uploads/${rec.uploadId}/content`).expect(200);
    w.later(1 * DAY + 60);
    await purgeIdPhotos(w.ctx);
    await w.firm('get', `/access-requests/${id}/id-photo`).expect(404);
    await w.firm('get', `/uploads/${rec.uploadId}/content`).expect(404);
  });

  it('denied: the ID goes 30 days later; never confirmed: with the request', async () => {
    const id = await ask();
    await sendId(w, id);
    await confirm(id);
    await w.firm('post', `/access-requests/${id}/deny`).expect(200);
    w.later(29 * DAY);
    await purgeIdPhotos(w.ctx);
    await w.firm('get', `/access-requests/${id}/id-photo`).expect(200);
    w.later(1 * DAY + 60);
    await purgeIdPhotos(w.ctx);
    await w.firm('get', `/access-requests/${id}/id-photo`).expect(404);

    const other = await request(w.app)
      .post('/api/portal/access-requests')
      .send({ name: 'Sam', email: 'sam@example.test', clientAs: 'Sam' })
      .expect(201);
    await sendId(w, other.body.requestId as string);
    w.later(6 * DAY + 60);
    expect(await purgeIdPhotos(w.ctx)).toBe(1);
  });
});
