// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Phase 7 security review fixes.

import { createHash, randomUUID } from 'node:crypto';

import { schema } from '@vibe-portal/db';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { purgeStale } from '../lib/housekeeping';
import { isUsCanadaPhone } from '../lib/contact';
import { TRUST_CF_IP } from '../lib/http';
import { shortText } from '../lib/notify';
import { WAITING_MAX_BYTES } from '../portal/uploads';
import { CLIENT, OTHER, world, type World } from './harness';

let w: World;
beforeEach(async () => {
  w = await world();
});
afterEach(async () => {
  await w.close();
});

describe('Phase 7', () => {
  it('a phone typed beside an email is not a way to sign in as that person (P45)', async () => {
    await w
      .firm('post', `/clients/${CLIENT}/invites`)
      .send({ email: 'a@example.test', phone: '5550001111' })
      .expect(201);
    await request(w.app)
      .post('/api/portal/invitations/accept')
      .send({ token: w.linkToken('a@example.test') })
      .expect(200);
    const [a] = await w.t.db.select().from(schema.portalIdentity);
    expect(a).toMatchObject({ email: 'a@example.test', phone: null });
    // Someone else invited by that phone to another client gets an account of their own.
    await w.firm('post', `/clients/${OTHER}/invites`).send({ phone: '5550001111' }).expect(201);
    await request(w.app)
      .post('/api/portal/invitations/accept')
      .send({ token: w.linkToken('+15550001111') })
      .expect(200);
    const ids = await w.t.db.select().from(schema.portalIdentity);
    expect(ids).toHaveLength(2);
  });

  it("strangers asking for someone's sign-in do not use up theirs", async () => {
    await w.member('victim@example.test');
    w.app.set(TRUST_CF_IP, true);
    const ask = (ip: string) =>
      request(w.app)
        .post('/api/portal/auth/login')
        .set('CF-Connecting-IP', ip)
        .send({ contact: 'victim@example.test' })
        .expect(200);
    for (let i = 0; i < 6; i++) await ask('203.0.113.9');
    const count = () => w.notes.sent.filter((m) => m.to === 'victim@example.test').length;
    const before = count();
    await ask('198.51.100.7');
    expect(count()).toBe(before + 1);
  });

  it('a text never cuts its link', () => {
    const url = `https://files.example-cpa.test/invite#t=${'x'.repeat(43)}`;
    const body = `${'A very long firm name and a trust client name '.repeat(6)}: ${url}`;
    const t = shortText(body);
    expect(t.length).toBeLessThanOrEqual(300);
    expect(t.endsWith(url)).toBe(true);
    expect(shortText('short')).toBe('short');
  });

  it('housekeeping deletes old counters, links, sessions and unconfirmed requests', async () => {
    const old = new Date(w.ctx.now().getTime() - 8 * 24 * 3_600_000);
    await w.t.db.insert(schema.rateLimit).values({ bucket: 'x', windowStart: old, hits: 1 });
    await w.t.db.insert(schema.accessRequest).values({
      name: 'Old',
      email: 'old@example.test',
      clientAs: 'x',
      createdAt: old,
    });
    await purgeStale(w.t.db, w.ctx.now());
    expect(await w.t.db.select().from(schema.rateLimit)).toHaveLength(0);
    expect(await w.t.db.select().from(schema.accessRequest)).toHaveLength(0);
  });
});

describe('P47', () => {
  const send = (agent: ReturnType<typeof request.agent>, headers: Record<string, string> = {}) => {
    let r = agent
      .post(`/api/portal/uploads?clientId=${CLIENT}&batchId=${randomUUID()}`)
      .set('Content-Type', 'application/octet-stream');
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    return r.send(Buffer.from('%PDF-1.7 test'));
  };

  it('names and notes travel in headers, not the URL', async () => {
    const m = await w.member('a@example.test');
    const up = await send(m.agent, {
      'X-Vibe-Name': encodeURIComponent('Révisé W-2.pdf'),
      'X-Vibe-Note': encodeURIComponent('for 2025 & more'),
    }).expect(201);
    expect(up.body.name).toBe('Révisé W-2.pdf');
    const [row] = await w.t.db.select().from(schema.uploads);
    expect(row?.note).toBe('for 2025 & more');
    await send(m.agent, { 'X-Vibe-Name': '%E0%A4%A' }).expect(400);
    // Vibe Files' firm API too.
    const pdf = Buffer.from('%PDF x');
    const sha = createHash('sha256').update(pdf).digest('hex');
    await w
      .firm('post', `/files?clientId=${CLIENT}&vfDocumentId=d1&sha256=${sha}`)
      .set('X-Vibe-Name', encodeURIComponent('Smith 2025.pdf'))
      .set('Content-Type', 'application/octet-stream')
      .send(pdf)
      .expect(201);
    const [file] = await w.t.db.select().from(schema.files);
    expect(file?.name).toBe('Smith 2025.pdf');
  });

  it('new batches cannot get past the daily limit, or fill the disk while nobody collects', async () => {
    const m = await w.member('a@example.test');
    const day = 24 * 60 * 60 * 1000;
    await w.t.db.insert(schema.rateLimit).values({
      bucket: `upload:identity-day:${m.id}`,
      windowStart: new Date(Math.floor(w.ctx.now().getTime() / day) * day),
      hits: 300,
    });
    await send(m.agent, { 'X-Vibe-Name': 'a.pdf' }).expect(429);

    const n = await w.member('b@example.test');
    await w.t.db.insert(schema.uploads).values({
      clientId: CLIENT,
      identityId: n.id,
      name: 'big.pdf',
      size: WAITING_MAX_BYTES,
      sha256: '0'.repeat(64),
    });
    const full = await send(n.agent, { 'X-Vibe-Name': 'b.pdf' }).expect(429);
    expect(full.body.error).toBe('too_much_waiting');
  });

  it('the access-request page only texts US and Canadian numbers', async () => {
    expect(isUsCanadaPhone('+15555550100')).toBe(true);
    expect(isUsCanadaPhone('+14165550100')).toBe(true); // Toronto
    expect(isUsCanadaPhone('+18765550100')).toBe(false); // Jamaica
    expect(isUsCanadaPhone('+447700900123')).toBe(false);
    const abroad = await request(w.app)
      .post('/api/portal/access-requests')
      .send({ name: 'X', phone: '+44 7700 900123', clientAs: 'X' })
      .expect(400);
    expect(abroad.body.error).toBe('phone_us_only');
    await request(w.app)
      .post('/api/portal/access-requests')
      .send({ name: 'X', phone: '(555) 555-0100', clientAs: 'X' })
      .expect(201);
  });
});
