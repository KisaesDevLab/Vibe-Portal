// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Who on staff may do what (P48). Admins alone use Settings; other staff see every client unless
// an admin limits them to some, and then every other client answers as if it were not there.

import { createHash, randomUUID } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { schema } from '@vibe-portal/db';
import { listMigrations, migrate } from '@vibe-portal/db/migrations';
import { pgliteTarget } from '@vibe-portal/db/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applianceReset, createSetupLink } from '../staff/auth';
import { totpCode } from '../staff/credentials';
import { CLIENT, OTHER, world, type World, sendId } from './harness';

let w: World;
beforeEach(async () => {
  w = await world();
});
afterEach(async () => {
  await w.close();
});

const PASSWORD = 'a long staff password';
type Agent = ReturnType<typeof request.agent>;

/** Finishes the account a setup link is for and returns its signed-in agent. */
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

/** The firm's first account: an admin. */
async function admin(): Promise<Agent> {
  return finish(await createSetupLink(w.ctx, null, 'appliance'), 'kurt@example-cpa.test');
}

/** Staff added in Settings by `by`. */
async function added(
  by: Agent,
  email: string,
  more: { admin?: boolean; clientIds?: string[] | null } = {},
): Promise<{ agent: Agent; id: string }> {
  const res = await by.post('/api/staff/v1/staff').send({ email, name: email, ...more });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { agent: await finish(res.body.setupLink as string), id: res.body.id as string };
}

/** A file Vibe Files shared for a client; returns its id. */
async function share(clientId: string, doc: string): Promise<string> {
  const body = Buffer.from(`%PDF ${doc}`);
  const sha = createHash('sha256').update(body).digest('hex');
  const res = await w
    .firm('post', `/files?clientId=${clientId}&vfDocumentId=${doc}&name=${doc}.pdf&sha256=${sha}`)
    .set('Content-Type', 'application/octet-stream')
    .send(body)
    .expect(201);
  return res.body.fileId as string;
}

/** A file a client's person sent; returns its id. */
async function upload(agent: Agent, clientId: string): Promise<string> {
  const res = await agent
    .post(`/api/portal/uploads?clientId=${clientId}&batchId=${randomUUID()}&name=W-2.pdf`)
    .set('Content-Type', 'application/octet-stream')
    .send(Buffer.from('%PDF-1.7 W-2'))
    .expect(201);
  return res.body.uploadId as string;
}

describe('admins (P48)', () => {
  it('the first account is an admin; staff added later are not, and see every client', async () => {
    const boss = await admin();
    expect((await boss.get('/api/staff/auth/me').expect(200)).body).toMatchObject({
      admin: true,
      allClients: true,
    });
    const mary = await added(boss, 'mary@example-cpa.test');
    expect((await mary.agent.get('/api/staff/auth/me').expect(200)).body).toMatchObject({
      admin: false,
      allClients: true,
    });
    const list = await boss.get('/api/staff/v1/staff').expect(200);
    expect(
      list.body.staff.map((s: { email: string; admin: boolean; clientIds: unknown }) => [
        s.email,
        s.admin,
        s.clientIds,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ['kurt@example-cpa.test', true, null],
        ['mary@example-cpa.test', false, null],
      ]),
    );
    // The rest of the staff page is theirs as before.
    const clients = await mary.agent.get('/api/staff/v1/clients').expect(200);
    expect(clients.body.clients).toHaveLength(2);
    await mary.agent.get('/api/staff/v1/access-requests').expect(200);
    await mary.agent.get('/api/staff/v1/events?since=0').expect(200);
  });

  it('Settings are refused to staff who are not admins', async () => {
    const boss = await admin();
    const mary = await added(boss, 'mary@example-cpa.test');
    const bob = await added(boss, 'bob@example-cpa.test');
    const tries: [string, string, object?][] = [
      ['get', '/settings'],
      ['put', '/settings', { firmName: 'Mine', accentColor: '#000000' }],
      ['put', '/settings/logo'],
      ['put', '/settings/logo/dark'],
      ['delete', '/settings/logo/dark'],
      ['get', '/keys'],
      ['post', '/keys', { label: 'Mine' }],
      ['delete', `/keys/${randomUUID()}`],
      ['get', '/staff'],
      ['post', '/staff', { email: 'x@example-cpa.test', name: 'X', admin: true }],
      ['patch', `/staff/${mary.id}`, { admin: true }],
      ['patch', `/staff/${bob.id}`, { active: false }],
      ['post', `/staff/${bob.id}/reset`],
      // Express ignores case and a trailing slash: so does the refusal.
      ['get', '/STAFF/'],
      ['get', '/Settings'],
    ];
    for (const [method, path, send] of tries) {
      const res = await mary.agent[method as 'get'](`/api/staff/v1${path}`).send(send);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body, `${method} ${path}`).toEqual({ error: 'admins_only' });
    }
    await bob.agent.get('/api/staff/auth/me').expect(200);
    expect(await w.t.db.select().from(schema.staffUsers)).toHaveLength(3);
  });

  it('an admin makes another admin and takes it away; it applies at once', async () => {
    const boss = await admin();
    const mary = await added(boss, 'mary@example-cpa.test');
    await boss.patch(`/api/staff/v1/staff/${mary.id}`).send({ admin: true }).expect(200);
    await mary.agent.get('/api/staff/v1/staff').expect(200);
    const [ev] = await w.t.db
      .select()
      .from(schema.events)
      .where(eq(schema.events.kind, 'staff_access'));
    expect(ev).toMatchObject({
      actorKind: 'staff',
      detail: { staffId: mary.id, admin: true, clients: 'all' },
    });
    await boss.patch(`/api/staff/v1/staff/${mary.id}`).send({ admin: false }).expect(200);
    await mary.agent.get('/api/staff/v1/staff').expect(403);
    // Added as an admin.
    const ann = await added(boss, 'ann@example-cpa.test', { admin: true });
    await ann.agent.get('/api/staff/v1/keys').expect(200);
  });

  it('nobody takes their own access away, so an admin always remains', async () => {
    const boss = await admin();
    const me = (await boss.get('/api/staff/v1/staff').expect(200)).body.staff[0].id as string;
    const off = await boss.patch(`/api/staff/v1/staff/${me}`).send({ admin: false });
    expect([off.status, off.body]).toEqual([409, { error: 'cannot_change_yourself' }]);
    const limit = await boss.patch(`/api/staff/v1/staff/${me}`).send({ clientIds: [CLIENT] });
    expect([limit.status, limit.body]).toEqual([409, { error: 'cannot_change_yourself' }]);
    await boss.patch(`/api/staff/v1/staff/${me}`).send({ active: false }).expect(409);
    await boss.patch(`/api/staff/v1/staff/${me}`).send({}).expect(400);
    // The same id in capitals is still your own.
    const caps = await boss.patch(`/api/staff/v1/staff/${me.toUpperCase()}`).send({ admin: false });
    expect([caps.status, caps.body]).toEqual([409, { error: 'cannot_change_yourself' }]);
    const reset = await boss.post(`/api/staff/v1/staff/${me.toUpperCase()}/reset`);
    expect([reset.status, reset.body]).toEqual([409, { error: 'cannot_reset_yourself' }]);
    await boss.get('/api/staff/v1/settings').expect(200);
    // Two admins: the one demoted first cannot then demote the other.
    const ann = await added(boss, 'ann@example-cpa.test', { admin: true });
    await boss.patch(`/api/staff/v1/staff/${ann.id}`).send({ admin: false }).expect(200);
    await ann.agent.patch(`/api/staff/v1/staff/${me}`).send({ admin: false }).expect(403);
    await ann.agent.post(`/api/staff/v1/staff/${me}/reset`).expect(403);
    await boss.get('/api/staff/v1/settings').expect(200);
  });

  it('a new setup link for someone else ends their sessions; an unknown id is not found', async () => {
    const boss = await admin();
    const mary = await added(boss, 'mary@example-cpa.test');
    const res = await boss.post(`/api/staff/v1/staff/${mary.id.toUpperCase()}/reset`).expect(200);
    expect(res.body.setupLink).toMatch(/#t=/);
    await mary.agent.get('/api/staff/auth/me').expect(401);
    await boss.post(`/api/staff/v1/staff/${randomUUID()}/reset`).expect(404);
    await boss.patch(`/api/staff/v1/staff/${mary.id}`).send({ active: false }).expect(200);
    const off = await boss.post(`/api/staff/v1/staff/${mary.id}/reset`);
    expect([off.status, off.body]).toEqual([409, { error: 'staff_off' }]);
  });

  it('a long list of clients is read, not refused as too large', async () => {
    const boss = await admin();
    const mary = await added(boss, 'mary@example-cpa.test');
    const many = Array.from({ length: 2000 }, () => randomUUID());
    const res = await boss.patch(`/api/staff/v1/staff/${mary.id}`).send({ clientIds: many });
    expect([res.status, res.body]).toEqual([400, { error: 'client_not_found' }]);
  });

  it('what admins do in Settings is not in the history of staff who are not admins', async () => {
    const boss = await admin();
    const mary = await added(boss, 'mary@example-cpa.test');
    await boss.post('/api/staff/v1/keys').send({ label: 'Front desk PC' }).expect(201);
    await w.member('a@example.test', CLIENT);
    const kinds = async (a: Agent): Promise<Set<string>> =>
      new Set(
        (
          (await a.get('/api/staff/v1/events?since=0').expect(200)).body.events as {
            kind: string;
          }[]
        ).map((e) => e.kind),
      );
    const hers = await kinds(mary.agent);
    for (const k of ['staff_added', 'staff_sign_in', 'firm_key_created', 'staff_access']) {
      expect(hers.has(k), k).toBe(false);
    }
    expect(hers.size).toBeGreaterThan(0);
    const newest = await mary.agent.get('/api/staff/v1/events?latest=1&limit=50').expect(200);
    expect(
      newest.body.events.some((e: { kind: string }) => e.kind.startsWith('staff_')),
      'newest',
    ).toBe(false);
    const his = await kinds(boss);
    expect(his.has('staff_added')).toBe(true);
    expect(his.has('firm_key_created')).toBe(true);
    // Vibe Files' audit trail is whole.
    const firm = (await w.firm('get', '/events?since=0').expect(200)).body.events as {
      kind: string;
    }[];
    expect(firm.some((e) => e.kind === 'staff_added')).toBe(true);
  });
});

describe('staff limited to some clients (P48)', () => {
  it('see only their clients: people, invitations, files, uploads and history', async () => {
    const boss = await admin();
    const mary = await added(boss, 'mary@example-cpa.test');
    const mine = await w.member('a@example.test', CLIENT);
    const theirs = await w.member('b@example.test', OTHER);
    const myFile = await share(CLIENT, 'd1');
    const theirFile = await share(OTHER, 'd2');
    const myUpload = await upload(mine.agent, CLIENT);
    const theirUpload = await upload(theirs.agent, OTHER);

    await boss
      .patch(`/api/staff/v1/staff/${mary.id}`)
      .send({ clientIds: [CLIENT] })
      .expect(200);
    const a = mary.agent; // the session she already had: no new sign-in needed
    expect((await a.get('/api/staff/auth/me').expect(200)).body).toMatchObject({
      admin: false,
      allClients: false,
    });
    const row = (await boss.get('/api/staff/v1/staff').expect(200)).body.staff.find(
      (s: { id: string }) => s.id === mary.id,
    );
    expect(row.clientIds).toEqual([CLIENT]);

    const clients = await a.get('/api/staff/v1/clients').expect(200);
    expect(clients.body.clients.map((c: { id: string }) => c.id)).toEqual([CLIENT]);

    await a.get(`/api/staff/v1/clients/${CLIENT}/users`).expect(200);
    await a
      .post(`/api/staff/v1/clients/${CLIENT}/invites`)
      .send({ email: 'new@example.test' })
      .expect(201);
    const refused: [string, string, object?][] = [
      ['get', `/clients/${OTHER}/users`],
      ['get', `/clients/${OTHER.toUpperCase()}/users/`],
      ['post', `/clients/${OTHER}/invites`, { email: 'x@example.test' }],
      ['patch', `/clients/${OTHER}/users/${theirs.id}`, { active: false }],
      ['put', `/clients/${OTHER}`, { clientCode: '9', displayName: 'Mine now' }],
      ['put', `/clients/${randomUUID()}`, { clientCode: '9', displayName: 'New' }],
    ];
    for (const [method, path, send] of refused) {
      const res = await a[method as 'get'](`/api/staff/v1${path}`).send(send);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.body, `${method} ${path}`).toEqual({ error: 'client_not_found' });
    }

    const files = await a.get('/api/staff/v1/files?all=1').expect(200);
    expect(files.body.files.map((f: { fileId: string }) => f.fileId)).toEqual([myFile]);
    const asked = await a.get(`/api/staff/v1/files?clientId=${OTHER}`).expect(200);
    expect(asked.body.files).toEqual([]);
    // Another client's person named under a client she does see.
    await a
      .patch(`/api/staff/v1/clients/${CLIENT}/users/${theirs.id}`)
      .send({ active: false })
      .expect(404);
    await a
      .put(`/api/staff/v1/files/${theirFile}/visibility`)
      .send({ users: { [theirs.id]: false } })
      .expect(404);
    await a.delete(`/api/staff/v1/files/${theirFile}`).expect(404);
    await a
      .put(`/api/staff/v1/files/${myFile}/visibility`)
      .send({ users: { [mine.id]: true } })
      .expect(200);

    const uploads = await a.get('/api/staff/v1/uploads').expect(200);
    expect(uploads.body.uploads.map((u: { uploadId: string }) => u.uploadId)).toEqual([myUpload]);
    await a.get(`/api/staff/v1/uploads/${theirUpload}/content`).expect(404);
    await a.get(`/api/staff/v1/uploads/${myUpload}/content`).expect(200);

    const events = (await a.get('/api/staff/v1/events?since=0').expect(200)).body.events as {
      clientId: string | null;
    }[];
    expect(events.length).toBeGreaterThan(0);
    expect(new Set(events.map((e) => e.clientId))).toEqual(new Set([CLIENT]));
    const newest = await a.get('/api/staff/v1/events?latest=1&limit=50').expect(200);
    expect(
      newest.body.events.every((e: { clientId: string | null }) => e.clientId === CLIENT),
    ).toBe(true);

    // The other client is as it was.
    const live = await w.firm('get', '/files?all=1').expect(200);
    expect(live.body.files).toHaveLength(2);
    const users = await w.firm('get', `/clients/${OTHER}/users`).expect(200);
    expect(users.body.users).toContainEqual(expect.objectContaining({ active: true }));
  });

  it('do not see or answer access requests', async () => {
    const boss = await admin();
    const mary = await added(boss, 'mary@example-cpa.test', { clientIds: [CLIENT] });
    const created = await request(w.app)
      .post('/api/portal/access-requests')
      .send({ name: 'Jane Smith', email: 'jane@example.test', clientAs: 'John Smith' })
      .expect(201);
    const id = created.body.requestId as string;
    await sendId(w, id);
    await request(w.app)
      .post(`/api/portal/access-requests/${id}/confirm`)
      .send({ code: w.code('jane@example.test') })
      .expect(200);
    const list = await mary.agent.get('/api/staff/v1/access-requests');
    expect([list.status, list.body]).toEqual([403, { error: 'all_clients_only' }]);
    // P63: nor the list of everyone on the portal.
    await mary.agent.get('/api/staff/v1/people?q=smith').expect(403);
    await mary.agent
      .post(`/api/staff/v1/access-requests/${id}/approve`)
      .send({ clientId: CLIENT })
      .expect(403);
    await mary.agent.post(`/api/staff/v1/access-requests/${id}/deny`).expect(403);
    await boss
      .post(`/api/staff/v1/access-requests/${id}/approve`)
      .send({ clientId: CLIENT })
      .expect(200);
  });

  it('with no client ticked see none; back to every client shows all again', async () => {
    const boss = await admin();
    const mary = await added(boss, 'mary@example-cpa.test', { clientIds: [] });
    await share(CLIENT, 'd1');
    expect((await mary.agent.get('/api/staff/v1/clients').expect(200)).body.clients).toEqual([]);
    expect((await mary.agent.get('/api/staff/v1/files?all=1').expect(200)).body.files).toEqual([]);
    expect((await mary.agent.get('/api/staff/v1/events?since=0').expect(200)).body.events).toEqual(
      [],
    );
    await mary.agent.get(`/api/staff/v1/clients/${CLIENT}/users`).expect(404);

    await boss.patch(`/api/staff/v1/staff/${mary.id}`).send({ clientIds: null }).expect(200);
    expect((await mary.agent.get('/api/staff/v1/clients').expect(200)).body.clients).toHaveLength(
      2,
    );
    await mary.agent.get('/api/staff/v1/access-requests').expect(200);
    expect(await w.t.db.select().from(schema.staffClient)).toEqual([]);
  });

  it('an admin sees every client: a list for an admin is refused, and making one clears it', async () => {
    const boss = await admin();
    const both = await boss
      .post('/api/staff/v1/staff')
      .send({ email: 'x@example-cpa.test', name: 'X', admin: true, clientIds: [CLIENT] });
    expect([both.status, both.body]).toEqual([400, { error: 'admin_sees_all' }]);
    const mary = await added(boss, 'mary@example-cpa.test', { clientIds: [CLIENT] });
    const patch = await boss
      .patch(`/api/staff/v1/staff/${mary.id}`)
      .send({ admin: true, clientIds: [CLIENT] });
    expect([patch.status, patch.body]).toEqual([400, { error: 'admin_sees_all' }]);
    await boss.patch(`/api/staff/v1/staff/${mary.id}`).send({ admin: true }).expect(200);
    expect((await mary.agent.get('/api/staff/v1/clients').expect(200)).body.clients).toHaveLength(
      2,
    );
    expect(await w.t.db.select().from(schema.staffClient)).toEqual([]);
    // No longer an admin: every client, not the old list.
    await boss.patch(`/api/staff/v1/staff/${mary.id}`).send({ admin: false }).expect(200);
    expect((await mary.agent.get('/api/staff/auth/me').expect(200)).body).toMatchObject({
      admin: false,
      allClients: true,
    });
    const ann = await added(boss, 'ann@example-cpa.test', { admin: true });
    const limit = await boss.patch(`/api/staff/v1/staff/${ann.id}`).send({ clientIds: [CLIENT] });
    expect([limit.status, limit.body]).toEqual([400, { error: 'admin_sees_all' }]);
  });

  it('a client that does not exist is refused and nothing changes', async () => {
    const boss = await admin();
    const mary = await added(boss, 'mary@example-cpa.test', { clientIds: [CLIENT] });
    const res = await boss
      .patch(`/api/staff/v1/staff/${mary.id}`)
      .send({ clientIds: [OTHER, randomUUID()] });
    expect([res.status, res.body]).toEqual([400, { error: 'client_not_found' }]);
    const list = await mary.agent.get('/api/staff/v1/clients').expect(200);
    expect(list.body.clients.map((c: { id: string }) => c.id)).toEqual([CLIENT]);
    const add = await boss
      .post('/api/staff/v1/staff')
      .send({ email: 'x@example-cpa.test', name: 'X', clientIds: [randomUUID()] });
    expect(add.status).toBe(400);
    expect(await w.t.db.select().from(schema.staffUsers)).toHaveLength(2);
    // The same client twice, in capitals, is one client.
    await boss
      .patch(`/api/staff/v1/staff/${mary.id}`)
      .send({ clientIds: [OTHER, OTHER.toUpperCase()] })
      .expect(200);
    expect(await w.t.db.select().from(schema.staffClient)).toHaveLength(1);
  });

  it('Vibe Files (the firm key) sees every client whatever staff are limited to', async () => {
    const boss = await admin();
    await added(boss, 'mary@example-cpa.test', { clientIds: [] });
    const list = await w.firm('get', '/clients').expect(200);
    expect(list.body.clients).toHaveLength(2);
    await w.firm('get', '/access-requests').expect(200);
  });
});

describe('the appliance reset (P48)', () => {
  it('makes the account an admin when no other admin can sign in', async () => {
    const boss = await admin();
    const mary = await added(boss, 'mary@example-cpa.test', { clientIds: [CLIENT] });
    // Another admin can sign in: Mary stays as she is.
    const first = await applianceReset(w.ctx, ' Mary@Example-CPA.test ');
    expect(first).toMatchObject({ email: 'mary@example-cpa.test', madeAdmin: false });
    await mary.agent.get('/api/staff/auth/me').expect(401);
    // An authenticator code is good once per half minute, across a reset too.
    w.later(1);
    const again = await finish(first?.link ?? '');
    expect((await again.get('/api/staff/auth/me').expect(200)).body).toMatchObject({
      admin: false,
      allClients: false,
    });
    // The only admin is gone (turned off in the database: the page refuses it).
    await w.t.db
      .update(schema.staffUsers)
      .set({ active: false })
      .where(eq(schema.staffUsers.email, 'kurt@example-cpa.test'));
    const second = await applianceReset(w.ctx, 'mary@example-cpa.test');
    expect(second?.madeAdmin).toBe(true);
    w.later(1);
    const now = await finish(second?.link ?? '');
    expect((await now.get('/api/staff/auth/me').expect(200)).body).toMatchObject({
      admin: true,
      allClients: true,
    });
    await now.get('/api/staff/v1/staff').expect(200);
    expect(await w.t.db.select().from(schema.staffClient)).toEqual([]);
    expect(await applianceReset(w.ctx, 'nobody@example-cpa.test')).toBeNull();
  });

  it('with --admin makes an admin though another admin has a working account', async () => {
    // The admin left the firm: their account still works, so the portal cannot tell.
    const boss = await admin();
    const mary = await added(boss, 'mary@example-cpa.test', { clientIds: [CLIENT] });
    const done = await applianceReset(w.ctx, 'mary@example-cpa.test', { admin: true });
    expect(done?.madeAdmin).toBe(true);
    await mary.agent.get('/api/staff/auth/me').expect(401);
    w.later(1);
    const now = await finish(done?.link ?? '');
    expect((await now.get('/api/staff/auth/me').expect(200)).body).toMatchObject({
      admin: true,
      allClients: true,
    });
    expect(await w.t.db.select().from(schema.staffClient)).toEqual([]);
    // Already an admin: nothing to make.
    const again = await applianceReset(w.ctx, 'mary@example-cpa.test', { admin: true });
    expect(again?.madeAdmin).toBe(false);
    await boss.get('/api/staff/v1/settings').expect(200);
  });
});

describe('the upgrade (P48)', () => {
  it('staff accounts from before are admins who see every client', async () => {
    const pg = new PGlite();
    try {
      const all = listMigrations();
      const at = all.findIndex((m) => m.name.startsWith('0008_'));
      expect(at).toBeGreaterThan(0);
      await migrate(pgliteTarget(pg), all.slice(0, at));
      await pg.query(`INSERT INTO staff_users (email, name) VALUES ($1, $2), ($3, $4)`, [
        'kurt@example-cpa.test',
        'Kurt',
        'mary@example-cpa.test',
        'Mary',
      ]);
      await migrate(pgliteTarget(pg), all);
      const rows = await pg.query<{ admin: boolean; all_clients: boolean }>(
        'SELECT admin, all_clients FROM staff_users',
      );
      expect(rows.rows).toEqual([
        { admin: true, all_clients: true },
        { admin: true, all_clients: true },
      ]);
      await pg.query(`INSERT INTO staff_users (email, name) VALUES ($1, $2)`, ['new@x.test', 'N']);
      const fresh = await pg.query<{ admin: boolean; all_clients: boolean }>(
        `SELECT admin, all_clients FROM staff_users WHERE email = 'new@x.test'`,
      );
      expect(fresh.rows).toEqual([{ admin: false, all_clients: true }]);
    } finally {
      await pg.close();
    }
  });
});
