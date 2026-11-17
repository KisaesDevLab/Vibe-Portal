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
    const wrong = await staff
      .put(`/api/staff/v1/files/${theirs}/visibility`)
      .send({ invites: { [inv]: true } });
    expect([wrong.status, wrong.body]).toEqual([400, { error: 'not_an_invitation' }]);

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

    // Resent: the new invitation has the same files chosen.
    const again = await invite(CLIENT, 'joe@example.test', 'Joe Smith');
    expect(again).not.toBe(inv);
    list = await filesOf(CLIENT);
    expect(list.find((f) => f.name === 'Return.pdf')?.invites).toEqual([again]);
    // The old one takes no more files.
    await staff
      .put(`/api/staff/v1/files/${c}/visibility`)
      .send({ invites: { [inv]: true } })
      .expect(400);

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
