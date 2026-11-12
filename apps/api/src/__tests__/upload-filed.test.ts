// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P74: the portal keeps a fetched upload until Vibe Files says it was filed (or dismissed), lists
// the ones not filed yet, and counts the keep period from the filing. A fetcher that does not
// report filing (Vibe Files 0.1.18 and older) is treated as before: filed when fetched.

import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { schema } from '@vibe-portal/db';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { purgeUploads, UNFILED_CAP_DAYS } from '../firm/uploads';
import { purgeIdPhotos } from '../portal/access-id';
import { createSetupLink } from '../staff/auth';
import { totpCode } from '../staff/credentials';
import { CLIENT, OTHER, sendId, world, type World } from './harness';

let w: World;

beforeEach(async () => {
  w = await world();
});
afterEach(async () => {
  await w.close();
});

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n');
const DAY = 24 * 60;

async function upload(name = 'a.pdf'): Promise<string> {
  const a = await w.member(`${randomUUID()}@example.test`);
  const q = new URLSearchParams({ clientId: CLIENT, batchId: randomUUID(), name });
  const res = await a.agent
    .post(`/api/portal/uploads?${q.toString()}`)
    .set('Content-Type', 'application/octet-stream')
    .send(PDF)
    .expect(201);
  return res.body.uploadId as string;
}

const fetchTracking = (id: string) =>
  w.firm('post', `/uploads/${id}/fetched`).send({ tracksFiling: true }).expect(200);

type Agent = ReturnType<typeof request.agent>;
const PASSWORD = 'a long staff password';

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

async function admin(): Promise<Agent> {
  return finish(await createSetupLink(w.ctx, null, 'appliance'), 'kurt@example-cpa.test');
}

async function added(by: Agent, email: string, more: { clientIds?: string[] }): Promise<Agent> {
  const res = await by.post('/api/staff/v1/staff').send({ email, name: email, ...more });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return finish(res.body.setupLink as string);
}

async function row(id: string) {
  const [r] = await w.t.db.select().from(schema.uploads).where(eq(schema.uploads.id, id));
  return r!;
}

describe('fetched, not filed (P74)', () => {
  it('lists an upload fetched by a filing-aware fetcher until it is filed', async () => {
    const id = await upload('2025 W-2.pdf');
    // Not fetched yet: not on the list, and cannot be filed.
    expect((await w.firm('get', '/uploads/unfiled').expect(200)).body.uploads).toEqual([]);
    expect((await w.firm('post', `/uploads/${id}/filed`)).status).toBe(409);

    await fetchTracking(id);
    const list = (await w.firm('get', '/uploads/unfiled').expect(200)).body;
    expect(list.state).toBe('unfiled');
    expect(list.keepDays).toBe(30);
    expect(list.capDays).toBe(UNFILED_CAP_DAYS);
    expect(list.uploads).toEqual([
      expect.objectContaining({
        uploadId: id,
        name: '2025 W-2.pdf',
        fetchedBy: 'THGR18C-XA003\\kurt',
        fetchedAt: expect.any(String),
      }),
    ]);
    // Its content can still be fetched again.
    await w.firm('get', `/uploads/${id}/content`).expect(200);

    await w.firm('post', `/uploads/${id}/filed`).expect(200);
    expect((await w.firm('get', '/uploads/unfiled')).body.uploads).toEqual([]);
    // Saying it again (another PC saw the same filing) is fine.
    const again = await w.firm('post', `/uploads/${id}/filed`).expect(200);
    expect(again.body.already).toBe('filed');
    const evs = await w.t.db
      .select()
      .from(schema.events)
      .where(eq(schema.events.kind, 'upload_filed'));
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ uploadId: id, clientId: CLIENT });
  });

  it('a dismissed upload leaves the list too', async () => {
    const id = await upload();
    await fetchTracking(id);
    await w.firm('post', `/uploads/${id}/dismissed`).expect(200);
    expect((await w.firm('get', '/uploads/unfiled')).body.uploads).toEqual([]);
    expect((await w.firm('post', `/uploads/${id}/filed`).expect(200)).body.already).toBe(
      'dismissed',
    );
    expect((await row(id)).dismissedBy).toBe('THGR18C-XA003\\kurt');
  });

  it('an older fetcher (no tracksFiling) counts as filed when it fetched', async () => {
    const id = await upload();
    await w.firm('post', `/uploads/${id}/fetched`).expect(200);
    const r = await row(id);
    expect(r.filedAt).toEqual(r.fetchedAt);
    expect((await w.firm('get', '/uploads/unfiled')).body.uploads).toEqual([]);
  });

  it('staff see the list (limited staff only their clients) but cannot file, dismiss or fetch', async () => {
    const id = await upload();
    await fetchTracking(id);
    const boss = await admin();
    const list = await boss.get('/api/staff/v1/uploads/unfiled').expect(200);
    expect(list.body.uploads.map((u: { uploadId: string }) => u.uploadId)).toEqual([id]);
    for (const what of ['filed', 'dismissed', 'fetched']) {
      const res = await boss.post(`/api/staff/v1/uploads/${id}/${what}`);
      expect(res.status, what).toBe(403);
    }
    const limited = await added(boss, 'mary@example-cpa.test', { clientIds: [OTHER] });
    const theirs = await limited.get('/api/staff/v1/uploads/unfiled').expect(200);
    expect(theirs.body.uploads).toEqual([]);
  });

  it('unknown or malformed ids are 404', async () => {
    await w.firm('post', `/uploads/${randomUUID()}/filed`).expect(404);
    await w.firm('post', '/uploads/nope/dismissed').expect(404);
  });
});

describe('keeping uploads not filed (P74)', () => {
  it('keeps an unfiled upload past the keep period; counts the keep period from filing', async () => {
    const id = await upload();
    await fetchTracking(id);
    w.later(60 * DAY);
    expect(await purgeUploads(w.ctx)).toBe(0);
    await w.firm('post', `/uploads/${id}/filed`).expect(200);
    w.later(29 * DAY);
    expect(await purgeUploads(w.ctx)).toBe(0);
    w.later(2 * DAY);
    expect(await purgeUploads(w.ctx)).toBe(1);
    expect((await row(id)).purgedAt).not.toBeNull();
  });

  it('a keep period longer than the cap is kept for filed uploads, old and new', async () => {
    await w.t.db.update(schema.firm).set({ uploadKeepDays: 365 });
    const old = await upload('old.pdf');
    // An older fetcher: filed when fetched.
    await w.firm('post', `/uploads/${old}/fetched`).expect(200);
    const id = await upload();
    await fetchTracking(id);
    await w.firm('post', `/uploads/${id}/filed`).expect(200);
    w.later((UNFILED_CAP_DAYS + 10) * DAY);
    expect(await purgeUploads(w.ctx)).toBe(0);
    w.later((365 - UNFILED_CAP_DAYS) * DAY);
    expect(await purgeUploads(w.ctx)).toBe(2);
  });

  it('a dismissed upload is kept the keep period from dismissal', async () => {
    const id = await upload();
    await fetchTracking(id);
    await w.firm('post', `/uploads/${id}/dismissed`).expect(200);
    w.later(29 * DAY);
    expect(await purgeUploads(w.ctx)).toBe(0);
    w.later(2 * DAY);
    expect(await purgeUploads(w.ctx)).toBe(1);
  });

  it('clears an upload never filed after the cap, and says why', async () => {
    const id = await upload();
    await fetchTracking(id);
    w.later((UNFILED_CAP_DAYS - 1) * DAY);
    expect(await purgeUploads(w.ctx)).toBe(0);
    w.later(2 * DAY);
    expect(await purgeUploads(w.ctx)).toBe(1);
    const [ev] = await w.t.db
      .select()
      .from(schema.events)
      .where(eq(schema.events.kind, 'upload_purged'));
    expect(ev?.detail).toEqual({ reason: `not filed ${UNFILED_CAP_DAYS} days after fetch` });
    // A purged upload is off the list: it cannot be fetched again.
    expect((await w.firm('get', '/uploads/unfiled')).body.uploads).toEqual([]);
  });
});

describe('access-request records (P67, P74)', () => {
  it('filing one stays out of the client History; the ID and the PDF go 7 days after filing', async () => {
    const made = await request(w.app)
      .post('/api/portal/access-requests')
      .send({ name: 'Mary Smith', email: 'mary@example.test', clientAs: 'Smith, John' })
      .expect(201);
    const reqId = made.body.requestId as string;
    await sendId(w, reqId);
    await request(w.app)
      .post(`/api/portal/access-requests/${reqId}/confirm`)
      .send({ code: w.code('mary@example.test') })
      .expect(200);
    await w
      .firm('post', `/access-requests/${reqId}/approve`)
      .send({ clientId: CLIENT })
      .expect(200);
    const rec = (await w.firm('get', '/uploads').expect(200)).body.uploads[0];
    await fetchTracking(rec.uploadId);
    expect((await w.firm('get', '/uploads/unfiled')).body.uploads).toHaveLength(1);
    // Fetched, not filed: the ID and the portal's copy are kept past 7 days.
    w.later(8 * DAY);
    await purgeIdPhotos(w.ctx);
    await w.firm('get', `/access-requests/${reqId}/id-photo`).expect(200);
    await w.firm('get', `/uploads/${rec.uploadId}/content`).expect(200);
    await w.firm('post', `/uploads/${rec.uploadId}/filed`).expect(200);
    const [ev] = await w.t.db
      .select()
      .from(schema.events)
      .where(eq(schema.events.kind, 'upload_filed'));
    expect(ev?.clientId).toBeNull();
    w.later(6 * DAY);
    await purgeIdPhotos(w.ctx);
    await w.firm('get', `/uploads/${rec.uploadId}/content`).expect(200);
    w.later(2 * DAY);
    await purgeIdPhotos(w.ctx);
    await w.firm('get', `/access-requests/${reqId}/id-photo`).expect(404);
    await w.firm('get', `/uploads/${rec.uploadId}/content`).expect(404);
  });
});
