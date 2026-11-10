// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Fixes from the P49 review: a file that changed after the link was made, marked copies kept
// per day (made in a worker), access codes and the daily quota when an email fails, five links
// per recipient counted per client, and where the watermark goes on the page.

import { createHash, randomUUID } from 'node:crypto';

import { eq, like } from 'drizzle-orm';
import { schema } from '@vibe-portal/db';
import { degrees, PDFDocument, StandardFonts } from 'pdf-lib';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { purgeMarks } from '../files/marks';
import { markCorners, markLayout } from '../files/watermark-layout.mjs';
import { checkPdf, watermarkPdf } from '../files/watermark';
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

const PASSWORD = 'a long staff password';
const LENDER = 'pat@first-bank.test';
type Agent = ReturnType<typeof request.agent>;

async function admin(): Promise<Agent> {
  const link = await createSetupLink(w.ctx, null, 'appliance');
  const token = /#t=([\w-]+)/.exec(link)?.[1] ?? '';
  const agent = request.agent(w.app);
  const set = await agent
    .post('/api/staff/auth/setup')
    .send({ token, email: 'kurt@example-cpa.test', name: 'Kurt', password: PASSWORD })
    .expect(200);
  await agent
    .post('/api/staff/auth/setup/confirm')
    .send({ token, code: totpCode(set.body.secret as string, w.ctx.now()) })
    .expect(200);
  return agent;
}

async function realPdf(pages = 2): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pages; i++) pdf.addPage([612, 792]);
  return Buffer.from(await pdf.save());
}

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

async function onPortal(clientId: string, name: string, bytes: Buffer): Promise<string> {
  const res = await w
    .firm(
      'post',
      `/files?clientId=${clientId}&vfDocumentId=${randomUUID()}&name=${name}&sha256=${sha(bytes)}`,
    )
    .set('Content-Type', 'application/octet-stream')
    .send(bytes);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.fileId as string;
}

/** Vibe Files replaces the file's content (and maybe its name). */
async function replace(fileId: string, bytes: Buffer, name?: string): Promise<void> {
  const res = await w
    .firm('put', `/files/${fileId}/content?sha256=${sha(bytes)}${name ? `&name=${name}` : ''}`)
    .set('Content-Type', 'application/octet-stream')
    .send(bytes);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

interface Sent {
  id: string;
  key: string;
  path: string;
}

function linkOf(to: string): Sent {
  const token = /\/shared#t=([\w.-]+)/.exec(w.notes.last(to).body)?.[1] ?? '';
  const id = token.slice(0, 36);
  return { id, key: token.slice(37), path: `/api/portal/shared/${id}` };
}

async function send(
  staff: Agent,
  fileIds: string[],
  more: { email?: string; clientId?: string; [k: string]: unknown } = {},
): Promise<Sent> {
  const res = await staff
    .post('/api/staff/v1/shares')
    .send({ clientId: CLIENT, fileIds, email: LENDER, ...more });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return linkOf(more.email ?? LENDER);
}

async function unlock(s: Sent): Promise<Agent> {
  const agent = request.agent(w.app);
  await agent.post(`${s.path}/code`).send({ key: s.key }).expect(200);
  await agent
    .post(`${s.path}/verify`)
    .send({ key: s.key, code: w.code(LENDER) })
    .expect(200);
  return agent;
}

const marks = () => w.t.db.select().from(schema.fileShareMark);

function failingEmail(): () => void {
  const real = w.ctx.notifier.send;
  w.ctx.notifier.send = async () => {
    throw new Error('smtp down');
  };
  return () => {
    w.ctx.notifier.send = real;
  };
}

describe('a file that changed after the link was made (P49 review)', () => {
  it('the link shows it as it is now, and does not open it if the link does not allow it', async () => {
    const boss = await admin();
    const a = await onPortal(CLIENT, 'a.pdf', await realPdf());
    const b = await onPortal(CLIENT, 'b.pdf', await realPdf());
    // View only: the page must be able to show each file.
    const s = await send(boss, [a, b]);
    const pat = await unlock(s);
    await replace(a, Buffer.from('x,y\n1,2\n'), 'a.csv');
    const open = await pat.post(`${s.path}/open`).send({ key: s.key }).expect(200);
    expect(
      open.body.files.map((f: { name: string; available: boolean }) => [f.name, f.available]),
    ).toEqual([
      ['a.csv', false],
      ['b.pdf', true],
    ]);
    const res = await pat.get(`${s.path}/files/${a}/content?mode=view`);
    expect([res.status, res.body]).toEqual([409, { error: 'not_available' }]);
    await pat.get(`${s.path}/files/${b}/content?mode=view`).expect(200);
    // A newer version the link allows opens again.
    await replace(a, await realPdf(3), 'a.pdf');
    await pat.get(`${s.path}/files/${a}/content?mode=view`).expect(200);
  });
});

describe('marked copies (P49 review)', () => {
  it('a PDF is marked once a day, again when it changes, and the copy goes when the link ends', async () => {
    const boss = await admin();
    const fileId = await onPortal(CLIENT, 'a.pdf', await realPdf());
    const s = await send(boss, [fileId], { watermark: true, canDownload: true, name: 'Pat Roe' });
    const pat = await unlock(s);

    // Views at once wait for one marking.
    const first = await Promise.all(
      [1, 2, 3].map(() => pat.get(`${s.path}/files/${fileId}/content?mode=view`).buffer(true)),
    );
    expect(first.map((r) => r.status)).toEqual([200, 200, 200]);
    const [kept, ...extra] = await marks();
    expect(extra).toEqual([]);
    expect(kept?.day).toBe('2026-11-09');
    const again = await pat.get(`${s.path}/files/${fileId}/content?mode=download`).buffer(true);
    expect(Buffer.compare(again.body as Buffer, first[0]?.body as Buffer)).toBe(0);
    expect((await marks()).map((m) => m.blobKey)).toEqual([kept?.blobKey]);

    // A kept copy that has gone missing is made again, not refused.
    await w.ctx.blobs.remove(kept?.blobKey ?? '');
    await pat.get(`${s.path}/files/${fileId}/content?mode=view`).expect(200);
    const [remade] = await marks();
    expect(remade?.blobKey).not.toBe(kept?.blobKey);

    // Vibe Files updates the file: the old marked copy goes at once.
    await replace(fileId, await realPdf(3));
    expect(await marks()).toEqual([]);
    expect(await w.ctx.blobs.exists(remade?.blobKey ?? '')).toBe(false);
    const v2 = await pat.get(`${s.path}/files/${fileId}/content?mode=view`).buffer(true);
    expect((await PDFDocument.load(v2.body as Buffer)).getPageCount()).toBe(3);

    // A new day, a new mark; housekeeping removes yesterday's.
    w.later(24 * 60);
    const pat2 = await unlock(s);
    await pat2.get(`${s.path}/files/${fileId}/content?mode=view`).expect(200);
    expect((await marks()).map((m) => m.day).sort()).toEqual(['2026-11-09', '2026-11-10']);
    const yesterday = (await marks()).find((m) => m.day === '2026-11-09');
    await purgeMarks(w.ctx);
    expect((await marks()).map((m) => m.day)).toEqual(['2026-11-10']);
    expect(await w.ctx.blobs.exists(yesterday?.blobKey ?? '')).toBe(false);
  });

  it('a new version that cannot be marked is refused, then listed as not available', async () => {
    const boss = await admin();
    const fileId = await onPortal(CLIENT, 'a.pdf', await realPdf());
    const s = await send(boss, [fileId], { watermark: true });
    const pat = await unlock(s);
    await pat.get(`${s.path}/files/${fileId}/content?mode=view`).expect(200);
    await replace(fileId, Buffer.from('%PDF-1.7 damaged'));
    const refused = await pat.get(`${s.path}/files/${fileId}/content?mode=view`);
    expect([refused.status, refused.body]).toEqual([422, { error: 'watermark_failed' }]);
    const open = await pat.post(`${s.path}/open`).send({ key: s.key }).expect(200);
    expect(open.body.files[0].available).toBe(false);
    // A version that can be marked opens again.
    await replace(fileId, await realPdf(1));
    const again = await pat.post(`${s.path}/open`).send({ key: s.key }).expect(200);
    expect(again.body.files[0].available).toBe(true);
    await pat.get(`${s.path}/files/${fileId}/content?mode=view`).expect(200);
  });

  it('wrong codes lock the link: nothing marked stays on disk', async () => {
    const boss = await admin();
    const fileId = await onPortal(CLIENT, 'a.pdf', await realPdf());
    const s = await send(boss, [fileId], { watermark: true });
    const pat = await unlock(s);
    await pat.get(`${s.path}/files/${fileId}/content?mode=view`).expect(200);
    const [m] = await marks();
    expect(m).toBeDefined();
    const guesser = request.agent(w.app);
    let last = 0;
    for (let i = 0; i < 3 && last !== 410; i++) {
      w.later(2);
      await guesser.post(`${s.path}/code`).send({ key: s.key }).expect(200);
      const right = w.code(LENDER);
      const wrong = right === '000000' ? '111111' : '000000';
      for (let t = 0; t < 5 && last !== 410; t++) {
        last = (await guesser.post(`${s.path}/verify`).send({ key: s.key, code: wrong })).status;
      }
    }
    expect(last).toBe(410);
    expect(await marks()).toEqual([]);
    expect(await w.ctx.blobs.exists(m?.blobKey ?? '')).toBe(false);
  });

  it('staff end the link: nothing marked stays on disk', async () => {
    const boss = await admin();
    const fileId = await onPortal(CLIENT, 'a.pdf', await realPdf());
    const s = await send(boss, [fileId], { watermark: true });
    const pat = await unlock(s);
    await pat.get(`${s.path}/files/${fileId}/content?mode=view`).expect(200);
    const [m] = await marks();
    await boss.delete(`/api/staff/v1/shares/${s.id}`).expect(200);
    expect(await marks()).toEqual([]);
    expect(await w.ctx.blobs.exists(m?.blobKey ?? '')).toBe(false);
  });

  it('a file taken off the portal takes its marked copies with it', async () => {
    const boss = await admin();
    const fileId = await onPortal(CLIENT, 'a.pdf', await realPdf());
    const s = await send(boss, [fileId], { watermark: true });
    const pat = await unlock(s);
    await pat.get(`${s.path}/files/${fileId}/content?mode=view`).expect(200);
    const [m] = await marks();
    await w.firm('delete', `/files/${fileId}`).expect(200);
    expect(await marks()).toEqual([]);
    expect(await w.ctx.blobs.exists(m?.blobKey ?? '')).toBe(false);
  });
});

describe('when an email fails (P49 review)', () => {
  it('a new code that could not be sent leaves the earlier one working, and the minute unused', async () => {
    const boss = await admin();
    const s = await send(boss, [await onPortal(CLIENT, 'a.pdf', await realPdf())]);
    const pat = request.agent(w.app);
    await pat.post(`${s.path}/code`).send({ key: s.key }).expect(200);
    const earlier = w.code(LENDER);
    w.later(2);
    const restore = failingEmail();
    const failed = await pat.post(`${s.path}/code`).send({ key: s.key });
    restore();
    expect([failed.status, failed.body]).toEqual([502, { error: 'email_failed' }]);
    // Asking again straight away is fine: the failed try used up nothing.
    await pat.post(`${s.path}/code`).send({ key: s.key }).expect(200);
    const sent = await w.t.db
      .select()
      .from(schema.rateLimit)
      .where(like(schema.rateLimit.bucket, 'outside:code:day:%'));
    expect(sent.map((r) => r.hits)).toEqual([2]);
    // And the earlier code stopped working only once the new one was sent.
    const old = await pat.post(`${s.path}/verify`).send({ key: s.key, code: earlier });
    expect(old.status).toBe(400);
    await pat
      .post(`${s.path}/verify`)
      .send({ key: s.key, code: w.code(LENDER) })
      .expect(200);
  });

  it('the earlier code still opens the link when the new one could not be sent', async () => {
    const boss = await admin();
    const s = await send(boss, [await onPortal(CLIENT, 'a.pdf', await realPdf())]);
    const pat = request.agent(w.app);
    await pat.post(`${s.path}/code`).send({ key: s.key }).expect(200);
    const earlier = w.code(LENDER);
    w.later(2);
    const restore = failingEmail();
    await pat.post(`${s.path}/code`).send({ key: s.key }).expect(502);
    restore();
    await pat.post(`${s.path}/verify`).send({ key: s.key, code: earlier }).expect(200);
  });

  it('links that were refused or not sent do not count toward the 50 a day', async () => {
    const boss = await admin();
    const fileId = await onPortal(CLIENT, 'a.pdf', await realPdf());
    const restore = failingEmail();
    for (let i = 0; i < 3; i++) {
      await boss
        .post('/api/staff/v1/shares')
        .send({ clientId: CLIENT, fileIds: [fileId], email: LENDER })
        .expect(502);
    }
    restore();
    for (let i = 0; i < 5; i++) await send(boss, [fileId]);
    await boss
      .post('/api/staff/v1/shares')
      .send({ clientId: CLIENT, fileIds: [fileId], email: LENDER })
      .expect(429);
    const [quota] = await w.t.db
      .select()
      .from(schema.rateLimit)
      .where(like(schema.rateLimit.bucket, 'outside-share:%'));
    expect(quota?.hits).toBe(5);
  });
});

describe('five links per recipient (P49 review)', () => {
  it('are counted for each client, and two sent at once cannot make a sixth', async () => {
    const boss = await admin();
    const mine = await onPortal(CLIENT, 'a.pdf', await realPdf());
    const theirs = await onPortal(OTHER, 'b.pdf', await realPdf());
    for (let i = 0; i < 4; i++) await send(boss, [mine]);
    const both = await Promise.all(
      [1, 2].map(() =>
        boss
          .post('/api/staff/v1/shares')
          .send({ clientId: CLIENT, fileIds: [mine], email: LENDER }),
      ),
    );
    expect(both.map((r) => r.status).sort()).toEqual([201, 429]);
    const held = await w.t.db
      .select()
      .from(schema.fileShare)
      .where(eq(schema.fileShare.clientId, CLIENT));
    expect(held).toHaveLength(5);
    // Another client's link to the same person is not held up.
    await send(boss, [theirs], { clientId: OTHER });
  });
});

describe('where the watermark goes (P49 review)', () => {
  async function widthAtOne(text: string): Promise<number> {
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    return font.widthOfTextAtSize(text, 1);
  }

  const LONG =
    `${'Patricia Alexandra Roe-Whitfield '.repeat(2)}\xb7 First National Bank of Somewhere \xb7 viewed 2026-11-10`.slice(
      0,
      120,
    );

  it.each([
    ['Letter', { x: 0, y: 0, width: 612, height: 792 }, 0],
    ['a box not at 0,0', { x: 100, y: 200, width: 612, height: 792 }, 0],
    ['a small crop box', { x: 50, y: 60, width: 300, height: 200 }, 0],
    ['turned 90', { x: 0, y: 0, width: 792, height: 612 }, 90],
    ['turned 270, offset', { x: -30, y: 40, width: 595, height: 842 }, 270],
  ])('fits inside the visible page: %s', async (_name, box, rotation) => {
    for (const text of ['Pat \xb7 viewed 2026-11-10', LONG]) {
      const k = await widthAtOne(text);
      const at = markLayout(box, rotation, k);
      expect(at.size).toBeGreaterThan(4);
      for (const [x, y] of markCorners(at, k)) {
        expect(x).toBeGreaterThanOrEqual(box.x);
        expect(x).toBeLessThanOrEqual(box.x + box.width);
        expect(y).toBeGreaterThanOrEqual(box.y);
        expect(y).toBeLessThanOrEqual(box.y + box.height);
      }
      // Centred.
      const cs = markCorners(at, k);
      const cx = cs.reduce((t, [x]) => t + x, 0) / 4;
      const cy = cs.reduce((t, [, y]) => t + y, 0) / 4;
      expect(Math.abs(cx - (box.x + box.width / 2))).toBeLessThan(1);
      expect(Math.abs(cy - (box.y + box.height / 2))).toBeLessThan(1);
    }
  });

  it('marks pages with an offset box and a turn, and refuses what it cannot read', async () => {
    const doc = await PDFDocument.create();
    const p = doc.addPage([612, 792]);
    p.setMediaBox(100, 200, 612, 792);
    p.setCropBox(150, 250, 400, 500);
    p.setRotation(degrees(90));
    const out = await watermarkPdf(Buffer.from(await doc.save()), 'Pat \xb7 viewed 2026-11-10');
    expect((await PDFDocument.load(out)).getPageCount()).toBe(1);
    await checkPdf(await realPdf());
    await expect(checkPdf(Buffer.from('%PDF d1'))).rejects.toThrow();
  });
});
