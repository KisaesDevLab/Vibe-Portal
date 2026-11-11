// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P66: the staff page's People view: a person's details, clients, account, sign-in link, a new
// email or number confirmed from it, and their activity.

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

type Agent = ReturnType<typeof request.agent>;
const MARY = 'mary@example.test';

async function admin(): Promise<Agent> {
  const link = await createSetupLink(w.ctx, null, 'appliance');
  const token = /#t=([\w-]+)/.exec(link)?.[1] ?? '';
  const agent = request.agent(w.app);
  const set = await agent
    .post('/api/staff/auth/setup')
    .send({
      token,
      email: 'kurt@example-cpa.test',
      name: 'Kurt',
      password: 'a long staff password',
    })
    .expect(200);
  await agent
    .post('/api/staff/auth/setup/confirm')
    .send({ token, code: totpCode(set.body.secret as string, w.ctx.now()) })
    .expect(200);
  return agent;
}

const P = '/api/staff/v1/people';

describe('People view (P66)', () => {
  it('lists people with their clients, turned-off accounts too, and finds by name', async () => {
    const boss = await admin();
    const mary = await w.member(MARY, CLIENT);
    await w.member('bob@example.test', OTHER);
    await boss.post(`${P}/${mary.id}/turn-off`).expect(200);
    const all = await boss.get(`${P}/list`).expect(200);
    expect(all.body.more).toBe(false);
    expect(all.body.people).toHaveLength(2);
    const m = all.body.people.find((p: { email: string }) => p.email === MARY);
    expect(m).toEqual(
      expect.objectContaining({
        status: 'disabled',
        clients: [{ id: CLIENT, name: 'Smith, John' }],
      }),
    );
    const found = await boss.get(`${P}/list?q=bob`).expect(200);
    expect(found.body.people.map((p: { email: string }) => p.email)).toEqual(['bob@example.test']);
    // Vibe Files' search (P63) is unchanged: turned-off accounts are left out.
    const vf = await w.firm('get', '/people?q=mary').expect(200);
    expect(vf.body.people).toEqual([]);
  });

  it('edits the name and notifications, only to a channel they have', async () => {
    const boss = await admin();
    const mary = await w.member(MARY, CLIENT);
    await boss.patch(`${P}/${mary.id}`).send({ name: 'Mary Smith' }).expect(200);
    const bad = await boss.patch(`${P}/${mary.id}`).send({ notify: 'sms' });
    expect([bad.status, bad.body.error]).toEqual([400, 'notify_unreachable']);
    await boss.patch(`${P}/${mary.id}`).send({ notify: 'none' }).expect(200);
    const d = await boss.get(`${P}/${mary.id}`).expect(200);
    expect(d.body.person).toEqual(
      expect.objectContaining({
        name: 'Mary Smith',
        email: MARY,
        notify: 'none',
        status: 'active',
      }),
    );
  });

  it('turning the account off signs them out and keeps them out until turned on', async () => {
    const boss = await admin();
    const mary = await w.member(MARY, CLIENT);
    // An invitation to another client, waiting.
    await w.firm('post', `/clients/${OTHER}/invites`).send({ email: MARY }).expect(201);
    const invite = w.linkToken(MARY);
    await boss.post(`${P}/${mary.id}/turn-off`).expect(200);
    await mary.agent.get('/api/portal/auth/me').expect(401);
    // Asking to sign in sends nothing.
    const before = w.notes.sent.length;
    await request(w.app).post('/api/portal/auth/login').send({ contact: MARY }).expect(200);
    expect(w.notes.sent.length).toBe(before);
    // The invitation was withdrawn.
    const acc = await request(w.app).post('/api/portal/invitations/accept').send({ token: invite });
    expect(acc.status).toBeGreaterThanOrEqual(400);
    // No sign-in link either.
    const link = await boss.post(`${P}/${mary.id}/sign-in-link`);
    expect([link.status, link.body.error]).toEqual([409, 'account_off']);

    await boss.post(`${P}/${mary.id}/turn-on`).expect(200);
    await request(w.app).post('/api/portal/auth/login').send({ contact: MARY }).expect(200);
    const back = request.agent(w.app);
    await back
      .post('/api/portal/auth/verify-link')
      .send({ token: w.linkToken(MARY) })
      .expect(200);
    const me = await back.get('/api/portal/auth/me').expect(200);
    expect(me.body.clients).toEqual([{ id: CLIENT, name: 'Smith, John' }]);
  });

  it('adds a client at once and tells them; removing it takes it away', async () => {
    const boss = await admin();
    const mary = await w.member(MARY, CLIENT);
    const added = await boss
      .post(`${P}/${mary.id}/clients`)
      .send({ clientId: OTHER, roleLabel: 'Partner' });
    expect([added.status, added.body]).toEqual([201, { ok: true, told: true }]);
    const notice = w.notes.last(MARY);
    expect(notice.subject).toBe("Smith Farms LLC on Example CPA's client portal");
    let me = await mary.agent.get('/api/portal/auth/me').expect(200);
    expect(me.body.clients.map((c: { id: string }) => c.id).sort()).toEqual([CLIENT, OTHER].sort());
    const again = await boss.post(`${P}/${mary.id}/clients`).send({ clientId: OTHER });
    expect([again.status, again.body.error]).toEqual([409, 'already_has_access']);

    await boss.delete(`${P}/${mary.id}/clients/${OTHER}`).expect(200);
    // Signed out (as when turned off for a client); signing in again shows the one left.
    await mary.agent.get('/api/portal/auth/me').expect(401);
    const d = await boss.get(`${P}/${mary.id}`).expect(200);
    expect(d.body.clients).toEqual([
      expect.objectContaining({ id: OTHER, active: false, roleLabel: 'Partner' }),
      expect.objectContaining({ id: CLIENT, active: true }),
    ]);
  });

  it('sends a sign-in link that works once', async () => {
    const boss = await admin();
    const mary = await w.member(MARY, CLIENT);
    const sent = await boss.post(`${P}/${mary.id}/sign-in-link`).expect(200);
    expect(sent.body.to).toBe(MARY);
    const mail = w.notes.last(MARY);
    expect(mail.subject).toBe("Sign in to Example CPA's client portal");
    expect(mail.body).toContain('It works once, for 24 hours.');
    const token = w.linkToken(MARY);
    w.later(60 * 20); // still good after 20 hours
    const a = request.agent(w.app);
    await a.post('/api/portal/auth/verify-link').send({ token }).expect(200);
    await a.get('/api/portal/auth/me').expect(200);
    await request(w.app).post('/api/portal/auth/verify-link').send({ token }).expect(400);
  });

  it('a new email is used only once the link sent to it is opened', async () => {
    const boss = await admin();
    const mary = await w.member(MARY, CLIENT);
    const NEW = 'mary.smith@newmail.test';
    await boss
      .post(`${P}/${mary.id}/contact`)
      .send({ email: ' Mary.Smith@NewMail.test ' })
      .expect(200);
    const mail = w.notes.last(NEW);
    expect(mail.subject).toBe("Confirm your email for Example CPA's client portal");
    expect(mail.body).not.toContain('Smith, John');
    let d = await boss.get(`${P}/${mary.id}`).expect(200);
    // Nothing changed yet.
    expect(d.body.person.email).toBe(MARY);
    expect(d.body.pendingContact).toEqual(expect.objectContaining({ contact: NEW }));

    await request(w.app)
      .post('/api/portal/auth/confirm-contact')
      .send({ token: w.linkToken(NEW) })
      .expect(200);
    d = await boss.get(`${P}/${mary.id}`).expect(200);
    expect(d.body.person.email).toBe(NEW);
    expect(d.body.pendingContact).toBeNull();
    // Signed out; the old address is told (without the new one) and no longer signs in.
    await mary.agent.get('/api/portal/auth/me').expect(401);
    const told = w.notes.last(MARY);
    expect(told.subject).toBe("Your email for Example CPA's client portal was changed");
    expect(told.body).not.toContain(NEW);
    const before = w.notes.sent.length;
    await request(w.app).post('/api/portal/auth/login').send({ contact: MARY }).expect(200);
    expect(w.notes.sent.length).toBe(before);
    await request(w.app).post('/api/portal/auth/login').send({ contact: NEW }).expect(200);
    expect(w.notes.last(NEW).subject).toBe("Sign in to Example CPA's client portal");

    const history = await boss.get(`${P}/${mary.id}/history`).expect(200);
    const kinds = history.body.events.map((e: { kind: string }) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['contact_change_sent', 'contact_changed']));
  });

  it("never takes another person's email, and the link cannot be reused", async () => {
    const boss = await admin();
    const mary = await w.member(MARY, CLIENT);
    await w.member('bob@example.test', OTHER);
    const taken = await boss.post(`${P}/${mary.id}/contact`).send({ email: 'bob@example.test' });
    expect([taken.status, taken.body.error]).toEqual([409, 'contact_taken']);
    const same = await boss.post(`${P}/${mary.id}/contact`).send({ email: MARY });
    expect(same.body.error).toBe('same_contact');
    await boss.post(`${P}/${mary.id}/contact`).send({ email: 'm2@example.test' }).expect(200);
    const token = w.linkToken('m2@example.test');
    // Withdrawn by staff: the link no longer works.
    await boss.delete(`${P}/${mary.id}/contact`).expect(200);
    await request(w.app).post('/api/portal/auth/confirm-contact').send({ token }).expect(400);
  });

  it('refuses at confirm a contact someone else took meanwhile', async () => {
    const boss = await admin();
    const mary = await w.member(MARY, CLIENT);
    const NEW = 'shared@example.test';
    await boss.post(`${P}/${mary.id}/contact`).send({ email: NEW }).expect(200);
    const token = w.linkToken(NEW);
    await w.member(NEW, OTHER);
    const res = await request(w.app).post('/api/portal/auth/confirm-contact').send({ token });
    expect([res.status, res.body.error]).toEqual([409, 'contact_taken']);
    const d = await boss.get(`${P}/${mary.id}`).expect(200);
    expect(d.body.person.email).toBe(MARY);
  });

  it('works by text: a new number, a sign-in link to a number, removing a number', async () => {
    const boss = await admin();
    // Someone with only a mobile number.
    await w
      .firm('post', `/clients/${CLIENT}/invites`)
      .send({ phone: '+15551230001', name: 'Tim' })
      .expect(201);
    await request(w.app)
      .post('/api/portal/invitations/accept')
      .send({ token: w.linkToken('+15551230001') })
      .expect(200);
    const list = await boss.get(`${P}/list?q=Tim`).expect(200);
    const tim = list.body.people[0].identityId as string;
    // A rename is fine whatever the notify setting.
    await boss.patch(`${P}/${tim}`).send({ name: 'Tim Roe', notify: 'sms' }).expect(200);

    const sent = await boss.post(`${P}/${tim}/sign-in-link`).expect(200);
    expect(sent.body.to).toBe('+15551230001');
    const text = w.notes.last('+15551230001');
    expect(text.channel).toBe('sms');
    expect(text.body.length).toBeLessThanOrEqual(300);
    const a = request.agent(w.app);
    await a
      .post('/api/portal/auth/verify-link')
      .send({ token: w.linkToken('+15551230001') })
      .expect(200);

    // Only a number: it cannot be removed.
    const only = await boss.delete(`${P}/${tim}/phone`);
    expect([only.status, only.body.error]).toEqual([409, 'only_contact']);
    // A new number, confirmed by the link texted to it.
    await boss.post(`${P}/${tim}/contact`).send({ phone: '(555) 123-0002' }).expect(200);
    await request(w.app)
      .post('/api/portal/auth/confirm-contact')
      .send({ token: w.linkToken('+15551230002') })
      .expect(200);
    let d = await boss.get(`${P}/${tim}`).expect(200);
    expect(d.body.person.phone).toBe('+15551230002');
    await a.get('/api/portal/auth/me').expect(401);

    // With an email too, the number can be removed; texts stop.
    await boss.post(`${P}/${tim}/contact`).send({ email: 'tim@example.test' }).expect(200);
    await request(w.app)
      .post('/api/portal/auth/confirm-contact')
      .send({ token: w.linkToken('tim@example.test') })
      .expect(200);
    await boss.delete(`${P}/${tim}/phone`).expect(200);
    d = await boss.get(`${P}/${tim}`).expect(200);
    expect(d.body.person).toEqual(
      expect.objectContaining({ phone: null, email: 'tim@example.test', notify: 'email' }),
    );
  });

  it('a turned-off account is not invited, nor approved, nor let in by an older invitation', async () => {
    const boss = await admin();
    const mary = await w.member(MARY, CLIENT);
    // An invitation sent before (it is withdrawn at turn-off) and one refused after.
    await boss.post(`${P}/${mary.id}/turn-off`).expect(200);
    const inv = await w.firm('post', `/clients/${OTHER}/invites`).send({ email: MARY });
    expect([inv.status, inv.body.error]).toEqual([409, 'account_off']);

    // An access request from her address: approving it is refused and it keeps waiting.
    const made = await request(w.app)
      .post('/api/portal/access-requests')
      .send({ name: 'Mary', email: MARY, clientAs: 'Smith Farms' })
      .expect(201);
    await request(w.app)
      .post(`/api/portal/access-requests/${made.body.requestId}/confirm`)
      .send({ code: w.code(MARY) })
      .expect(200);
    const approve = await w
      .firm('post', `/access-requests/${made.body.requestId}/approve`)
      .send({ clientId: OTHER });
    expect([approve.status, approve.body.error]).toEqual([409, 'account_off']);
    const waiting = await w.firm('get', '/access-requests').expect(200);
    expect(waiting.body.requests.map((r: { id: string }) => r.id)).toContain(made.body.requestId);

    // A number cannot be taken off a turned-off account (or an invitation to it would make a
    // new account).
    await boss.post(`${P}/${mary.id}/turn-on`).expect(200);
    await boss.post(`${P}/${mary.id}/contact`).send({ phone: '5551230077' }).expect(200);
    await request(w.app)
      .post('/api/portal/auth/confirm-contact')
      .send({ token: w.linkToken('+15551230077') })
      .expect(200);
    await boss.post(`${P}/${mary.id}/turn-off`).expect(200);
    const phone = await boss.delete(`${P}/${mary.id}/phone`);
    expect([phone.status, phone.body.error]).toEqual([409, 'account_off']);
  });

  it('removing a client keeps a change of email waiting; a second change replaces it', async () => {
    const boss = await admin();
    const mary = await w.member(MARY, CLIENT);
    await boss.post(`${P}/${mary.id}/clients`).send({ clientId: OTHER }).expect(201);
    await boss.post(`${P}/${mary.id}/contact`).send({ email: 'm1@example.test' }).expect(200);
    await boss.delete(`${P}/${mary.id}/clients/${OTHER}`).expect(200);
    let d = await boss.get(`${P}/${mary.id}`).expect(200);
    expect(d.body.pendingContact).toEqual(expect.objectContaining({ contact: 'm1@example.test' }));
    // Only US and Canadian numbers.
    const far = await boss.post(`${P}/${mary.id}/contact`).send({ phone: '+44 20 7946 0958' });
    expect([far.status, far.body.error]).toEqual([400, 'phone_us_only']);
    // History shows the address masked.
    const h = await w.firm('get', `/clients/${CLIENT}/history`).expect(200);
    const sent = h.body.events.find((e: { kind: string }) => e.kind === 'contact_change_sent');
    expect(sent.recipient).not.toBe('m1@example.test');
    expect(JSON.stringify(h.body)).not.toContain('m1@example.test');
    d = await boss.get(`${P}/${mary.id}`).expect(200);
  });

  it('a first email for a phone-only person is told to their phone', async () => {
    const boss = await admin();
    await w
      .firm('post', `/clients/${CLIENT}/invites`)
      .send({ phone: '+15551230009', name: 'Tim' })
      .expect(201);
    await request(w.app)
      .post('/api/portal/invitations/accept')
      .send({ token: w.linkToken('+15551230009') })
      .expect(200);
    const tim = (await boss.get(`${P}/list?q=Tim`).expect(200)).body.people[0].identityId as string;
    await boss.post(`${P}/${tim}/contact`).send({ email: 'tim@example.test' }).expect(200);
    await request(w.app)
      .post('/api/portal/auth/confirm-contact')
      .send({ token: w.linkToken('tim@example.test') })
      .expect(200);
    const text = w.notes.last('+15551230009');
    expect(text.body).toContain('an email address was added');
    expect(text.body).not.toContain('tim@example.test');
  });

  it('is for staff who see every client, and not for Vibe Files', async () => {
    const mary = await w.member(MARY, CLIENT);
    await request(w.app).get(`${P}/list`).expect(401);
    await w.firm('get', `/people/${mary.id}`).expect(404);
    await w.firm('post', `/people/${mary.id}/turn-off`).expect(404);
  });
});
