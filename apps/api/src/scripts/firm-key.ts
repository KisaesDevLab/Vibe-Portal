// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Creates, lists or revokes the firm key Vibe Files uses, until the appliance admin screen does
// this (Phase 5).
//
//   pnpm --filter @vibe-portal/api firm-key create "Office"
//   pnpm --filter @vibe-portal/api firm-key list
//   pnpm --filter @vibe-portal/api firm-key revoke <id>

import { createDb, schema } from '@vibe-portal/db';

import { loadConfig } from '../config';
import { createFirmKey, revokeFirmKey } from '../firm/keys';

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  const { db, close } = createDb({ connectionString: loadConfig().DATABASE_URL, max: 1 });
  try {
    if (cmd === 'create') {
      const { id, key } = await createFirmKey(db, arg || 'Firm key');
      console.warn(
        `Key ${id} created. Paste it into Vibe Files > Setup > Portal; it is shown once:`,
      );
      process.stdout.write(`${key}\n`);
    } else if (cmd === 'list') {
      for (const k of await db.select().from(schema.firmKeys)) {
        const state = k.revokedAt ? `revoked ${k.revokedAt.toISOString()}` : 'live';
        const used = k.lastUsedAt ? k.lastUsedAt.toISOString() : 'never';
        process.stdout.write(`${k.id}  ${k.label}  ${state}  last used ${used}\n`);
      }
    } else if (cmd === 'revoke' && arg) {
      const isId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(arg);
      const done = isId && (await revokeFirmKey(db, arg, new Date()));
      console.warn(done ? 'Revoked.' : 'No live key with that id.');
      if (!done) process.exitCode = 1;
    } else {
      console.error('Usage: firm-key create <label> | list | revoke <id>');
      process.exitCode = 2;
    }
  } finally {
    await close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
