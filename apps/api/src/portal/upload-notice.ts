// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Telling someone at the firm that a client sent files (P56). The client picks a staff member
// from those the firm allows (Settings > Staff, "Clients may notify") who can see that client;
// the client sees their names only. One email per batch, naming the files and the note, with a
// link to the client's page; the files stay on the portal.
//
//   GET  /api/portal/uploads/notify-options?clientId     -> { staff: [{ id, name }] }
//   POST /api/portal/uploads/notify   { clientId, batchId, staffId }  after the batch is sent

import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@vibe-portal/db';

import { activeClientsOf } from '../auth/grant';
import type { ClientSession } from '../auth/sessions';
import type { Ctx } from '../context';
import { record } from '../lib/events';
import { HttpError } from '../lib/http';
import { displayNameOf } from '../lib/contact';
import { messageTo } from '../lib/notify';
import { hit } from '../lib/rate-limit';

export const NotifySchema = z.object({
  clientId: z.string().uuid(),
  batchId: z.string().uuid(),
  staffId: z.string().uuid(),
});

/** Staff a client may tell about an upload to this client. */
export async function notifyOptions(
  ctx: Ctx,
  clientId: string,
): Promise<{ id: string; name: string; email: string }[]> {
  return ctx.db
    .select({
      id: schema.staffUsers.id,
      name: schema.staffUsers.name,
      email: schema.staffUsers.email,
    })
    .from(schema.staffUsers)
    .where(
      and(
        eq(schema.staffUsers.notifyUploads, true),
        eq(schema.staffUsers.active, true),
        // Only someone who can see this client on the staff page (P48).
        or(
          eq(schema.staffUsers.admin, true),
          eq(schema.staffUsers.allClients, true),
          sql`${schema.staffUsers.id} IN (SELECT staff_id FROM staff_client WHERE client_id = ${clientId})`,
        ),
      ),
    )
    .orderBy(schema.staffUsers.name);
}

async function mustHaveClient(ctx: Ctx, s: ClientSession, clientId: string): Promise<string> {
  const clients = await activeClientsOf(ctx.db, s.identityId);
  const c = clients.find((x) => x.id === clientId);
  if (!c) throw new HttpError(404, 'not_found');
  return c.displayName;
}

export async function listOptions(ctx: Ctx, s: ClientSession, clientId: string) {
  await mustHaveClient(ctx, s, clientId);
  return (await notifyOptions(ctx, clientId)).map(({ id, name }) => ({ id, name }));
}

/** Emails the chosen staff member about one batch, once. */
export async function notifyBatch(
  ctx: Ctx,
  s: ClientSession,
  input: z.infer<typeof NotifySchema>,
): Promise<void> {
  const clientName = await mustHaveClient(ctx, s, input.clientId);
  if (
    !(await hit(
      ctx.db,
      `uploadnotice:${s.identityId}`,
      { max: 20, windowSeconds: 3600 },
      ctx.now(),
    ))
  ) {
    throw new HttpError(429, 'too_many_requests');
  }
  const staff = (await notifyOptions(ctx, input.clientId)).find((x) => x.id === input.staffId);
  if (!staff) throw new HttpError(400, 'cannot_notify');
  const files = await ctx.db
    .select({ name: schema.uploads.name, note: schema.uploads.note })
    .from(schema.uploads)
    .where(
      and(
        eq(schema.uploads.batchId, input.batchId),
        eq(schema.uploads.identityId, s.identityId),
        eq(schema.uploads.clientId, input.clientId),
        isNull(schema.uploads.removedAt),
      ),
    );
  if (files.length === 0) throw new HttpError(404, 'not_found');
  // Once per batch, whoever asks again.
  const [first] = await ctx.db
    .insert(schema.uploadNotice)
    .values({
      batchId: input.batchId,
      identityId: s.identityId,
      clientId: input.clientId,
      staffId: staff.id,
    })
    .onConflictDoNothing()
    .returning({ batchId: schema.uploadNotice.batchId });
  if (!first) return;
  const [who] = await ctx.db
    .select({
      name: schema.portalIdentity.name,
      email: schema.portalIdentity.email,
      phone: schema.portalIdentity.phone,
    })
    .from(schema.portalIdentity)
    .where(eq(schema.portalIdentity.id, s.identityId));
  const from = displayNameOf(who);
  const note = files.find((f) => f.note)?.note ?? '';
  const n = files.length;
  const body =
    `${from} (${clientName}) sent ${n === 1 ? 'a file' : `${n} files`} through the client portal ` +
    `and asked that you be told:\n\n${files.map((f) => `  - ${f.name}`).join('\n')}\n` +
    (note ? `\nTheir note: ${note}\n` : '') +
    `\nVibe Files collects them into Intake. To see them now:\n` +
    `${ctx.portalUrl}/staff/clients/${input.clientId}`;
  try {
    await ctx.notifier.send(
      messageTo(staff.email, `${clientName} sent ${n === 1 ? 'a file' : `${n} files`}`, body),
    );
  } catch (err) {
    ctx.log.error({ err }, 'upload notice email failed');
    // Let the client try again.
    await ctx.db.delete(schema.uploadNotice).where(eq(schema.uploadNotice.batchId, input.batchId));
    throw new HttpError(502, 'notice_not_sent');
  }
  await record(
    ctx.db,
    'upload_notice',
    { kind: 'client', name: s.identityId },
    { clientId: input.clientId, identityId: s.identityId, detail: { staff: staff.name, files: n } },
  );
}
