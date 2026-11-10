// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Phase 7 security review fixes.

import { schema } from '@vibe-portal/db';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { purgeStale } from '../lib/housekeeping';
import { TRUST_CF_IP } from '../lib/http';
import { shortText } from '../lib/notify';
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
