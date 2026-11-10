// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Phase 7 load check (BUILD_PLAN.md §7): 500 clients, 20,000 files, two people per client,
// each file visible to both, and 50,000 events. Times the calls that grow with the firm.
// Opt-in, as it takes a while:  LOAD=1 npx vitest run src/__tests__/load.test.ts
// pglite is slower than the appliance's Postgres, so these limits are generous upper bounds.

import { createHash, randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSetupLink } from '../staff/auth';
import { totpCode } from '../staff/credentials';
import { world, type World } from './harness';

const CLIENTS = 500;
const FILES_PER_CLIENT = 40;
const EVENTS = 50_000;

let w: World;

async function timed<T>(label: string, run: () => Promise<T>): Promise<{ ms: number; r: T }> {
  const t0 = performance.now();
  const r = await run();
  const ms = Math.round(performance.now() - t0);
  console.log(`${label}: ${ms} ms`);
  return { ms, r };
}

describe.skipIf(!process.env.LOAD)('load (Phase 7)', () => {
  beforeAll(async () => {
    w = await world();
    const db = w.t.db;
    await timed('seed', async () => {
      await db.execute(sql`
        INSERT INTO clients (id, client_code, display_name, active, created_at, updated_at)
        SELECT gen_random_uuid(), (2000 + n)::text, 'Client ' || lpad(n::text, 4, '0'), true, now(), now()
        FROM generate_series(1, ${CLIENTS}) n`);
      await db.execute(sql`
        INSERT INTO portal_identity (email, name)
        SELECT 'p' || n || '@load.test', 'Person ' || n FROM generate_series(1, ${CLIENTS * 2}) n`);
      await db.execute(sql`
        INSERT INTO client_access (identity_id, client_id)
        SELECT i.id, c.id
        FROM (SELECT id, row_number() OVER (ORDER BY client_code) r FROM clients
              WHERE display_name LIKE 'Client %') c
        JOIN (SELECT id, (row_number() OVER (ORDER BY email) + 1) / 2 r FROM portal_identity
              WHERE email LIKE '%@load.test') i ON i.r = c.r`);
      await db.execute(sql`
        INSERT INTO files (client_id, vf_document_id, name, size, sha256, shared_by, tax_year)
        SELECT c.id, 'doc-' || n, 'Return ' || n || '.pdf', 100000, repeat('a', 64), 'PC\\load', 2020 + n % 6
        FROM clients c, generate_series(1, ${FILES_PER_CLIENT}) n
        WHERE c.display_name LIKE 'Client %'`);
      await db.execute(sql`
        INSERT INTO file_visibility (file_id, identity_id, visible)
        SELECT f.id, a.identity_id, true FROM files f JOIN client_access a ON a.client_id = f.client_id`);
      await db.execute(sql`
        INSERT INTO events (kind, actor_kind, actor, client_id, detail)
        SELECT 'download', 'client', 'someone', NULL, '{}'::jsonb FROM generate_series(1, ${EVENTS})`);
      await db.execute(sql`ANALYZE`);
    });
  }, 600_000);

  afterAll(async () => {
    await w?.close();
  });

  it('Vibe Files: every client, and every live file for the Browse marks', async () => {
    const clients = await timed('firm GET /clients', () => w.firm('get', '/clients').expect(200));
    expect(clients.r.body.clients.length).toBe(CLIENTS + 2);
    expect(clients.ms).toBeLessThan(5_000);
    const all = await timed('firm GET /files?all=1', () =>
      w.firm('get', '/files?all=1').expect(200),
    );
    expect(all.r.body.files.length).toBe(CLIENTS * FILES_PER_CLIENT);
    console.log(`  /files?all=1 body: ${Math.round(all.r.text.length / 1024)} KB`);
    expect(all.ms).toBeLessThan(10_000);
    const one = await timed('firm GET /files?clientId', async () => {
      const c = clients.r.body.clients.find((x: { files: number }) => x.files > 0);
      return w.firm('get', `/files?clientId=${c.id}`).expect(200);
    });
    expect(one.ms).toBeLessThan(1_000);
    const ev = await timed('firm GET /events?since=0&limit=1000', () =>
      w.firm('get', '/events?since=0&limit=1000').expect(200),
    );
    expect(ev.ms).toBeLessThan(2_000);
  }, 120_000);

  it('a client lists their files; staff see the newest history', async () => {
    const m = await w.member('busy@load.test');
    // Give this person every file of a loaded client too.
    await w.t.db.execute(sql`
      INSERT INTO client_access (identity_id, client_id)
      SELECT ${m.id}::uuid, id FROM clients WHERE client_code = '2001'`);
    await w.t.db.execute(sql`
      INSERT INTO file_visibility (file_id, identity_id, visible)
      SELECT f.id, ${m.id}::uuid, true FROM files f
      JOIN clients c ON c.id = f.client_id WHERE c.client_code = '2001'`);
    const mine = await timed('client GET /files', () =>
      m.agent.get('/api/portal/files').expect(200),
    );
    expect(mine.ms).toBeLessThan(1_000);

    const agent = request.agent(w.app);
    const token = /#t=([\w-]+)/.exec(await createSetupLink(w.ctx, null, 'load'))?.[1];
    const set = await agent
      .post('/api/staff/auth/setup')
      .send({ token, email: 'staff@load.test', name: 'Staff', password: 'a long staff password' })
      .expect(200);
    await agent
      .post('/api/staff/auth/setup/confirm')
      .send({ token, code: totpCode(set.body.secret as string, w.ctx.now()) })
      .expect(200);
    const hist = await timed('staff GET /events?latest=1&limit=300', () =>
      agent.get('/api/staff/v1/events?latest=1&limit=300').expect(200),
    );
    expect(hist.ms).toBeLessThan(1_000);
    const list = await timed('staff GET /clients', () =>
      agent.get('/api/staff/v1/clients').expect(200),
    );
    expect(list.ms).toBeLessThan(5_000);
  }, 120_000);

  it('a 90 MB upload streams through without holding it all in memory', async () => {
    const m = await w.member('big@load.test');
    const size = 90 * 1024 * 1024;
    const body = Buffer.alloc(size, 7);
    body.write('%PDF-1.7\n', 0, 'latin1');
    const sha = createHash('sha256').update(body).digest('hex');
    const before = process.memoryUsage().rss;
    const peak = process.resourceUsage().maxRSS * 1024;
    const up = await timed('client upload 90 MB', () =>
      m.agent
        .post(
          `/api/portal/uploads?clientId=11111111-1111-4111-8111-111111111111&batchId=${randomUUID()}&name=big.pdf`,
        )
        .set('Content-Type', 'application/octet-stream')
        .send(body),
    );
    expect(up.r.status, JSON.stringify(up.r.body)).toBe(201);
    console.log(`  rss grew by ${Math.round((process.memoryUsage().rss - before) / 1048576)} MB`);
    // The peak resident memory may not grow by anything like the file (the test's own copy of
    // it is already counted in `peak`).
    const grew = process.resourceUsage().maxRSS * 1024 - peak;
    console.log(`  peak rss grew by ${Math.round(grew / 1048576)} MB`);
    expect(grew).toBeLessThan(size / 2);
    const got = await timed('firm download 90 MB', () =>
      w
        .firm('get', `/uploads/${up.r.body.uploadId}/content`)
        .buffer(true)
        .parse((res, cb) => {
          const parts: Buffer[] = [];
          res.on('data', (c: Buffer) => parts.push(c));
          res.on('end', () => cb(null, Buffer.concat(parts)));
        })
        .expect(200),
    );
    expect(
      createHash('sha256')
        .update(got.r.body as Buffer)
        .digest('hex'),
    ).toBe(sha);
  }, 300_000);
});
