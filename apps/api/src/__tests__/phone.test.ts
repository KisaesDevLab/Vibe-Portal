// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P50: a person signed in by email adds a mobile number to sign in by text, proved by a code;
// removes it; and is offered the number staff typed beside the email on the invitation.

import { eq } from 'drizzle-orm';
import { schema } from '@vibe-portal/db';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CLIENT, world, type World } from './harness';

const PHONE = '+15551234567';
const TYPED = '(555) 123-4567';

let w: World;
beforeEach(async () => {
  w = await world();
});
afterEach(async () => {
  await w.close();
});

async function identity(id: string) {
  const [row] = await w.t.db
    .select()
    .from(schema.portalIdentity)
    .where(eq(schema.portalIdentity.id, id));
  return row;
}

async function kinds(): Promise<string[]> {
  return (await w.t.db.select({ k: schema.events.kind }).from(schema.events)).map((e) => e.k);
}

/** Asks for a sign-in by text; true when a code was texted. */
async function textSignIn(phone: string): Promise<boolean> {
  const before = w.notes.sent.length;
  await request(w.app).post('/api/portal/auth/login').send({ contact: phone }).expect(200);
  return w.notes.sent.slice(before).some((m) => m.to === phone);
}

describe('adding a mobile number (P50)', () => {
  it('is stored only after the texted code, then signs in by text', async () => {
    const { agent, id } = await w.member('ann@example.test');
    const r = await agent.post('/api/portal/account/phone').send({ phone: TYPED }).expect(200);
    expect(r.body.phone).toBe('***-***-4567');
    const text = w.notes.last(PHONE);
    expect(text.channel).toBe('sms');
    // Not yet proved: not on the account, and no sign-in by text.
    expect((await identity(id))?.phone).toBeNull();
    expect(await textSignIn(PHONE)).toBe(false);

    await agent
      .post('/api/portal/account/phone/verify')
      .send({ code: w.code(PHONE) })
      .expect(200);
    expect((await identity(id))?.phone).toBe(PHONE);
    expect(await kinds()).toContain('phone_added');
    // The email hears about it.
    expect(w.notes.last('ann@example.test').body).toContain('***-***-4567');
    const me = await agent.get('/api/portal/auth/me').expect(200);
    expect(me.body.identity.phone).toBe(PHONE);

    // Signing in by text now works.
    expect(await textSignIn(PHONE)).toBe(true);
    const phoneAgent = request.agent(w.app);
    await phoneAgent
      .post('/api/portal/auth/verify-code')
      .send({ phone: PHONE, code: w.code(PHONE) })
      .expect(200);
    const me2 = await phoneAgent.get('/api/portal/auth/me').expect(200);
    expect(me2.body.identity.id).toBe(id);
  });

  it('a confirm code never signs anyone in', async () => {
    const { agent } = await w.member('ann@example.test');
    await agent.post('/api/portal/account/phone').send({ phone: PHONE }).expect(200);
    const r = await request(w.app)
      .post('/api/portal/auth/verify-code')
      .send({ phone: PHONE, code: w.code(PHONE) });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('code_wrong');
  });

  it('a wrong code counts as a try, and five use the code up', async () => {
    const { agent, id } = await w.member('ann@example.test');
    await agent.post('/api/portal/account/phone').send({ phone: PHONE }).expect(200);
    const right = w.code(PHONE);
    const wrong = right === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      await agent.post('/api/portal/account/phone/verify').send({ code: wrong }).expect(400);
    }
    await agent.post('/api/portal/account/phone/verify').send({ code: right }).expect(400);
    expect((await identity(id))?.phone).toBeNull();
  });

  it('expires after five minutes', async () => {
    const { agent } = await w.member('ann@example.test');
    await agent.post('/api/portal/account/phone').send({ phone: PHONE }).expect(200);
    w.later(6);
    await agent
      .post('/api/portal/account/phone/verify')
      .send({ code: w.code(PHONE) })
      .expect(400);
  });

  it("only checks the person's own code", async () => {
    const ann = await w.member('ann@example.test');
    const bob = await w.member('bob@example.test');
    await ann.agent.post('/api/portal/account/phone').send({ phone: PHONE }).expect(200);
    const r = await bob.agent
      .post('/api/portal/account/phone/verify')
      .send({ code: w.code(PHONE) });
    expect(r.body.error).toBe('code_wrong');
    expect((await identity(bob.id))?.phone).toBeNull();
  });

  it('a number on another account is refused only after the code proves it', async () => {
    const ann = await w.member('ann@example.test');
    await ann.agent.post('/api/portal/account/phone').send({ phone: PHONE }).expect(200);
    await ann.agent
      .post('/api/portal/account/phone/verify')
      .send({ code: w.code(PHONE) })
      .expect(200);
    const bob = await w.member('bob@example.test');
    // Asking answers the same as for any number.
    const ask = await bob.agent.post('/api/portal/account/phone').send({ phone: PHONE });
    expect(ask.status).toBe(200);
    const r = await bob.agent
      .post('/api/portal/account/phone/verify')
      .send({ code: w.code(PHONE) });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('phone_in_use');
    expect((await identity(bob.id))?.phone).toBeNull();
    expect((await identity(ann.id))?.phone).toBe(PHONE);
  });

  it('texts US and Canadian numbers only, and refuses bad input', async () => {
    const { agent } = await w.member('ann@example.test');
    const abroad = await agent.post('/api/portal/account/phone').send({ phone: '+447700900123' });
    expect(abroad.body.error).toBe('phone_us_only');
    const caribbean = await agent.post('/api/portal/account/phone').send({ phone: '+18765550123' });
    expect(caribbean.body.error).toBe('phone_us_only');
    const junk = await agent.post('/api/portal/account/phone').send({ phone: '12-34-567' });
    expect(junk.body.error).toBe('invalid_phone');
    expect(w.notes.sent.filter((m) => m.channel === 'sms')).toHaveLength(0);
  });

  it('limits the codes one person asks for and one number receives', async () => {
    const ann = await w.member('ann@example.test');
    for (let i = 0; i < 5; i++) {
      await ann.agent.post('/api/portal/account/phone').send({ phone: PHONE }).expect(200);
    }
    const r = await ann.agent.post('/api/portal/account/phone').send({ phone: '+15559876543' });
    expect(r.status).toBe(429);
    // Others cannot flood the same number either.
    const bob = await w.member('bob@example.test');
    const b = await bob.agent.post('/api/portal/account/phone').send({ phone: PHONE });
    expect(b.status).toBe(429);
  });

  it('needs a signed-in person', async () => {
    const r = await request(w.app).post('/api/portal/account/phone').send({ phone: PHONE });
    expect(r.status).toBe(401);
  });
});

describe('removing the mobile number (P50)', () => {
  async function withPhone() {
    const m = await w.member('ann@example.test');
    await m.agent.post('/api/portal/account/phone').send({ phone: PHONE }).expect(200);
    await m.agent
      .post('/api/portal/account/phone/verify')
      .send({ code: w.code(PHONE) })
      .expect(200);
    return m;
  }

  it('goes back to email, and a sign-in code already texted stops working', async () => {
    const { agent, id } = await withPhone();
    await w.t.db
      .update(schema.portalIdentity)
      .set({ notify: 'both' })
      .where(eq(schema.portalIdentity.id, id));
    expect(await textSignIn(PHONE)).toBe(true);
    const code = w.code(PHONE);
    await agent.delete('/api/portal/account/phone').expect(200);
    const row = await identity(id);
    expect(row?.phone).toBeNull();
    expect(row?.notify).toBe('email');
    expect(await kinds()).toContain('phone_removed');
    expect(w.notes.last('ann@example.test').body).toContain('removed');
    const r = await request(w.app)
      .post('/api/portal/auth/verify-code')
      .send({ phone: PHONE, code });
    expect(r.body.error).toBe('code_wrong');
    expect(await textSignIn(PHONE)).toBe(false);
  });

  it('is refused when the number is the only way to sign in', async () => {
    await w
      .firm('post', `/clients/${CLIENT}/invites`)
      .send({ phone: PHONE, name: 'Cal' })
      .expect(201);
    const agent = request.agent(w.app);
    await agent
      .post('/api/portal/invitations/accept')
      .send({ token: w.linkToken(PHONE) })
      .expect(200);
    const r = await agent.delete('/api/portal/account/phone');
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('phone_only_contact');
  });

  it('a phone-only account cannot move to another number (nobody could be told)', async () => {
    await w
      .firm('post', `/clients/${CLIENT}/invites`)
      .send({ phone: PHONE, name: 'Cal' })
      .expect(201);
    const agent = request.agent(w.app);
    await agent
      .post('/api/portal/invitations/accept')
      .send({ token: w.linkToken(PHONE) })
      .expect(200);
    const before = w.notes.sent.length;
    const r = await agent.post('/api/portal/account/phone').send({ phone: '+15559876543' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('phone_only_contact');
    expect(w.notes.sent.length).toBe(before);
  });

  it('a new number replaces the old one, whose sign-in codes stop working', async () => {
    const { agent, id } = await withPhone();
    expect(await textSignIn(PHONE)).toBe(true);
    const old = w.code(PHONE);
    const NEW = '+15559876543';
    await agent.post('/api/portal/account/phone').send({ phone: NEW }).expect(200);
    await agent
      .post('/api/portal/account/phone/verify')
      .send({ code: w.code(NEW) })
      .expect(200);
    expect((await identity(id))?.phone).toBe(NEW);
    const r = await request(w.app)
      .post('/api/portal/auth/verify-code')
      .send({ phone: PHONE, code: old });
    expect(r.body.error).toBe('code_wrong');
  });

  it('asking again for the number already on the account says so', async () => {
    const { agent } = await withPhone();
    const r = await agent.post('/api/portal/account/phone').send({ phone: PHONE });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('phone_already_yours');
  });
});

describe('the number on an invitation (P50)', () => {
  async function invite(): Promise<string> {
    await w
      .firm('post', `/clients/${CLIENT}/invites`)
      .send({ email: 'dee@example.test', phone: TYPED, name: 'Dee' })
      .expect(201);
    return w.linkToken('dee@example.test');
  }

  it('is offered masked, texted a code when ticked, and stored once confirmed', async () => {
    const token = await invite();
    const p = await request(w.app).post('/api/portal/invitations/preview').send({ token });
    expect(p.body.alsoPhone).toBe('***-***-4567');
    expect(JSON.stringify(p.body)).not.toContain('5551234567');
    const agent = request.agent(w.app);
    const a = await agent
      .post('/api/portal/invitations/accept')
      .send({ token, addPhone: true })
      .expect(200);
    expect(a.body).toMatchObject({ phoneCode: 'sent', phone: '***-***-4567' });
    const me = await agent.get('/api/portal/auth/me').expect(200);
    expect(me.body.identity.phone).toBeNull();
    await agent
      .post('/api/portal/account/phone/verify')
      .send({ code: w.code(PHONE) })
      .expect(200);
    expect((await identity(me.body.identity.id))?.phone).toBe(PHONE);
  });

  it('texts nothing when not ticked', async () => {
    const token = await invite();
    const a = await request(w.app)
      .post('/api/portal/invitations/accept')
      .send({ token })
      .expect(200);
    expect(a.body.phoneCode).toBeUndefined();
    expect(w.notes.sent.filter((m) => m.to === PHONE)).toHaveLength(0);
  });

  it('is not offered without an email, or for a number abroad', async () => {
    await w
      .firm('post', `/clients/${CLIENT}/invites`)
      .send({ phone: PHONE, name: 'Cal' })
      .expect(201);
    const p = await request(w.app)
      .post('/api/portal/invitations/preview')
      .send({ token: w.linkToken(PHONE) });
    expect(p.body.alsoPhone).toBeNull();
    await w
      .firm('post', `/clients/${CLIENT}/invites`)
      .send({ email: 'eve@example.test', phone: '+447700900123', name: 'Eve' })
      .expect(201);
    const q = await request(w.app)
      .post('/api/portal/invitations/preview')
      .send({ token: w.linkToken('eve@example.test') });
    expect(q.body.alsoPhone).toBeNull();
  });
});

describe('a portal without text messages (P50)', () => {
  it('offers no number to add, on the account or the invitation', async () => {
    w.ctx.textsOff = true;
    const { agent } = await w.member('ann@example.test');
    const me = await agent.get('/api/portal/auth/me').expect(200);
    expect(me.body.textsOn).toBe(false);
    const r = await agent.post('/api/portal/account/phone').send({ phone: PHONE });
    expect(r.body.error).toBe('texts_off');
    await w
      .firm('post', `/clients/${CLIENT}/invites`)
      .send({ email: 'dee@example.test', phone: PHONE, name: 'Dee' })
      .expect(201);
    const p = await request(w.app)
      .post('/api/portal/invitations/preview')
      .send({ token: w.linkToken('dee@example.test') });
    expect(p.body.alsoPhone).toBeNull();
    expect(w.notes.sent.filter((m) => m.channel === 'sms')).toHaveLength(0);
  });
});
