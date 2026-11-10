// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../app';
import { loadConfig } from '../config';
import { VERSION } from '../version';

describe('GET /health', () => {
  it('is ok when the database answers', async () => {
    const res = await request(createApp({ pingDb: async () => true })).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', version: VERSION, db: 'ok' });
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('is 503 when the database is down', async () => {
    const res = await request(createApp({ pingDb: async () => false })).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.db).toBe('down');
  });

  it('unknown API paths are a JSON 404', async () => {
    const res = await request(createApp({ pingDb: async () => true })).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });
});

describe('config', () => {
  it('needs DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('fills the defaults', () => {
    const c = loadConfig({ DATABASE_URL: 'postgres://x' });
    expect(c.PORT).toBe(3101);
    expect(c.DATA_DIR).toBe('/data/portal');
  });
});
