// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P98: files chosen for someone who was invited and has not accepted yet are theirs when they
// accept; the People page lists the invitations still waiting.

import { createHash } from 'node:crypto';

import { schema } from '@vibe-portal/db';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSetupLink } from '../staff/auth';
import { totpCode } from '../staff/credentials';
import { CLIENT, OTHER, world, type World } from './harness';

type Agent = ReturnType<typeof request.agent>;

let w: World;
let staff: Agent;
beforeEach(async () => {
  w = await world();
  const link = await createSetupLink(w.ctx, null, 'appliance');
  const token = /#t=([\w-]+)/.exec(link)?.[1] ?? '';
  staff = request.agent(w.app);
  const set = await staff
    .post('/api/staff/auth/setup')
    .send({
      token,
      email: 'kurt@example-cpa.test',
      name: 'Kurt',
      password: 'a long staff password',
    })
    .expect(200);
  await staff
    .post('/api/staff/auth/setup/confirm')
    .send({ token, code: totpCode(set.body.secret as string, w.ctx.now()) })
    .expect(200);
});
afterEach(async () => {
  await w.close();
});

async function share(clientId: string, name: string): Promise<string> {
  const buf = Buffer.from(`%PDF ${name}`);
  const sha = createHash('sha256').update(buf).digest('hex');
  const res = await w
    .firm('post', `/files?clientId=${clientId}&vfDocumentId=${name}&name=${name}&sha256=${sha}`)
    .set('Content-Type', 'application/octet-stream')
    .send(buf)
    .expect(201);
  return res.body.fileId as string;
}

const invite = async (clientId: string, email: string, name: string): Promise<string> =>
  (await staff.post(`/api/staff/v1/clients/${clientId}/invites`).send({ email, name }).expect(201))
    .body.invitationId as string;

const filesOf = async (clientId: string) =>
  (await staff.get(`/api/staff/v1/files?clientId=${clientId}`).expect(200)).body.files as {
    fileId: string;
    name: string;
    invites: string[];
    users: { identityId: string; visible: boolean }[];
  }[];

describe('files chosen for someone invited (P98)', () => {
  it('are kept with the invitation, follow a resend, and are theirs when they accept', async () => {
    const a = await share(CLIENT, 'Return.pdf');
    const b = await share(CLIENT, 'W-2.pdf');
    const c = await share(CLIENT, 'Draft.pdf');
    const theirs = await share(OTHER, 'Farm.pdf');
    const inv = await invite(CLIENT, 'joe@example.test', 'Joe Smith');

    await staff
      .put(`/api/staff/v1/files/${a}/visibility`)
      .send({ invites: { [inv]: true } })
      .expect(200);
    await staff
      .put(`/api/staff/v1/files/${b}/visibility`)
      .send({ invites: { [inv]: true } })
      .expect(200);
    await staff
      .put(`/api/staff/v1/files/${c}/visibility`)
      .send({ invites: { [inv]: true } })
      .expect(200);
    // Chosen, then taken back.
    await staff
      .put(`/api/staff/v1/files/${c}/visibility`)
      .send({ invites: { [inv]: false } })
      .expect(200);
    // Not an invitation to that file's client, or not an invitation at all.
    // Passed over, not a failure of the whole call: nothing is chosen.
    const wrong = await staff
      .put(`/api/staff/v1/files/${theirs}/visibility`)
      .send({ invites: { [inv]: true } })
      .expect(200);
    expect(wrong.body.staleInvites).toBe(1);
    expect((await filesOf(OTHER))[0]?.invites).toEqual([]);
    // The client's History says who it was chosen for, who is no person yet.
    const hist = (await staff.get(`/api/staff/v1/clients/${CLIENT}/history`).expect(200)).body
      .events as { kind: string; person: string | null }[];
    expect(hist.find((e) => e.kind === 'share')?.person).toBe(
      'Joe Smith (invited, not accepted yet)',
    );
    // History has only what changed: chosen three times, taken back once.
    const said = (await w.t.db.select().from(schema.events)).filter(
      (e) => e.kind === 'share' || e.kind === 'unshare',
    );
    expect(said.map((e) => e.kind).sort()).toEqual(['share', 'share', 'share', 'unshare']);
    // Chosen again for the one it is chosen for already: nothing new is said.
    await staff
      .put(`/api/staff/v1/files/${a}/visibility`)
      .send({ invites: { [inv]: true } })
      .expect(200);
    expect(
      (await w.t.db.select().from(schema.events)).filter((e) => e.kind === 'share'),
    ).toHaveLength(3);

    let list = await filesOf(CLIENT);
    expect(Object.fromEntries(list.map((f) => [f.name, f.invites]))).toEqual({
      'Return.pdf': [inv],
      'W-2.pdf': [inv],
      'Draft.pdf': [],
    });
    // Nobody was told of a file: they have no account yet.
    expect(await w.t.db.select().from(schema.notifyQueue)).toHaveLength(0);

    // The People page says who is waiting, by name or contact.
    const people = (await staff.get('/api/staff/v1/people/list').expect(200)).body;
    expect(people.people).toEqual([]);
    expect(people.invited).toEqual([
      expect.objectContaining({
        invitationId: inv,
        name: 'Joe Smith',
        email: 'joe@example.test',
        clientId: CLIENT,
        clientName: 'Smith, John',
        status: 'invited',
      }),
    ]);
    expect(
      (await staff.get('/api/staff/v1/people/list?q=nobody').expect(200)).body.invited,
    ).toEqual([]);
    expect(
      (await staff.get('/api/staff/v1/people/list?q=joe').expect(200)).body.invited,
    ).toHaveLength(1);

    // The first invitation said nothing of files: none could be chosen before it existed.
    expect(w.notes.last('joe@example.test').body).not.toContain('Files are waiting');
    // Resent: the new invitation has the same files chosen, and its message says files wait
    // (no name, no count).
    const again = await invite(CLIENT, 'joe@example.test', 'Joe Smith');
    expect(again).not.toBe(inv);
    const mail = w.notes.last('joe@example.test').body;
    expect(mail).toContain('Files are waiting for you there.');
    expect(mail).not.toContain('Return.pdf');
    list = await filesOf(CLIENT);
    expect(list.find((f) => f.name === 'Return.pdf')?.invites).toEqual([again]);
    // The old one takes no more files.
    const old = await staff
      .put(`/api/staff/v1/files/${c}/visibility`)
      .send({ invites: { [inv]: true } })
      .expect(200);
    expect(old.body.staleInvites).toBe(1);
    expect(await w.t.db.select().from(schema.invitationFile)).toHaveLength(2);

    // A file removed meanwhile is not theirs.
    await staff.delete(`/api/staff/v1/files/${b}`).expect(200);

    // Joe accepts: the chosen files are there at once, new to him; the others are not.
    const joe = request.agent(w.app);
    await joe
      .post('/api/portal/invitations/accept')
      .send({ token: w.linkToken('joe@example.test') })
      .expect(200);
    const his = (await joe.get('/api/portal/files').expect(200)).body.files as {
      name: string;
      isNew: boolean;
    }[];
    expect(his.map((f) => [f.name, f.isNew])).toEqual([['Return.pdf', true]]);
    await joe.get(`/api/portal/files/${a}/content`).expect(200);
    await joe.get(`/api/portal/files/${c}/content`).expect(404);

    // On the staff page he is now a person who sees the file, and no invitation waits.
    list = await filesOf(CLIENT);
    const ret = list.find((f) => f.name === 'Return.pdf')!;
    expect(ret.invites).toEqual([]);
    expect(ret.users.filter((u) => u.visible)).toHaveLength(1);
    const after = (await staff.get('/api/staff/v1/people/list').expect(200)).body;
    expect(after.invited).toEqual([]);
    expect(after.people).toHaveLength(1);
    expect(await w.t.db.select().from(schema.invitationFile)).toHaveLength(0);
  });

  it('a couple sharing a number: one\u2019s files are never handed to the other', async () => {
    const w2 = await share(CLIENT, 'W-2.pdf');
    // The wife by email, the couple's number beside it; a file is chosen for her.
    const wife = (
      await staff
        .post(`/api/staff/v1/clients/${CLIENT}/invites`)
        .send({ email: 'ann@example.test', phone: '+15555550100', name: 'Ann Smith' })
        .expect(201)
    ).body.invitationId as string;
    await staff
      .put(`/api/staff/v1/files/${w2}/visibility`)
      .send({ invites: { [wife]: true } })
      .expect(200);
    // The husband by that number alone: her invitation is withdrawn (as it always was), and
    // her file is not his; his message says nothing of files.
    const husband = (
      await staff
        .post(`/api/staff/v1/clients/${CLIENT}/invites`)
        .send({ phone: '+15555550100', name: 'Bob Smith' })
        .expect(201)
    ).body.invitationId as string;
    expect(husband).not.toBe(wife);
    expect((await filesOf(CLIENT))[0]?.invites).toEqual([]);
    expect(w.notes.last('+15555550100').body).not.toContain('Files are waiting');
    expect(await w.t.db.select().from(schema.invitationFile)).toHaveLength(0);
  });

  it('a resend says nothing of files when the only one chosen was removed', async () => {
    const a = await share(CLIENT, 'Return.pdf');
    const inv = await invite(CLIENT, 'joe@example.test', 'Joe Smith');
    await staff
      .put(`/api/staff/v1/files/${a}/visibility`)
      .send({ invites: { [inv]: true } })
      .expect(200);
    await staff.delete(`/api/staff/v1/files/${a}`).expect(200);
    await invite(CLIENT, 'joe@example.test', 'Joe Smith');
    expect(w.notes.last('joe@example.test').body).not.toContain('Files are waiting');
  });

  it('someone invited has a page: their invitations by client; one acceptance takes them all (P100)', async () => {
    const mine = await share(CLIENT, 'Return.pdf');
    const farm = await share(OTHER, 'Farm.pdf');
    const first = await invite(CLIENT, 'joe@example.test', 'Joe Smith');
    await staff
      .put(`/api/staff/v1/files/${mine}/visibility`)
      .send({ invites: { [first]: true } })
      .expect(200);
    // Add a client for him from his page: an invitation to that client, the same contact.
    const second = await invite(OTHER, 'joe@example.test', 'Joe Smith');
    await staff
      .put(`/api/staff/v1/files/${farm}/visibility`)
      .send({ invites: { [second]: true } })
      .expect(200);
    // Someone else waits too: not on his page.
    await invite(CLIENT, 'ann@example.test', 'Ann Smith');

    const page = (await staff.get(`/api/staff/v1/people/invited/${first}`).expect(200)).body;
    expect(page.invited).toEqual({ name: 'Joe Smith', email: 'joe@example.test', phone: null });
    expect(page.account).toBeNull();
    expect(
      (page.invitations as { clientName: string; files: number; status: string }[]).map((i) => [
        i.clientName,
        i.files,
        i.status,
      ]),
    ).toEqual([
      ['Smith Farms LLC', 1, 'invited'],
      ['Smith, John', 1, 'invited'],
    ]);
    // By either of his invitations; not by an id that is none, nor without a staff session.
    await staff.get(`/api/staff/v1/people/invited/${second}`).expect(200);
    await staff.get('/api/staff/v1/people/invited/not-an-id').expect(404);
    await request(w.app).get(`/api/staff/v1/people/invited/${first}`).expect(401);

    // He opens the first link: both clients are his, each with its file, and nothing waits.
    const joe = request.agent(w.app);
    const mail = w.notes.sent.filter((m) => m.to === 'joe@example.test');
    const token = /#t=([\w-]+)/.exec(mail[0]!.body)?.[1] ?? '';
    await joe.post('/api/portal/invitations/accept').send({ token }).expect(200);
    const me = (await joe.get('/api/portal/auth/me').expect(200)).body;
    expect((me.clients as { name: string }[]).map((c) => c.name).sort()).toEqual([
      'Smith Farms LLC',
      'Smith, John',
    ]);
    await joe.get(`/api/portal/files/${mine}/content`).expect(200);
    const after = (await staff.get('/api/staff/v1/people/list').expect(200)).body;
    expect((after.invited as { email: string }[]).map((i) => i.email)).toEqual([
      'ann@example.test',
    ]);
    await staff.get(`/api/staff/v1/people/invited/${first}`).expect(404);
    const accepted = (await w.t.db.select().from(schema.events)).filter(
      (e) => e.kind === 'invite_accepted',
    );
    expect(accepted).toHaveLength(2);
    // The second link, opened later, has nothing left to accept.
    const token2 = /#t=([\w-]+)/.exec(mail[1]!.body)?.[1] ?? '';
    await request(w.app).post('/api/portal/invitations/accept').send({ token: token2 }).expect(404);
  });

  it('an invitation link is made to copy, with nothing sent (P101)', async () => {
    const a = await share(CLIENT, 'Return.pdf');
    const first = await invite(CLIENT, 'joe@example.test', 'Joe Smith');
    await staff
      .put(`/api/staff/v1/files/${a}/visibility`)
      .send({ invites: { [first]: true } })
      .expect(200);
    const sentBefore = w.notes.sent.length;
    const made = await staff
      .post(`/api/staff/v1/clients/${CLIENT}/invites`)
      .send({ email: 'joe@example.test', name: 'Joe Smith', send: false })
      .expect(201);
    // Nothing went out; the link is in the answer, and nowhere in History.
    expect(w.notes.sent.length).toBe(sentBefore);
    expect(made.body.link).toMatch(/^https:\/\/files\.example-cpa\.test\/invite#t=[\w-]+$/);
    const events = await w.t.db.select().from(schema.events);
    expect(JSON.stringify(events)).not.toContain(made.body.link.split('#t=')[1]);
    expect(events.filter((e) => e.kind === 'invite').at(-1)?.detail).toEqual(
      expect.objectContaining({ copied: true }),
    );
    // Only from the staff page: Vibe Files' key is not handed a link.
    const firm = await w
      .firm('post', `/clients/${CLIENT}/invites`)
      .send({ email: 'ann@example.test', name: 'Ann', send: false });
    expect([firm.status, firm.body]).toEqual([403, { error: 'staff_only' }]);
    // The link works as the emailed one would, and the files chosen came with it; the link
    // emailed before does not work any more.
    const old = /#t=([\w-]+)/.exec(w.notes.last('joe@example.test').body)?.[1] ?? '';
    const joe = request.agent(w.app);
    await request(w.app).post('/api/portal/invitations/accept').send({ token: old }).expect(404);
    await joe
      .post('/api/portal/invitations/accept')
      .send({ token: (made.body.link as string).split('#t=')[1] })
      .expect(200);
    expect((await joe.get('/api/portal/files').expect(200)).body.files).toHaveLength(1);
  });

  it('a deleted invitation takes its choices with it', async () => {
    const a = await share(CLIENT, 'Return.pdf');
    const inv = await invite(CLIENT, 'joe@example.test', 'Joe Smith');
    await staff
      .put(`/api/staff/v1/files/${a}/visibility`)
      .send({ invites: { [inv]: true } })
      .expect(200);
    await staff.delete(`/api/staff/v1/clients/${CLIENT}/invites/${inv}`).expect(200);
    expect((await filesOf(CLIENT))[0]?.invites).toEqual([]);
    // Invited afresh (not a resend of a waiting one): nothing is chosen.
    const fresh = await invite(CLIENT, 'joe@example.test', 'Joe Smith');
    expect((await filesOf(CLIENT))[0]?.invites).toEqual([]);
    expect(fresh).not.toBe(inv);
  });
});
