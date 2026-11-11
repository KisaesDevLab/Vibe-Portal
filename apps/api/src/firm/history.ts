// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// History rows in words for the staff page: a client's History (P65) and a person's activity
// (P66). Newest first, a page at a time.

import { alias } from 'drizzle-orm/pg-core';
import { and, desc, eq, lt, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@vibe-portal/db';

import type { Ctx } from '../context';

export const HistoryQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  before: z.coerce.number().int().min(1).optional(),
});

export interface HistoryRow {
  id: number;
  at: Date;
  kind: string;
  who: string;
  /** The person it was about, when not the one who did it. */
  person: string | null;
  file: string | null;
  /** A secure link's outside recipient (P49). */
  recipient: string | null;
  /** The client it was on (a person's activity spans their clients). */
  client: string | null;
}

/** The person's name, else email, else number. */
const named = (n: string | null, e: string | null, p: string | null): string | null =>
  n || e || p || null;

export async function historyRows(
  ctx: Ctx,
  where: SQL | undefined,
  q: z.infer<typeof HistoryQuery>,
): Promise<HistoryRow[]> {
  const person = alias(schema.portalIdentity, 'person');
  const actorPerson = alias(schema.portalIdentity, 'actor_person');
  const rows = await ctx.db
    .select({
      id: schema.events.id,
      at: schema.events.at,
      kind: schema.events.kind,
      actorKind: schema.events.actorKind,
      actor: schema.events.actor,
      actorName: actorPerson.name,
      actorEmail: actorPerson.email,
      actorPhone: actorPerson.phone,
      personName: person.name,
      personEmail: person.email,
      personPhone: person.phone,
      file: schema.files.name,
      upload: schema.uploads.name,
      client: schema.clients.displayName,
      detail: schema.events.detail,
    })
    .from(schema.events)
    .leftJoin(schema.files, eq(schema.files.id, schema.events.fileId))
    .leftJoin(schema.uploads, eq(schema.uploads.id, schema.events.uploadId))
    .leftJoin(schema.clients, eq(schema.clients.id, schema.events.clientId))
    .leftJoin(person, eq(person.id, schema.events.identityId))
    .leftJoin(
      actorPerson,
      and(
        eq(schema.events.actorKind, 'client'),
        eq(sql`${actorPerson.id}::text`, schema.events.actor),
      ),
    )
    .where(and(q.before ? lt(schema.events.id, q.before) : undefined, where))
    .orderBy(desc(schema.events.id))
    .limit(q.limit);
  return rows.map((e) => {
    const who =
      e.actorKind === 'client'
        ? (named(e.actorName, e.actorEmail, e.actorPhone) ?? 'a client')
        : e.actorKind === 'system'
          ? 'the portal'
          : e.actorKind === 'firm_key'
            ? `Vibe Files (${e.actor})`
            : e.actor;
    const d = (e.detail ?? {}) as Record<string, unknown>;
    return {
      id: e.id,
      at: e.at,
      kind: e.kind,
      who,
      person: named(e.personName, e.personEmail, e.personPhone),
      file: e.file ?? e.upload ?? null,
      recipient: typeof d['to'] === 'string' ? d['to'] : null,
      client: e.client ?? null,
    };
  });
}
