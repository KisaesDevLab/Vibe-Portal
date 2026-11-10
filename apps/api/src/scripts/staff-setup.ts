// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// One-time links for staff accounts on the appliance (P36):
//
//   staff-setup link            the first account's setup link (only while none is finished)
//   staff-setup reset <email> [--admin]
//                               a new link for a locked-out staff member (password and
//                               authenticator set again). With --admin, or when no other admin
//                               has a finished account, it also makes them an admin (P48), so
//                               the firm is never locked out of Settings.

import { count, isNotNull } from 'drizzle-orm';
import { createDb, schema } from '@vibe-portal/db';

import { loadConfig } from '../config';
import { applianceReset, createSetupLink } from '../staff/auth';

async function main(): Promise<void> {
  const [cmd, arg, flag] = process.argv.slice(2);
  const config = loadConfig();
  const { db, close } = createDb({ connectionString: config.DATABASE_URL, max: 1 });
  const ctx = { db, now: () => new Date(), portalUrl: config.PORTAL_URL.replace(/\/+$/, '') };
  try {
    if (cmd === 'link') {
      const [r] = await db
        .select({ n: count() })
        .from(schema.staffUsers)
        .where(isNotNull(schema.staffUsers.totpConfirmedAt));
      if (Number(r?.n ?? 0) > 0) {
        console.error('A staff account exists: add more in the staff page, Settings > Staff.');
        process.exitCode = 1;
        return;
      }
      console.warn('Open this link to make the first staff account (it works for 3 days, once):');
      process.stdout.write(`${await createSetupLink(ctx, null, 'appliance')}\n`);
    } else if (cmd === 'reset' && arg && (flag === undefined || flag === '--admin')) {
      const done = await applianceReset(ctx, arg, { admin: flag === '--admin' });
      if (!done) {
        console.error('No staff account with that email.');
        process.exitCode = 1;
        return;
      }
      if (done.madeAdmin) console.warn(`${done.email} is now an admin.`);
      console.warn(`New setup link for ${done.email} (works for 3 days, once):`);
      process.stdout.write(`${done.link}\n`);
    } else {
      console.error('Usage: staff-setup link | reset <email> [--admin]');
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
