// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Phase 2 gate (BUILD_PLAN.md §7): invite -> accept -> sign in -> sign out, by email and by
// text; request -> confirm -> approve -> sign in; a revoked firm key is refused. Plus the rules
// around them: sessions (P11, P12), one-time codes, rate limits, the event history (P15).

import { eq } from 'drizzle-orm';
import { schema } from '@vibe-portal/db';
import { createTestDb, type TestDb } from '@vibe-portal/db/testing';
import pino from 'pino';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { rm } from 'node:fs/promises';

import { createApp } from '../app';
import type { Ctx } from '../context';
import { createFirmKey, revokeFirmKey } from '../firm/keys';
import { recordingNotifier } from '../lib/notify';
import { fileServices, sendId } from './harness';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const T0 = new Date('2026-11-09T15:00:00Z');

let t: TestDb;
let clock: Date;
let notes: ReturnType<typeof recordingNotifier>;
let app: ReturnType<typeof createApp>;
let key: string;
let files: Awaited<ReturnType<typeof fileServices>>;

function later(minutes: number): void {
  clock = new Date(clock.getTime() + minutes * 60_000);
}

function firm(method: 'get' | 'put' | 'post' | 'patch' | 'delete', path: string, k = key) {
  return request(app)
    [method](`/api/firm/v1${path}`)
    .set('Authorization', `Bearer ${k}`)
    .set('X-Vibe-PC', 'THGR18C-XA003')
    .set('X-Vibe-User', 'kurt');
}

function linkToken(to: string): string {
  const m = /#t=([\w-]+)/.exec(notes.last(to).body);
  if (!m?.[1]) throw new Error(`no link in message to ${to}`);
  return m[1];
}

function code(to: string): string {
  const m = /\b(\d{6})\b/.exec(notes.last(to).body);
  if (!m?.[1]) throw new Error(`no code in message to ${to}`);
  return m[1];
}

async function invite(contact: { email?: string; phone?: string }, clientId = CLIENT) {
  const res = await firm('post', `/clients/${clientId}/invites`).send({
    ...contact,
    name: 'John Smith',
    roleLabel: 'Taxpayer',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { invitationId: string };
}

beforeEach(async () => {
  t = await createTestDb();
  clock = T0;
  notes = recordingNotifier();
  files = await fileServices(t.db);
  const ctx: Ctx = {
    db: t.db,
    notifier: notes,
    log: pino({ level: 'silent' }),
    now: () => clock,
    portalUrl: 'https://files.example-cpa.test',
    cookie: { secure: false },
    trustCfIp: false,
    keyring: files.keyring,
    blobs: files.blobs,
  };
  app = createApp({ pingDb: async () => true, ctx });
  await t.db.update(schema.firm).set({ name: 'Example CPA' });
  key = (await createFirmKey(t.db, 'Office')).key;
  for (const [id, name] of [
    [CLIENT, 'Smith, John'],
    [OTHER, 'Smith Farms LLC'],
  ] as const) {
    const res = await firm('put', `/clients/${id}`).send({ clientCode: '1001', displayName: name });
    expect(res.status).toBe(200);
  }
});

afterEach(async () => {
  await t.close();
  await rm(files.dir, { recursive: true, force: true });
});

describe('firm key', () => {
  it('a live key works; missing, wrong and revoked keys are refused', async () => {
    const ok = await firm('get', '/status');
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ firmName: 'Example CPA' });

    expect((await request(app).get('/api/firm/v1/status')).status).toBe(401);
    expect((await firm('get', '/status', 'vpk_wrong')).status).toBe(401);

    const [row] = await t.db.select().from(schema.firmKeys);
    await revokeFirmKey(t.db, row?.id ?? '', clock);
    const revoked = await firm('get', '/status');
    expect(revoked.status).toBe(401);
    expect(revoked.body).toEqual({ error: 'bad_firm_key' });
  });

  it('repeated wrong keys from one address are blocked, but never the right key', async () => {
    for (let i = 0; i < 20; i++) await firm('get', '/status', 'vpk_wrong');
    expect((await firm('get', '/status', 'vpk_wrong')).status).toBe(429);
    expect((await firm('get', '/status')).status).toBe(200);
  });

  it('records the PC and Windows user on what Vibe Files does (P15)', async () => {
    await invite({ email: 'john@example.test' });
    const [ev] = await t.db.select().from(schema.events).where(eq(schema.events.kind, 'invite'));
    expect(ev).toMatchObject({ actorKind: 'firm_key', actor: 'THGR18C-XA003\\kurt' });
  });
});

describe('invite -> accept -> sign in -> sign out', () => {
  it('by email', async () => {
    await invite({ email: 'John@Example.test' });
    const msg = notes.last('john@example.test');
    expect(msg.channel).toBe('email');
    expect(msg.body).toContain('https://files.example-cpa.test/invite#t=');
    const token = linkToken('john@example.test');

    const preview = await request(app).post('/api/portal/invitations/preview').send({ token });
    expect(preview.body).toEqual({
      firmName: 'Example CPA',
      clientName: 'Smith, John',
      name: 'John Smith',
      contact: 'j***@example.test',
      alsoPhone: null,
    });

    const agent = request.agent(app);
    expect((await agent.post('/api/portal/invitations/accept').send({ token })).status).toBe(200);
    const me = await agent.get('/api/portal/auth/me');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      identity: { email: 'john@example.test', name: 'John Smith' },
      clients: [{ id: CLIENT, name: 'Smith, John' }],
      activeClientId: CLIENT,
    });

    // The invitation works once.
    expect((await request(app).post('/api/portal/invitations/accept').send({ token })).status).toBe(
      404,
    );

    expect((await agent.post('/api/portal/auth/logout')).status).toBe(200);
    expect((await agent.get('/api/portal/auth/me')).status).toBe(401);

    const login = await agent.post('/api/portal/auth/login').send({ contact: 'john@example.test' });
    expect(login.body.kind).toBe('email');
    const link = linkToken('john@example.test');
    expect(notes.last('john@example.test').body).toContain('/auth/verify#t=');
    expect((await agent.post('/api/portal/auth/verify-link').send({ token: link })).status).toBe(
      200,
    );
    expect((await agent.get('/api/portal/auth/me')).status).toBe(200);
    // A sign-in link works once.
    expect(
      (await request(app).post('/api/portal/auth/verify-link').send({ token: link })).body,
    ).toEqual({ error: 'link_expired' });
  });

  it('by text', async () => {
    await invite({ phone: '(555) 201-3344' });
    const msg = notes.last('+15552013344');
    expect(msg.channel).toBe('sms');
    const agent = request.agent(app);
    await agent
      .post('/api/portal/invitations/accept')
      .send({ token: linkToken('+15552013344'), name: 'John' })
      .expect(200);
    await agent.post('/api/portal/auth/logout').expect(200);

    const login = await agent.post('/api/portal/auth/login').send({ contact: '555-201-3344' });
    expect(login.body.kind).toBe('phone');
    await agent
      .post('/api/portal/auth/verify-code')
      .send({ phone: '5552013344', code: code('+15552013344') })
      .expect(200);
    const me = await agent.get('/api/portal/auth/me').expect(200);
    expect(me.body.identity).toMatchObject({ phone: '+15552013344', name: 'John' });
  });

  it('an expired or withdrawn invitation cannot be accepted; Resend replaces the old link', async () => {
    await invite({ email: 'a@example.test' });
    const first = linkToken('a@example.test');
    await invite({ email: 'a@example.test' });
    const second = linkToken('a@example.test');
    expect(
      (await request(app).post('/api/portal/invitations/accept').send({ token: first })).status,
    ).toBe(404);

    later(7 * 24 * 60 + 1);
    expect(
      (await request(app).post('/api/portal/invitations/accept').send({ token: second })).status,
    ).toBe(404);
    const users = await firm('get', `/clients/${CLIENT}/users`).expect(200);
    expect(users.body.invitations).toEqual([
      expect.objectContaining({ email: 'a@example.test', status: 'expired' }),
    ]);
  });

  it('cannot invite someone who already has access; can add them to another client', async () => {
    await invite({ email: 'a@example.test' });
    await request(app)
      .post('/api/portal/invitations/accept')
      .send({ token: linkToken('a@example.test') })
      .expect(200);
    const again = await firm('post', `/clients/${CLIENT}/invites`).send({
      email: 'a@example.test',
    });
    expect(again.status).toBe(409);

    await invite({ email: 'a@example.test' }, OTHER);
    const agent = request.agent(app);
    await agent
      .post('/api/portal/invitations/accept')
      .send({ token: linkToken('a@example.test') })
      .expect(200);
    const me = await agent.get('/api/portal/auth/me').expect(200);
    expect(me.body.clients.map((c: { id: string }) => c.id).sort()).toEqual([CLIENT, OTHER].sort());
    await agent.post('/api/portal/auth/switch-client').send({ clientId: OTHER }).expect(200);
    expect((await agent.get('/api/portal/auth/me')).body.activeClientId).toBe(OTHER);
    // Only one identity for the person.
    expect(await t.db.select().from(schema.portalIdentity)).toHaveLength(1);
  });

  it('P63: people on the portal are found by name, email or number, with their clients', async () => {
    await invite({ email: 'a@example.test' });
    await request(app)
      .post('/api/portal/invitations/accept')
      .send({ token: linkToken('a@example.test') })
      .expect(200);
    await t.db.insert(schema.portalIdentity).values([
      { name: 'Pat Lee', phone: '+15552010001' },
      { name: 'Pat Gone', email: 'gone@example.test', status: 'disabled' },
      { name: '100% Owner', email: 'pct@example.test' },
    ]);
    const find = async (q: string) =>
      (await firm('get', `/people?q=${encodeURIComponent(q)}`).expect(200)).body.people as {
        name: string;
        email: string | null;
        phone: string | null;
        clients: { id: string; name: string }[];
      }[];

    // By name, any case, every word; with the clients they can see.
    const john = await find('john SMITH');
    expect(john).toHaveLength(1);
    expect(john[0]).toMatchObject({ name: 'John Smith', email: 'a@example.test' });
    expect(john[0]?.clients).toEqual([{ id: CLIENT, name: 'Smith, John' }]);
    expect((await find('a@example'))[0]?.name).toBe('John Smith');
    // A number typed as people write it; a turned-off account is not offered.
    expect((await find('(555) 201-0001')).map((p) => p.name)).toEqual(['Pat Lee']);
    expect((await find('pat')).map((p) => p.name)).toEqual(['Pat Lee']);
    // LIKE's own characters are plain text ("100" alone is also in Pat's number).
    expect((await find('100% own')).map((p) => p.name)).toEqual(['100% Owner']);
    expect(await find('_%')).toEqual([]);
    expect(await find('nobody')).toEqual([]);
    // Never the whole list: one letter is refused.
    const short = await firm('get', '/people?q=a');
    expect(short.status).toBe(400);
    expect((await firm('get', '/people')).status).toBe(400);
  });
});

describe('sign-in rules', () => {
  async function signedIn(keepSignedIn: boolean) {
    await invite({ email: 'k@example.test' });
    const agent = request.agent(app);
    await agent
      .post('/api/portal/invitations/accept')
      .send({ token: linkToken('k@example.test'), keepSignedIn })
      .expect(200);
    return agent;
  }

  it('signs out after 30 minutes idle unless "keep me signed in" (P12)', async () => {
    const plain = await signedIn(false);
    later(29);
    await plain.get('/api/portal/auth/me').expect(200);
    later(29);
    await plain.get('/api/portal/auth/me').expect(200);
    later(31);
    await plain.get('/api/portal/auth/me').expect(401);
  });

  it('a kept session lasts 7 days, then ends (P11)', async () => {
    const kept = await signedIn(true);
    later(60 * 24 * 3);
    await kept.get('/api/portal/auth/me').expect(200);
    later(60 * 24 * 4 + 1);
    await kept.get('/api/portal/auth/me').expect(401);
  });

  it('the answer to an unknown email is the same, and nothing is sent', async () => {
    const res = await request(app)
      .post('/api/portal/auth/login')
      .send({ contact: 'nobody@example.test' })
      .expect(200);
    expect(res.body.message).toMatch(/If that email or phone has access/);
    expect(notes.sent).toHaveLength(0);
  });

  it('a text code allows 5 tries, then stops working', async () => {
    await invite({ phone: '5550001111' });
    await request(app)
      .post('/api/portal/invitations/accept')
      .send({ token: linkToken('+15550001111') })
      .expect(200);
    await request(app).post('/api/portal/auth/login').send({ contact: '5550001111' }).expect(200);
    const right = code('+15550001111');
    const wrong = right === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post('/api/portal/auth/verify-code')
        .send({ phone: '5550001111', code: wrong })
        .expect(400);
    }
    await request(app)
      .post('/api/portal/auth/verify-code')
      .send({ phone: '5550001111', code: right })
      .expect(400);
  });

  it('a text code ends after 5 minutes', async () => {
    await invite({ phone: '5550002222' });
    await request(app)
      .post('/api/portal/invitations/accept')
      .send({ token: linkToken('+15550002222') })
      .expect(200);
    await request(app).post('/api/portal/auth/login').send({ contact: '5550002222' }).expect(200);
    later(6);
    await request(app)
      .post('/api/portal/auth/verify-code')
      .send({ phone: '5550002222', code: code('+15550002222') })
      .expect(400);
  });

  it('more than 5 sign-in requests for one email in 15 minutes send nothing more', async () => {
    await invite({ email: 'r@example.test' });
    await request(app)
      .post('/api/portal/invitations/accept')
      .send({ token: linkToken('r@example.test') })
      .expect(200);
    const before = notes.sent.length;
    for (let i = 0; i < 7; i++) {
      await request(app)
        .post('/api/portal/auth/login')
        .send({ contact: 'r@example.test' })
        .expect(200);
    }
    expect(notes.sent.length - before).toBe(5);
  });

  it('turning off a user ends their sessions and they cannot sign in to that client', async () => {
    const agent = await signedIn(false);
    const [identity] = await t.db.select().from(schema.portalIdentity);
    await firm('patch', `/clients/${CLIENT}/users/${identity?.id}`)
      .send({ active: false })
      .expect(200);
    await agent.get('/api/portal/auth/me').expect(401);
    const before = notes.sent.length;
    await request(app)
      .post('/api/portal/auth/login')
      .send({ contact: 'k@example.test' })
      .expect(200);
    expect(notes.sent.length).toBe(before);
    const users = await firm('get', `/clients/${CLIENT}/users`).expect(200);
    expect(users.body.users).toEqual([expect.objectContaining({ status: 'disabled' })]);
  });

  it('a bodyless POST typed as JSON is accepted', async () => {
    await request(app)
      .post('/api/portal/auth/logout')
      .set('Content-Type', 'application/json')
      .expect(200);
  });

  it('portal changes must be JSON (no cross-site form posts)', async () => {
    const res = await request(app)
      .post('/api/portal/auth/login')
      .type('form')
      .send('contact=a@example.test');
    expect(res.status).toBe(415);
  });
});

describe('request access -> confirm -> approve -> sign in', () => {
  it('works, and staff only see the request once it is confirmed (P16)', async () => {
    const created = await request(app)
      .post('/api/portal/access-requests')
      .send({
        name: 'Mary Smith',
        email: 'mary@example.test',
        clientAs: 'Smith, John and Mary (joint return)',
        note: 'Spouse',
      })
      .expect(201);
    expect(created.body.sentTo).toBe('m***@example.test');
    const id = created.body.requestId as string;

    expect((await firm('get', '/access-requests')).body.requests).toEqual([]);

    const c = code('mary@example.test');
    await sendId({ app }, id);
    await request(app)
      .post(`/api/portal/access-requests/${id}/confirm`)
      .send({ code: c === '000000' ? '111111' : '000000' })
      .expect(400);
    await sendId({ app }, id);
    await request(app)
      .post(`/api/portal/access-requests/${id}/confirm`)
      .send({ code: c })
      .expect(200);

    const list = await firm('get', '/access-requests').expect(200);
    expect(list.body.requests).toEqual([
      expect.objectContaining({
        id,
        name: 'Mary Smith',
        clientAs: 'Smith, John and Mary (joint return)',
      }),
    ]);

    await firm('post', `/access-requests/${id}/approve`)
      .send({ clientId: CLIENT, roleLabel: 'Spouse' })
      .expect(200);
    expect(notes.last('mary@example.test').body).toContain('https://files.example-cpa.test');
    expect((await firm('get', '/access-requests')).body.requests).toEqual([]);

    const agent = request.agent(app);
    await agent.post('/api/portal/auth/login').send({ contact: 'mary@example.test' }).expect(200);
    await agent
      .post('/api/portal/auth/verify-link')
      .send({ token: linkToken('mary@example.test') })
      .expect(200);
    const me = await agent.get('/api/portal/auth/me').expect(200);
    expect(me.body.clients).toEqual([{ id: CLIENT, name: 'Smith, John' }]);

    const users = await firm('get', `/clients/${CLIENT}/users`).expect(200);
    expect(users.body.users).toEqual([
      expect.objectContaining({ name: 'Mary Smith', roleLabel: 'Spouse', status: 'active' }),
    ]);
  });

  it('a denied request gives no access', async () => {
    const created = await request(app)
      .post('/api/portal/access-requests')
      .send({ name: 'X', phone: '5553334444', clientAs: 'Someone' })
      .expect(201);
    const id = created.body.requestId as string;
    await sendId({ app }, id);
    await request(app)
      .post(`/api/portal/access-requests/${id}/confirm`)
      .send({ code: code('+15553334444') })
      .expect(200);
    await firm('post', `/access-requests/${id}/deny`).expect(200);
    await firm('post', `/access-requests/${id}/approve`).send({ clientId: CLIENT }).expect(404);
    expect(await t.db.select().from(schema.portalIdentity)).toHaveLength(0);
  });

  it('limits requests from one address to 5 an hour', async () => {
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post('/api/portal/access-requests')
        .send({ name: 'Spam', email: `s${i}@example.test`, clientAs: 'x' })
        .expect(201);
    }
    await request(app)
      .post('/api/portal/access-requests')
      .send({ name: 'Spam', email: 's9@example.test', clientAs: 'x' })
      .expect(429);
  });
});

describe('QA 2026-11-09', () => {
  async function accept(to: string, keepSignedIn = false) {
    const agent = request.agent(app);
    await agent
      .post('/api/portal/invitations/accept')
      .send({ token: linkToken(to), keepSignedIn })
      .expect(200);
    return agent;
  }

  it('an invitation never signs someone in as another person who shares a phone', async () => {
    await invite({ email: 'husband@example.test', phone: '5551112222' });
    await accept('husband@example.test');
    await invite({ email: 'wife@example.test', phone: '5551112222' }, OTHER);
    const wife = await accept('wife@example.test');
    const me = await wife.get('/api/portal/auth/me').expect(200);
    expect(me.body.identity).toMatchObject({ email: 'wife@example.test', phone: null });
    expect(me.body.clients).toEqual([{ id: OTHER, name: 'Smith Farms LLC' }]);
    expect(await t.db.select().from(schema.portalIdentity)).toHaveLength(2);
  });

  it('a couple sharing a phone can both be invited to the same client', async () => {
    await invite({ email: 'husband@example.test', phone: '5551112222' });
    await accept('husband@example.test');
    await invite({ email: 'wife@example.test', phone: '5551112222' });
  });

  it("an access request with someone else's phone cannot reach their account", async () => {
    // The victim signs in by phone only.
    await invite({ phone: '5559990000' });
    await accept('+15559990000');
    const created = await request(app)
      .post('/api/portal/access-requests')
      .send({ name: 'Mallory', email: 'mallory@example.test', phone: '5559990000', clientAs: 'x' })
      .expect(201);
    const id = created.body.requestId as string;
    await sendId({ app }, id);
    await request(app)
      .post(`/api/portal/access-requests/${id}/confirm`)
      .send({ code: code('mallory@example.test') })
      .expect(200);
    const list = await firm('get', '/access-requests').expect(200);
    expect(list.body.requests[0].confirmedContact).toBe('mallory@example.test');
    await firm('post', `/access-requests/${id}/approve`).send({ clientId: OTHER }).expect(200);

    const rows = await t.db.select().from(schema.portalIdentity);
    const victim = rows.find((r) => r.phone === '+15559990000');
    const mallory = rows.find((r) => r.email === 'mallory@example.test');
    expect(victim?.email).toBeNull();
    expect(mallory?.phone).toBeNull();
    expect(victim?.id).not.toBe(mallory?.id);
  });

  it('a switched-off client: no invitations, pending ones stop, users signed out', async () => {
    await invite({ email: 'a@example.test' });
    const agent = await accept('a@example.test');
    await invite({ email: 'b@example.test' });
    const pending = linkToken('b@example.test');

    await firm('put', `/clients/${CLIENT}`)
      .send({ clientCode: '1001', displayName: 'Smith, John', active: false })
      .expect(200);
    await agent.get('/api/portal/auth/me').expect(401);
    await request(app).post('/api/portal/invitations/accept').send({ token: pending }).expect(404);
    const again = await firm('post', `/clients/${CLIENT}/invites`).send({
      email: 'c@example.test',
    });
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: 'client_inactive' });
    const [ev] = await t.db
      .select()
      .from(schema.events)
      .where(eq(schema.events.kind, 'client_updated'))
      .orderBy(schema.events.id);
    expect(ev).toMatchObject({ clientId: CLIENT, actor: 'THGR18C-XA003\\kurt' });
  });

  it('an invitation that fails to accept is not used up', async () => {
    await invite({ email: 'a@example.test' });
    const token = linkToken('a@example.test');
    await firm('put', `/clients/${CLIENT}`)
      .send({ clientCode: '1001', displayName: 'Smith, John', active: false })
      .expect(200);
    await request(app).post('/api/portal/invitations/accept').send({ token }).expect(404);
    expect(await t.db.select().from(schema.clientAccess)).toHaveLength(0);
  });

  it('turning a user off withdraws an invitation still waiting for them', async () => {
    await invite({ email: 'a@example.test' });
    await accept('a@example.test');
    await invite({ email: 'a@example.test' }, OTHER);
    const otherLink = linkToken('a@example.test');
    // A second, older invitation to the first client would re-enable them.
    await t.db.update(schema.clientAccess).set({ active: false });
    await firm('post', `/clients/${CLIENT}/invites`).send({ email: 'a@example.test' }).expect(201);
    const stale = linkToken('a@example.test');
    await t.db.update(schema.clientAccess).set({ active: true });
    const [identity] = await t.db.select().from(schema.portalIdentity);
    await firm('patch', `/clients/${CLIENT}/users/${identity?.id}`)
      .send({ active: false })
      .expect(200);
    await request(app).post('/api/portal/invitations/accept').send({ token: stale }).expect(404);
    // The invitation to the other client is not touched.
    await request(app)
      .post('/api/portal/invitations/accept')
      .send({ token: otherLink })
      .expect(200);
    const users = await firm('get', `/clients/${CLIENT}/users`).expect(200);
    expect(users.body.users).toEqual([expect.objectContaining({ status: 'disabled' })]);
  });

  it('a request is decided once: approve twice, or deny after approve, is refused', async () => {
    const created = await request(app)
      .post('/api/portal/access-requests')
      .send({ name: 'M', email: 'm@example.test', clientAs: 'x' })
      .expect(201);
    const id = created.body.requestId as string;
    await sendId({ app }, id);
    await request(app)
      .post(`/api/portal/access-requests/${id}/confirm`)
      .send({ code: code('m@example.test') })
      .expect(200);
    await firm('post', `/access-requests/${id}/approve`).send({ clientId: CLIENT }).expect(200);
    await firm('post', `/access-requests/${id}/approve`).send({ clientId: OTHER }).expect(404);
    await firm('post', `/access-requests/${id}/deny`).expect(404);
    expect(await t.db.select().from(schema.clientAccess)).toHaveLength(1);
  });

  it('approves one request for several clients at once (P61)', async () => {
    const created = await request(app)
      .post('/api/portal/access-requests')
      .send({ name: 'Mary Smith', email: 'mary@example.test', clientAs: 'Smith family' })
      .expect(201);
    const id = created.body.requestId as string;
    await sendId({ app }, id);
    await request(app)
      .post(`/api/portal/access-requests/${id}/confirm`)
      .send({ code: code('mary@example.test') })
      .expect(200);
    const res = await firm('post', `/access-requests/${id}/approve`)
      .send({ clientIds: [CLIENT, OTHER, CLIENT], roleLabel: 'Spouse' })
      .expect(200);
    expect(res.body.clientIds).toEqual([CLIENT, OTHER]);
    // One email, one account, both clients.
    expect(notes.sent.filter((m) => m.to === 'mary@example.test')).toHaveLength(2); // code, approval
    expect(await t.db.select().from(schema.portalIdentity)).toHaveLength(1);
    const agent = request.agent(app);
    await agent.post('/api/portal/auth/login').send({ contact: 'mary@example.test' }).expect(200);
    await agent
      .post('/api/portal/auth/verify-link')
      .send({ token: linkToken('mary@example.test') })
      .expect(200);
    const me = await agent.get('/api/portal/auth/me').expect(200);
    expect(me.body.clients).toEqual(
      expect.arrayContaining([
        { id: CLIENT, name: 'Smith, John' },
        { id: OTHER, name: 'Smith Farms LLC' },
      ]),
    );
    expect(me.body.clients).toHaveLength(2);
    for (const c of [CLIENT, OTHER]) {
      const users = await firm('get', `/clients/${c}/users`).expect(200);
      expect(users.body.users).toEqual([
        expect.objectContaining({
          name: 'Mary Smith',
          roleLabel: 'Spouse',
          status: 'active',
          // P62: every client she can see, by name, for the tags under her name.
          clients: expect.arrayContaining([
            { id: CLIENT, name: 'Smith, John' },
            { id: OTHER, name: 'Smith Farms LLC' },
          ]),
        }),
      ]);
    }
    expect(
      (await firm('get', `/clients/${CLIENT}/users`).expect(200)).body.users[0].clients,
    ).toHaveLength(2);
    // A client she was turned off for is not listed.
    await firm('patch', `/clients/${OTHER}/users/${res.body.identityId}`)
      .send({ active: false })
      .expect(200);
    const after = await firm('get', `/clients/${CLIENT}/users`).expect(200);
    expect(after.body.users[0].clients).toEqual([{ id: CLIENT, name: 'Smith, John' }]);
  });

  it('several clients: one switched off or unknown, and nobody is given access (P61)', async () => {
    const created = await request(app)
      .post('/api/portal/access-requests')
      .send({ name: 'M', email: 'm@example.test', clientAs: 'x' })
      .expect(201);
    const id = created.body.requestId as string;
    await sendId({ app }, id);
    await request(app)
      .post(`/api/portal/access-requests/${id}/confirm`)
      .send({ code: code('m@example.test') })
      .expect(200);
    const unknown = '33333333-3333-4333-8333-333333333333';
    await firm('post', `/access-requests/${id}/approve`)
      .send({ clientIds: [CLIENT, unknown] })
      .expect(404);
    await firm('put', `/clients/${OTHER}`)
      .send({ displayName: 'Smith Farms LLC', active: false })
      .expect(200);
    await firm('post', `/access-requests/${id}/approve`)
      .send({ clientIds: [CLIENT, OTHER] })
      .expect(409);
    await firm('post', `/access-requests/${id}/approve`).send({ clientIds: [] }).expect(400);
    expect(await t.db.select().from(schema.portalIdentity)).toHaveLength(0);
    // Still waiting: it can be approved for the right clients.
    await firm('post', `/access-requests/${id}/approve`)
      .send({ clientIds: [CLIENT] })
      .expect(200);
  });

  it('approving onto a switched-off client is refused', async () => {
    const created = await request(app)
      .post('/api/portal/access-requests')
      .send({ name: 'M', email: 'm@example.test', clientAs: 'x' })
      .expect(201);
    const id = created.body.requestId as string;
    await sendId({ app }, id);
    await request(app)
      .post(`/api/portal/access-requests/${id}/confirm`)
      .send({ code: code('m@example.test') })
      .expect(200);
    await firm('put', `/clients/${OTHER}`)
      .send({ displayName: 'Smith Farms LLC', active: false })
      .expect(200);
    const res = await firm('post', `/access-requests/${id}/approve`).send({ clientId: OTHER });
    expect(res.status).toBe(409);
  });

  it('parallel wrong codes cannot get past 5 tries', async () => {
    await invite({ phone: '5550003333' });
    await accept('+15550003333');
    await request(app).post('/api/portal/auth/login').send({ contact: '5550003333' }).expect(200);
    const right = code('+15550003333');
    const wrong = right === '000000' ? '111111' : '000000';
    await Promise.all(
      Array.from({ length: 8 }, () =>
        request(app)
          .post('/api/portal/auth/verify-code')
          .send({ phone: '5550003333', code: wrong }),
      ),
    );
    const [ch] = await t.db
      .select()
      .from(schema.signInChallenge)
      .where(eq(schema.signInChallenge.contact, '+15550003333'));
    expect(ch?.attempts).toBe(5);
    await request(app)
      .post('/api/portal/auth/verify-code')
      .send({ phone: '5550003333', code: right })
      .expect(400);
  });

  it('at most 10 code checks per phone in 15 minutes, across new codes', async () => {
    await invite({ phone: '5550004444' });
    await accept('+15550004444');
    for (let round = 0; round < 3; round++) {
      await request(app).post('/api/portal/auth/login').send({ contact: '5550004444' });
      for (let i = 0; i < 4; i++) {
        await request(app)
          .post('/api/portal/auth/verify-code')
          .send({
            phone: '5550004444',
            code: '999999' === code('+15550004444') ? '888888' : '999999',
          });
      }
    }
    const res = await request(app)
      .post('/api/portal/auth/verify-code')
      .send({ phone: '5550004444', code: code('+15550004444') });
    expect(res.status).toBe(429);
  });

  it('a new sign-in link replaces the earlier one', async () => {
    await invite({ email: 'n@example.test' });
    await accept('n@example.test');
    await request(app).post('/api/portal/auth/login').send({ contact: 'n@example.test' });
    const first = linkToken('n@example.test');
    await request(app).post('/api/portal/auth/login').send({ contact: 'n@example.test' });
    const second = linkToken('n@example.test');
    await request(app).post('/api/portal/auth/verify-link').send({ token: first }).expect(400);
    await request(app).post('/api/portal/auth/verify-link').send({ token: second }).expect(200);
  });

  it('a phone sign-in over its limit still says "phone"', async () => {
    for (let i = 0; i < 6; i++) {
      const res = await request(app).post('/api/portal/auth/login').send({ contact: '5550005555' });
      expect(res.body.kind).toBe('phone');
    }
  });

  it('a made-up X-Forwarded-For does not get round the per-address limit', async () => {
    for (let i = 0; i < 30; i++) {
      await request(app)
        .post('/api/portal/auth/login')
        .set('X-Forwarded-For', `203.0.113.${i}`)
        .send({ contact: `x${i}@example.test` })
        .expect(200);
    }
    await request(app)
      .post('/api/portal/auth/login')
      .set('X-Forwarded-For', '198.51.100.7')
      .send({ contact: 'y@example.test' })
      .expect(429);
  });

  it('a disabled identity cannot sign in', async () => {
    await invite({ email: 'd@example.test' });
    const agent = await accept('d@example.test');
    await t.db.update(schema.portalIdentity).set({ status: 'disabled' });
    await agent.get('/api/portal/auth/me').expect(401);
    const before = notes.sent.length;
    await request(app).post('/api/portal/auth/login').send({ contact: 'd@example.test' });
    expect(notes.sent.length).toBe(before);
  });

  it('request access: "Send a new code" works, and replaces the old code', async () => {
    const created = await request(app)
      .post('/api/portal/access-requests')
      .send({ name: 'M', phone: '5550006666', clientAs: 'x' })
      .expect(201);
    const id = created.body.requestId as string;
    const old = code('+15550006666');
    await request(app).post(`/api/portal/access-requests/${id}/resend`).expect(200);
    const fresh = code('+15550006666');
    if (old !== fresh) {
      await sendId({ app }, id);
      await request(app)
        .post(`/api/portal/access-requests/${id}/confirm`)
        .send({ code: old })
        .expect(400);
    }
    await sendId({ app }, id);
    await request(app)
      .post(`/api/portal/access-requests/${id}/confirm`)
      .send({ code: fresh })
      .expect(200);
    await request(app).post(`/api/portal/access-requests/${id}/resend`).expect(404);
  });

  it('at most 3 requests or new codes an hour for one phone', async () => {
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post('/api/portal/access-requests')
        .send({ name: 'M', phone: '5550007777', clientAs: 'x' })
        .expect(201);
    }
    await request(app)
      .post('/api/portal/access-requests')
      .send({ name: 'M', phone: '5550007777', clientAs: 'x' })
      .expect(429);
  });
});
