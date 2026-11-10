// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// The first staff account without a command (P52): the portal emails the first admin a setup
// link at startup, and the sign-in page can send it again, only to that address.

import { schema } from '@vibe-portal/db';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { firstAdminOnStart } from '../staff/first-admin';
import { totpCode } from '../staff/credentials';
import { world, type World } from './harness';

let w: World;
beforeEach(async () => {
  w = await world();
  w.ctx.firstAdminEmail = 'kurt@example-cpa.test';
});
afterEach(async () => {
  await w.close();
});

const sentTo = (to: string) => w.notes.sent.filter((m) => m.to === to);
const linkIn = (body: string): string => /#t=([\w-]+)/.exec(body)?.[1] ?? '';

async function finish(token: string, email = 'kurt@example-cpa.test') {
  const agent = request.agent(w.app);
  const set = await agent
    .post('/api/staff/auth/setup')
    .send({ token, email, name: 'Kurt', password: 'a long staff password' });
  if (set.status !== 200) return set;
  return agent
    .post('/api/staff/auth/setup/confirm')
    .send({ token, code: totpCode(set.body.secret as string, w.ctx.now()) });
}

describe('first admin by email (P52)', () => {
  it('emails a setup link once at startup, not again on a restart', async () => {
    const m = await firstAdminOnStart(w.ctx);
    expect(m).toEqual(expect.objectContaining({ email: 'kurt@example-cpa.test', ok: true }));
    expect(sentTo('kurt@example-cpa.test')).toHaveLength(1);
    expect(await firstAdminOnStart(w.ctx)).toBeNull();
    expect(sentTo('kurt@example-cpa.test')).toHaveLength(1);

    // The link opens the setup page with the address filled in, and makes the account.
    const token = linkIn(w.notes.last('kurt@example-cpa.test').body);
    const preview = await request(w.app)
      .post('/api/staff/auth/setup/preview')
      .send({ token })
      .expect(200);
    expect([preview.body.first, preview.body.email]).toEqual([true, 'kurt@example-cpa.test']);
    expect((await finish(token)).status).toBe(200);
    // With an account, nothing more is sent.
    w.ctx.firstAdminEmail = 'someone@example-cpa.test';
    expect(await firstAdminOnStart(w.ctx)).toBeNull();
    const status = await request(w.app).get('/api/staff/auth/status').expect(200);
    expect(status.body).toEqual({ setupNeeded: false, firstAdmin: null });
    await request(w.app).post('/api/staff/auth/setup/resend').expect(409);
  });

  it('a changed address, or an email that failed, is sent again at startup', async () => {
    const send = w.ctx.notifier.send.bind(w.ctx.notifier);
    w.ctx.notifier.send = async () => {
      throw new Error('535 authentication failed');
    };
    expect((await firstAdminOnStart(w.ctx))?.ok).toBe(false);
    let status = await request(w.app).get('/api/staff/auth/status').expect(200);
    expect(status.body.firstAdmin).toEqual(
      expect.objectContaining({ to: 'k•••@example-cpa.test', ok: false }),
    );
    // Never the mail server's words on the page.
    expect(JSON.stringify(status.body)).not.toContain('535');

    // The SMTP password put right, the portal restarted: sent.
    w.ctx.notifier.send = send;
    expect((await firstAdminOnStart(w.ctx))?.ok).toBe(true);
    // The address corrected on the appliance: sent to the new one, the old link ended.
    const oldToken = linkIn(w.notes.last('kurt@example-cpa.test').body);
    w.ctx.firstAdminEmail = 'mary@example-cpa.test';
    status = await request(w.app).get('/api/staff/auth/status').expect(200);
    expect(status.body.firstAdmin).toEqual({ to: 'm•••@example-cpa.test', at: '', ok: false });
    expect((await firstAdminOnStart(w.ctx))?.email).toBe('mary@example-cpa.test');
    await request(w.app)
      .post('/api/staff/auth/setup/preview')
      .send({ token: oldToken })
      .expect(404);
  });

  it('"Send again" sends only to the set address, a few times an hour, newest link only', async () => {
    await firstAdminOnStart(w.ctx);
    const first = linkIn(w.notes.last('kurt@example-cpa.test').body);
    const again = await request(w.app)
      .post('/api/staff/auth/setup/resend')
      .send({ email: 'attacker@example.test' })
      .expect(200);
    expect(again.body.firstAdmin.to).toBe('k•••@example-cpa.test');
    expect(sentTo('attacker@example.test')).toHaveLength(0);
    expect(sentTo('kurt@example-cpa.test')).toHaveLength(2);
    // Only the newest link works.
    await request(w.app).post('/api/staff/auth/setup/preview').send({ token: first }).expect(404);
    const newest = linkIn(w.notes.last('kurt@example-cpa.test').body);
    await request(w.app).post('/api/staff/auth/setup/preview').send({ token: newest }).expect(200);

    await request(w.app).post('/api/staff/auth/setup/resend').expect(200);
    await request(w.app).post('/api/staff/auth/setup/resend').expect(200);
    // Three an hour for the whole portal, whoever asks.
    await request(w.app).post('/api/staff/auth/setup/resend').expect(429);
    expect(sentTo('kurt@example-cpa.test')).toHaveLength(4);
    w.later(61);
    await request(w.app).post('/api/staff/auth/setup/resend').expect(200);
  });

  it('with no first admin set, nothing is sent and the page is told so', async () => {
    delete w.ctx.firstAdminEmail;
    expect(await firstAdminOnStart(w.ctx)).toBeNull();
    const status = await request(w.app).get('/api/staff/auth/status').expect(200);
    expect(status.body).toEqual({ setupNeeded: true, firstAdmin: null });
    await request(w.app).post('/api/staff/auth/setup/resend').expect(409);
    expect(await w.t.db.select().from(schema.staffSetupToken)).toEqual([]);
  });
});
