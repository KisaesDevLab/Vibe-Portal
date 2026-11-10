// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Staff sign-in through Vibe Auth (P44), without a Vibe Auth server: the engine in its local
// mode, the staff account adapter, the emergency account, and single sign-on only. The whole
// OpenID Connect flow is checked against a real Vibe Auth separately.

import { schema } from '@vibe-portal/db';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../app';
import { staffSessions } from '../staff/auth';
import { BREAKGLASS_EMAIL, createStaffSso, staffUsers } from '../staff/sso';
import { world, type World } from './harness';

let w: World;
const saved = { ...process.env };
beforeEach(async () => {
  w = await world();
});
afterEach(async () => {
  process.env = { ...saved };
  await w.close();
});

async function withSso() {
  w.ctx.sso = createStaffSso(w.ctx, staffSessions(w.ctx));
  await w.ctx.sso.start();
  return createApp({ pingDb: async () => true, ctx: w.ctx });
}

describe('Vibe Auth staff sign-in (P44)', () => {
  it('changes nothing until the firm turns it on', async () => {
    const app = await withSso();
    const s = await request(app).get('/api/staff/sso/auth/status').expect(200);
    expect(s.body).toEqual(expect.objectContaining({ mode: 'local', localLoginVisible: true }));
    expect(s.body.oidc.enabled).toBe(false);
    // A client page under /auth is still the client's.
    await request(app).get('/api/staff/sso/auth/oidc/start').expect(409);
  });

  it('staff accounts: made on first sign-in, admin from Vibe Auth, never the last admin lost', async () => {
    const users = staffUsers(w.t.db);
    const ann = await users.create({
      email: 'Ann@Example-CPA.test',
      name: 'Ann',
      role: 'admin',
      emailVerified: true,
      issuer: 'https://auth.example/',
      subject: 'ann',
    });
    expect([ann.email, ann.role]).toEqual(['ann@example-cpa.test', 'admin']);
    const bob = await users.create({
      email: 'bob@example-cpa.test',
      role: 'staff',
      emailVerified: true,
      issuer: 'https://auth.example/',
      subject: 'bob',
    });
    const [row] = await w.t.db
      .select()
      .from(schema.staffUsers)
      .where((await import('drizzle-orm')).eq(schema.staffUsers.id, bob.id));
    // Sees every client, like anyone added on Settings.
    expect([row?.admin, row?.allClients, row?.name]).toEqual([false, true, 'bob@example-cpa.test']);
    // Ann is the only admin: Vibe Auth cannot take that away.
    expect(await users.setRole(ann.id, 'staff')).toBe(false);
    expect(await users.setRole(bob.id, 'admin')).toBe(true);
    expect(await users.setRole(ann.id, 'staff')).toBe(true);
  });

  it('the emergency account: never linked by email; password alone; not a first account', async () => {
    const users = staffUsers(w.t.db);
    const bg = await users.createLocalUser({
      username: 'vibe-breakglass',
      email: BREAKGLASS_EMAIL,
      name: 'x',
      role: 'admin',
      password: 'a very long emergency password',
    });
    // A Vibe Auth user claiming its address is never linked to it.
    expect(await users.findByEmail(BREAKGLASS_EMAIL)).toBeNull();
    expect((await users.findByUsername('vibe-breakglass'))?.id).toBe(bg.id);
    // It signs in with its password alone, and does not end first-time setup.
    const app = await withSso();
    const status = await request(app).get('/api/staff/auth/status').expect(200);
    expect(status.body.setupNeeded).toBe(true);
    const agent = request.agent(app);
    await agent
      .post('/api/staff/auth/login')
      .send({ email: BREAKGLASS_EMAIL, password: 'a very long emergency password', code: '' })
      .expect(200);
    const me = await agent.get('/api/staff/auth/me').expect(200);
    expect([me.body.email, me.body.admin, me.body.sso]).toEqual([BREAKGLASS_EMAIL, true, false]);
    await request(app)
      .post('/api/staff/auth/login')
      .send({ email: BREAKGLASS_EMAIL, password: 'wrong password entirely', code: '' })
      .expect(401);
  });

  it('single sign-on only: the portal sign-in is for the emergency account alone', async () => {
    const users = staffUsers(w.t.db);
    await users.createLocalUser({
      username: 'vibe-breakglass',
      email: BREAKGLASS_EMAIL,
      name: 'x',
      role: 'admin',
      password: 'a very long emergency password',
    });
    process.env['VIBE_AUTH_MODE'] = 'oidc_only';
    process.env['VIBE_OIDC_ISSUER'] = 'http://127.0.0.1:9/application/o/vibe-files-portal/';
    process.env['VIBE_OIDC_CLIENT_ID'] = 'portal';
    process.env['VIBE_OIDC_CLIENT_SECRET'] = 'secret';
    const app = await withSso();
    const s = await request(app).get('/api/staff/sso/auth/status').expect(200);
    expect([s.body.mode, s.body.localLoginVisible]).toEqual(['oidc_only', false]);
    const refused = await request(app)
      .post('/api/staff/auth/login')
      .send({ email: 'kurt@example-cpa.test', password: 'anything at all', code: '123456' });
    expect([refused.status, refused.body.error]).toEqual([403, 'local_login_disabled']);
    await request(app)
      .post('/api/staff/auth/login')
      .send({ email: BREAKGLASS_EMAIL, password: 'a very long emergency password', code: '' })
      .expect(200);
  });
});
