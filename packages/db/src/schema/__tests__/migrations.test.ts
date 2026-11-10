// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// The migrations apply to an in-process Postgres (pglite), the Drizzle schema matches them, and
// the constraints that protect the data hold.

import { PGlite } from '@electric-sql/pglite';
import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { listMigrations, migrate } from '../../migrations';
import { pgliteTarget as target } from '../../testing';
import * as schema from '../index';

async function fresh(): Promise<PGlite> {
  const db = new PGlite();
  await migrate(target(db));
  return db;
}

describe('migrations', () => {
  it('apply once, and a second run applies nothing', async () => {
    const db = new PGlite();
    const first = await migrate(target(db));
    expect(first).toEqual(listMigrations().map((m) => m.name));
    expect(await migrate(target(db))).toEqual([]);
  });

  it('every Drizzle column exists in the database with the same nullability', async () => {
    const db = await fresh();
    const cols = await db.query<{ table_name: string; column_name: string; is_nullable: string }>(
      `SELECT table_name, column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public'`,
    );
    const inDb = new Map(cols.rows.map((r) => [`${r.table_name}.${r.column_name}`, r.is_nullable]));
    const tables = (Object.values(schema) as unknown[]).filter((v): v is PgTable => is(v, PgTable));
    const dbTables = new Set([...inDb.keys()].map((k) => k.split('.')[0]));
    dbTables.delete('schema_migrations');
    expect(tables.map((t) => getTableConfig(t).name).sort()).toEqual([...dbTables].sort());
    for (const t of tables) {
      const cfg = getTableConfig(t);
      const dbCols = [...inDb.keys()].filter((k) => k.startsWith(`${cfg.name}.`));
      expect(dbCols.length, cfg.name).toBe(cfg.columns.length);
      for (const c of cfg.columns) {
        const key = `${cfg.name}.${c.name}`;
        expect(inDb.has(key), key).toBe(true);
        expect(inDb.get(key), key).toBe(c.notNull ? 'NO' : 'YES');
      }
    }
  });

  it('has exactly one firm row, with the upload defaults (P1, P8)', async () => {
    const db = await fresh();
    const r = await db.query<{ upload_limit_bytes: string; upload_keep_days: number }>(
      'SELECT upload_limit_bytes, upload_keep_days FROM firm',
    );
    expect(r.rows).toHaveLength(1);
    expect(Number(r.rows[0]?.upload_limit_bytes)).toBe(100 * 1024 * 1024);
    expect(r.rows[0]?.upload_keep_days).toBe(30);
    await expect(db.exec('INSERT INTO firm (id) VALUES (2)')).rejects.toThrow();
  });

  it('events cannot be changed or deleted', async () => {
    const db = await fresh();
    await db.exec(
      `INSERT INTO events (kind, actor_kind, actor) VALUES ('share', 'firm_key', 'test')`,
    );
    await expect(db.exec(`UPDATE events SET actor = 'x'`)).rejects.toThrow(/append-only/);
    await expect(db.exec('DELETE FROM events')).rejects.toThrow(/append-only/);
  });

  it('one live copy of a document per client; a removed file has no blob', async () => {
    const db = await fresh();
    const client = '00000000-0000-4000-8000-000000000001';
    await db.exec(`INSERT INTO clients (id, display_name) VALUES ('${client}', 'Smith, John')`);
    const add = (id: string) =>
      db.exec(
        `INSERT INTO files (id, client_id, vf_document_id, name, size, sha256, blob_key)
         VALUES ('${id}', '${client}', 'doc-1', 'a.pdf', 1, 'h', 'k')`,
      );
    await add('00000000-0000-4000-8000-0000000000a1');
    await expect(add('00000000-0000-4000-8000-0000000000a2')).rejects.toThrow();
    await expect(
      db.exec(`UPDATE files SET removed_at = now() WHERE vf_document_id = 'doc-1'`),
    ).rejects.toThrow();
    await db.exec(
      `UPDATE files SET removed_at = now(), blob_key = NULL WHERE vf_document_id = 'doc-1'`,
    );
    await add('00000000-0000-4000-8000-0000000000a3');
  });

  it('an approved access request must name its client', async () => {
    const db = await fresh();
    await expect(
      db.exec(
        `INSERT INTO access_request (name, email, status) VALUES ('A', 'a@x.test', 'approved')`,
      ),
    ).rejects.toThrow();
  });
});
