// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P103: the History page's rows, in words, narrowed by each of its columns; kept to a limited
// staff member's clients, and without what admins do for staff who are not admins.

import { createHash } from 'node:crypto';

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { flush } from '../files/notify-queue';
import { createSetupLink } from '../staff/auth';
import { totpCode } from '../staff/credentials';
import { CLIENT, OTHER, world, type World } from './harness';

type Agent = ReturnType<typeof request.agent>;
interface Row {
  kind: string;
  who: string;
  client: string | null;
  file: string | null;
  person: string | null;
}

let w: World;
let boss: Agent;
beforeEach(async () => {
  w = await world();
  boss = await finish(await createSetupLink(w.ctx, null, 'appliance'), {
    email: 'kurt@example-cpa.test',
    name: 'Kurt',
  });
});
afterEach(async () => {
  await w.close();
});

async function finish(link: string, who?: { email: string; name: string }): Promise<Agent> {
  const token = /#t=([\w-]+)/.exec(link)?.[1] ?? '';
  const agent = request.agent(w.app);
  const set = await agent
    .post('/api/staff/auth/setup')
    .send({ token, ...(who ?? {}), password: 'a long staff password' })
    .expect(200);
  await agent
    .post('/api/staff/auth/setup/confirm')
    .send({ token, code: totpCode(set.body.secret as string, w.ctx.now()) })
    .expect(200);
  return agent;
}

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

const history = async (a: Agent, query = ''): Promise<Row[]> =>
  (await a.get(`/api/staff/v1/history?limit=500${query}`).expect(200)).body.events as Row[];

describe('the History page (P103)', () => {
  it('gives each row its client and file, and is narrowed by any column', async () => {
    const mary = await w.member('mary@example.test');
    const ret = await share(CLIENT, 'Return.pdf');
    const farm = await share(OTHER, 'Farm.pdf');
    await w
      .firm('put', `/files/${ret}/visibility`)
      .send({ users: { [mary.id]: true } })
      .expect(200);
    await mary.agent.get(`/api/portal/files/${ret}/content`).expect(200);
    await boss.delete(`/api/staff/v1/files/${farm}`).expect(200);

    const all = await history(boss);
    // The client and the file are columns of their own.
    expect(all.find((e) => e.kind === 'share')).toEqual(
      expect.objectContaining({
        client: 'Smith, John',
        file: 'Return.pdf',
        person: 'mary@example.test',
      }),
    );
    expect(all.find((e) => e.kind === 'remove')).toEqual(
      expect.objectContaining({
        client: 'Smith Farms LLC',
        file: 'Farm.pdf',
        who: 'kurt@example-cpa.test',
      }),
    );

    // What: one kind, or several.
    expect((await history(boss, '&kind=remove')).map((e) => e.kind)).toEqual(['remove']);
    expect(new Set((await history(boss, '&kind=remove,share')).map((e) => e.kind))).toEqual(
      new Set(['remove', 'share']),
    );
    // Who: as the row words it (a client by name or contact, Vibe Files by its PC, staff by email).
    expect(new Set((await history(boss, '&who=MARY')).map((e) => e.who))).toEqual(
      new Set(['mary@example.test']),
    );
    expect(
      (await history(boss, '&who=vibe files')).every((e) => e.who.startsWith('Vibe Files')),
    ).toBe(true);
    expect((await history(boss, '&who=kurt@')).length).toBeGreaterThan(0);
    // Client: by name or client ID.
    const farms = await history(boss, '&client=farms');
    expect(farms.length).toBeGreaterThan(0);
    expect(farms.every((e) => e.client === 'Smith Farms LLC')).toBe(true);
    // File: by name; a percent sign is a percent sign, not "anything".
    expect(new Set((await history(boss, '&file=return')).map((e) => e.file))).toEqual(
      new Set(['Return.pdf']),
    );
    expect(await history(boss, '&file=%25')).toEqual([]);
    // About: the person a row is about.
    const about = await history(boss, '&about=mary');
    expect(about.length).toBeGreaterThan(0);
    expect(about.every((e) => e.person === 'mary@example.test')).toBe(true);
    // When: the events were all written just now.
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    const ago = new Date(Date.now() - 3_600_000).toISOString();
    expect(await history(boss, `&from=${encodeURIComponent(soon)}`)).toEqual([]);
    expect((await history(boss, `&from=${encodeURIComponent(ago)}`)).length).toBe(all.length);
    expect(await history(boss, `&to=${encodeURIComponent(ago)}`)).toEqual([]);
    // Several together narrow further.
    expect(await history(boss, '&client=farms&file=return')).toEqual([]);

    // A page at a time, older by `before`.
    const page = (await boss.get('/api/staff/v1/history?limit=2').expect(200)).body.events as {
      id: number;
    }[];
    expect(page).toHaveLength(2);
    const next = (await boss.get(`/api/staff/v1/history?limit=2&before=${page[1]!.id}`).expect(200))
      .body.events as { id: number }[];
    expect(next[0]!.id).toBeLessThan(page[1]!.id);
  });

  it('says when someone was told of new files, and how (P103)', async () => {
    const mary = await w.member('mary@example.test');
    const ret = await share(CLIENT, 'Return.pdf');
    await w
      .firm('put', `/files/${ret}/visibility`)
      .send({ users: { [mary.id]: true } })
      .expect(200);
    // Nothing yet: notices are gathered for five minutes.
    expect((await history(boss, '&kind=file_notice')).length).toBe(0);
    w.later(6);
    expect(await flush(w.ctx)).toBe(1);
    const told = (await boss.get('/api/staff/v1/history?kind=file_notice').expect(200)).body
      .events as (Row & { channel: string | null })[];
    expect(told).toEqual([
      expect.objectContaining({
        who: 'the portal',
        client: 'Smith, John',
        person: 'mary@example.test',
        channel: 'email',
      }),
    ]);
    // The client's own History has it too; the invitation says how it went out.
    const hers = (await boss.get(`/api/staff/v1/clients/${CLIENT}/history`).expect(200)).body
      .events as (Row & { channel: string | null })[];
    expect(hers.some((e) => e.kind === 'file_notice')).toBe(true);
    expect(hers.find((e) => e.kind === 'invite')).toEqual(
      expect.objectContaining({ channel: 'email', person: 'mary@example.test' }),
    );
    // Found by how it was sent, under About.
    expect((await history(boss, '&about=email')).some((e) => e.kind === 'file_notice')).toBe(true);
  });

  it('keeps a limited staff member to their clients, and admin doings to admins', async () => {
    await share(CLIENT, 'Return.pdf');
    await share(OTHER, 'Farm.pdf');
    const added = await boss
      .post('/api/staff/v1/staff')
      .send({ email: 'mary@example-cpa.test', name: 'Mary', clientIds: [CLIENT] })
      .expect(201);
    const mary = await finish(added.body.setupLink as string);

    const hers = await history(mary);
    expect(hers.length).toBeGreaterThan(0);
    expect(hers.every((e) => e.client === 'Smith, John')).toBe(true);
    expect(hers.some((e) => e.kind === 'staff_added')).toBe(false);
    // The admin sees both clients and what was done in Settings.
    const his = await history(boss);
    expect(his.some((e) => e.client === 'Smith Farms LLC')).toBe(true);
    expect(his.some((e) => e.kind === 'staff_added')).toBe(true);
    // Not for Vibe Files' key, nor without a session.
    await w.firm('get', '/history').expect(404);
    await request(w.app).get('/api/staff/v1/history').expect(401);
  });
});
