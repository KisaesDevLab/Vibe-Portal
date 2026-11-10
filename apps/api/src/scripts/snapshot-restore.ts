// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Gets the portal back from its B2 bucket after the appliance is lost (P51): the database from
// the newest snapshot there, and the stored files where they already are.
//
//   snapshot-restore list
//   snapshot-restore restore [name] --seal <path to the old .firm-key.seal> [--replace]
//
// The bucket comes from B2_ENDPOINT, B2_BUCKET, B2_KEY_ID and B2_APP_KEY. Before restoring, start
// the new portal once (it prepares an empty database), then stop it. Keep the old seal file
// apart: the new portal makes a seal file of its own, which this replaces with the old one once
// the database is restored. Then start the portal.

import { copyFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createDb } from '@vibe-portal/db';

import { loadConfig } from '../config';
import { B2Objects } from '../files/b2';
import { listSnapshots, openSnapshot, restoreSnapshot } from '../files/snapshot';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Set ${name} (the bucket's settings from Backblaze).`);
  return v;
}

async function main(): Promise<void> {
  const [cmd, maybeName] = process.argv.slice(2);
  const bucket = new B2Objects({
    endpoint: need('B2_ENDPOINT'),
    bucket: need('B2_BUCKET'),
    keyId: need('B2_KEY_ID'),
    appKey: need('B2_APP_KEY'),
  });
  const all = await listSnapshots(bucket);
  if (cmd === 'list') {
    for (const s of all) {
      process.stdout.write(`${s.name}  ${s.modified.toISOString()}  ${s.size} bytes\n`);
    }
    if (!all.length) console.error('The bucket has no database snapshot.');
    return;
  }
  if (cmd !== 'restore') {
    console.error('Usage: snapshot-restore list | restore [name] --seal <file> [--replace]');
    process.exitCode = 2;
    return;
  }
  const seal = arg('--seal');
  if (!seal) throw new Error('Give the old seal file: --seal <path to .firm-key.seal>.');
  const name = maybeName && !maybeName.startsWith('--') ? maybeName : all[0]?.name;
  if (!name) throw new Error('The bucket has no database snapshot.');
  const data = await bucket.getNote(name);
  if (!data) throw new Error(`No snapshot named ${name}.`);
  // Opened (and so the seal file checked) before anything is changed.
  const snap = await openSnapshot(data, seal);
  console.warn(`Snapshot ${name}, taken ${snap.header.takenAt}.`);
  const config = loadConfig();
  const { db, close } = createDb({ connectionString: config.DATABASE_URL, max: 1 });
  try {
    const counts = await restoreSnapshot(db, snap, process.argv.includes('--replace'));
    const target = join(config.DATA_DIR, '.firm-key.seal');
    // The new portal's own seal file is read-only: replaced, not written over.
    if (resolve(seal) !== resolve(target)) {
      await rm(target, { force: true });
      await copyFile(seal, target);
    }
    // The portal reads the seal file from the path its key record names.
    const named = (snap.header.envelope.kekMetadata as { path?: string }).path;
    if (named && named !== target) {
      console.warn(`The firm key record names ${named}: put the seal file there too.`);
    }
    console.warn(`Restored: ${JSON.stringify(counts)}`);
    console.warn('The seal file is back in place. Start the portal; everyone signs in again.');
  } finally {
    await close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
