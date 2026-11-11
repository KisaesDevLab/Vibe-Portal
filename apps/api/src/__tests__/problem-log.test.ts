// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P64: the server's warnings and errors on the staff page's Log (admins only), without secrets.

import pino from 'pino';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { purgeProblems, ProblemLog, toRow } from '../lib/problems';
import { MemoryObjects } from '../files/objects';
import { createSetupLink } from '../staff/auth';
import { totpCode } from '../staff/credentials';
import { world, type World } from './harness';

let w: World;
let bucket: MemoryObjects;
beforeEach(async () => {
  w = await world();
  bucket = new MemoryObjects();
  w.ctx.openB2 = () => bucket;
  const problems = new ProblemLog();
  problems.attach(w.t.db);
  // As the server does: everything to the console, warnings and errors also to the database.
  w.ctx.log = pino(
    { level: 'info' },
    pino.multistream([{ level: 'warn', stream: problems.stream }]),
  );
});
afterEach(async () => {
  await w.close();
});

type Agent = ReturnType<typeof request.agent>;

async function admin(email = 'kurt@example-cpa.test'): Promise<Agent> {
  const link = await createSetupLink(w.ctx, null, 'appliance');
  const token = /#t=([\w-]+)/.exec(link)?.[1] ?? '';
  const agent = request.agent(w.app);
  const set = await agent
    .post('/api/staff/auth/setup')
    .send({ token, email, name: email, password: 'a long staff password' })
    .expect(200);
  await agent
    .post('/api/staff/auth/setup/confirm')
    .send({ token, code: totpCode(set.body.secret as string, w.ctx.now()) })
    .expect(200);
  return agent;
}

describe('Log (P64)', () => {
  it("says why a bucket was refused, with B2's reason and never the key", async () => {
    const boss = await admin();
    bucket.down = true;
    await boss
      .put('/api/staff/v1/settings/storage/b2')
      .send({
        endpoint: 's3.us-west-004.backblazeb2.com',
        bucket: 'example-cpa-portal',
        keyId: '004a1b2c3d4e5f60000000001',
        appKey: 'K004SuperSecretApplicationKeyValue',
      })
      .expect(400);
    const log = await vi.waitFor(async () => {
      const r = await boss.get('/api/staff/v1/settings/log').expect(200);
      expect(r.body.problems).toHaveLength(1);
      return r.body.problems;
    });
    expect(log[0]).toEqual(
      expect.objectContaining({
        level: 'warning',
        msg: 'B2 bucket could not be used',
        detail: { check: 'saving the bucket', reason: 'network down' },
      }),
    );
    expect(JSON.stringify(log)).not.toContain('SuperSecret');
  });

  it('pages newest first, and keeps 30 days', async () => {
    const boss = await admin();
    for (let i = 1; i <= 5; i++) w.ctx.log.error({ err: new Error(`boom ${i}`), n: i }, 'failed');
    await vi.waitFor(async () => {
      const r = await boss.get('/api/staff/v1/settings/log').expect(200);
      expect(r.body.problems).toHaveLength(5);
    });
    const page = await boss.get('/api/staff/v1/settings/log?limit=2').expect(200);
    expect(page.body.problems.map((p: { level: string }) => p.level)).toEqual(['error', 'error']);
    const ids = page.body.problems.map((p: { id: number }) => p.id);
    expect(ids[0]).toBeGreaterThan(ids[1]);
    const next = await boss.get(`/api/staff/v1/settings/log?limit=10&before=${ids[1]}`).expect(200);
    expect(next.body.problems).toHaveLength(3);

    await purgeProblems(w.t.db, new Date(Date.now() + 31 * 24 * 3_600_000));
    const none = await boss.get('/api/staff/v1/settings/log').expect(200);
    expect(none.body.problems).toEqual([]);
  });

  it('needs a signed-in admin', async () => {
    await request(w.app).get('/api/staff/v1/settings/log').expect(401);
  });
});

describe('toRow', () => {
  it('keeps the message, the error and plain values; drops secrets, stacks and info lines', () => {
    const line = JSON.stringify({
      level: 50,
      time: 1_700_000_000_000,
      pid: 1,
      hostname: 'h',
      msg: 'notification failed',
      err: { type: 'Error', message: 'SMTP refused', stack: 'Error: at x' },
      channel: 'email',
      appKey: 'K004secret',
      token: 'abc',
      password: 'p',
      attempts: 3,
      nested: { a: 1 },
    });
    expect(toRow(line)).toEqual({
      at: new Date(1_700_000_000_000),
      level: 'error',
      msg: 'notification failed',
      detail: { error: 'SMTP refused', channel: 'email', attempts: 3 },
    });
    expect(toRow(JSON.stringify({ level: 30, msg: 'ok' }))).toBeNull();
    expect(toRow('not json')).toBeNull();
  });
});
