// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Moves the stored files between the data volume and B2 (P51), from the appliance:
//
//   storage-move b2        ask the running portal to move every stored file to the B2 bucket
//   storage-move local     ask it to move them back to the data volume
//   storage-move status    where files are, and how the last move went
//
// The bucket and key are set on the staff page (Settings > Storage), which can also start a move.
// This only asks: the running portal does the move (within half a minute), since it is the one
// writing files. Nothing is deleted from the old place until every file is in the new one.

import { createDb, schema } from '@vibe-portal/db';

import { loadConfig } from '../config';

async function main(): Promise<void> {
  const [cmd] = process.argv.slice(2);
  const config = loadConfig();
  const { db, close } = createDb({ connectionString: config.DATABASE_URL, max: 1 });
  try {
    const [f] = await db.select().from(schema.firm);
    if (!f) throw new Error('the portal has not been set up');
    if (cmd === 'status') {
      process.stdout.write(
        `${JSON.stringify(
          {
            storage: f.storage,
            bothInUse: f.storageOther,
            bucket: f.b2Bucket || null,
            lastMove: f.storageMove,
          },
          null,
          2,
        )}\n`,
      );
    } else if (cmd === 'b2' || cmd === 'local') {
      const state = f.storageMove?.state;
      if (state === 'requested' || state === 'running') {
        console.error('A move is already under way: see `storage-move status`.');
        process.exitCode = 1;
      } else if (f.storage === cmd && !f.storageOther) {
        console.error(
          `The stored files are already ${cmd === 'b2' ? 'in B2' : 'on the appliance'}.`,
        );
        process.exitCode = 1;
      } else if (!f.b2Bucket || !f.b2AppKeyEnc) {
        console.error('Set up the B2 bucket first: staff page, Settings > Storage.');
        process.exitCode = 1;
      } else {
        await db.update(schema.firm).set({
          storageMove: {
            to: cmd,
            state: 'requested',
            by: 'appliance',
            requestedAt: new Date().toISOString(),
          },
        });
        console.warn('Asked. The portal starts the move within half a minute; follow it with');
        console.warn('`storage-move status` or on Settings > Storage.');
      }
    } else {
      console.error('Usage: storage-move b2 | local | status');
      process.exitCode = 2;
    }
  } finally {
    await close();
  }
}

void main();
