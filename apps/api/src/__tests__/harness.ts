// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// A whole portal for tests: a fresh database, a firm key, two clients, recorded messages, a
// clock the test moves, and file storage in a temporary folder.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { schema, type Database } from '@vibe-portal/db';
import { createTestDb, type TestDb } from '@vibe-portal/db/testing';
import pino from 'pino';
import request from 'supertest';
import { expect } from 'vitest';

import { createApp } from '../app';
import type { Ctx } from '../context';
import { BlobStore } from '../files/blobs';
import { openKeyring } from '../files/keyring';
import { createFirmKey } from '../firm/keys';
import { recordingNotifier } from '../lib/notify';

export const CLIENT = '11111111-1111-4111-8111-111111111111';
export const OTHER = '22222222-2222-4222-8222-222222222222';
export const T0 = new Date('2026-11-09T15:00:00Z');

/** Key handling and encrypted storage in a new temporary folder. */
export async function fileServices(
  db: Database,
): Promise<Pick<Ctx, 'keyring' | 'blobs'> & { dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'vibe-portal-'));
  return { keyring: await openKeyring(db, dir), blobs: new BlobStore(join(dir, 'blobs')), dir };
}

export interface World {
  t: TestDb;
  ctx: Ctx;
  app: ReturnType<typeof createApp>;
  notes: ReturnType<typeof recordingNotifier>;
  dir: string;
  later(minutes: number): void;
  firm(
    method: 'get' | 'put' | 'post' | 'patch' | 'delete',
    path: string,
  ): ReturnType<ReturnType<typeof request>['get']>;
  linkToken(to: string): string;
  code(to: string): string;
  /** Invites `email` to `clientId`, accepts, and returns a signed-in agent and the identity. */
  member(
    email: string,
    clientId?: string,
  ): Promise<{ agent: ReturnType<typeof request.agent>; id: string }>;
  close(): Promise<void>;
}

export async function world(): Promise<World> {
  const t = await createTestDb();
  let clock = T0;
  const notes = recordingNotifier();
  const services = await fileServices(t.db);
  const ctx: Ctx = {
    db: t.db,
    notifier: notes,
    log: pino({ level: 'silent' }),
    now: () => clock,
    portalUrl: 'https://files.example-cpa.test',
    cookie: { secure: false },
    trustCfIp: false,
    keyring: services.keyring,
    blobs: services.blobs,
  };
  const app = createApp({ pingDb: async () => true, ctx });
  await t.db.update(schema.firm).set({ name: 'Example CPA' });
  const key = (await createFirmKey(t.db, 'Office')).key;
  const firm: World['firm'] = (method, path) =>
    request(app)
      [method](`/api/firm/v1${path}`)
      .set('Authorization', `Bearer ${key}`)
      .set('X-Vibe-PC', 'THGR18C-XA003')
      .set('X-Vibe-User', 'kurt');
  for (const [id, name] of [
    [CLIENT, 'Smith, John'],
    [OTHER, 'Smith Farms LLC'],
  ] as const) {
    await firm('put', `/clients/${id}`).send({ clientCode: '1001', displayName: name }).expect(200);
  }
  const linkToken = (to: string): string => {
    const m = /#t=([\w-]+)/.exec(notes.last(to).body);
    if (!m?.[1]) throw new Error(`no link in message to ${to}`);
    return m[1];
  };
  const code = (to: string): string => {
    const m = /\b(\d{6})\b/.exec(notes.last(to).body);
    if (!m?.[1]) throw new Error(`no code in message to ${to}`);
    return m[1];
  };
  return {
    t,
    ctx,
    app,
    notes,
    dir: services.dir,
    later(minutes) {
      clock = new Date(clock.getTime() + minutes * 60_000);
    },
    firm,
    linkToken,
    code,
    async member(email, clientId = CLIENT) {
      const res = await firm('post', `/clients/${clientId}/invites`).send({ email, name: email });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const agent = request.agent(app);
      await agent
        .post('/api/portal/invitations/accept')
        .send({ token: linkToken(email) })
        .expect(200);
      const me = await agent.get('/api/portal/auth/me').expect(200);
      return { agent, id: me.body.identity.id as string };
    },
    async close() {
      await t.close();
      await rm(services.dir, { recursive: true, force: true });
    },
  };
}

/** A 1x1 PNG: a photo ID for tests (P67). */
export const ID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** Sends the photo ID an access request needs before its code is given (P67). */
export async function sendId(w: Pick<World, 'app'>, requestId: string): Promise<void> {
  await request(w.app)
    .post(`/api/portal/access-requests/${requestId}/id-photo`)
    .set('Content-Type', 'application/octet-stream')
    .send(ID_PNG);
}
