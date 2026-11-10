// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// One-time links for staff accounts on the appliance (P36):
//
//   staff-setup link            the first account's setup link (only while none is finished)
//   staff-setup reset <email>   a new link for a locked-out staff member (password and
//                               authenticator set again)

import { and, count, eq, isNotNull } from 'drizzle-orm';
import { createDb, schema } from '@vibe-portal/db';

import { loadConfig } from '../config';
import { record } from '../lib/events';
import { createSetupLink } from '../staff/auth';

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
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
    } else if (cmd === 'reset' && arg) {
      const [u] = await db
        .select()
        .from(schema.staffUsers)
        .where(eq(schema.staffUsers.email, arg.trim().toLowerCase()));
      if (!u) {
        console.error('No staff account with that email.');
        process.exitCode = 1;
        return;
      }
      await db
        .update(schema.staffUsers)
        .set({
          passwordHash: null,
          totpSecretEnc: null,
          totpConfirmedAt: null,
          failedLogins: 0,
          lockedUntil: null,
          active: true,
        })
        .where(and(eq(schema.staffUsers.id, u.id)));
      await db.delete(schema.sessions).where(eq(schema.sessions.subjectId, u.id));
      await record(
        db,
        'staff_reset',
        { kind: 'system', name: 'appliance' },
        {
          detail: { staffId: u.id },
        },
      );
      console.warn(`New setup link for ${u.email} (works for 3 days, once):`);
      process.stdout.write(`${await createSetupLink(ctx, u.id, 'appliance')}\n`);
    } else {
      console.error('Usage: staff-setup link | reset <email>');
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
