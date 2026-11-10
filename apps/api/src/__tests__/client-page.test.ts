// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// A client's page on the staff page (P54): its heading, and its own uploads.

import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CLIENT, OTHER, world, type World } from './harness';

let w: World;
beforeEach(async () => {
  w = await world();
});
afterEach(async () => {
  await w.close();
});

function upload(
  agent: Awaited<ReturnType<World['member']>>['agent'],
  clientId: string,
  name: string,
) {
  const q = new URLSearchParams({ clientId, batchId: randomUUID(), name });
  return agent
    .post(`/api/portal/uploads?${q.toString()}`)
    .set('Content-Type', 'application/octet-stream')
    .send(Buffer.from('%PDF-1.7\n%%EOF\n'));
}

describe("a client's page (P54)", () => {
  it('names the client, with its counts', async () => {
    const pat = await w.member('pat@example.test');
    await upload(pat.agent, CLIENT, 'W-2.pdf').expect(201);
    const res = await w.firm('get', `/clients/${CLIENT}`).expect(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        id: CLIENT,
        clientCode: '1001',
        active: true,
        users: 1,
        waiting: 1,
      }),
    );
    expect(typeof res.body.displayName).toBe('string');
    await w.firm('get', `/clients/${randomUUID()}`).expect(404);
  });

  it("lists one client's uploads waiting for Vibe Files", async () => {
    const pat = await w.member('pat@example.test');
    const sam = await w.member('sam@example.test', OTHER);
    await upload(pat.agent, CLIENT, 'W-2.pdf').expect(201);
    await upload(sam.agent, OTHER, '1099.pdf').expect(201);
    const all = await w.firm('get', '/uploads').expect(200);
    expect(all.body.uploads).toHaveLength(2);
    const one = await w.firm('get', `/uploads?clientId=${CLIENT}`).expect(200);
    expect(one.body.uploads.map((u: { clientId: string }) => u.clientId)).toEqual([CLIENT]);
    await w.firm('get', '/uploads?clientId=nope').expect(400);
  });
});
