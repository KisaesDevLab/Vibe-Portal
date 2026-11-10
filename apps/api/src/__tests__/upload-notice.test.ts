// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// A client sending files can have someone at the firm told (P56): only someone the firm allows
// and who can see that client, once per batch.

import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { schema } from '@vibe-portal/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CLIENT, OTHER, world, type World } from './harness';

let w: World;
beforeEach(async () => {
  w = await world();
});
afterEach(async () => {
  await w.close();
});

async function staffMember(email: string, name: string, notify: boolean, clients?: string[]) {
  const [u] = await w.t.db
    .insert(schema.staffUsers)
    .values({ email, name, notifyUploads: notify, allClients: !clients })
    .returning();
  for (const c of clients ?? []) {
    await w.t.db.insert(schema.staffClient).values({ staffId: u?.id as string, clientId: c });
  }
  return u?.id as string;
}

function upload(
  agent: Awaited<ReturnType<World['member']>>['agent'],
  batchId: string,
  name: string,
) {
  const q = new URLSearchParams({ clientId: CLIENT, batchId, name, note: 'For the 2025 return' });
  return agent
    .post(`/api/portal/uploads?${q.toString()}`)
    .set('Content-Type', 'application/octet-stream')
    .send(Buffer.from('%PDF-1.7\n%%EOF\n'));
}

describe('telling someone at the firm about an upload (P56)', () => {
  it('offers only those the firm allows who see the client, and tells them once', async () => {
    const ann = await staffMember('ann@example-cpa.test', 'Ann Preparer', true);
    await staffMember('bob@example-cpa.test', 'Bob NotTicked', false);
    await staffMember('cy@example-cpa.test', 'Cy OtherClient', true, [OTHER]);
    const lee = await staffMember('lee@example-cpa.test', 'Lee ThisClient', true, [CLIENT]);
    const pat = await w.member('pat@example.test');

    const opts = await pat.agent
      .get(`/api/portal/uploads/notify-options?clientId=${CLIENT}`)
      .expect(200);
    expect(opts.body.staff).toEqual([
      { id: ann, name: 'Ann Preparer' },
      { id: lee, name: 'Lee ThisClient' },
    ]);
    // Names only: no email address reaches the client.
    expect(JSON.stringify(opts.body)).not.toContain('@example-cpa.test');

    const batchId = randomUUID();
    await upload(pat.agent, batchId, 'W-2.pdf').expect(201);
    await upload(pat.agent, batchId, '1099-INT.pdf').expect(201);
    await pat.agent
      .post('/api/portal/uploads/notify')
      .send({ clientId: CLIENT, batchId, staffId: ann })
      .expect(200);
    const m = w.notes.last('ann@example-cpa.test');
    expect(m.body).toContain('W-2.pdf');
    expect(m.body).toContain('1099-INT.pdf');
    expect(m.body).toContain('For the 2025 return');
    expect(m.body).toContain(`/staff/clients/${CLIENT}`);
    // Once per batch.
    await pat.agent
      .post('/api/portal/uploads/notify')
      .send({ clientId: CLIENT, batchId, staffId: ann })
      .expect(200);
    expect(w.notes.sent.filter((x) => x.to === 'ann@example-cpa.test')).toHaveLength(1);
    const kinds = (await w.t.db.select().from(schema.events)).map((e) => e.kind);
    expect(kinds).toContain('upload_notice');
  });

  it('refuses someone not on the list, a batch that is not theirs, and a turned-off person', async () => {
    const bob = await staffMember('bob@example-cpa.test', 'Bob', false);
    const ann = await staffMember('ann@example-cpa.test', 'Ann', true);
    const pat = await w.member('pat@example.test');
    const sam = await w.member('sam@example.test');
    const batchId = randomUUID();
    await upload(pat.agent, batchId, 'W-2.pdf').expect(201);
    await pat.agent
      .post('/api/portal/uploads/notify')
      .send({ clientId: CLIENT, batchId, staffId: bob })
      .expect(400);
    // Someone else's batch.
    await sam.agent
      .post('/api/portal/uploads/notify')
      .send({ clientId: CLIENT, batchId, staffId: ann })
      .expect(404);
    await w.t.db
      .update(schema.staffUsers)
      .set({ active: false })
      .where(eq(schema.staffUsers.id, ann));
    await pat.agent
      .post('/api/portal/uploads/notify')
      .send({ clientId: CLIENT, batchId, staffId: ann })
      .expect(400);
    expect(w.notes.sent.filter((x) => x.to.endsWith('@example-cpa.test'))).toHaveLength(0);
  });
});
