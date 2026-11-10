// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Phase 6b: the staff web page (D13). Staff sign in with email, password and an authenticator
// code (P9); the first account comes from a one-time setup link (P36); staff do what Vibe Files
// does except share new files or mark uploads fetched (P10); Settings (P36).

import { createHash, randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { schema } from '@vibe-portal/db';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFirmKey } from '../firm/keys';
import { createSetupLink, LOCK_MINUTES } from '../staff/auth';
import { totpCode } from '../staff/credentials';
import { CLIENT, world, type World } from './harness';

let w: World;
beforeEach(async () => {
  w = await world();
});
afterEach(async () => {
  await w.close();
});

const PASSWORD = 'a long staff password';

function tokenOf(link: string): string {
  return /#t=([\w-]+)/.exec(link)?.[1] ?? '';
}

/** Makes a staff account through its setup link and returns a signed-in agent. */
async function staff(email = 'kurt@example-cpa.test', first = true) {
  const link = first
    ? await createSetupLink(w.ctx, null, 'appliance')
    : await createSetupLink(
        w.ctx,
        (
          await w.t.db
            .insert(schema.staffUsers)
            .values({ email, name: 'Staff' })
            .returning({ id: schema.staffUsers.id })
        )[0]?.id ?? null,
        'test',
      );
  const token = tokenOf(link);
  const agent = request.agent(w.app);
  const set = await agent
    .post('/api/staff/auth/setup')
    .send({ token, email, name: 'Kurt', password: PASSWORD })
    .expect(200);
  const secret = set.body.secret as string;
  await agent
    .post('/api/staff/auth/setup/confirm')
    .send({ token, code: totpCode(secret, w.ctx.now()) })
    .expect(200);
  return { agent, secret, email };
}

describe('setting up staff accounts (P36)', () => {
  it('the first account comes from the appliance link, once', async () => {
    expect((await request(w.app).get('/api/staff/auth/status')).body).toEqual({
      setupNeeded: true,
      firstAdmin: null,
    });
    const { agent } = await staff();
    expect((await agent.get('/api/staff/auth/me').expect(200)).body).toMatchObject({
      email: 'kurt@example-cpa.test',
      firmName: 'Example CPA',
    });
    expect((await request(w.app).get('/api/staff/auth/status')).body.setupNeeded).toBe(false);
    // A first-account link made afterwards does nothing.
    const late = tokenOf(await createSetupLink(w.ctx, null, 'appliance'));
    await request(w.app)
      .post('/api/staff/auth/setup')
      .send({ token: late, email: 'evil@x.test', name: 'X', password: PASSWORD })
      .expect(404);
  });

  it('a short password is refused; a wrong authenticator code does not finish the account', async () => {
    const token = tokenOf(await createSetupLink(w.ctx, null, 'appliance'));
    await request(w.app)
      .post('/api/staff/auth/setup')
      .send({ token, email: 'k@x.test', name: 'K', password: 'short' })
      .expect(400);
    const set = await request(w.app)
      .post('/api/staff/auth/setup')
      .send({ token, email: 'k@x.test', name: 'K', password: PASSWORD })
      .expect(200);
    expect(set.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    await request(w.app)
      .post('/api/staff/auth/setup/confirm')
      .send({
        token,
        code: '000000' === totpCode(set.body.secret, w.ctx.now()) ? '111111' : '000000',
      })
      .expect(400);
    // Trying again with the same link updates the same account.
    const again = await request(w.app)
      .post('/api/staff/auth/setup')
      .send({ token, email: 'k@x.test', name: 'K', password: PASSWORD })
      .expect(200);
    await request(w.app)
      .post('/api/staff/auth/setup/confirm')
      .send({ token, code: totpCode(again.body.secret, w.ctx.now()) })
      .expect(200);
    expect(await w.t.db.select().from(schema.staffUsers)).toHaveLength(1);
  });
});

describe('staff sign-in (P9)', () => {
  it('needs the password and the current code; signs out after 30 minutes idle', async () => {
    const { secret, email } = await staff();
    const a = request.agent(w.app);
    await a
      .post('/api/staff/auth/login')
      .send({
        email,
        password: PASSWORD,
        code: '000000' === totpCode(secret, w.ctx.now()) ? '111111' : '000000',
      })
      .expect(401);
    await a
      .post('/api/staff/auth/login')
      .send({ email, password: 'wrong', code: totpCode(secret, w.ctx.now()) })
      .expect(401);
    // The code that finished setup cannot be used again (RFC 6238 §5.2): the next one can.
    await a
      .post('/api/staff/auth/login')
      .send({ email, password: PASSWORD, code: totpCode(secret, w.ctx.now()) })
      .expect(401);
    w.later(1);
    await a
      .post('/api/staff/auth/login')
      .send({ email: email.toUpperCase(), password: PASSWORD, code: totpCode(secret, w.ctx.now()) })
      .expect(200);
    await request(w.app)
      .post('/api/staff/auth/login')
      .send({ email, password: PASSWORD, code: totpCode(secret, w.ctx.now()) })
      .expect(401);
    await a.get('/api/staff/auth/me').expect(200);
    w.later(31);
    await a.get('/api/staff/auth/me').expect(401);
  });

  it('five wrong tries lock the account for 15 minutes; an unknown email looks the same', async () => {
    const { secret, email } = await staff();
    for (let i = 0; i < 5; i++) {
      await request(w.app)
        .post('/api/staff/auth/login')
        .send({ email, password: 'wrong', code: '123456' })
        .expect(401);
    }
    // While locked, a wrong try looks like an unknown email; only the right password and code
    // are told it is locked.
    const wrong = await request(w.app)
      .post('/api/staff/auth/login')
      .send({ email, password: 'wrong', code: '123456' });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual({ error: 'sign_in_failed' });
    w.later(1);
    const locked = await request(w.app)
      .post('/api/staff/auth/login')
      .send({ email, password: PASSWORD, code: totpCode(secret, w.ctx.now()) });
    expect(locked.status).toBe(423);
    w.later(LOCK_MINUTES + 1);
    await request(w.app)
      .post('/api/staff/auth/login')
      .send({ email, password: PASSWORD, code: totpCode(secret, w.ctx.now()) })
      .expect(200);
    const unknown = await request(w.app)
      .post('/api/staff/auth/login')
      .send({ email: 'nobody@x.test', password: PASSWORD, code: '123456' });
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual({ error: 'sign_in_failed' });
  });

  it('the staff API needs a staff session, not a client one or a firm key', async () => {
    await request(w.app).get('/api/staff/v1/clients').expect(401);
    const client = await w.member('c@example.test');
    await client.agent.get('/api/staff/v1/clients').expect(401);
    const { key } = await createFirmKey(w.t.db, 'Probe');
    await request(w.app)
      .get('/api/staff/v1/clients')
      .set('Authorization', `Bearer ${key}`)
      .expect(401);
  });
});

describe('what staff do (D13)', () => {
  it('lists clients, invites, approves, and is recorded under their name', async () => {
    const { agent } = await staff();
    const list = await agent.get('/api/staff/v1/clients').expect(200);
    expect(list.body.clients.map((c: { displayName: string }) => c.displayName)).toEqual([
      'Smith Farms LLC',
      'Smith, John',
    ]);
    await agent
      .post(`/api/staff/v1/clients/${CLIENT}/invites`)
      .send({ email: 'new@example.test' })
      .expect(201);
    const [ev] = await w.t.db.select().from(schema.events).where(eq(schema.events.kind, 'invite'));
    expect(ev).toMatchObject({ actorKind: 'staff', actor: 'kurt@example-cpa.test' });
  });

  it('cannot share new files or replace content; can hide and remove', async () => {
    const { agent } = await staff();
    const m = await w.member('a@example.test');
    const body = Buffer.from('%PDF shared by Vibe Files');
    const sha = createHash('sha256').update(body).digest('hex');
    const q = `clientId=${CLIENT}&vfDocumentId=d1&name=a.pdf&sha256=${sha}`;
    const forbidden = await agent
      .post(`/api/staff/v1/files?${q}`)
      .set('Content-Type', 'application/octet-stream')
      .send(body);
    expect(forbidden.status).toBe(403);
    for (const path of ['/api/staff/v1/FILES', '/api/staff/v1/Files/', '/api/staff/v1/files//']) {
      const res = await agent
        .post(`${path}?${q}`)
        .set('Content-Type', 'application/octet-stream')
        .send(body);
      expect(res.status, path).toBe(403);
    }
    const fileId = (
      await w.firm('post', `/files?${q}`).set('Content-Type', 'application/octet-stream').send(body)
    ).body.fileId as string;
    for (const p of ['content', 'CONTENT']) {
      await agent
        .put(`/api/staff/v1/files/${fileId}/${p}?sha256=${sha}`)
        .set('Content-Type', 'application/octet-stream')
        .send(body)
        .expect(403);
    }
    await agent
      .put(`/api/staff/v1/files/${fileId}/visibility`)
      .send({ users: { [m.id]: true } })
      .expect(200);
    await agent
      .put(`/api/staff/v1/files/${fileId}/visibility`)
      .send({ users: { [m.id]: false } })
      .expect(200);
    await agent.delete(`/api/staff/v1/files/${fileId}`).expect(200);
  });

  it('gate: what staff approve or remove is what Vibe Files sees', async () => {
    const { agent } = await staff();
    const created = await request(w.app)
      .post('/api/portal/access-requests')
      .send({ name: 'Jane Smith', email: 'jane@example.test', clientAs: 'John Smith' })
      .expect(201);
    const id = created.body.requestId as string;
    await request(w.app)
      .post(`/api/portal/access-requests/${id}/confirm`)
      .send({ code: w.code('jane@example.test') })
      .expect(200);
    await agent
      .post(`/api/staff/v1/access-requests/${id}/approve`)
      .send({ clientId: CLIENT, roleLabel: 'Spouse' })
      .expect(200);
    // Vibe Files' Portal users window reads this list.
    const users = await w.firm('get', `/clients/${CLIENT}/users`).expect(200);
    expect(users.body.users).toContainEqual(
      expect.objectContaining({ email: 'jane@example.test', roleLabel: 'Spouse', active: true }),
    );

    const body = Buffer.from('%PDF shared by Vibe Files');
    const sha = createHash('sha256').update(body).digest('hex');
    const fileId = (
      await w
        .firm('post', `/files?clientId=${CLIENT}&vfDocumentId=d9&name=a.pdf&sha256=${sha}`)
        .set('Content-Type', 'application/octet-stream')
        .send(body)
        .expect(201)
    ).body.fileId as string;
    await agent.delete(`/api/staff/v1/files/${fileId}`).expect(200);
    // Vibe Files' Browse marks read every live file.
    const live = await w.firm('get', '/files?all=1').expect(200);
    expect(live.body.files.map((f: { fileId: string }) => f.fileId)).not.toContain(fileId);
    const [ev] = await w.t.db.select().from(schema.events).where(eq(schema.events.kind, 'remove'));
    expect(ev).toMatchObject({ actorKind: 'staff', actor: 'kurt@example-cpa.test' });
  });

  it('the client list counts people, live files and waiting uploads', async () => {
    const { agent } = await staff();
    const m = await w.member('a@example.test');
    const body = Buffer.from('%PDF counted');
    const sha = createHash('sha256').update(body).digest('hex');
    for (const d of ['d1', 'd2']) {
      await w
        .firm('post', `/files?clientId=${CLIENT}&vfDocumentId=${d}&name=${d}.pdf&sha256=${sha}`)
        .set('Content-Type', 'application/octet-stream')
        .send(body)
        .expect(201);
    }
    await m.agent
      .post(`/api/portal/uploads?clientId=${CLIENT}&batchId=${randomUUID()}&name=W-2.pdf`)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('%PDF-1.7 W-2'))
      .expect(201);
    const list = await agent.get('/api/staff/v1/clients').expect(200);
    const row = list.body.clients.find((c: { id: string }) => c.id === CLIENT);
    expect(row).toMatchObject({ users: 1, files: 2, waiting: 1 });
  });

  it('can download a client upload without taking it from Intake (P10)', async () => {
    const { agent } = await staff();
    const m = await w.member('a@example.test');
    const up = await m.agent
      .post(`/api/portal/uploads?clientId=${CLIENT}&batchId=${randomUUID()}&name=W-2.pdf`)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('%PDF-1.7 W-2'))
      .expect(201);
    const id = up.body.uploadId as string;
    await agent.get(`/api/staff/v1/uploads/${id}/content`).expect(200);
    const [dl] = await w.t.db
      .select()
      .from(schema.events)
      .where(eq(schema.events.kind, 'download'));
    expect(dl).toMatchObject({ actorKind: 'staff', uploadId: id });
    await agent.post(`/api/staff/v1/uploads/${id}/fetched`).expect(403);
    // Express ignores case and a trailing slash: so does the refusal.
    await agent.post(`/api/staff/v1/Uploads/${id}/FETCHED/`).expect(403);
    const waiting = await w.firm('get', '/uploads').expect(200);
    expect(waiting.body.uploads.map((u: { uploadId: string }) => u.uploadId)).toEqual([id]);
  });

  it('sees the portal history (P43)', async () => {
    const { agent } = await staff();
    const h = await agent.get('/api/staff/v1/events?since=0').expect(200);
    expect(h.body.events.some((e: { kind: string }) => e.kind === 'staff_sign_in')).toBe(true);
    const newest = await agent.get('/api/staff/v1/events?latest=1&limit=2').expect(200);
    const ids = newest.body.events.map((e: { id: number }) => e.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBeGreaterThan(ids[1]);
    expect(ids[0]).toBe(Math.max(...h.body.events.map((e: { id: number }) => e.id)));
    // P57: the next page, older than the last one shown.
    const older = await agent
      .get(`/api/staff/v1/events?latest=1&limit=2&before=${ids[1] as number}`)
      .expect(200);
    for (const e of older.body.events as { id: number }[]) expect(e.id).toBeLessThan(ids[1]);
  });
});

describe('Settings (P36)', () => {
  it('changes the firm name, limits and logo; the client pages show them', async () => {
    const { agent } = await staff();
    await agent
      .put('/api/staff/v1/settings')
      .send({
        firmName: 'Example CPA LLC',
        accentColor: '#225588',
        uploadLimitMb: 25,
        uploadKeepDays: 60,
      })
      .expect(200);
    const [f] = await w.t.db.select().from(schema.firm);
    expect(f).toMatchObject({
      name: 'Example CPA LLC',
      uploadLimitBytes: 25 * 1024 * 1024,
      uploadKeepDays: 60,
    });
    await agent
      .put('/api/staff/v1/settings')
      .send({ firmName: 'X', accentColor: 'red', uploadLimitMb: 25, uploadKeepDays: 60 })
      .expect(400);
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    await agent
      .put('/api/staff/v1/settings/logo')
      .set('Content-Type', 'application/octet-stream')
      .send(png)
      .expect(200);
    await agent
      .put('/api/staff/v1/settings/logo')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('<svg/>'))
      .expect(415);
    const big = await agent
      .put('/api/staff/v1/settings/logo')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.concat([png, Buffer.alloc(600 * 1024)]));
    expect(big.status).toBe(413);
    expect(big.body).toEqual({ error: 'too_large' });
    const b = await request(w.app).get('/api/portal/branding').expect(200);
    expect(b.body).toEqual({ firmName: 'Example CPA LLC', accentColor: '#225588', hasLogo: true });
    const logo = await request(w.app).get('/api/portal/branding/logo').expect(200);
    expect(logo.headers['content-type']).toBe('image/png');
  });

  it('makes and revokes firm keys; the new key works for Vibe Files', async () => {
    const { agent } = await staff();
    const made = await agent.post('/api/staff/v1/keys').send({ label: 'Front desk' }).expect(201);
    await request(w.app)
      .get('/api/firm/v1/status')
      .set('Authorization', `Bearer ${made.body.key}`)
      .expect(200);
    const keys = await agent.get('/api/staff/v1/keys').expect(200);
    expect(keys.body.keys.map((k: { label: string }) => k.label)).toContain('Front desk');
    expect(JSON.stringify(keys.body)).not.toContain(made.body.key);
    await agent.delete(`/api/staff/v1/keys/${made.body.id}`).expect(200);
    await request(w.app)
      .get('/api/firm/v1/status')
      .set('Authorization', `Bearer ${made.body.key}`)
      .expect(401);
  });

  it('adds staff with a setup link, turns them off, and resets a locked-out one', async () => {
    const { agent } = await staff();
    const added = await agent
      .post('/api/staff/v1/staff')
      .send({ email: 'Mary@Example-CPA.test', name: 'Mary' })
      .expect(201);
    expect(w.notes.last('mary@example-cpa.test').body).toContain(added.body.setupLink);
    const mary = await staff('mary2@example-cpa.test', false);
    const list = await agent.get('/api/staff/v1/staff').expect(200);
    const m2 = list.body.staff.find((s: { email: string }) => s.email === 'mary2@example-cpa.test');
    expect(m2).toMatchObject({ ready: true, active: true });
    await agent.patch(`/api/staff/v1/staff/${m2.id}`).send({ active: false }).expect(200);
    await mary.agent.get('/api/staff/auth/me').expect(401);
    const me = list.body.staff.find((s: { email: string }) => s.email === 'kurt@example-cpa.test');
    await agent.patch(`/api/staff/v1/staff/${me.id}`).send({ active: false }).expect(409);
    await agent.post(`/api/staff/v1/staff/${me.id}/reset`).expect(409);
    await agent.post(`/api/staff/v1/staff/${m2.id}/reset`).expect(409);
    await agent.patch(`/api/staff/v1/staff/${m2.id}`).send({ active: true }).expect(200);
    const reset = await agent.post(`/api/staff/v1/staff/${m2.id}/reset`).expect(200);
    expect(reset.body.setupLink).toContain('/staff/setup#t=');
  });

  it('setup links: a newer one or turning off ends the old; the first account ends the others', async () => {
    const first1 = tokenOf(await createSetupLink(w.ctx, null, 'appliance'));
    const { agent } = await staff();
    // A first-account link made before the first account was finished no longer works.
    await request(w.app).post('/api/staff/auth/setup/preview').send({ token: first1 }).expect(404);

    const added = await agent
      .post('/api/staff/v1/staff')
      .send({ email: 'bob@example-cpa.test', name: 'Bob' })
      .expect(201);
    const old = tokenOf(added.body.setupLink as string);
    const again = await agent.post(`/api/staff/v1/staff/${added.body.id}/reset`).expect(200);
    await request(w.app).post('/api/staff/auth/setup/preview').send({ token: old }).expect(404);
    const newer = tokenOf(again.body.setupLink as string);
    await request(w.app).post('/api/staff/auth/setup/preview').send({ token: newer }).expect(200);
    // Turned off: the link stops working and cannot turn Bob back on.
    await agent.patch(`/api/staff/v1/staff/${added.body.id}`).send({ active: false }).expect(200);
    await request(w.app).post('/api/staff/auth/setup/preview').send({ token: newer }).expect(404);
  });

  it('a first account left half way can be made again with a new link', async () => {
    const t1 = tokenOf(await createSetupLink(w.ctx, null, 'appliance'));
    await request(w.app)
      .post('/api/staff/auth/setup')
      .send({ token: t1, email: 'kurt@example-cpa.test', name: 'Kurt', password: PASSWORD })
      .expect(200);
    // Closed the tab before the authenticator step; the appliance makes a new link.
    const { agent } = await staff();
    await agent.get('/api/staff/auth/me').expect(200);
  });
});
