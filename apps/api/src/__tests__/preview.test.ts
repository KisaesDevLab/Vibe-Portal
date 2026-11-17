// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P77: staff see a client's portal as its people do, read only.

import { createHash } from 'node:crypto';

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSetupLink } from '../staff/auth';
import { totpCode } from '../staff/credentials';
import { CLIENT, OTHER, world, type World } from './harness';

const PASSWORD = 'a long staff password';
type Agent = ReturnType<typeof request.agent>;

let w: World;
let staff: Agent;
beforeEach(async () => {
  w = await world();
  staff = await finish(await createSetupLink(w.ctx, null, 'appliance'), 'kurt@example-cpa.test');
});
afterEach(async () => {
  await w.close();
});

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

async function share(clientId: string, name: string, body = `%PDF ${name}`): Promise<string> {
  const buf = Buffer.from(body);
  const sha = createHash('sha256').update(buf).digest('hex');
  const res = await w
    .firm('post', `/files?clientId=${clientId}&vfDocumentId=${name}&name=${name}&sha256=${sha}`)
    .set('Content-Type', 'application/octet-stream')
    .send(buf)
    .expect(201);
  return res.body.fileId as string;
}

const show = (fileId: string, users: Record<string, boolean>) =>
  w.firm('put', `/files/${fileId}/visibility`).send({ users }).expect(200);

const preview = (id: string) => `/api/staff/v1/clients/${id}/preview`;

describe('the preview of a client portal (P77)', () => {
  it('lists the files someone at the client sees, with the link; opening changes nothing for them', async () => {
    const mary = await w.member('mary@example.test');
    const seen = await share(CLIENT, 'Return.pdf');
    const nobody = await share(CLIENT, 'Draft.pdf');
    const sheet = await share(CLIENT, 'Book.xlsx', 'PK sheet');
    await show(seen, { [mary.id]: true });
    await show(nobody, { [mary.id]: false });
    await show(sheet, { [mary.id]: true });
    await staff
      .put(`/api/staff/v1/clients/${CLIENT}/link`)
      .send({ url: 'https://pay.example.com/c/1', message: 'Pay here' })
      .expect(200);

    const p = (await staff.get(preview(CLIENT)).expect(200)).body;
    expect(p.client.name).toBe('Smith, John');
    expect(p.people).toBe(1);
    expect(p.link.message).toBe('Pay here');
    expect(p.files.map((f: { name: string }) => f.name).sort()).toEqual([
      'Book.xlsx',
      'Return.pdf',
    ]);

    const res = await staff.get(`${preview(CLIENT)}/files/${seen}/content`).expect(200);
    expect(res.headers['content-disposition']).toMatch(/^inline/);
    // Mary still sees it as new; the look is the staff member's, in History.
    const mine = (await mary.agent.get('/api/portal/files').expect(200)).body.files;
    expect(mine.find((f: { id: string }) => f.id === seen).isNew).toBe(true);
    const kinds = (await staff.get(`/api/staff/v1/clients/${CLIENT}/history`)).body.events.map(
      (e: { kind: string }) => e.kind,
    );
    expect(kinds).toContain('preview_view');
    expect(kinds).not.toContain('view');

    // Nothing downloads: a file the page cannot show, or one shared with nobody, is not sent.
    await staff.get(`${preview(CLIENT)}/files/${sheet}/content`).expect(404);
    await staff.get(`${preview(CLIENT)}/files/${nobody}/content`).expect(404);
  });

  it('seen as one person: only the files shared with them, with their New marks (P92)', async () => {
    const mary = await w.member('mary@example.test');
    const joe = await w.member('joe@example.test');
    const farmer = await w.member('farmer@example.test', OTHER);
    const both = await share(CLIENT, 'Return.pdf');
    const hers = await share(CLIENT, 'W-2.pdf');
    const his = await share(CLIENT, 'K-1.pdf');
    await show(both, { [mary.id]: true, [joe.id]: true });
    await show(hers, { [mary.id]: true });
    await show(his, { [joe.id]: true });
    // Mary opens one herself: no longer new for her, still new for Joe.
    await mary.agent.get(`/api/portal/files/${both}/content`).expect(200);

    const all = (await staff.get(preview(CLIENT)).expect(200)).body;
    expect(all.files).toHaveLength(3);
    expect(all.as).toBeNull();
    expect(all.persons.map((p: { identityId: string }) => p.identityId).sort()).toEqual(
      [mary.id, joe.id].sort(),
    );
    // Nobody's view: nothing is marked new.
    expect(all.files.every((f: { isNew: boolean }) => !f.isNew)).toBe(true);

    const asMary = (await staff.get(`${preview(CLIENT)}?as=${mary.id}`).expect(200)).body;
    expect(asMary.as.identityId).toBe(mary.id);
    const news = Object.fromEntries(
      asMary.files.map((f: { name: string; isNew: boolean }) => [f.name, f.isNew]),
    );
    expect(news).toEqual({ 'Return.pdf': false, 'W-2.pdf': true });
    const asJoe = (await staff.get(`${preview(CLIENT)}?as=${joe.id}`).expect(200)).body;
    expect(
      Object.fromEntries(
        asJoe.files.map((f: { name: string; isNew: boolean }) => [f.name, f.isNew]),
      ),
    ).toEqual({ 'Return.pdf': true, 'K-1.pdf': true });

    // A file opens in a person's view only when it is shared with that person, and the
    // opening is the staff member's: it stays new for them.
    await staff.get(`${preview(CLIENT)}/files/${his}/content?as=${mary.id}`).expect(404);
    await staff.get(`${preview(CLIENT)}/files/${hers}/content?as=${mary.id}`).expect(200);
    const mine = (await mary.agent.get('/api/portal/files').expect(200)).body.files;
    expect(mine.find((f: { id: string }) => f.id === hers).isNew).toBe(true);

    // Someone of another client, a made-up id, or a person turned off for this client: not found.
    await staff.get(`${preview(CLIENT)}?as=${farmer.id}`).expect(404);
    await staff.get(`${preview(CLIENT)}?as=not-an-id`).expect(404);
    await staff
      .patch(`/api/staff/v1/clients/${CLIENT}/users/${joe.id}`)
      .send({ active: false })
      .expect(200);
    await staff.get(`${preview(CLIENT)}?as=${joe.id}`).expect(404);
    await staff.get(`${preview(CLIENT)}/files/${his}/content?as=${joe.id}`).expect(404);

    // The whole account turned off: the client's People list says so (no View as), and the
    // preview as that person is not found.
    await staff.post(`/api/staff/v1/people/${mary.id}/turn-off`).expect(200);
    const users = (await staff.get(`/api/staff/v1/clients/${CLIENT}/users`).expect(200)).body
      .users as { identityId: string; active: boolean; accountOff: boolean }[];
    expect(users.find((u) => u.identityId === mary.id)).toEqual(
      expect.objectContaining({ active: true, accountOff: true }),
    );
    await staff.get(`${preview(CLIENT)}?as=${mary.id}`).expect(404);
  });

  it('a file of another client is not in this preview', async () => {
    const mary = await w.member('mary@example.test', OTHER);
    const theirs = await share(OTHER, 'Farm.pdf');
    await show(theirs, { [mary.id]: true });
    await staff.get(`${preview(CLIENT)}/files/${theirs}/content`).expect(404);
    expect((await staff.get(preview(CLIENT)).expect(200)).body.files).toEqual([]);
  });

  it('staff limited to some clients preview only theirs; the firm key and clients cannot', async () => {
    const res = await staff
      .post('/api/staff/v1/staff')
      .send({ email: 'jane@example-cpa.test', name: 'Jane', clientIds: [OTHER] })
      .expect(201);
    const jane = await finish(res.body.setupLink as string);
    await jane.get(preview(CLIENT)).expect(404);
    await jane.get(preview(OTHER)).expect(200);
    const mary0 = await w.member('mary0@example.test');
    const theirs = await share(CLIENT, 'Theirs.pdf');
    await show(theirs, { [mary0.id]: true });
    await staff.get(`${preview(CLIENT)}/files/${theirs}/content`).expect(200);
    await jane.get(`${preview(CLIENT)}/files/${theirs}/content`).expect(404);
    await w.firm('get', `/clients/${CLIENT}/preview`).expect(404);
    const mary = await w.member('mary@example.test');
    await mary.agent.get(preview(CLIENT)).expect(401);
  });

  it('a person turned off, or a client switched off, takes the files out', async () => {
    const mary = await w.member('mary@example.test');
    const f = await share(CLIENT, 'Return.pdf');
    await show(f, { [mary.id]: true });
    expect((await staff.get(preview(CLIENT))).body.files).toHaveLength(1);
    await w
      .firm('patch', `/clients/${CLIENT}/users/${mary.id}`)
      .send({ active: false })
      .expect(200);
    expect((await staff.get(preview(CLIENT))).body.files).toHaveLength(0);
    await staff.get(`${preview(CLIENT)}/files/${f}/content`).expect(404);
    await w.firm('patch', `/clients/${CLIENT}/users/${mary.id}`).send({ active: true }).expect(200);
    expect((await staff.get(preview(CLIENT))).body.files).toHaveLength(1);
    await w
      .firm('put', `/clients/${CLIENT}`)
      .send({ clientCode: '1001', displayName: 'Smith, John', active: false })
      .expect(200);
    const p = (await staff.get(preview(CLIENT)).expect(200)).body;
    expect(p.client.active).toBe(false);
    expect(p.files).toHaveLength(0);
    await staff.get(`${preview(CLIENT)}/files/${f}/content`).expect(404);
  });
});
