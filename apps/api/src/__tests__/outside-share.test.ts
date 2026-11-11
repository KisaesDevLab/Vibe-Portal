// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Files sent to someone outside the client by a private link (P49): what staff may send, what
// the recipient must prove, and every way the link stops working.

import { createHash, randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { schema } from '@vibe-portal/db';
import { listMigrations, migrate } from '@vibe-portal/db/migrations';
import { pgliteTarget } from '@vibe-portal/db/testing';
import { PDFDocument } from 'pdf-lib';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { watermarkPdf, watermarkText } from '../files/watermark';
import { shareStatus } from '../firm/shares';
import { purgeStale } from '../lib/housekeeping';
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

/** A PDF pdf-lib can read, with `pages` pages. */
async function realPdf(pages = 2): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pages; i++) pdf.addPage([612, 792]);
  return Buffer.from(await pdf.save());
}

/** A file Vibe Files put on the portal for a client; returns its id. */
async function onPortal(clientId: string, name: string, bytes: Buffer): Promise<string> {
  const sha = createHash('sha256').update(bytes).digest('hex');
  const res = await w
    .firm(
      'post',
      `/files?clientId=${clientId}&vfDocumentId=${randomUUID()}&name=${name}&sha256=${sha}`,
    )
    .set('Content-Type', 'application/octet-stream')
    .send(bytes);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.fileId as string;
}

interface Sent {
  id: string;
  key: string;
  path: string;
}

/** Sends files to the lender and reads the link out of the email. */
async function send(staff: Agent, fileIds: string[], more: object = {}): Promise<Sent> {
  const res = await staff
    .post('/api/staff/v1/shares')
    .send({ clientId: CLIENT, fileIds, email: LENDER, ...more });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return linkOf((more as { email?: string }).email ?? LENDER);
}

function linkOf(to: string): Sent {
  const token = /\/shared#t=([\w.-]+)/.exec(w.notes.last(to).body)?.[1] ?? '';
  const id = token.slice(0, 36);
  return { id, key: token.slice(37), path: `/api/portal/shared/${id}` };
}

/** Asks for a code and gives it: the agent is then verified. */
async function unlock(s: Sent, to = LENDER): Promise<Agent> {
  const agent = request.agent(w.app);
  await agent.post(`${s.path}/code`).send({ key: s.key }).expect(200);
  await agent
    .post(`${s.path}/verify`)
    .send({ key: s.key, code: w.code(to) })
    .expect(200);
  return agent;
}

const wrongFor = (right: string): string => (right === '000000' ? '111111' : '000000');

describe('a secure link to someone outside (P49)', () => {
  it('resending a link locked by wrong codes opens it again, with a fresh count (P66)', async () => {
    const boss = await admin();
    const fileId = await onPortal(CLIENT, 'Return-2025.pdf', await realPdf());
    const s1 = await send(boss, [fileId], { canDownload: true });
    // Wrong codes until the link locks.
    let locked = false;
    for (let i = 0; i < 40 && !locked; i++) {
      if (i % 5 === 0) {
        w.later(2);
        await request(w.app).post(`${s1.path}/code`).send({ key: s1.key }).expect(200);
      }
      const r = await request(w.app)
        .post(`${s1.path}/verify`)
        .send({ key: s1.key, code: wrongFor(w.code(LENDER)) });
      locked = r.status === 410;
    }
    expect(locked).toBe(true);
    await boss.post(`/api/staff/v1/shares/${s1.id}/resend`).expect(200);
    const s2 = linkOf(LENDER);
    w.later(60);
    await request(w.app).post(`${s2.path}/code`).send({ key: s2.key }).expect(200);
    // One wrong code does not lock it again.
    const wrong = await request(w.app)
      .post(`${s2.path}/verify`)
      .send({ key: s2.key, code: wrongFor(w.code(LENDER)) });
    expect(wrong.status).toBe(400);
    const pat = request.agent(w.app);
    await pat
      .post(`${s2.path}/verify`)
      .send({ key: s2.key, code: w.code(LENDER) })
      .expect(200);
    await pat.get(`${s2.path}/files/${fileId}/content?mode=download`).expect(200);
  });

  it('staff resend it: a new link to the same files, and the old one stops (P66)', async () => {
    const boss = await admin();
    const fileId = await onPortal(CLIENT, 'Return-2025.pdf', await realPdf());
    const first = await send(boss, [fileId], { canDownload: true, name: 'Pat Roe' });
    const opened = await unlock(first);
    expect(
      (await opened.post(`${first.path}/open`).send({ key: first.key }).expect(200)).body.files,
    ).toHaveLength(1);

    await boss.post(`/api/staff/v1/shares/${first.id}/resend`).expect(200);
    const again = linkOf(LENDER);
    expect(again.id).toBe(first.id);
    expect(again.key).not.toBe(first.key);
    const mail = w.notes.last(LENDER);
    expect(mail.body).toContain('This is a new link');
    expect(mail.body).toContain('Hello Pat Roe,');
    // The old link and the browser that unlocked it no longer work; the new one does.
    const old = await request(w.app).post(`${first.path}/code`).send({ key: first.key });
    expect(old.status).toBeGreaterThanOrEqual(400);
    const stale = await opened.get(`${first.path}/files/${fileId}/content?mode=download`);
    expect(stale.status).toBeGreaterThanOrEqual(400);
    w.later(15); // past the limit on codes asked for
    const fresh = await unlock(again);
    await fresh.get(`${again.path}/files/${fileId}/content?mode=download`).expect(200);

    const history = await w.firm('get', '/events?latest=1&limit=20').expect(200);
    expect(history.body.events.map((e: { kind: string }) => e.kind)).toContain(
      'outside_share_resent',
    );

    // A revoked link is not sent again.
    await boss.delete(`/api/staff/v1/shares/${first.id}`).expect(200);
    const ended = await boss.post(`/api/staff/v1/shares/${first.id}/resend`);
    expect([ended.status, ended.body.error]).toEqual([409, 'share_ended']);
  });

  it('staff send it; the recipient proves the mailbox, then views and downloads', async () => {
    const boss = await admin();
    const original = await realPdf();
    const fileId = await onPortal(CLIENT, 'Return-2025.pdf', original);
    const made = await boss.post('/api/staff/v1/shares').send({
      clientId: CLIENT,
      fileIds: [fileId],
      email: ' Pat@First-Bank.test ',
      name: 'Pat Roe',
      organization: 'First Bank',
      message: 'For the loan file.\nThanks',
      canDownload: true,
      days: 7,
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.expiresAt).toBe('2026-11-16T15:00:00.000Z');

    const mail = w.notes.last(LENDER);
    expect(mail.subject).toBe('Example CPA shared a secure document with you');
    expect(mail.body).toContain('Hello Pat Roe,');
    expect(mail.body).toContain('For the loan file.\nThanks');
    expect(mail.body).toContain('expires 2026-11-16');
    expect(mail.body).toContain('https://files.example-cpa.test/shared#t=');
    // Whose file it is stays out of the email.
    expect(mail.body).not.toContain('Smith');
    expect(mail.body).not.toContain('Return-2025');

    const s = linkOf(LENDER);
    expect(s.id).toBe(made.body.shareId);
    // The link's secret is kept only as a hash.
    const [row] = await w.t.db.select().from(schema.fileShare);
    expect(row?.secretHash).toBe(createHash('sha256').update(s.key).digest('hex'));
    expect(JSON.stringify(row)).not.toContain(s.key);

    const pat = request.agent(w.app);
    const before = await pat.post(`${s.path}/open`).send({ key: s.key }).expect(200);
    expect(before.body).toEqual({
      firmName: 'Example CPA',
      emailMasked: 'p***@first-bank.test',
      expiresAt: '2026-11-16T15:00:00.000Z',
      canDownload: true,
      // P58: the firm's limit (5 unless changed) when the link was made.
      downloadLimit: 5,
      count: 1,
      verified: false,
    });
    const early = await pat.get(`${s.path}/files/${fileId}/content?mode=view`);
    expect([early.status, early.body]).toEqual([401, { error: 'not_verified' }]);

    const asked = await pat.post(`${s.path}/code`).send({ key: s.key }).expect(200);
    expect(asked.body).toEqual({ ok: true, emailMasked: 'p***@first-bank.test' });
    expect(w.notes.last(LENDER).subject).toBe('Your document access code');
    const code = w.code(LENDER);
    // Not six digits: refused, and no try is used.
    for (const bad of ['', '12345', 'abcdef', '1234567']) {
      const res = await pat.post(`${s.path}/verify`).send({ key: s.key, code: bad });
      expect([res.status, res.body]).toEqual([400, { error: 'code_wrong' }]);
    }
    expect((await w.t.db.select().from(schema.fileShareCode))[0]?.attempts).toBe(0);

    const ok = await pat.post(`${s.path}/verify`).send({ key: s.key, code });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({
      verified: true,
      recipientName: 'Pat Roe',
      organization: 'First Bank',
      verifiedUntil: '2026-11-09T15:30:00.000Z',
      files: [{ id: fileId, name: 'Return-2025.pdf', size: original.length, preview: 'pdf' }],
    });
    const cookie = (ok.headers['set-cookie'] as unknown as string[])[0] ?? '';
    expect(cookie).toMatch(/^__vibe_share=[\w-]+; Max-Age=1800; Path=\/api\/portal\/shared\//);
    expect(cookie).toContain(`Path=${s.path};`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    // The code works once.
    const again = await request(w.app).post(`${s.path}/verify`).send({ key: s.key, code });
    expect([again.status, again.body]).toEqual([400, { error: 'code_expired' }]);

    const after = await pat.post(`${s.path}/open`).send({ key: s.key }).expect(200);
    expect(after.body.verified).toBe(true);
    expect(after.body.files).toHaveLength(1);

    const view = await pat.get(`${s.path}/files/${fileId}/content?mode=view`).buffer(true);
    expect(view.status).toBe(200);
    expect(view.headers['content-type']).toBe('application/pdf');
    expect(view.headers['content-disposition']).toMatch(/^inline; filename="Return-2025.pdf"/);
    expect(view.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
    expect(view.headers['cache-control']).toBe('no-store');
    expect(Buffer.compare(view.body as Buffer, original)).toBe(0);
    const down = await pat.get(`${s.path}/files/${fileId}/content?mode=download`);
    expect(down.status).toBe(200);
    expect(down.headers['content-disposition']).toMatch(/^attachment;/);
    // A file that is not in the link is not found, though it is the same client's.
    const other = await onPortal(CLIENT, 'Other.pdf', original);
    await pat.get(`${s.path}/files/${other}/content`).expect(404);
    await pat.get(`${s.path}/files/not-a-file/content`).expect(404);

    // Staff see what became of it.
    const list = await boss.get(`/api/staff/v1/shares?clientId=${CLIENT}`).expect(200);
    expect(list.body.shares).toEqual([
      {
        id: s.id,
        email: LENDER,
        name: 'Pat Roe',
        organization: 'First Bank',
        canDownload: true,
        watermark: false,
        createdAt: '2026-11-09T15:00:00.000Z',
        createdBy: 'kurt@example-cpa.test',
        byClient: false,
        downloads: 1,
        downloadLimit: 5,
        expiresAt: '2026-11-16T15:00:00.000Z',
        revokedAt: null,
        opens: 1,
        lastOpenedAt: '2026-11-09T15:00:00.000Z',
        status: 'opened',
        files: [{ fileId, name: 'Return-2025.pdf', removed: false, downloads: 1 }],
      },
    ]);
    const events = (await boss.get('/api/staff/v1/events?since=0').expect(200)).body.events as {
      kind: string;
      actorKind: string;
      actor: string;
      clientId: string | null;
    }[];
    const outside = events.filter((e) => e.kind.startsWith('outside_'));
    expect(outside.map((e) => [e.kind, e.actorKind, e.actor])).toEqual([
      ['outside_share', 'staff', 'kurt@example-cpa.test'],
      ['outside_code_sent', 'recipient', LENDER],
      ['outside_verified', 'recipient', LENDER],
      ['outside_view', 'recipient', LENDER],
      ['outside_download', 'recipient', LENDER],
    ]);
    expect(outside.every((e) => e.clientId === CLIENT)).toBe(true);
  });

  it('a link may be downloaded as many times as the firm allows, then not (P58)', async () => {
    const boss = await admin();
    // The firm allows 2; a link made now keeps 2 even if the setting changes later.
    const settings = (await boss.get('/api/staff/v1/settings').expect(200)).body;
    expect(settings.shareDownloadLimit).toBe(5);
    await boss
      .put('/api/staff/v1/settings')
      .send({ ...settings, shareDownloadLimit: 2 })
      .expect(200);
    const fileId = await onPortal(CLIENT, 'Return-2025.pdf', await realPdf());
    const s = await send(boss, [fileId], { canDownload: true });
    await boss
      .put('/api/staff/v1/settings')
      .send({ ...settings, shareDownloadLimit: 50 })
      .expect(200);
    const pat = await unlock(s);
    const dl = () => pat.get(`${s.path}/files/${fileId}/content?mode=download`);
    expect((await dl()).status).toBe(200);
    expect((await dl()).status).toBe(200);
    const third = await dl();
    expect([third.status, third.body]).toEqual([403, { error: 'download_limit' }]);
    // Viewing on the page is not a download.
    expect((await pat.get(`${s.path}/files/${fileId}/content?mode=view`)).status).toBe(200);
    const list = await boss.get(`/api/staff/v1/shares?clientId=${CLIENT}`).expect(200);
    expect(list.body.shares[0]).toEqual(
      expect.objectContaining({ downloads: 2, downloadLimit: 2 }),
    );
    // Per file (owner 2026-11-10): another file in a link has its own count.
    await boss
      .put('/api/staff/v1/settings')
      .send({ ...settings, shareDownloadLimit: 2 })
      .expect(200);
    const second = await onPortal(CLIENT, 'K-1.pdf', await realPdf());
    const two = await send(boss, [fileId, second], {
      canDownload: true,
      email: 'two@third-bank.test',
    });
    const ann = await unlock(two, 'two@third-bank.test');
    const get = (f: string) => ann.get(`${two.path}/files/${f}/content?mode=download`);
    expect((await get(fileId)).status).toBe(200);
    expect((await get(fileId)).status).toBe(200);
    expect((await get(fileId)).status).toBe(403);
    expect((await get(second)).status).toBe(200);
    expect((await get(second)).status).toBe(200);
    expect((await get(second)).status).toBe(403);

    // 0: no limit, for links made from then on.
    await boss
      .put('/api/staff/v1/settings')
      .send({ ...settings, shareDownloadLimit: 0 })
      .expect(200);
    const t = await send(boss, [fileId], { canDownload: true, email: 'lee@other-bank.test' });
    const lee = await unlock(t, 'lee@other-bank.test');
    for (let i = 0; i < 7; i++) {
      expect((await lee.get(`${t.path}/files/${fileId}/content?mode=download`)).status).toBe(200);
    }
  });

  it('a wrong link is not found, whatever is asked of it', async () => {
    const boss = await admin();
    const s = await send(boss, [await onPortal(CLIENT, 'a.pdf', await realPdf())]);
    const tries: [string, object | undefined][] = [
      [`${s.path}/open`, { key: `${s.key}x` }],
      [`${s.path}/open`, {}],
      [`${s.path}/open`, undefined],
      [`${s.path}/open`, { key: 5 }],
      [`${s.path}/code`, { key: 'nope' }],
      [`${s.path}/verify`, { key: 'nope', code: '123456' }],
      [`/api/portal/shared/${randomUUID()}/open`, { key: s.key }],
      [`/api/portal/shared/not-an-id/open`, { key: s.key }],
      [`/api/portal/shared/${randomUUID()}/code`, { key: s.key }],
    ];
    for (const [path, body] of tries) {
      const res = await request(w.app).post(path).send(body);
      expect([res.status, res.body], path).toEqual([404, { error: 'not_found' }]);
    }
    expect(w.notes.sent.filter((m) => m.subject === 'Your document access code')).toEqual([]);
    // A form post from another site is refused before anything is read.
    await request(w.app).post(`${s.path}/open`).type('form').send(`key=${s.key}`).expect(415);
    // No cookie: the files say nothing, even about a share that does not exist.
    for (const id of [s.id, randomUUID(), 'not-an-id']) {
      const res = await request(w.app).get(
        `/api/portal/shared/${id}/files/${randomUUID()}/content`,
      );
      expect([res.status, res.body], id).toEqual([401, { error: 'not_verified' }]);
    }
  });

  it('view only: the page may show it, nothing is sent to keep', async () => {
    const boss = await admin();
    const pdf = await onPortal(CLIENT, 'a.pdf', await realPdf());
    const png = await onPortal(CLIENT, 'scan.png', Buffer.from('89504e470d0a1a0a', 'hex'));
    const s = await send(boss, [pdf, png]);
    const pat = await unlock(s);
    await pat.get(`${s.path}/files/${pdf}/content?mode=view`).expect(200);
    const img = await pat.get(`${s.path}/files/${png}/content?mode=view`).expect(200);
    expect(img.headers['content-type']).toBe('image/png');
    for (const q of ['?mode=download', '']) {
      const res = await pat.get(`${s.path}/files/${pdf}/content${q}`);
      expect([res.status, res.body]).toEqual([403, { error: 'view_only' }]);
    }
    await pat.get(`${s.path}/files/${pdf}/content?mode=print`).expect(400);
    const events = await w.t.db.select().from(schema.events);
    expect(events.filter((e) => e.kind === 'outside_download')).toEqual([]);
    expect(events.filter((e) => e.kind === 'outside_view')).toHaveLength(2);
  });

  it('with download, a file the page cannot show is sent as a download', async () => {
    const boss = await admin();
    const docx = await onPortal(CLIENT, 'letter.docx', Buffer.from('PK letter'));
    const s = await send(boss, [docx], { canDownload: true });
    const pat = await unlock(s);
    const res = await pat.get(`${s.path}/files/${docx}/content?mode=view`).expect(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    const kinds = (await w.t.db.select().from(schema.events)).map((e) => e.kind);
    expect(kinds).toContain('outside_download');
    expect(kinds).not.toContain('outside_view');
  });
});

describe('the ways a secure link stops working (P49)', () => {
  it('staff end it: the verified browser stops at once, and ending it again is fine', async () => {
    const boss = await admin();
    const fileId = await onPortal(CLIENT, 'a.pdf', await realPdf());
    const s = await send(boss, [fileId]);
    const pat = await unlock(s);
    await pat.get(`${s.path}/files/${fileId}/content?mode=view`).expect(200);

    await boss.delete(`/api/staff/v1/shares/${s.id}`).expect(200);
    await boss.delete(`/api/staff/v1/shares/${s.id.toUpperCase()}`).expect(200);
    await boss.delete(`/api/staff/v1/shares/${randomUUID()}`).expect(404);
    await boss.delete('/api/staff/v1/shares/not-an-id').expect(404);

    const file = await pat.get(`${s.path}/files/${fileId}/content?mode=view`);
    expect([file.status, file.body]).toEqual([401, { error: 'not_verified' }]);
    for (const step of ['open', 'code', 'verify']) {
      const res = await pat.post(`${s.path}/${step}`).send({ key: s.key, code: '123456' });
      expect([res.status, res.body], step).toEqual([410, { error: 'share_revoked' }]);
    }
    const list = await boss.get(`/api/staff/v1/shares?clientId=${CLIENT}`).expect(200);
    expect(list.body.shares[0]).toMatchObject({
      status: 'revoked',
      revokedAt: '2026-11-09T15:00:00.000Z',
    });
    const events = await w.t.db.select().from(schema.events);
    expect(events.filter((e) => e.kind === 'outside_share_revoked')).toHaveLength(1);
  });

  it('it expires, though the browser was verified minutes before', async () => {
    const boss = await admin();
    const fileId = await onPortal(CLIENT, 'a.pdf', await realPdf());
    const s = await send(boss, [fileId], { days: 1 });
    w.later(24 * 60 - 10);
    const pat = await unlock(s);
    await pat.get(`${s.path}/files/${fileId}/content?mode=view`).expect(200);
    w.later(10);
    const file = await pat.get(`${s.path}/files/${fileId}/content?mode=view`);
    expect([file.status, file.body]).toEqual([410, { error: 'share_expired' }]);
    const open = await pat.post(`${s.path}/open`).send({ key: s.key });
    expect([open.status, open.body]).toEqual([410, { error: 'share_expired' }]);
    // (The staff session is long over by now: the list's word for it is read from the row.)
    const [row] = await w.t.db.select().from(schema.fileShare);
    expect(row && shareStatus(row, w.ctx.now())).toBe('expired');
  });

  it('a client turned off takes their links with them, until they are on again', async () => {
    const boss = await admin();
    const fileId = await onPortal(CLIENT, 'a.pdf', await realPdf());
    const s = await send(boss, [fileId]);
    const pat = await unlock(s);
    const turn = (active: boolean) =>
      w
        .firm('put', `/clients/${CLIENT}`)
        .send({ clientCode: '1001', displayName: 'Smith, John', active })
        .expect(200);
    await turn(false);
    const file = await pat.get(`${s.path}/files/${fileId}/content?mode=view`);
    expect([file.status, file.body]).toEqual([410, { error: 'share_revoked' }]);
    const open = await pat.post(`${s.path}/open`).send({ key: s.key });
    expect([open.status, open.body]).toEqual([410, { error: 'share_revoked' }]);
    // Nothing new can be sent for them either.
    const more = await boss
      .post('/api/staff/v1/shares')
      .send({ clientId: CLIENT, fileIds: [fileId], email: 'x@first-bank.test' });
    expect([more.status, more.body]).toEqual([409, { error: 'client_inactive' }]);
    await turn(true);
    await pat.get(`${s.path}/files/${fileId}/content?mode=view`).expect(200);
  });

  it('the verified half hour ends; the link then asks for a new code', async () => {
    const boss = await admin();
    const fileId = await onPortal(CLIENT, 'a.pdf', await realPdf());
    const s = await send(boss, [fileId]);
    const pat = await unlock(s);
    w.later(29);
    await pat.get(`${s.path}/files/${fileId}/content?mode=view`).expect(200);
    w.later(1);
    const file = await pat.get(`${s.path}/files/${fileId}/content?mode=view`);
    expect([file.status, file.body]).toEqual([401, { error: 'not_verified' }]);
    const open = await pat.post(`${s.path}/open`).send({ key: s.key }).expect(200);
    expect(open.body.verified).toBe(false);
    expect(open.body.files).toBeUndefined();
    // Housekeeping clears what stopped working.
    expect(await w.t.db.select().from(schema.fileShareGrant)).toHaveLength(1);
    w.later(24 * 60);
    await purgeStale(w.t.db, w.ctx.now());
    expect(await w.t.db.select().from(schema.fileShareGrant)).toEqual([]);
    expect(await w.t.db.select().from(schema.fileShareCode)).toEqual([]);
    // Opening again counts again.
    const back = await unlock(s);
    await back.get(`${s.path}/files/${fileId}/content?mode=view`).expect(200);
    const [row] = await w.t.db.select().from(schema.fileShare);
    expect(row?.opens).toBe(2);
    expect(row?.firstOpenedAt?.toISOString()).toBe('2026-11-09T15:00:00.000Z');
    expect(row?.lastOpenedAt?.toISOString()).toBe('2026-11-10T15:30:00.000Z');
  });

  it("one link's cookie does not open another link", async () => {
    const boss = await admin();
    const a = await onPortal(CLIENT, 'a.pdf', await realPdf());
    const b = await onPortal(CLIENT, 'b.pdf', await realPdf());
    const first = await send(boss, [a]);
    const second = await send(boss, [b]);
    const agent = request.agent(w.app);
    await agent.post(`${first.path}/code`).send({ key: first.key }).expect(200);
    const ok = await agent
      .post(`${first.path}/verify`)
      .send({ key: first.key, code: w.code(LENDER) })
      .expect(200);
    const cookie = ((ok.headers['set-cookie'] as unknown as string[])[0] ?? '').split(';')[0] ?? '';
    await request(w.app)
      .get(`${first.path}/files/${a}/content?mode=view`)
      .set('Cookie', cookie)
      .expect(200);
    const res = await request(w.app)
      .get(`${second.path}/files/${b}/content?mode=view`)
      .set('Cookie', cookie);
    expect([res.status, res.body]).toEqual([401, { error: 'not_verified' }]);
    // Nor a file of the other link through its own.
    await request(w.app)
      .get(`${first.path}/files/${b}/content?mode=view`)
      .set('Cookie', cookie)
      .expect(404);
    // The first link's code is not the second's.
    w.later(2);
    await request(w.app).post(`${first.path}/code`).send({ key: first.key }).expect(200);
    const crossed = await request(w.app)
      .post(`${second.path}/verify`)
      .send({ key: second.key, code: w.code(LENDER) });
    expect([crossed.status, crossed.body]).toEqual([400, { error: 'code_expired' }]);
  });

  it('a file taken off the portal leaves the link', async () => {
    const boss = await admin();
    const a = await onPortal(CLIENT, 'a.pdf', await realPdf());
    const b = await onPortal(CLIENT, 'b.pdf', await realPdf());
    const s = await send(boss, [a, b]);
    const pat = await unlock(s);
    await w.firm('delete', `/files/${a}`).expect(200);
    await pat.get(`${s.path}/files/${a}/content?mode=view`).expect(404);
    await pat.get(`${s.path}/files/${b}/content?mode=view`).expect(200);
    const open = await pat.post(`${s.path}/open`).send({ key: s.key }).expect(200);
    expect(open.body.count).toBe(1);
    expect(open.body.files.map((f: { name: string }) => f.name)).toEqual(['b.pdf']);
    const list = await boss.get(`/api/staff/v1/shares?clientId=${CLIENT}`).expect(200);
    expect(list.body.shares[0].files).toEqual([
      { fileId: a, name: 'a.pdf', removed: true, downloads: 0 },
      { fileId: b, name: 'b.pdf', removed: false, downloads: 0 },
    ]);
    // And cannot be sent anew.
    const more = await boss
      .post('/api/staff/v1/shares')
      .send({ clientId: CLIENT, fileIds: [a], email: LENDER });
    expect([more.status, more.body]).toEqual([400, { error: 'file_not_found' }]);
  });
});

describe('access codes (P49)', () => {
  it('one a minute; a new code ends the one before; a code lasts ten minutes', async () => {
    const boss = await admin();
    const s = await send(boss, [await onPortal(CLIENT, 'a.pdf', await realPdf())]);
    const post = (step: string, more: object = {}) =>
      request(w.app)
        .post(`${s.path}/${step}`)
        .send({ key: s.key, ...more });
    await post('code').expect(200);
    const first = w.code(LENDER);
    const soon = await post('code');
    expect([soon.status, soon.body]).toEqual([429, { error: 'code_wait' }]);
    w.later(1);
    await post('code').expect(200);
    const second = w.code(LENDER);
    if (first !== second) {
      const old = await post('verify', { code: first });
      expect([old.status, old.body]).toEqual([400, { error: 'code_wrong' }]);
    }
    w.later(10);
    const late = await post('verify', { code: second });
    expect([late.status, late.body]).toEqual([400, { error: 'code_expired' }]);
    // No code asked for at all.
    const other = await send(boss, [await onPortal(CLIENT, 'b.pdf', await realPdf())]);
    const none = await request(w.app)
      .post(`${other.path}/verify`)
      .send({ key: other.key, code: '123456' });
    expect([none.status, none.body]).toEqual([400, { error: 'code_expired' }]);
  });

  it('ten codes a day for one link', async () => {
    const boss = await admin();
    const s = await send(boss, [await onPortal(CLIENT, 'a.pdf', await realPdf())]);
    for (let i = 0; i < 10; i++) {
      await request(w.app).post(`${s.path}/code`).send({ key: s.key }).expect(200);
      w.later(2);
    }
    const res = await request(w.app).post(`${s.path}/code`).send({ key: s.key });
    expect([res.status, res.body]).toEqual([429, { error: 'too_many_codes' }]);
    expect(w.notes.sent.filter((m) => m.subject === 'Your document access code')).toHaveLength(10);
  });

  it('five wrong tries use a code up; fifteen end the link', async () => {
    const boss = await admin();
    const fileId = await onPortal(CLIENT, 'a.pdf', await realPdf());
    const s = await send(boss, [fileId]);
    const post = (step: string, more: object = {}) =>
      request(w.app)
        .post(`${s.path}/${step}`)
        .send({ key: s.key, ...more });
    const tries = async (n: number): Promise<string[]> => {
      await post('code').expect(200);
      const right = w.code(LENDER);
      const out: string[] = [];
      for (let i = 0; i < n; i++) {
        const res = await post('verify', { code: wrongFor(right) });
        out.push(`${res.status} ${res.body.error}`);
      }
      return out;
    };
    expect(await tries(5)).toEqual([
      '400 code_wrong',
      '400 code_wrong',
      '400 code_wrong',
      '400 code_wrong',
      '400 code_locked',
    ]);
    // The right code is no good now either.
    const spent = await post('verify', { code: w.code(LENDER) });
    expect([spent.status, spent.body]).toEqual([400, { error: 'code_expired' }]);

    // A right code starts the count again.
    w.later(2);
    await post('code').expect(200);
    await post('verify', { code: w.code(LENDER) }).expect(200);
    expect((await w.t.db.select().from(schema.fileShare))[0]?.wrongTries).toBe(0);

    w.later(2);
    expect((await tries(5)).at(-1)).toBe('400 code_locked');
    w.later(2);
    // Four tries of each code, then a new one, gets no further.
    expect(await tries(4)).toEqual(Array(4).fill('400 code_wrong'));
    w.later(2);
    expect(await tries(4)).toEqual(Array(4).fill('400 code_wrong'));
    w.later(2);
    expect(await tries(3)).toEqual(['400 code_wrong', '410 share_locked', '410 share_locked']);

    const open = await post('open');
    expect([open.status, open.body]).toEqual([410, { error: 'share_locked' }]);
    const list = await boss.get(`/api/staff/v1/shares?clientId=${CLIENT}`).expect(200);
    expect(list.body.shares[0].status).toBe('locked');
    const events = await w.t.db.select().from(schema.events);
    const locked = events.filter((e) => e.kind === 'outside_locked');
    expect(locked).toHaveLength(1);
    expect(locked[0]).toMatchObject({ actorKind: 'system', clientId: CLIENT });
    expect(await w.t.db.select().from(schema.fileShareGrant)).toEqual([]);
  });

  it('a code that could not be emailed is not left to guess at', async () => {
    const boss = await admin();
    const s = await send(boss, [await onPortal(CLIENT, 'a.pdf', await realPdf())]);
    const real = w.ctx.notifier.send;
    w.ctx.notifier.send = async () => {
      throw new Error('smtp down');
    };
    const res = await request(w.app).post(`${s.path}/code`).send({ key: s.key });
    w.ctx.notifier.send = real;
    expect([res.status, res.body]).toEqual([502, { error: 'email_failed' }]);
    expect(await w.t.db.select().from(schema.fileShareCode)).toEqual([]);
  });
});

describe('what staff may send (P49)', () => {
  it('only files of that client, still on the portal, to a real address, for 1 to 90 days', async () => {
    const boss = await admin();
    const mine = await onPortal(CLIENT, 'a.pdf', await realPdf());
    const theirs = await onPortal(OTHER, 'b.pdf', await realPdf());
    const docx = await onPortal(CLIENT, 'letter.docx', Buffer.from('PK letter'));
    const base = { clientId: CLIENT, fileIds: [mine], email: LENDER };
    const tries: [object, number, string][] = [
      [{ ...base, fileIds: [theirs] }, 400, 'file_not_found'],
      [{ ...base, fileIds: [mine, theirs] }, 400, 'file_not_found'],
      [{ ...base, fileIds: [randomUUID()] }, 400, 'file_not_found'],
      [{ ...base, fileIds: [] }, 400, 'invalid'],
      [{ ...base, fileIds: Array.from({ length: 21 }, () => randomUUID()) }, 400, 'invalid'],
      [{ ...base, email: 'not an address' }, 400, 'invalid_email'],
      [{ ...base, days: 0 }, 400, 'invalid'],
      [{ ...base, days: 91 }, 400, 'invalid'],
      [{ ...base, days: 1.5 }, 400, 'invalid'],
      [{ ...base, clientId: randomUUID() }, 404, 'client_not_found'],
      // View only is for what the page can show.
      [{ ...base, fileIds: [mine, docx] }, 400, 'view_only_needs_preview'],
    ];
    for (const [send, status, error] of tries) {
      const res = await boss.post('/api/staff/v1/shares').send(send);
      expect([res.status, res.body.error], JSON.stringify(send)).toEqual([status, error]);
    }
    expect(await w.t.db.select().from(schema.fileShare)).toEqual([]);
    expect(w.notes.sent.filter((m) => m.to === LENDER)).toEqual([]);
    // The same file named twice is one file.
    await send(boss, [mine, mine.toUpperCase()]);
    expect(await w.t.db.select().from(schema.fileShareItem)).toHaveLength(1);
    // A line break in a name does not reach the email as one.
    await send(boss, [mine], { name: 'Pat\nRoe', email: 'q@first-bank.test' });
    expect(w.notes.last('q@first-bank.test').body).toContain('Hello Pat Roe,');
  });

  it('only the staff page, signed in; Vibe Files has no such call', async () => {
    const boss = await admin();
    const fileId = await onPortal(CLIENT, 'a.pdf', await realPdf());
    const s = await send(boss, [fileId]);
    const send1 = { clientId: CLIENT, fileIds: [fileId], email: LENDER };
    await request(w.app).post('/api/staff/v1/shares').send(send1).expect(401);
    await request(w.app).get(`/api/staff/v1/shares?clientId=${CLIENT}`).expect(401);
    await request(w.app).delete(`/api/staff/v1/shares/${s.id}`).expect(401);
    await w.firm('post', '/shares').send(send1).expect(404);
    await w.firm('get', `/shares?clientId=${CLIENT}`).expect(404);
    await w.firm('delete', `/shares/${s.id}`).expect(404);
    // A client's person is not staff.
    const person = await w.member('a@example.test', CLIENT);
    await person.agent.post('/api/staff/v1/shares').send(send1).expect(401);
    expect(await w.t.db.select().from(schema.fileShare)).toHaveLength(1);
  });

  it('staff limited to some clients send, see and end links for those alone (P48)', async () => {
    const boss = await admin();
    const made = await boss
      .post('/api/staff/v1/staff')
      .send({ email: 'mary@example-cpa.test', name: 'Mary', clientIds: [CLIENT] })
      .expect(201);
    const mary = await finish(made.body.setupLink as string);
    const mine = await onPortal(CLIENT, 'a.pdf', await realPdf());
    const theirs = await onPortal(OTHER, 'b.pdf', await realPdf());
    const res = await boss
      .post('/api/staff/v1/shares')
      .send({ clientId: OTHER, fileIds: [theirs], email: LENDER })
      .expect(201);
    const hidden = res.body.shareId as string;

    const no = await mary
      .post('/api/staff/v1/shares')
      .send({ clientId: OTHER, fileIds: [theirs], email: LENDER });
    expect([no.status, no.body]).toEqual([404, { error: 'client_not_found' }]);
    const list = await mary.get(`/api/staff/v1/shares?clientId=${OTHER}`);
    expect([list.status, list.body]).toEqual([404, { error: 'client_not_found' }]);
    await mary.delete(`/api/staff/v1/shares/${hidden}`).expect(404);
    expect((await w.t.db.select().from(schema.fileShare))[0]?.revokedAt).toBeNull();

    await mary
      .post('/api/staff/v1/shares')
      .send({ clientId: CLIENT, fileIds: [mine], email: LENDER })
      .expect(201);
    const hers = await mary.get(`/api/staff/v1/shares?clientId=${CLIENT}`).expect(200);
    expect(hers.body.shares).toHaveLength(1);
    expect(hers.body.shares[0].createdBy).toBe('mary@example-cpa.test');
    await mary.delete(`/api/staff/v1/shares/${hers.body.shares[0].id as string}`).expect(200);
    // Her history has her own client's links, not the other's.
    const events = (await mary.get('/api/staff/v1/events?since=0').expect(200)).body.events as {
      kind: string;
      clientId: string;
    }[];
    const outside = events.filter((e) => e.kind.startsWith('outside_'));
    expect(outside.map((e) => e.kind)).toEqual(['outside_share', 'outside_share_revoked']);
    expect(outside.every((e) => e.clientId === CLIENT)).toBe(true);
  });

  it('one recipient holds five links at a time', async () => {
    const boss = await admin();
    const fileId = await onPortal(CLIENT, 'a.pdf', await realPdf());
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await send(boss, [fileId])).id);
    const sixth = await boss
      .post('/api/staff/v1/shares')
      .send({ clientId: CLIENT, fileIds: [fileId], email: 'PAT@first-bank.test' });
    expect([sixth.status, sixth.body]).toEqual([429, { error: 'recipient_has_too_many' }]);
    // Someone else is not held up, and an ended link makes room.
    await send(boss, [fileId], { email: 'lee@first-bank.test' });
    await boss.delete(`/api/staff/v1/shares/${ids[0] ?? ''}`).expect(200);
    await send(boss, [fileId]);
    // So does one that ran out.
    const full = await boss
      .post('/api/staff/v1/shares')
      .send({ clientId: CLIENT, fileIds: [fileId], email: LENDER });
    expect(full.status).toBe(429);
    await w.t.db
      .update(schema.fileShare)
      .set({ expiresAt: w.ctx.now() })
      .where(eq(schema.fileShare.id, ids[1] ?? ''));
    await send(boss, [fileId]);
  });

  it('a link whose email could not be sent does not exist', async () => {
    const boss = await admin();
    const fileId = await onPortal(CLIENT, 'a.pdf', await realPdf());
    const real = w.ctx.notifier.send;
    w.ctx.notifier.send = async () => {
      throw new Error('smtp down');
    };
    const res = await boss
      .post('/api/staff/v1/shares')
      .send({ clientId: CLIENT, fileIds: [fileId], email: LENDER });
    w.ctx.notifier.send = real;
    expect([res.status, res.body]).toEqual([502, { error: 'email_failed' }]);
    expect(await w.t.db.select().from(schema.fileShare)).toEqual([]);
    expect(await w.t.db.select().from(schema.fileShareItem)).toEqual([]);
    expect((await w.t.db.select().from(schema.events)).map((e) => e.kind)).not.toContain(
      'outside_share',
    );
  });
});

describe('the watermark (P49)', () => {
  it('says who and when, in letters the font has', () => {
    const on = new Date('2026-11-10T03:00:00Z');
    expect(watermarkText({ name: 'Pat Roe', email: LENDER, organization: 'First Bank' }, on)).toBe(
      'Pat Roe \xb7 First Bank \xb7 viewed 2026-11-10',
    );
    expect(watermarkText({ name: '', email: LENDER, organization: '' }, on)).toBe(
      `${LENDER} \xb7 viewed 2026-11-10`,
    );
    expect(
      watermarkText(
        { name: `Jos\xe9 ${String.fromCharCode(0x6f22, 0x5b57)}`, email: LENDER, organization: '' },
        on,
      ),
    ).toBe('Jos\xe9 ?? \xb7 viewed 2026-11-10');
    const long = watermarkText({ name: 'x'.repeat(300), email: LENDER, organization: '' }, on);
    expect(long).toHaveLength(120);
    expect(long.endsWith('...')).toBe(true);
  });

  it('marks every page, and refuses what is not a PDF it can read', async () => {
    const out = await watermarkPdf(await realPdf(3), 'Pat Roe \xb7 viewed 2026-11-10');
    const pdf = await PDFDocument.load(out);
    expect(pdf.getPageCount()).toBe(3);
    await expect(watermarkPdf(Buffer.from('%PDF d1'), 'x')).rejects.toThrow();
    await expect(watermarkPdf(Buffer.from('hello'), 'x')).rejects.toThrow();
  });

  it('a marked link sends marked PDFs, viewed or downloaded, and other files as they are', async () => {
    const boss = await admin();
    const original = await realPdf();
    const pdf = await onPortal(CLIENT, 'a.pdf', original);
    const png = await onPortal(CLIENT, 'scan.png', Buffer.from('89504e470d0a1a0a', 'hex'));
    const s = await send(boss, [pdf, png], { watermark: true, canDownload: true, name: 'Pat Roe' });
    const pat = await unlock(s);
    for (const mode of ['view', 'download']) {
      const res = await pat.get(`${s.path}/files/${pdf}/content?mode=${mode}`).buffer(true);
      expect(res.status, mode).toBe(200);
      const got = res.body as Buffer;
      expect(Number(res.headers['content-length'])).toBe(got.length);
      expect(Buffer.compare(got, original)).not.toBe(0);
      expect((await PDFDocument.load(got)).getPageCount()).toBe(2);
      expect(res.headers['content-disposition']).toMatch(
        mode === 'view' ? /^inline;/ : /^attachment;/,
      );
      expect(res.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
    }
    const img = await pat.get(`${s.path}/files/${png}/content?mode=view`).buffer(true);
    expect((img.body as Buffer).toString('hex')).toBe('89504e470d0a1a0a');
    const kinds = (await w.t.db.select().from(schema.events)).map((e) => e.kind);
    expect(kinds.filter((k) => k === 'outside_view')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'outside_download')).toHaveLength(1);
  });

  it('a PDF that cannot be marked is refused when the link is made, and never sent unmarked', async () => {
    const boss = await admin();
    const bad = await onPortal(CLIENT, 'locked.pdf', Buffer.from('%PDF d1'));
    const res = await boss
      .post('/api/staff/v1/shares')
      .send({ clientId: CLIENT, fileIds: [bad], email: LENDER, watermark: true });
    expect([res.status, res.body]).toEqual([400, { error: 'cannot_watermark' }]);
    expect(await w.t.db.select().from(schema.fileShare)).toEqual([]);

    // A good PDF whose content Vibe Files then replaces with one that cannot be marked.
    const good = await onPortal(CLIENT, 'a.pdf', await realPdf());
    const s = await send(boss, [good], { watermark: true });
    const pat = await unlock(s);
    await pat.get(`${s.path}/files/${good}/content?mode=view`).expect(200);
    await w.t.db
      .update(schema.files)
      .set({ contentType: 'application/pdf', blobKey: null, dekWrapped: null })
      .where(eq(schema.files.id, good));
    await pat.get(`${s.path}/files/${good}/content?mode=view`).expect(404);
    const [stored] = await w.t.db.select().from(schema.files).where(eq(schema.files.id, bad));
    await w.t.db
      .update(schema.files)
      .set({ blobKey: stored?.blobKey ?? null, dekWrapped: stored?.dekWrapped ?? null, size: 7 })
      .where(eq(schema.files.id, good));
    const refused = await pat.get(`${s.path}/files/${good}/content?mode=view`);
    expect([refused.status, refused.body]).toEqual([422, { error: 'watermark_failed' }]);
    const views = (await w.t.db.select().from(schema.events)).filter(
      (e) => e.kind === 'outside_view',
    );
    expect(views).toHaveLength(1);
  });
});

describe('the upgrade (P49)', () => {
  it('the history takes a recipient as who did it, and nothing else new', async () => {
    const pg = new PGlite();
    try {
      const all = listMigrations();
      const at = all.findIndex((m) => m.name.startsWith('0009_'));
      expect(at).toBeGreaterThan(0);
      await migrate(pgliteTarget(pg), all.slice(0, at));
      await pg.query(
        `INSERT INTO events (kind, actor_kind, actor) VALUES ('view', 'client', 'someone')`,
      );
      await expect(
        pg.query(`INSERT INTO events (kind, actor_kind, actor) VALUES ('view', 'recipient', 'x')`),
      ).rejects.toThrow();
      await migrate(pgliteTarget(pg), all);
      await pg.query(
        `INSERT INTO events (kind, actor_kind, actor) VALUES ('outside_view', 'recipient', 'x')`,
      );
      await expect(
        pg.query(`INSERT INTO events (kind, actor_kind, actor) VALUES ('view', 'nobody', 'x')`),
      ).rejects.toThrow();
      const n = await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM events');
      expect(n.rows[0]?.n).toBe(2);
    } finally {
      await pg.close();
    }
  });
});
